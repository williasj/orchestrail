// -- Task decomposition --------------------------------------------------------
// Parses LLM output into pipeline stages or DAG task specs,
// then orchestrates the full decompose-goal flow.

import { cols } from '../utils/config.js'
import { extractJsonText } from '../utils/text.js'
import { memoryEnabled, qdrantSearch } from './memory.js'
import { callCoordinatorLLM } from './llm.js'
import { coordinatorSystem } from './prompts.js'
import { appendToolLog } from './tools.js'
import type {
  TeamAgent, CoordinatorConfig,
  TaskSpec, PipelineStage, DecomposeResult,
} from '../types/index.js'

// -- Module init ---------------------------------------------------------------

type DecomposeDeps = {
  getAgents:      () => TeamAgent[]
  getCoordinator: () => CoordinatorConfig
}

let _deps: DecomposeDeps | null = null

export function initDecompose(deps: DecomposeDeps): void {
  _deps = deps
}

// Agents available for normal goal decomposition.
// self-improvement is a meta-agent and must never appear in a regular pipeline
// or DAG -- it is spawned explicitly by the health-signal check post-synthesis.
const META_AGENTS = new Set(['self-improvement'])

function agents():      TeamAgent[]      { return (_deps?.getAgents() ?? []).filter(a => !META_AGENTS.has(a.name)) }
function coordinator(): CoordinatorConfig { return _deps?.getCoordinator() ?? ({} as CoordinatorConfig) }

function pipelineAgents(): TeamAgent[] {
  return [...agents()].sort((a, b) => {
    const oa = a.order ?? Infinity
    const ob = b.order ?? Infinity
    return oa - ob
  })
}

// -- Parsers -------------------------------------------------------------------

function parseTaskSpecs(llmOutput: string): TaskSpec[] | null {
  const text = extractJsonText(llmOutput)
  const arrayMatch = text.match(/\[[\s\S]*\]/)
  if (!arrayMatch) return null

  try {
    const items: unknown = JSON.parse(arrayMatch[0])
    if (!Array.isArray(items) || items.length === 0) return null

    const agentList = agents()
    const specs: TaskSpec[] = []
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue
      const obj = item as Record<string, unknown>

      const title    = String(obj['title'] ?? obj['task'] ?? obj['name'] ?? '').trim()
      const assignee = String(obj['assignee'] ?? obj['agent'] ?? agentList[0]!.name).trim()
      if (!title || !assignee) continue

      const rawDeps = obj['dependsOn'] ?? obj['depends_on']
      specs.push({
        title,
        description: String(obj['description'] ?? obj['task'] ?? title),
        assignee,
        dependsOn: Array.isArray(rawDeps)
          ? rawDeps.filter((d): d is string => typeof d === 'string')
          : [],
      })
    }

    if (specs.length === 0) return null

    if (specs.length > 1) {
      const assignees = new Set(specs.map(s => s.assignee))
      if (assignees.size === 1) {
        console.warn(`[decompose] All ${specs.length} tasks assigned to "${[...assignees][0]}" -- possible coordinator hallucination, proceeding`)
      }
    }

    return specs
  } catch {
    return null
  }
}

function findClosestAgent(name: string): string {
  const agentList = agents()
  const exact = agentList.find(a => a.name === name)
  if (exact) return exact.name
  const ci = agentList.find(a => a.name.toLowerCase() === name.toLowerCase())
  if (ci) return ci.name
  const sub = agentList.find(a => a.name.includes(name) || name.includes(a.name))
  if (sub) return sub.name
  return agentList[0]?.name ?? name
}

function parsePipelineSpec(llmOutput: string): PipelineStage[] | null {
  const text = extractJsonText(llmOutput)
  const objectMatch = text.match(/\{[\s\S]*\}/)
  if (!objectMatch) return null

  try {
    const parsed: unknown = JSON.parse(objectMatch[0])
    if (typeof parsed !== 'object' || parsed === null) return null

    const obj = parsed as Record<string, unknown>
    if (obj['mode'] !== 'pipeline') return null
    if (!Array.isArray(obj['stages']) || (obj['stages'] as unknown[]).length === 0) return null

    const agentList = agents()
    const stages: PipelineStage[] = (obj['stages'] as Record<string, unknown>[]).map(s => ({
      name:        String(s['name']        ?? 'Stage'),
      assignee:    findClosestAgent(String(s['assignee'] ?? agentList[0]!.name)),
      description: String(s['description'] ?? ''),
      escalateTo:  s['escalateTo'] ? findClosestAgent(String(s['escalateTo'])) : undefined,
      maxRetries:  typeof s['maxRetries'] === 'number' ? s['maxRetries'] : 3,
    }))

    // Default missing escalateTo to the implementer (order:2 agent, i.e. senior-engineer).
    const implementer = (agentList.find(a => a.order === 2) ?? agentList[1])?.name
    if (implementer) {
      for (const stage of stages) {
        if (!stage.escalateTo && stage.assignee !== implementer) {
          stage.escalateTo = implementer
          console.log(`[pipeline] defaulted escalateTo="${implementer}" for stage "${stage.name}"`)
        }
      }
    }

    return stages
  } catch {
    return null
  }
}

