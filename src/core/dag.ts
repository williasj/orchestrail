// -- Dependency-aware execution engine ----------------------------------------
// Builds a task graph, detects cycles, and runs tasks in dependency order
// with maximum parallelism. Tasks whose deps are satisfied run concurrently.

import type { TaskSpec, AgentResult, ExecCallbacks } from '../types/index.js'
import { stripCodeBlocks } from '../utils/text.js'

export type RunAgentFn = (spec: TaskSpec, generation: number) => Promise<AgentResult>

/**
 * Execute a set of tasks respecting their `dependsOn` relationships.
 * Tasks with no unmet deps run immediately and in parallel.
 *
 * @param runAgent      - Caller-supplied agent execution function (avoids circular import)
 * @param getGeneration - Returns current global generation; tasks abort if stale
 */
export async function executeWithDeps(
  specs:         TaskSpec[],
  callbacks:     ExecCallbacks,
  generation:    number,
  runAgent:      RunAgentFn,
  getGeneration: () => number,
): Promise<AgentResult[]> {
  const specMap = new Map<string, TaskSpec>(specs.map(s => [s.title, s]))

  // Strip unknown deps and warn -- unknown dep titles are coordinator hallucinations
  for (const spec of specs) {
    const unknown = spec.dependsOn.filter(d => !specMap.has(d))
    if (unknown.length > 0) {
      console.warn(`[deps] "${spec.title}" has unknown dependencies ${JSON.stringify(unknown)} -- dropping them`)
      spec.dependsOn = spec.dependsOn.filter(d => specMap.has(d))
    }
  }

  // Cycle detection via DFS -- throws if a cycle is found
  function detectCycles() {
    const WHITE = 0, GRAY = 1, BLACK = 2
    const color = new Map<string, number>(specs.map(s => [s.title, WHITE]))
    function visit(title: string, stack: string[]) {
      color.set(title, GRAY)
      for (const dep of specMap.get(title)!.dependsOn) {
        if (color.get(dep) === GRAY) {
          throw new Error(`Dependency cycle detected: ${[...stack, title, dep].join(' -> ')}`)
        }
        if (color.get(dep) === WHITE) visit(dep, [...stack, title])
      }
      color.set(title, BLACK)
    }
    for (const spec of specs) {
      if (color.get(spec.title) === WHITE) visit(spec.title, [])
    }
  }
  detectCycles()

  // Memoised promise per task title -- each task awaits its deps then runs
  const resultPromises = new Map<string, Promise<AgentResult>>()
  function getOrCreate(title: string): Promise<AgentResult> {
    if (resultPromises.has(title)) return resultPromises.get(title)!
    const spec = specMap.get(title)!
    const p: Promise<AgentResult> = (async () => {
      // Abort immediately if already superseded before we even start
      if (generation !== getGeneration()) {
        return { assignee: spec.assignee, title: spec.title, output: '(aborted — superseded)', success: false }
      }
      // Signal waiting state before blocking
      if (spec.dependsOn.length > 0) {
        callbacks.onWaiting(spec, spec.dependsOn)
      }
      // Block until all deps resolve (in parallel among themselves)
      const depResults = await Promise.all(spec.dependsOn.map(dep => getOrCreate(dep)))
      // Inject successful dep outputs into this task's description
      const successfulDeps = depResults.filter(r => r.success)
      let enrichedDescription = spec.description
      if (successfulDeps.length > 0) {
        const depContext = successfulDeps
          .map(r => `### ${r.title} (${r.assignee})\n${stripCodeBlocks(r.output)}`)
          .join('\n\n')
        enrichedDescription =
          `${spec.description}\n\n---\n## Context from prior tasks\n\n${depContext}`
      }
      callbacks.onStart(spec)
      const result = await runAgent({ ...spec, description: enrichedDescription }, generation)
      callbacks.onComplete(result)
      return result
    })()
    resultPromises.set(title, p)
    return p
  }

  // Kick off everything -- tasks with no deps start immediately, others wait
  const settled = await Promise.allSettled(specs.map(s => getOrCreate(s.title)))
  return settled
    .filter((r): r is PromiseFulfilledResult<AgentResult> => r.status === 'fulfilled')
    .map(r => r.value)
}

/**
 * Tasks with no `dependsOn` receive no context from prior agents. Inject the
 * full goal (which contains all user data) so root agents are not working blind.
 */
export function injectGoalIntoRootTasks(specs: TaskSpec[], fullGoal: string): void {
  for (const spec of specs) {
    if (spec.dependsOn.length === 0) {
      spec.description = `## Goal and data\n\n${fullGoal}\n\n## Your task\n\n${spec.description}`
    }
  }
}
