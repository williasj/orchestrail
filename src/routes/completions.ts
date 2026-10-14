// -- Chat completions route ----------------------------------------------------
// Implements OpenAI-compatible /v1/chat/completions (and the /chat/completions
// alias used by OpenWebUI's External connection mode).

import { AsyncLocalStorage } from 'node:async_hooks'
import { v4 as uuidv4 }     from 'uuid'
import type { Request, Response, Router } from 'express'
import { requireAuth } from './auth.js'
import type {
  AgentResult, ChatMessage, DecomposeResult, TaskSpec,
  UsageTotals, PipelinesUser, CoordinatorConfig, AgentLLM,
} from '../types/index.js'
import type { CoordinatorRouteFn, RehydrateFn } from '../core/pipeline.js'
import { executePipeline }     from '../core/pipeline.js'
import { executeWithDeps, injectGoalIntoRootTasks } from '../core/dag.js'
import { wbIdToConversationId } from '../core/workbench.js'
import { toolLogContextStorage, getToolLog } from '../core/tools.js'
import { touchConversation, appendMessage, getMessages } from '../core/conversation.js'
import { MODEL_ID }             from '../utils/config.js'

// Marker injected into clarification replies so follow-up turns are routed
// back through the execute-with-context phase.
const CLARIFY_MARKER               = '<!-- __CLARIFY__ -->'
const CONV_CONTEXT_ASSISTANT_LIMIT = 600  // chars per assistant turn in context block

// -- Phase detection ----------------------------------------------------------

type Phase = 'clarify' | 'execute' | 'execute-with-context'

// Build the trailing "*Agents: ...*" footer with each agent's token usage and the
// grand total. Tokens are summed by assignee (a stage that re-runs after ESCALATE
// shares its assignee, so its runs accumulate). Agents whose token delta was
// unavailable simply show no count. Order of first appearance is preserved.
function buildAgentsFooter(results: AgentResult[], grandTotal = 0): string {
  const order: string[] = []
  const byAgent = new Map<string, number>()
  for (const r of results) {
    if (!byAgent.has(r.assignee)) order.push(r.assignee)
    byAgent.set(r.assignee, (byAgent.get(r.assignee) ?? 0) + (r.tokens ?? 0))
  }
  const agentSum = [...byAgent.values()].reduce((a, b) => a + b, 0)
  // Coordinator usage = everything in the per-request accumulator that was NOT an
  // agent stage: clarify, decompose, every route, and synthesize. Derived from the
  // grand total so we don't thread a separate counter through the coordinator calls.
  const coordinator = Math.max(0, grandTotal - agentSum)
  const total = grandTotal > 0 ? grandTotal : agentSum
  const fmt   = (n: number) => n.toLocaleString('en-US')
  const parts: string[] = []
  if (coordinator > 0) parts.push(`coordinator (${fmt(coordinator)} tokens)`)
  for (const a of order) {
    const t = byAgent.get(a) ?? 0
    parts.push(t > 0 ? `${a} (${fmt(t)} tokens)` : a)
  }
  const totalSuffix = total > 0 ? ` -- total ${fmt(total)} tokens` : ''
  return `\n\n---\n*Agents: ${parts.join(', ')}${totalSuffix}*`
}

function detectPhase(messages: ChatMessage[]): Phase {
  const assistantMessages = messages.filter(m => m.role === 'assistant')
  if (assistantMessages.length === 0) return 'clarify'
  if (assistantMessages.at(-1)?.content.includes(CLARIFY_MARKER)) return 'execute-with-context'
  const clarifyMsg = assistantMessages.find(m => m.content.includes(CLARIFY_MARKER))
  if (clarifyMsg) {
    const questions = clarifyMsg.content.replace(CLARIFY_MARKER, '').trim()
    const lastUser  = messages.filter(m => m.role === 'user').at(-1)?.content ?? ''
    if (lastUser && !questions.includes(lastUser)) return 'execute'
  }
  return 'execute'
}

