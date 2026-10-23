// -- BulletTrain per-project budget (pure leaf) ----------------------------------
// Pure, dependency-free budget logic for the OPTIONAL per-project token /
// wall-clock budget. No I/O, no LLM -- unit-testable in isolation, following the
// verifyquality.ts / clarify.ts leaf pattern. Only the store (persist) and the
// supervisor (check + accumulate) touch the filesystem; this module is the
// single source of truth for "is the budget set / used up / how to render it".
//
// Semantics (locked with the user):
//   - OFF by default. A project with no budget (budget === null) behaves exactly
//     as before -- no check, no section, no change to run behavior.
//   - Cumulative across ALL runs of a project (not per-run). The existing
//     per-run limits (max_sessions, wall_clock_hours, ...) are unchanged; this
//     caps the *total* spend a project is allowed to burn.
//   - Exhaustion is a GRACEFUL STOP, never a hard halt. The supervisor breaks to
//     the normal done path (package the deliverable + write the report + clean
//     state), so a budget never produces a run with no output. That is enforced
//     by the caller; this module only reports whether the budget is exhausted.

export interface BTBudget {
  tokens?: number      // cumulative token cap across all runs (prompt + completion)
  wallHours?: number   // cumulative wall-clock cap (hours) across all runs
}

export interface BTUsage {
  tokens: number
  wallSeconds: number
}

export interface BTBudgetState {
  budget: BTBudget | null   // null = no budget (off)
  usage: BTUsage            // cumulative across all runs
}

export const ZERO_USAGE: BTUsage = { tokens: 0, wallSeconds: 0 }

// A budget is "enabled" when at least one dimension carries a positive cap.
// A dimension of 0 / negative / missing counts as "not set" (a 0 cap would
// exhaust immediately -- a footgun, so it is treated as unset, not as a cap).
export function budgetEnabled(budget: BTBudget | null | undefined): boolean {
  if (!budget) return false
  return (typeof budget.tokens === 'number' && budget.tokens > 0) ||
         (typeof budget.wallHours === 'number' && budget.wallHours > 0)
}

export function addUsage(a: BTUsage, b: BTUsage): BTUsage {
  return { tokens: a.tokens + b.tokens, wallSeconds: a.wallSeconds + b.wallSeconds }
}

export interface BTBudgetCheck {
  exhausted: boolean
  reasons: string[]   // one per exhausted dimension (greppable, actionable)
  lines: string[]     // one per enabled dimension (usage vs limit), for the report
}

// Pure decision: has cumulative usage reached (>=) any enabled cap?
// `usage >= limit` means "we have used up the budget" -- the run may have
// overshot slightly within its last session (a session's cost is unknown until
// it runs), which is acceptable for a boundary-stop cap and is reported honestly.
export function checkBudget(usage: BTUsage, budget: BTBudget | null | undefined): BTBudgetCheck {
  const reasons: string[] = []
  const lines: string[] = []
  let exhausted = false
  if (budget && typeof budget.tokens === 'number' && budget.tokens > 0) {
    const over = usage.tokens >= budget.tokens
    if (over) { exhausted = true; reasons.push(`token budget exhausted: ${usage.tokens} >= ${budget.tokens}`) }
    lines.push(`tokens: ${usage.tokens} / ${budget.tokens}${over ? ' (EXHAUSTED)' : ''}`)
  }
  if (budget && typeof budget.wallHours === 'number' && budget.wallHours > 0) {
    const usedHours = usage.wallSeconds / 3600
    const over = usedHours >= budget.wallHours
    if (over) { exhausted = true; reasons.push(`wall-clock budget exhausted: ${usedHours.toFixed(2)}h >= ${budget.wallHours}h`) }
    lines.push(`wall clock: ${usedHours.toFixed(2)}h / ${budget.wallHours}h${over ? ' (EXHAUSTED)' : ''}`)
  }
  return { exhausted, reasons, lines }
}

export type BudgetNormalizeResult =
  | { ok: true; budget: BTBudget | null }
  | { ok: false; error: string }

// Coerce/validate a user-provided budget (the POST body). A dimension is set
// only when it is a finite number > 0; 0 / negative / NaN / non-number are
// rejected (a 0 cap is a footgun). Omitting both (or sending null/{} ) clears
// the budget (returns budget: null). Never throws.
export function normalizeBudget(input: unknown): BudgetNormalizeResult {
  if (input == null) return { ok: true, budget: null }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'budget must be an object like { tokens?, wallHours? }' }
  }
  const obj = input as Record<string, unknown>
  const budget: BTBudget = {}
  for (const key of ['tokens', 'wallHours'] as const) {
    const v = obj[key]
    if (v == null) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      return { ok: false, error: `${key} must be a positive finite number (or omitted to leave that dimension uncapped)` }
    }
    budget[key] = v
  }
  return { ok: true, budget: budgetEnabled(budget) ? budget : null }
}

// Body lines for the run report's "## Budget" section (the header is added by
// buildReport). Returns [] when no budget is enabled (no section rendered).
// When the run stopped because of the budget, appends a clear explanation.
export function renderBudgetSection(usage: BTUsage, budget: BTBudget | null, stoppedForBudget: boolean): string[] {
  if (!budgetEnabled(budget)) return []
  const check = checkBudget(usage, budget)
  const lines = [...check.lines]
  if (stoppedForBudget) {
    lines.push('',
      `Stopped: the project budget was reached (${check.reasons.join('; ')}). ` +
      'The deliverable packages the work completed so far; start a new run (or raise the budget) to continue.')
  }
  return lines
}
