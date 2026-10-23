// -- Cheap mode (pure leaf) ------------------------------------------------------
// Pure, dependency-free constants + stage builder for the user-selectable
// "cheap mode" (frontier item 17 / B3): a single-agent run with lower reasoning
// effort, as opposed to the full multi-stage Agentic Team pipeline. No I/O, no
// LLM -- unit-testable in isolation (cheapmode.check.mjs), following the
// terminal.ts / budget.ts leaf pattern.
//
// Semantics (locked with the user):
//   - Cheap mode is a MANUAL user toggle, distinct from the deferred automatic
//     role-collapse (item 13). When on, the run is a single senior-engineer stage
//     (no decompose, no coordinator routing, no escalation/rewind) and the agent
//     runs with a lower reasoning effort.
//   - The reasoning effort is only forwarded to local/custom providers (Ollama's
//     OpenAI endpoint honours reasoning_effort; OpenAI/Anthropic reject it) --
//     that gating lives in agent.ts runAgent, not here. This leaf only names the
//     effort and the stage.

import type { PipelineStage } from '../types/index.js'

// The single agent that performs the whole job in cheap mode.
export const CHEAP_MODE_AGENT = 'senior-engineer'

// The reasoning effort cheap mode requests (lower than the default). 'low' is
// honoured by Ollama's OpenAI-compatible endpoint for thinking models.
export const CHEAP_MODE_REASONING_EFFORT = 'low'

// Build the single-stage pipeline cheap mode runs. One senior-engineer stage that
// owns the whole goal. maxRetries is kept small (2) so a stage that fails its own
// contract gets a bounded self-correction rather than burning the full escalation
// budget -- cheap mode trades robustness for cost. The stage name 'Implementation'
// matches the senior-engineer's canonical stageName so workbench slot naming
// (stage.name -> 'implementation') stays aligned with a normal run.
export function cheapModeStage(goal: string): PipelineStage {
  return {
    name:        'Implementation',
    assignee:    CHEAP_MODE_AGENT,
    description:
      'Produce the complete deliverable for the goal above in a single pass. ' +
      'Write the implementation to the `implementation` workbench slot, verify it by ' +
      'running it where applicable, and finish with a concise summary of what you built.',
    maxRetries:  2,
  }
}