function buildEnrichedGoal(messages: ChatMessage[]): string {
  const allNonSystem = messages.filter(m => m.role !== 'system')
  const clarifyMsg   = allNonSystem.find(m => m.content.includes(CLARIFY_MARKER))
  if (!clarifyMsg) return allNonSystem.filter(m => m.role === 'user').at(-1)?.content ?? ''

  const clarifyIdx   = allNonSystem.indexOf(clarifyMsg)
  const questions    = clarifyMsg.content.replace(CLARIFY_MARKER, '').trim()
  const answers      = allNonSystem.slice(clarifyIdx + 1).filter(m => m.role === 'user').at(-1)?.content ?? ''
  const originalGoal = allNonSystem.slice(0, clarifyIdx).filter(m => m.role === 'user').at(-1)?.content ?? ''

  return `${originalGoal}\n\n## Clarification Q&A\n${questions}\n\nAnswers: ${answers}`
}

function buildExecuteGoal(messages: ChatMessage[]): string {
  const allNonSystem = messages.filter(m => m.role !== 'system')
  const lastUser     = allNonSystem.filter(m => m.role === 'user').at(-1)?.content ?? ''

  const priorTurns: ChatMessage[] = []
  let skipLast = true
  for (let i = allNonSystem.length - 1; i >= 0; i--) {
    const msg = allNonSystem[i]!
    if (skipLast && msg.role === 'user') { skipLast = false; continue }
    priorTurns.unshift(msg)
  }

  const recentTurns = priorTurns.slice(-6)
  if (recentTurns.length === 0) return lastUser

  const contextLines = recentTurns.map(m => {
    if (m.role === 'user') return `User: ${m.content.slice(0, 300)}`
    const cleaned   = m.content.replace(CLARIFY_MARKER, '').trim()
    const truncated = cleaned.length > CONV_CONTEXT_ASSISTANT_LIMIT
      ? cleaned.slice(0, CONV_CONTEXT_ASSISTANT_LIMIT) + '… [truncated]'
      : cleaned
    return `Assistant: ${truncated}`
  })

  return `## Prior conversation context\n${contextLines.join('\n')}\n\n## Current request\n${lastUser}`
}

function extractGoal(messages: { role: string; content: string }[]): string {
  return messages.filter(m => m.role === 'user').at(-1)?.content?.trim() ?? ''
}

// -- Deps ---------------------------------------------------------------------

export interface CompletionsDeps {
  /** Per-request usage accumulator — run() wraps each request. */
  usageStorage:     AsyncLocalStorage<UsageTotals>

  /** Bumps the global generation counter; returns current value after bump. */
  bumpGeneration:   () => number
  getGeneration:    () => number

  /** Fast LLM call for ghost/metadata requests. */
  callLLM: (
    messages: ChatMessage[],
    llm: AgentLLM,
    maxTokens: number,
    temperature: number,
  ) => Promise<string>

  getCoordinator: () => CoordinatorConfig

  runClarificationIntake: (goal: string) => Promise<
    | { decision: 'PROCEED' }
    | { decision: 'DIRECT';   answer: string }
    | { decision: 'CLARIFY';  questions: string }
  >

  decomposeGoal:   (goal: string) => Promise<DecomposeResult>
  synthesize:      (goal: string, results: AgentResult[], wbSnapshot?: Record<string, string>) => Promise<string>

  runAgent:          (spec: TaskSpec,    generation: number) => Promise<AgentResult>
  coordinatorRoute:  CoordinatorRouteFn
  rehydrateWorkbench: RehydrateFn

  reflectAndStoreMetaMemory: (
    goal: string, mode: 'pipeline' | 'dag', agents: string[], synthesis: string, results: AgentResult[], rewindCount?: number
  ) => Promise<void>
  analyzeAndStoreToolingPatterns: (runStartTs: number) => Promise<void>

  resolveConversationId: (messages: { role: string; content: string }[]) => string
  registerConvAlias:     (messages: { role: string; content: string }[], convId: string, content: string) => void
}

// -- Health signal check + self-improvement auto-spawn -------------------------
// After pipeline synthesis, check for quality signals. If any threshold is met,
// fire-and-forget a self-improvement meta-pipeline with the tool log as context.

const SELF_IMPROVE_RETRIES_THRESHOLD = 2
const SELF_IMPROVE_ESCALATION_THRESHOLD = 1

