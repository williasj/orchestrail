// -- Coordinator routing -------------------------------------------------------
// Evaluates completed pipeline stages and decides NEXT / ESCALATE / REWIND /
// SYNTHESIZE. Accepts dependencies via a factory so server.ts state (AGENTS,
// COORDINATOR, callCoordinatorLLM, appendToolLog) stays in server.ts and this
// module stays free of circular imports.

import type {
  TeamAgent, ChatMessage, PipelineStage, StageCompletion,
  CoordinatorDecision, ToolLogEntry,
} from '../types/index.js'
import type { CoordinatorRouteFn } from './pipeline.js'
import { wbGet, wbList } from './workbench.js'

// -- Types --------------------------------------------------------------------

export interface CoordinatorRouteDeps {
  /** Live reference to agent list — called on every route decision. */
  getAgents:        () => TeamAgent[]
  /** routingPrompt override from coordinator config (or undefined). */
  getRoutingPrompt: () => string | undefined
  /** Coordinator LLM call (already has COORDINATOR.llm bound). */
  callLLM:          (messages: ChatMessage[], maxTokens: number) => Promise<string>
  /** Side-effect log append. */
  appendToolLog:    (entry: Omit<ToolLogEntry, 'id'>) => void
}

// -- Helpers ------------------------------------------------------------------

/** Replaces {{VAR_NAME}} tokens in coordinator prompt overrides with runtime values. */
export function applyTemplateVars(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (str, [key, val]) => str.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val),
    template
  )
}

function buildRoutingSystem(
  goal:            string,
  remainingStages: string[],
  completedStages: string[],
  agents:          TeamAgent[],
  routingPrompt:   string | undefined,
): string {
  const ordered = [...agents].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))
  const roles = ordered.map(a =>
    `### ${a.name}${a.order !== undefined ? ` (stage ${a.order})` : ''}\n${a.systemPrompt.trim()}`
  ).join('\n\n')

  const remaining = remainingStages.length > 0
    ? `Remaining pipeline stages: ${remainingStages.join(' ? ')}`
    : `No remaining stages — all pipeline work is complete.`

  const rewindTargets = completedStages.length > 0
    ? `Completed stages available for REWIND: ${completedStages.join(', ')}`
    : ''

  const override = routingPrompt?.trim()
  if (override) {
    return applyTemplateVars(override, {
      AGENT_ROSTER:      roles,
      GOAL:              goal,
      REMAINING_STAGES:  remaining,
      COMPLETED_STAGES:  rewindTargets,
    })
  }

  return `You are a pipeline coordinator making a routing decision after reviewing a completed stage.

Goal: ${goal}

Team:
${roles}

${remaining}
${rewindTargets ? rewindTargets + '\n' : ''}
Routing options:
NEXT -- the stage work is acceptable, proceed to the next pipeline stage
ESCALATE -- a blocking defect was found; the fix agent is pre-assigned in the pipeline spec
REWIND <stage-name> -- a fix has changed code that a prior stage already approved; re-run that stage on the updated code
SYNTHESIZE -- all required work is done, skip remaining stages and generate the final answer

ESCALATE routes to the pre-assigned fix agent for this stage. You do not choose the target.
REWIND can only target stages that have already completed (listed above). Use it when a fix could invalidate a prior stage's approval.
Only ESCALATE or REWIND for concrete blocking issues. Do not use them for style or optional improvements.
CRITICAL: The "Workbench artifacts" block in the user message is the authoritative record of what has been produced. The byte count is ground truth. Do NOT claim a slot is missing, empty, truncated, or contains no code if that slot is listed as POPULATED -- it exists. Only ESCALATE for a missing artifact when the block shows the required slot as EMPTY or absent entirely.

Respond with exactly one of these on its own line:
NEXT
ESCALATE -- <one sentence describing the specific blocking defect>
REWIND <stage-name> -- <one sentence explaining why that stage must re-run>
SYNTHESIZE`
}

// -- Factory ------------------------------------------------------------------

/**
 * Returns a CoordinatorRouteFn bound to the provided dependencies.
 * Call once at startup and pass the result to executePipeline.
 */