// -- decomposeGoal -------------------------------------------------------------

export async function decomposeGoal(goal: string): Promise<DecomposeResult> {
  const t0 = Date.now()

  // Inject similar past patterns from institutional memory
  let pastPatternsBlock = ''
  if (memoryEnabled()) {
    try {
      const hits = await qdrantSearch(cols.meta, goal, 3)
      if (hits.length > 0) {
        const lines = hits.map((h, i) => {
          const p = h.payload as { goal?: string; mode?: string; agents?: string[]; reflection?: string }
          return `${i + 1}. Goal: "${String(p.goal ?? '').slice(0, 120)}" | Mode: ${p.mode ?? '?'} | Agents: ${(p.agents ?? []).join(', ')}\n   Reflection: ${String(p.reflection ?? '').slice(0, 200)}`
        })
        pastPatternsBlock = '\n\n## Patterns from similar past goals\n' + lines.join('\n')
      }
    } catch { /* non-fatal */ }
  }

  const systemPrompt = coordinatorSystem(() => agents(), coordinator) + pastPatternsBlock
  const raw = await callCoordinatorLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: `Decompose this goal. Use PIPELINE mode for any coding or implementation task.\n\nGoal: ${goal}\n\nRespond ONLY with JSON in a \`\`\`json code fence.` },
  ], 8192)   // thinking + JSON: 2048 could truncate on larger goals
  const durationMs = Date.now() - t0

  // Try pipeline first
  const stages = parsePipelineSpec(raw)
  if (stages && stages.length > 0) {
    const ordered = pipelineAgents()
    stages.forEach((stage, i) => {
      const expected = ordered[i]
      if (expected && stage.assignee !== expected.name) {
        console.warn(`[pipeline] Stage ${i} had assignee "${stage.assignee}", corrected to "${expected.name}" per pipeline order`)
        stage.assignee = expected.name
      }
      // Canonicalize the stage NAME to the role's stageName, regardless of whether the
      // assignee needed correcting. The decompose model sometimes emits stage names out
      // of role order (e.g. "Review" on the test stage and "Testing" on the review
      // stage). Pipeline position == role, so the name must follow the role rather than
      // the model's free text -- otherwise name-keyed logic (rewind targeting, slot
      // naming) and the agent's task framing get scrambled, and a "Testing"-named review
      // stage hands test-execution instructions to an agent that cannot execute.
      if (expected?.stageName && stage.name !== expected.stageName) {
        console.warn(`[pipeline] Stage ${i} name "${stage.name}" -> "${expected.stageName}" per role`)
        stage.name = expected.stageName
      }
    })
    appendToolLog({
      ts: Date.now(), agent: 'coordinator', tool: 'decompose',
      args: { goal: goal.slice(0, 500) },
      result: JSON.stringify({
        mode: 'pipeline',
        stages: stages.map(s => ({ name: s.name, assignee: s.assignee })),
      }),
      ok: true, durationMs,
    })
    return { mode: 'pipeline', stages }
  }

  // Fall back to DAG
  const specs = parseTaskSpecs(raw)
  if (specs && specs.length > 0) {
    appendToolLog({
      ts: Date.now(), agent: 'coordinator', tool: 'decompose',
      args: { goal: goal.slice(0, 500) },
      result: JSON.stringify({
        mode: 'dag',
        tasks: specs.map(s => ({ title: s.title, assignee: s.assignee })),
      }),
      ok: true, durationMs,
    })
    return { mode: 'dag', specs }
  }

  // Last resort — one task per agent
  const agentList = agents()
  const fallbackSpecs = agentList.map(a => ({
    title:       `${a.name}: ${goal.slice(0, 60)}`,
    description: goal,
    assignee:    a.name,
    dependsOn:   [],
  }))
  appendToolLog({
    ts: Date.now(), agent: 'coordinator', tool: 'decompose',
    args: { goal: goal.slice(0, 500) },
    result: JSON.stringify({ mode: 'dag', note: 'fallback — one task per agent', tasks: fallbackSpecs.map(s => s.assignee) }),
    ok: false, durationMs,
  })
  return { mode: 'dag', specs: fallbackSpecs }
}