function checkHealthSignals(
  results: AgentResult[],
  wbSnapshot: Record<string, string>,
  rewindCount: number,
): { triggered: boolean; signals: string[] } {
  const signals: string[] = []

  // Rewind count threshold
  if (rewindCount >= SELF_IMPROVE_RETRIES_THRESHOLD) {
    signals.push(`rewind_count=${rewindCount}`)
  }

  // Missing required slots (implementation OR test_report absent at synthesis time)
  const expectedSlots = ['implementation', 'test_report']
  for (const slot of expectedSlots) {
    if (!wbSnapshot[slot]) signals.push(`missing_slot=${slot}`)
  }

  // Test failures in test_report slot
  const testReport = wbSnapshot['test_report'] ?? ''
  if (/failed:\s*[1-9]\d*\b/i.test(testReport) || /\bFAILED\b/.test(testReport)) {
    signals.push('test_failures_in_report')
  }

  // Any stage completed with ESCALATE status (didn't converge)
  const escalations = results.filter(r => r.completion?.status === 'ESCALATE').length
  if (escalations >= SELF_IMPROVE_ESCALATION_THRESHOLD) {
    signals.push(`escalations=${escalations}`)
  }

  return { triggered: signals.length > 0, signals }
}

async function spawnSelfImprovementIfNeeded(
  results: AgentResult[],
  wbSnapshot: Record<string, string>,
  rewindCount: number,
  conversationId: string,
  spawnFn: (goal: string) => Promise<void>,
): Promise<void> {
  const { triggered, signals } = checkHealthSignals(results, wbSnapshot, rewindCount)
  if (!triggered) return

  console.log(`[self-improve] health signals detected (${signals.join(', ')}) -- spawning meta-pipeline`)

  // Inject last 50 tool log entries as context
  const toolLogEntries = getToolLog().slice(0, 50)
  const toolLogJson = JSON.stringify(toolLogEntries, null, 0)

  const goal =
    `SELF-IMPROVEMENT ANALYSIS

` +
    `Conversation ID: ${conversationId}
` +
    `Health signals triggered: ${signals.join(', ')}

` +
    `Analyze the following tool log from the pipeline run and propose targeted improvements ` +
    `to Orchestrail's source code, agent prompts, or coordinator prompts that would address ` +
    `the observed failure patterns. Use read_source_file to read relevant files before proposing ` +
    `changes. Use propose_edit to record proposals for human review.

` +
    `TOOL LOG (last 50 entries):
${toolLogJson}`

  try {
    await spawnFn(goal)
  } catch (err) {
    console.warn(`[self-improve] meta-pipeline spawn failed: ${err}`)
  }
}

// -- Route registration -------------------------------------------------------