export function createCoordinatorRoute(deps: CoordinatorRouteDeps): CoordinatorRouteFn {
  const { getAgents, getRoutingPrompt, callLLM, appendToolLog } = deps

  return async function coordinatorRoute(
    goal:            string,
    currentStage:    PipelineStage,
    stageOutput:     string,
    completion:      StageCompletion,
    history:         { name: string; assignee: string; summary: string }[],
    remainingStages: string[],
  ): Promise<CoordinatorDecision> {
    const t0        = Date.now()
    const agents    = getAgents()
    const sorted    = [...agents].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))

    const historyStr = history.length > 0
      ? history.map(h => `- ${h.name} (${h.assignee}): ${h.summary}`).join('\n')
      : '(no prior stages)'

    const agentSignal = completion.status === 'ESCALATE'
      ? `ESCALATE — ${completion.escalation_reason ?? completion.summary}`
      : `DONE — ${completion.summary}`

    const completedStages = history.map(h => h.name)

    // AUTO-ESCALATE: trust the agent's ESCALATE signal directly.
    // The coordinator LLM is unreliable at distinguishing valid from invalid
    // ESCALATEs; specialist agents are explicitly instructed to only ESCALATE
    // for concrete blocking issues — trusting them is safer.
    if (completion.status === 'ESCALATE') {
      const reason     = completion.escalation_reason ?? completion.summary ?? 'issue requires fix'
      // The escalating agent usually says who must fix it ("test-engineer must re-run...").
      // Without an escalateTo on the stage, everything used to land on the order-2 agent.
      const escRe = (n: string) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
      const named = agents.filter(a => a.name !== currentStage.assignee && a.name !== 'self-improvement'
        && escRe(a.name).test(reason))
      const escalateTarget = currentStage.escalateTo
        ?? (named.length === 1 ? named[0]!.name : undefined)
        ?? (agents.find(a => a.order === 2) ?? sorted[1])?.name
        ?? 'senior-engineer'
      const durationMs = Date.now() - t0
      appendToolLog({
        ts: Date.now(), agent: 'coordinator', tool: 'route',
        args: {
          stage:       currentStage.name,
          assignee:    currentStage.assignee,
          agentSignal: completion.status,
          summary:     completion.summary.slice(0, 150),
        },
        result: JSON.stringify({
          action: 'ESCALATE', targetAgent: escalateTarget, reason,
          override: false,
          note: 'auto-escalate: agent signal trusted, LLM routing skipped',
        }),
        ok: true, durationMs,
      })
      return { action: 'ESCALATE', targetAgent: escalateTarget, reason }
    }

    // DONE signals — need LLM judgment for NEXT vs REWIND vs SYNTHESIZE.
    //
    // Ground-truth workbench state. The routing LLM is otherwise blind to slot
    // contents and will confabulate "implementation is empty" / "blueprint
    // truncated" reasons -- then ESCALATE on its own fiction, looping the
    // pipeline. We hand it the actual slot manifest (presence + size + a short
    // preview) so routing decisions run on fact, and below we hard-override any
    // emptiness ESCALATE the manifest disproves.
    const artifactSlots = wbList().filter(s => !s.startsWith('__'))
    const slotManifest = artifactSlots.length > 0
      ? artifactSlots.map(s => {
          const v       = wbGet(s) ?? ''
          const bytes   = Buffer.byteLength(v, 'utf8')
          const preview = v.replace(/\s+/g, ' ').trim().slice(0, 160)
          return bytes > 0
            ? `- ${s}: POPULATED (${bytes} bytes) -- ${preview}${v.length > 160 ? ' ...' : ''}`
            : `- ${s}: EMPTY`
        }).join('\n')
      : '(no workbench slots written yet)'

    // Union of every slot any agent is contractually required to produce. Used
    // by the override guard to tell a real missing artifact from a hallucinated one.
    const knownArtifacts = [...new Set(agents.flatMap(a => a.requiredOutputSlots ?? []))]

    let raw = ''
    try { raw = await callLLM([
      { role: 'system', content: buildRoutingSystem(goal, remainingStages, completedStages, agents, getRoutingPrompt()) },
      { role: 'user',   content:
          `## Prior stages\n${historyStr}\n\n` +
          `## Completed stage: ${currentStage.name} (${currentStage.assignee})\n\n` +
          `## Workbench artifacts (ground truth -- trust this over any claim that work is missing or empty)\n${slotManifest}\n\n` +
          `Agent signal: ${agentSignal}\n\n` +
          `Stage output (first 2000 chars):\n${stageOutput.slice(0, 2000)}${stageOutput.length > 2000 ? '\n...' : ''}\n\n` +
          `What is your routing decision?`
      },
    ], 256) } catch (e) {
      // A routing failure must not abort the run: the stage signalled DONE, so advance.
      console.warn(`[coordinator] routing call failed after ${currentStage.name}: ${String(e).slice(0, 160)} -- defaulting to NEXT`)
    }
    const durationMs = Date.now() - t0

    const cleaned   = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    const firstLine = cleaned.split('\n')[0]?.trim() ?? ''
    const upper     = firstLine.toUpperCase()

    const logRoute = (decision: CoordinatorDecision): CoordinatorDecision => {
      const override = completion.status === 'ESCALATE' && decision.action === 'NEXT'
      appendToolLog({
        ts: Date.now(), agent: 'coordinator', tool: 'route',
        args: {
          stage:       currentStage.name,
          assignee:    currentStage.assignee,
          agentSignal: completion.status,
          summary:     completion.summary.slice(0, 150),
        },
        result: JSON.stringify({
          action:  decision.action,
          reason:  decision.reason,
          model:   firstLine.slice(0, 160) || '(empty reply)',
          override,
          ...(override ? { note: `agent signalled ${completion.status} but coordinator routed ${decision.action}` } : {}),
          ...(decision.targetAgent ? { targetAgent: decision.targetAgent } : {}),
          ...(decision.rewindTo    ? { rewindTo:    decision.rewindTo    } : {}),
        }),
        ok: true, durationMs,
      })
      return decision
    }

    if (upper.startsWith('SYNTHESIZE')) {
      return logRoute({ action: 'SYNTHESIZE', reason: 'coordinator: work complete' })
    }

    if (upper.startsWith('ESCALATE')) {
      const match  = firstLine.match(/ESCALATE\s*--\s*(.+)/i)
      const reason = match?.[1]?.trim() ?? completion.escalation_reason ?? 'issue requires fix'

      // Override guard: the LLM is prone to escalating on an invented "missing
      // artifact" reason. A populated slot is a verifiable fact -- if the reason
      // asserts emptiness/truncation of an artifact the workbench shows POPULATED,
      // the justification is fictional, so do not bounce the pipeline on it.
      const reasonLc = reason.toLowerCase()
      const emptinessClaim = /\b(empty|missing|no code|no implementation|not written|never written|wasn'?t written|absent|truncat|incomplete)\b/.test(reasonLc)
      if (emptinessClaim) {
        const implicated = new Set<string>()
        for (const s of knownArtifacts) {
          if (reasonLc.includes(s) || reasonLc.includes(s.replace(/_/g, ' '))) implicated.add(s)
        }
        // Generic "code"/"implementation" wording points at the implementation slot.
        if (/\b(code|implementation)\b/.test(reasonLc) && knownArtifacts.includes('implementation')) {
          implicated.add('implementation')
        }
        const implicatedList = [...implicated]
        const contradicted = implicatedList.length > 0
          && implicatedList.every(s => (wbGet(s) ?? '').trim().length > 0)
        if (contradicted) {
          return logRoute({
            action: 'NEXT',
            reason: `coordinator escalated citing empty/missing ${implicatedList.join(', ')}, but the workbench shows those slot(s) populated -- claim contradicted by ground truth, proceeding`,
          })
        }
      }

      if (currentStage.escalateTo) {
        return logRoute({ action: 'ESCALATE', targetAgent: currentStage.escalateTo, reason })
      }
    }

    if (upper.startsWith('REWIND')) {
      const match     = firstLine.match(/REWIND\s+([^\s\-]+(?:\s+[^\s\-]+)*?)\s*(?:--| )\s*(.+)/i)
      const stageName = match?.[1]?.trim()
      const reason    = match?.[2]?.trim() ?? 'prior stage must re-verify updated code'
      if (stageName && completedStages.includes(stageName)) {
        return logRoute({ action: 'REWIND', rewindTo: stageName, reason })
      }
      const partial = completedStages.find(s =>
        s.toLowerCase().includes((stageName ?? '').toLowerCase())
      )
      if (partial) {
        return logRoute({ action: 'REWIND', rewindTo: partial, reason })
      }
    }

    return logRoute({ action: 'NEXT', reason: 'proceeding to next stage' })
  }
}