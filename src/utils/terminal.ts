// -- Terminal-signal & state-transition validation -----------------------------
// Pure, dependency-free helpers shared by the agent finalization gate
// (core/agent.ts) and the pipeline executor (core/pipeline.ts). A pipeline
// stage's terminal signal is the complete_stage call itself; these helpers
// define what happens when that signal is missing or malformed, and which
// coordinator decisions are well-formed. Kept in a leaf module (types only)
// so they can be unit-tested standalone (terminal.check.mjs).

import type { StageCompletion, CoordinatorDecision } from '../types/index.js'

/**
 * The canonical escalation reason for a stage that ended without calling
 * complete_stage. Leads with the greppable `no_terminal_signal` token and
 * tells the agent exactly what to do on the re-run.
 */
export const NO_TERMINAL_SIGNAL_REASON =
  'no_terminal_signal: the stage ended without calling complete_stage, which is the required terminal signal for a pipeline stage. '
  + 'Call complete_stage now -- status DONE if the work is done, ESCALATE if a specific defect blocks the next stage.'

/**
 * Builds the synthesized completion for a pipeline stage that ended WITHOUT
 * calling complete_stage (plain-text stop or exhausted tool rounds).
 *
 * The stage is ALWAYS escalated -- even when the finalization checks (required
 * slots / verified execution) happen to pass. A missing terminal signal is
 * itself the failure: defaulting such a stage to DONE is the "silent quality
 * leak" where a stage advances without ever signalling completion. The
 * optional `finalReason` (from the finalization checks) is appended so the
 * re-run also gets the concrete complaint when there is one.
 *
 * `selfContract: true` routes the re-run back to the SAME stage (bounded by
 * maxRetries) instead of summoning another agent -- the agent's own contract
 * was to call complete_stage, so it is the one that must do it.
 */
export function noTerminalSignalCompletion(finalReason: string | null): StageCompletion {
  return {
    status:            'ESCALATE',
    summary:           '(stage ended without calling complete_stage)',
    escalation_reason: NO_TERMINAL_SIGNAL_REASON + (finalReason ? ` Also: ${finalReason}` : ''),
    selfContract:      true,
  }
}

/**
 * Fail closed on a malformed completion status. A stage's terminal signal must
 * be exactly 'DONE' or 'ESCALATE'; anything else is a malformed transition and
 * is read as a self-contract ESCALATE (re-run this stage, bounded by
 * maxRetries) rather than being silently treated as DONE downstream.
 * Well-formed completions pass through unchanged (same object reference).
 */
export function normalizeCompletion(completion: StageCompletion): StageCompletion {
  if (completion.status === 'DONE' || completion.status === 'ESCALATE') return completion
  return {
    status:            'ESCALATE',
    summary:           completion.summary || '(invalid completion status)',
    escalation_reason: `invalid_completion_status: ${String(completion.status)}`,
    selfContract:      true,
  }
}

/**
 * Decision well-formedness. Returns null when the coordinator decision is
 * well-formed, or a short human-readable reason when it is not.
 *
 * - NEXT / ESCALATE / SYNTHESIZE are always well-formed.
 * - REWIND is well-formed only when it carries a target stage (`rewindTo`);
 *   a REWIND without one cannot be applied and must fail closed.
 * - Any other action is unrecognized.
 *
 * Note: this validates the decision VALUE, not the pipeline state (e.g.
 * whether a REWIND target has actually completed is checked by the pipeline
 * itself). At the call site in pipeline.ts, SYNTHESIZE has already returned
 * and NEXT / a valid REWIND have already broken out of the stage loop, so the
 * only well-formed decision that can still arrive is ESCALATE.
 */
export function invalidDecisionReason(decision: CoordinatorDecision): string | null {
  if (decision.action === 'ESCALATE' || decision.action === 'NEXT' || decision.action === 'SYNTHESIZE') return null
  if (decision.action === 'REWIND') return decision.rewindTo ? null : 'REWIND without a target stage'
  return `unrecognized action ${JSON.stringify(decision.action)}`
}