export function registerCompletionsRoutes(router: Router, deps: CompletionsDeps): void {
  const {
    usageStorage, bumpGeneration, getGeneration,
    callLLM, getCoordinator,
    runClarificationIntake, decomposeGoal, synthesize,
    runAgent, coordinatorRoute, rehydrateWorkbench,
    reflectAndStoreMetaMemory, analyzeAndStoreToolingPatterns,
    resolveConversationId, registerConvAlias,
  } = deps

  // OpenWebUI hits /chat/completions (no /v1 prefix) for External connections.
  // Auth middleware only covers /v1/* so the alias is intentionally unauthenticated.
  router.post(['/v1/chat/completions', '/chat/completions'], async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>

    const { messages, stream = false } = body as {
      messages: { role: string; content: string }[]
      stream?: boolean
    }
    if (!messages?.length) { res.status(400).json({ error: { message: 'No messages', type: 'invalid_request_error' } }); return }
    const goal = extractGoal(messages)
    if (!goal)  { res.status(400).json({ error: { message: 'No user message', type: 'invalid_request_error' } }); return }

    // Extract Pipelines context ------------------------------------------------
    // OpenWebUI sends chat_id and user when registered as a Pipelines connection.
    const pipelinesUser = (typeof body['user'] === 'object' && body['user'] !== null)
      ? body['user'] as PipelinesUser
      : undefined

    const conversationId: string =
      (typeof body['chat_id']    === 'string' && body['chat_id'])    ||
      (typeof body['session_id'] === 'string' && body['session_id']) ||
      resolveConversationId(messages)

    console.log('[request] user=' + (pipelinesUser ? pipelinesUser.email + ' (' + pipelinesUser.role + ')' : '—') + ' conv=' + conversationId + ' stream=' + stream + ' stream_options=' + JSON.stringify(body['stream_options'] ?? null))

    // Persist conversation meta immediately so it appears in the logs list
    // while the run is in progress, enabling live tool-log polling.
    const userId = pipelinesUser?.email ?? '_anonymous'

    const systemMessage = messages.find(m => m.role === 'system')?.content
    const completionId  = `chatcmpl-${uuidv4()}`
    const userPrefix    = pipelinesUser ? `[Requested by: ${pipelinesUser.name}]\n\n` : ''
    const baseGoal      = userPrefix + (systemMessage ? `Context: ${systemMessage}\n\nGoal: ${goal}` : goal)

    // Ghost request filter ------------------------------------------------------
    // OpenWebUI sends background metadata requests (title gen, tag gen, follow-up
    // suggestions) starting with "### Task:". Route them directly to the LLM
    // WITHOUT persisting a conversation record.
    if (goal.startsWith('### Task:')) {
      const coordLLM  = getCoordinator().llm
      const ghostReply = (await callLLM([{ role: 'user', content: goal }], coordLLM, 256, 0)).trim() || 'General'
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no')
        res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL_ID, choices: [{ index: 0, delta: { content: ghostReply }, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL_ID, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        res.json({ id: completionId, object: 'chat.completion', model: MODEL_ID, created: Math.floor(Date.now() / 1000), choices: [{ index: 0, message: { role: 'assistant', content: ghostReply }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })
      }
      return
    }

    // Real conversation — persist meta now so it appears in logs during the run
    touchConversation(userId, conversationId, goal)
    // Persist the user's message immediately so history survives regardless of pipeline outcome
    appendMessage(userId, conversationId, 'user', goal)

    const phase      = detectPhase(messages as ChatMessage[])
    const generation = bumpGeneration()

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')

      let responseBuffer = ''
      const sendChunk = (content: string) => {
        responseBuffer += content
        res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL_ID, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`)
      }
      const sendDone = () => {
        const u = usageStorage.getStore() ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        const ts = Math.floor(Date.now() / 1000)
        // Send usage on the stop chunk — OpenWebUI reads it here when stream_options not set
        res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: ts, model: MODEL_ID, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: u })}\n\n`)
        // Also send usage-only chunk for OpenWebUI versions that expect it separately
        res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: ts, model: MODEL_ID, choices: [], usage: u })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      }

      await toolLogContextStorage.run(
        { userId: pipelinesUser?.email ?? '', conversationId },
        () => usageStorage.run({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, async () => {
        try {
          if (phase === 'clarify') {
            sendChunk('> **[coordinator]** reviewing goal...\n')
            const intake = await runClarificationIntake(baseGoal)
            if (intake.decision === 'DIRECT') {
              sendChunk(intake.answer); sendDone(); return
            }
            if (intake.decision === 'CLARIFY') {
              sendChunk(`> **[coordinator]** a few questions before the team starts:\n\n`)
              sendChunk(`${intake.questions}\n${CLARIFY_MARKER}`)
              sendDone(); return
            }
            sendChunk('> **[coordinator]** goal is clear, decomposing...\n')
          }

          const fullGoal = phase === 'execute-with-context'
            ? buildEnrichedGoal(messages as ChatMessage[])
            : phase === 'execute'
              ? buildExecuteGoal(messages as ChatMessage[])
              : baseGoal

          sendChunk('> **[coordinator]** decomposing goal...\n')
          const runStartTs = Date.now()
          const decomposed = await decomposeGoal(fullGoal)

          let completedResults: AgentResult[]
          let pipelineWbSnapshot: Record<string, string> = {}
          let pipelineRewindCount = 0

          if (decomposed.mode === 'pipeline') {
            sendChunk(`> **[coordinator]** pipeline — ${decomposed.stages.length} stages\n\n`)
            const pr = await executePipeline(decomposed.stages, fullGoal, generation, {
              onStageStart: (stage, attempt) => {
                sendChunk(`> **[${stage.assignee}]** ${stage.name}${attempt > 0 ? ` (retry ${attempt})` : ''}...\n`)
              },
              onStageDone: (stage, result, status) => {
                const icon = status === 'escalate' ? '⚠' : '✓'
                sendChunk(`> **[done]** ${stage.assignee}: ${stage.name} ${icon}\n`)
                sendChunk(`\n<details>\n<summary>${stage.assignee} — ${stage.name}${status === 'escalate' ? ' ⚠' : ''}</summary>\n\n${result.output}\n\n</details>\n`)
              },
              onFixStart:  (_stage, fixAgent, reason) => { sendChunk(`> **[${fixAgent}]** fixing ${_stage.name}: ${reason.slice(0, 80)}...\n`) },
              onFixDone:   (fixAgent) => { sendChunk(`> **[done]** ${fixAgent}: fix applied\n`) },
              onMaxRetries: (stage)   => { sendChunk(`> **[⚠ max retries]** ${stage.name} — continuing\n`) },
              onCoordinatorRoute: (decision) => {
                if (decision.action === 'ESCALATE') sendChunk(`> **[coordinator]** escalating to ${decision.targetAgent}: ${decision.reason}\n`)
                else if (decision.action === 'SYNTHESIZE') sendChunk(`> **[coordinator]** work complete — synthesizing early\n`)
              },
              onRewind: (_from, toStage, reason) => { sendChunk(`> **[coordinator]** rewinding to ${toStage}: ${reason}\n`) },
            }, { runAgent, coordinatorRoute, rehydrateWorkbench, getGeneration }, conversationId)
            completedResults    = pr.results
            pipelineWbSnapshot  = pr.wbSnapshot
            pipelineRewindCount = pr.rewindCount
          } else {
            injectGoalIntoRootTasks(decomposed.specs, fullGoal)
            wbIdToConversationId.set('default', conversationId)
            sendChunk(`> **[coordinator]** ${decomposed.specs.length} task${decomposed.specs.length !== 1 ? 's' : ''} assigned\n\n`)
            completedResults = await executeWithDeps(decomposed.specs, {
              onWaiting:  (spec, waitingFor) => { sendChunk(`> **[${spec.assignee}]** waiting for: ${waitingFor.join(', ')}...\n`) },
              onStart:    (spec)             => { sendChunk(`> **[${spec.assignee}]** working on: ${spec.title}...\n`) },
              onComplete: (result)           => {
                sendChunk(`> **[done]** ${result.assignee}: ${result.title}\n`)
                if (result.success && decomposed.specs.length > 1) {
                  sendChunk(`\n<details>\n<summary>${result.assignee} — ${result.title}</summary>\n\n${result.output}\n\n</details>\n`)
                }
              },
            }, generation, runAgent, getGeneration)
          }

          sendChunk('\n')
          if (completedResults.length === 1 && completedResults[0]) {
            const solo = completedResults[0]
            sendChunk(`---\n\n${solo.output}`)
            sendChunk(`\n\n---\n*Agent: ${solo.assignee}*`)
          } else {
            sendChunk('> **[coordinator]** synthesizing...\n\n---\n\n')
            const synthesis = await synthesize(fullGoal, completedResults, pipelineWbSnapshot)
            sendChunk(synthesis)
            sendChunk(buildAgentsFooter(completedResults, usageStorage.getStore()?.total_tokens ?? 0))
            reflectAndStoreMetaMemory(fullGoal, decomposed.mode, [...new Set(completedResults.map(r => r.assignee))], synthesis, completedResults, pipelineRewindCount).catch(() => {})
            analyzeAndStoreToolingPatterns(runStartTs).catch(() => {})
            // Health-signal check: fire-and-forget self-improvement spawn if quality signals detected
            spawnSelfImprovementIfNeeded(completedResults, pipelineWbSnapshot, pipelineRewindCount, conversationId,
              async (goal) => {
                const gen = getGeneration()
                await runAgent({ title: 'Self-Improvement Analysis', description: goal, assignee: 'self-improvement', dependsOn: [] }, gen)
              }
            ).catch(() => {})
          }

          registerConvAlias(messages, conversationId, responseBuffer)
          appendMessage(userId, conversationId, 'assistant', responseBuffer)
          sendDone()
          bumpGeneration() // abort any agents still running after response
        } catch (err) {
          sendChunk(`\n\n**Error:** ${err instanceof Error ? err.message : String(err)}`)
          sendDone()
          bumpGeneration()
        }
      })) // usageStorage.run + toolLogContextStorage.run

    } else {
      // Non-streaming path
      await toolLogContextStorage.run(
        { userId: pipelinesUser?.email ?? '', conversationId },
        () => usageStorage.run({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, async () => {
        try {
          if (phase === 'clarify') {
            const intake = await runClarificationIntake(baseGoal)
            if (intake.decision === 'DIRECT') {
              res.json({ id: completionId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL_ID, choices: [{ index: 0, message: { role: 'assistant', content: intake.answer }, finish_reason: 'stop' }], usage: usageStorage.getStore() ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })
              return
            }
            if (intake.decision === 'CLARIFY') {
              const content = `Before the team starts, a few questions:\n\n${intake.questions}\n${CLARIFY_MARKER}`
              res.json({ id: completionId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL_ID, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: usageStorage.getStore() ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })
              return
            }
          }

          const fullGoal = phase === 'execute-with-context'
            ? buildEnrichedGoal(messages as ChatMessage[])
            : phase === 'execute'
              ? buildExecuteGoal(messages as ChatMessage[])
              : baseGoal

          const runStartTs = Date.now()
          const decomposed = await decomposeGoal(fullGoal)
          let results: AgentResult[]
          let nsWbSnapshot:    Record<string, string> = {}
          let nsRewindCount  = 0

          if (decomposed.mode === 'pipeline') {
            const pr = await executePipeline(decomposed.stages, fullGoal, generation, {
              onStageStart:       (stage, attempt) => { console.log(`[pipeline] ${stage.assignee}: ${stage.name}${attempt > 0 ? ` retry ${attempt}` : ''}`) },
              onStageDone:        (stage, _r, status) => { console.log(`[done] ${stage.assignee}: ${stage.name} ${status}`) },
              onFixStart:         (_s, fixAgent, reason) => { console.log(`[fix] ${fixAgent}: ${reason.slice(0, 60)}`) },
              onFixDone:          (fixAgent) => { console.log(`[fix done] ${fixAgent}`) },
              onMaxRetries:       (stage) => { console.log(`[max retries] ${stage.name}`) },
              onCoordinatorRoute: (decision) => { console.log(`[coordinator] ${decision.action}${decision.targetAgent ? ' → ' + decision.targetAgent : ''}${decision.rewindTo ? ' → ' + decision.rewindTo : ''}: ${decision.reason}`) },
              onRewind:           (fromStage, toStage, reason) => { console.log(`[rewind] ${fromStage} → ${toStage}: ${reason}`) },
            }, { runAgent, coordinatorRoute, rehydrateWorkbench, getGeneration }, conversationId)
            results        = pr.results
            nsWbSnapshot   = pr.wbSnapshot
            nsRewindCount  = pr.rewindCount
          } else {
            injectGoalIntoRootTasks(decomposed.specs, fullGoal)
            wbIdToConversationId.set('default', conversationId)
            results = await executeWithDeps(decomposed.specs, {
              onWaiting:  (spec, waitingFor) => { console.log(`[deps] ${spec.assignee} waiting for: ${waitingFor.join(', ')}`) },
              onStart:    (spec)             => { console.log(`[start] ${spec.assignee}: ${spec.title}`) },
              onComplete: (result)           => { console.log(`[done]  ${result.assignee}: ${result.title}`) },
            }, generation, runAgent, getGeneration)
          }

          let content: string
          if (results.length === 1 && results[0]) {
            content = results[0].output + `\n\n---\n*Agent: ${results[0].assignee}*`
          } else {
            const synthesis = await synthesize(fullGoal, results, nsWbSnapshot)
            reflectAndStoreMetaMemory(fullGoal, decomposed.mode, [...new Set(results.map(r => r.assignee))], synthesis, results, nsRewindCount).catch(() => {})
            analyzeAndStoreToolingPatterns(runStartTs).catch(() => {})
            spawnSelfImprovementIfNeeded(results, nsWbSnapshot, nsRewindCount, conversationId,
              async (goal) => {
                const gen = getGeneration()
                await runAgent({ title: 'Self-Improvement Analysis', description: goal, assignee: 'self-improvement', dependsOn: [] }, gen)
              }
            ).catch(() => {})
            content = synthesis + buildAgentsFooter(results, usageStorage.getStore()?.total_tokens ?? 0)
          }

          registerConvAlias(messages, conversationId, content)
          appendMessage(userId, conversationId, 'assistant', content)
          res.json({ id: completionId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL_ID, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: usageStorage.getStore() ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })
        } catch (err) {
          res.status(500).json({ error: { message: err instanceof Error ? err.message :String(err), type: 'server_error' } })
        }
      })) // usageStorage.run + toolLogContextStorage.run
    }
  })

  // -- /api/chat ---------------------------------------------------------------
  // Native chat endpoint — auth-gated, no OpenWebUI dependency.
  // Request:  POST { message: string, conversationId?: string }
  // Response: SSE stream of { type: 'chunk'|'done'|'error', content?: string }
  //
  // conversationId is optional on first turn (server assigns one) and required
  // on follow-up turns to reconnect context. History is loaded from disk so
  // context persists across server restarts.

  router.post('/api/chat', requireAuth, async (req: Request, res: Response) => {
    const { message, conversationId: clientConvId } = req.body as {
      message?: string
      conversationId?: string
    }
    if (!message?.trim()) { res.status(400).json({ error: 'message is required' }); return }

    const userId = req.auth!.email
    const goal   = message.trim()

    // Resolve conversation ID — use client-supplied ID if valid, else generate
    const conversationId = clientConvId || `conv-${uuidv4().replace(/-/g, '').slice(0, 8)}`

    // Build messages array from disk history for pipeline context
    const history = getMessages(userId, conversationId)
    const messages: { role: string; content: string }[] = history.map(m => ({
      role:    m.role,
      content: m.content,
    }))
    // Append current user message (not yet persisted)
    messages.push({ role: 'user', content: goal })

    // Persist meta + user message immediately
    touchConversation(userId, conversationId, goal)
    appendMessage(userId, conversationId, 'user', goal)

    const phase      = detectPhase(messages as ChatMessage[])
    const generation = bumpGeneration()
    const runId      = uuidv4()

    // SSE helpers
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    // Send conversationId immediately so the client can store it for follow-up turns
    res.write(`data: ${JSON.stringify({ type: 'init', conversationId, runId })}\n\n`)

    let responseBuffer = ''
    const sendChunk = (content: string) => {
      responseBuffer += content
      res.write(`data: ${JSON.stringify({ type: 'chunk', content })}\n\n`)
    }
    const sendDone = () => {
      const u = usageStorage.getStore() ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      res.write(`data: ${JSON.stringify({ type: 'done', usage: u })}\n\n`)
      res.end()
    }
    const sendError = (msg: string) => {
      res.write(`data: ${JSON.stringify({ type: 'error', content: msg })}\n\n`)
      res.end()
    }

    await toolLogContextStorage.run(
      { userId, conversationId },
      () => usageStorage.run({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, async () => {
      try {
        // Clarification phase
        if (phase === 'clarify') {
          sendChunk('> **[coordinator]** reviewing goal...\n')
          const intake = await runClarificationIntake(goal)
          if (intake.decision === 'DIRECT') {
            sendChunk(intake.answer)
            appendMessage(userId, conversationId, 'assistant', intake.answer)
            sendDone(); return
          }
          if (intake.decision === 'CLARIFY') {
            const clarifyContent = `> **[coordinator]** a few questions before the team starts:\n\n${intake.questions}\n${CLARIFY_MARKER}`
            sendChunk(clarifyContent)
            appendMessage(userId, conversationId, 'assistant', clarifyContent)
            sendDone(); return
          }
          sendChunk('> **[coordinator]** goal is clear, decomposing...\n')
        }

        const fullGoal = phase === 'execute-with-context'
          ? buildEnrichedGoal(messages as ChatMessage[])
          : phase === 'execute'
            ? buildExecuteGoal(messages as ChatMessage[])
            : goal

        sendChunk('> **[coordinator]** decomposing goal...\n')
        const runStartTs = Date.now()
        const decomposed = await decomposeGoal(fullGoal)

        let completedResults: AgentResult[]
        let wbSnapshot: Record<string, string> = {}
        let rewindCount = 0

        if (decomposed.mode === 'pipeline') {
          sendChunk(`> **[coordinator]** pipeline — ${decomposed.stages.length} stages\n\n`)
          const pr = await executePipeline(decomposed.stages, fullGoal, generation, {
            onStageStart: (stage, attempt) => {
              sendChunk(`> **[${stage.assignee}]** ${stage.name}${attempt > 0 ? ` (retry ${attempt})` : ''}...\n`)
            },
            onStageDone: (stage, result, status) => {
              const icon = status === 'escalate' ? '⚠' : '✓'
              sendChunk(`> **[done]** ${stage.assignee}: ${stage.name} ${icon}\n`)
              sendChunk(`\n<details>\n<summary>${stage.assignee} — ${stage.name}${status === 'escalate' ? ' ⚠' : ''}</summary>\n\n${result.output}\n\n</details>\n`)
            },
            onFixStart:  (_stage, fixAgent, reason) => { sendChunk(`> **[${fixAgent}]** fixing ${_stage.name}: ${reason.slice(0, 80)}...\n`) },
            onFixDone:   (fixAgent) => { sendChunk(`> **[done]** ${fixAgent}: fix applied\n`) },
            onMaxRetries: (stage) => { sendChunk(`> **[⚠ max retries]** ${stage.name} — continuing\n`) },
            onCoordinatorRoute: (decision) => {
              if (decision.action === 'ESCALATE') sendChunk(`> **[coordinator]** escalating to ${decision.targetAgent}: ${decision.reason}\n`)
              else if (decision.action === 'SYNTHESIZE') sendChunk(`> **[coordinator]** work complete — synthesizing early\n`)
            },
            onRewind: (_from, toStage, reason) => { sendChunk(`> **[coordinator]** rewinding to ${toStage}: ${reason}\n`) },
          }, { runAgent, coordinatorRoute, rehydrateWorkbench, getGeneration }, conversationId)
          completedResults = pr.results
          wbSnapshot       = pr.wbSnapshot
          rewindCount      = pr.rewindCount
        } else {
          injectGoalIntoRootTasks(decomposed.specs, fullGoal)
          wbIdToConversationId.set('default', conversationId)
          sendChunk(`> **[coordinator]** ${decomposed.specs.length} task${decomposed.specs.length !== 1 ? 's' : ''} assigned\n\n`)
          completedResults = await executeWithDeps(decomposed.specs, {
            onWaiting:  (spec, waitingFor) => { sendChunk(`> **[${spec.assignee}]** waiting for: ${waitingFor.join(', ')}...\n`) },
            onStart:    (spec)             => { sendChunk(`> **[${spec.assignee}]** working on: ${spec.title}...\n`) },
            onComplete: (result)           => {
              sendChunk(`> **[done]** ${result.assignee}: ${result.title}\n`)
              if (result.success && decomposed.specs.length > 1) {
                sendChunk(`\n<details>\n<summary>${result.assignee} — ${result.title}</summary>\n\n${result.output}\n\n</details>\n`)
              }
            },
          }, generation, runAgent, getGeneration)
        }

        sendChunk('\n')
        if (completedResults.length === 1 && completedResults[0]) {
          const solo = completedResults[0]
          sendChunk(`---\n\n${solo.output}`)
          sendChunk(`\n\n---\n*Agent: ${solo.assignee}*`)
        } else {
          sendChunk('> **[coordinator]** synthesizing...\n\n---\n\n')
          const synthesis = await synthesize(fullGoal, completedResults, wbSnapshot)
          sendChunk(synthesis)
          sendChunk(buildAgentsFooter(completedResults, usageStorage.getStore()?.total_tokens ?? 0))
          reflectAndStoreMetaMemory(fullGoal, decomposed.mode, [...new Set(completedResults.map(r => r.assignee))], synthesis, completedResults, rewindCount).catch(() => {})
          analyzeAndStoreToolingPatterns(runStartTs).catch(() => {})
          spawnSelfImprovementIfNeeded(completedResults, wbSnapshot, rewindCount, conversationId,
            async (siGoal) => {
              const gen = getGeneration()
              await runAgent({ title: 'Self-Improvement Analysis', description: siGoal, assignee: 'self-improvement', dependsOn: [] }, gen)
            }
          ).catch(() => {})
        }

        appendMessage(userId, conversationId, 'assistant', responseBuffer)
        sendDone()
        bumpGeneration()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        sendError(msg)
        bumpGeneration()
      }
    })) // usageStorage.run + toolLogContextStorage.run
  })
}
