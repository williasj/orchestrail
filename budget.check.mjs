// Verifies the BulletTrain per-project budget contract
// (see src/bullettrain/budget.ts, a pure leaf following the verifyquality.ts /
// clarify.ts pattern). Follows the check.mjs pattern: a standalone assertion
// script, no test framework. Run after a build:
//   npm run build && node budget.check.mjs
//
// It unit-tests the pure logic behind item 14 sub-part 3 (optional per-project
// token / wall-clock budgets): whether a budget is enabled, how cumulative
// usage accumulates, when the budget is exhausted (a >= boundary), how a
// user-provided budget is normalized/validated, and how the report section
// renders. All pure (no I/O, no LLM) so they can be asserted deterministically.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const MODULE = process.env.BUDGET_MODULE || path.join(here, 'dist', 'bullettrain', 'budget.js')

const {
  budgetEnabled, addUsage, checkBudget, normalizeBudget, renderBudgetSection, ZERO_USAGE,
} = await import(pathToFileURL(MODULE).href)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}

// -- budgetEnabled ---------------------------------------------------------------

console.log('budgetEnabled:')
{
  ok(budgetEnabled(null) === false, 'null -> off')
  ok(budgetEnabled(undefined) === false, 'undefined -> off')
  ok(budgetEnabled({}) === false, 'empty object -> off')
  ok(budgetEnabled({ tokens: 0 }) === false, 'tokens 0 -> off (a 0 cap is a footgun, treated as unset)')
  ok(budgetEnabled({ tokens: -5 }) === false, 'tokens negative -> off')
  ok(budgetEnabled({ tokens: NaN }) === false, 'tokens NaN -> off')
  ok(budgetEnabled({ tokens: 100 }) === true, 'tokens positive -> on')
  ok(budgetEnabled({ wallHours: 0 }) === false, 'wallHours 0 -> off')
  ok(budgetEnabled({ wallHours: 2.5 }) === true, 'wallHours positive -> on')
  ok(budgetEnabled({ tokens: 100, wallHours: 0 }) === true, 'one dim set -> on')
  ok(budgetEnabled({ tokens: 0, wallHours: 0 }) === false, 'both zero -> off')
}

// -- addUsage --------------------------------------------------------------------

console.log('\naddUsage:')
{
  const z = addUsage(ZERO_USAGE, ZERO_USAGE)
  ok(z.tokens === 0 && z.wallSeconds === 0, 'zero + zero -> zero')
  const s = addUsage({ tokens: 10, wallSeconds: 100 }, { tokens: 5, wallSeconds: 50 })
  ok(s.tokens === 15 && s.wallSeconds === 150, 'sums both dimensions')
  const a = { tokens: 1, wallSeconds: 2 }
  const b = { tokens: 3, wallSeconds: 4 }
  addUsage(a, b)
  ok(a.tokens === 1 && a.wallSeconds === 2, 'does not mutate its inputs')
}

// -- checkBudget -----------------------------------------------------------------

console.log('\ncheckBudget:')
{
  const none = checkBudget({ tokens: 500, wallSeconds: 7200 }, null)
  ok(none.exhausted === false && none.reasons.length === 0 && none.lines.length === 0,
    'no budget -> not exhausted, no reasons, no lines')

  const under = checkBudget({ tokens: 999, wallSeconds: 0 }, { tokens: 1000 })
  ok(under.exhausted === false, 'tokens under cap -> not exhausted')
  ok(under.lines[0] === 'tokens: 999 / 1000', 'tokens line renders usage / limit', under.lines[0])

  const at = checkBudget({ tokens: 1000, wallSeconds: 0 }, { tokens: 1000 })
  ok(at.exhausted === true, 'tokens exactly at cap -> exhausted (>= boundary)')
  ok(at.reasons[0] === 'token budget exhausted: 1000 >= 1000', 'token reason is greppable', at.reasons[0])
  ok(at.lines[0] === 'tokens: 1000 / 1000 (EXHAUSTED)', 'exhausted tokens line is flagged', at.lines[0])

  const over = checkBudget({ tokens: 1500, wallSeconds: 0 }, { tokens: 1000 })
  ok(over.exhausted === true, 'tokens over cap -> exhausted')

  const wallUnder = checkBudget({ tokens: 0, wallSeconds: 3599 }, { wallHours: 1 })
  ok(wallUnder.exhausted === false, 'wall clock under cap (3599s < 1h) -> not exhausted')
  const wallAt = checkBudget({ tokens: 0, wallSeconds: 3600 }, { wallHours: 1 })
  ok(wallAt.exhausted === true, 'wall clock exactly at cap (3600s = 1h) -> exhausted')
  ok(wallAt.lines[0] === 'wall clock: 1.00h / 1h (EXHAUSTED)', 'wall clock line renders hours', wallAt.lines[0])

  const both = checkBudget({ tokens: 2000, wallSeconds: 7200 }, { tokens: 1000, wallHours: 1 })
  ok(both.exhausted === true && both.reasons.length === 2, 'both dims over -> two reasons', JSON.stringify(both.reasons))
  ok(both.lines.length === 2, 'both dims -> two lines')

  const zeroCap = checkBudget({ tokens: 500, wallSeconds: 0 }, { tokens: 0 })
  ok(zeroCap.exhausted === false && zeroCap.lines.length === 0, 'a 0 cap is treated as unset (no line, not exhausted)')
}

// -- normalizeBudget -------------------------------------------------------------

console.log('\nnormalizeBudget:')
{
  ok(normalizeBudget(null).ok === true && normalizeBudget(null).budget === null, 'null -> ok, cleared (budget null)')
  ok(normalizeBudget(undefined).ok === true && normalizeBudget(undefined).budget === null, 'undefined -> ok, cleared')
  ok(normalizeBudget({}).ok === true && normalizeBudget({}).budget === null, 'both omitted -> ok, cleared')

  const t = normalizeBudget({ tokens: 1000 })
  ok(t.ok === true && t.budget && t.budget.tokens === 1000 && t.budget.wallHours === undefined,
    'tokens only -> ok, only tokens set', JSON.stringify(t.budget))

  const w = normalizeBudget({ wallHours: 2 })
  ok(w.ok === true && w.budget && w.budget.wallHours === 2 && w.budget.tokens === undefined,
    'wallHours only -> ok, only wallHours set', JSON.stringify(w.budget))

  const both = normalizeBudget({ tokens: 1000, wallHours: 2 })
  ok(both.ok === true && both.budget.tokens === 1000 && both.budget.wallHours === 2,
    'both -> ok, both set')

  // A 0 cap is a footgun (it would exhaust immediately), so 0 is REJECTED, not
  // silently cleared. To clear a dimension you omit it (or send null / {}), never 0.
  ok(normalizeBudget({ tokens: 0 }).ok === false, 'tokens 0 -> rejected (a 0 cap would exhaust immediately)')
  ok(normalizeBudget({ wallHours: 0 }).ok === false, 'wallHours 0 -> rejected')
  ok(normalizeBudget({ tokens: 1000, wallHours: 0 }).ok === false,
    'tokens set + wallHours 0 -> rejected (the 0 dimension is invalid, not dropped)')

  ok(normalizeBudget({ tokens: -5 }).ok === false, 'negative tokens -> rejected')
  ok(normalizeBudget({ tokens: NaN }).ok === false, 'NaN tokens -> rejected')
  ok(normalizeBudget({ tokens: Infinity }).ok === false, 'Infinity tokens -> rejected (not finite)')
  ok(normalizeBudget({ tokens: '1000' }).ok === false, 'string tokens -> rejected (must be a number)')
  ok(normalizeBudget({ wallHours: -1 }).ok === false, 'negative wallHours -> rejected')

  ok(normalizeBudget([1000]).ok === false, 'array -> rejected')
  ok(normalizeBudget('1000').ok === false, 'string -> rejected')
  ok(normalizeBudget(1000).ok === false, 'number -> rejected (must be an object)')
}

// -- renderBudgetSection ---------------------------------------------------------

console.log('\nrenderBudgetSection:')
{
  ok(renderBudgetSection({ tokens: 500, wallSeconds: 0 }, null, false).length === 0,
    'no budget -> no section (empty array)')

  const lines = renderBudgetSection({ tokens: 500, wallSeconds: 0 }, { tokens: 1000 }, false)
  ok(lines.length === 1 && lines[0] === 'tokens: 500 / 1000',
    'budget set, not stopped -> single usage line, no stop note', JSON.stringify(lines))

  const stopped = renderBudgetSection({ tokens: 1000, wallSeconds: 0 }, { tokens: 1000 }, true)
  ok(stopped.some(l => l.includes('Stopped: the project budget was reached')),
    'stopped for budget -> appends a clear stop explanation', JSON.stringify(stopped))
  ok(stopped.some(l => l.includes('token budget exhausted')),
    'stop explanation names the exhausted dimension', JSON.stringify(stopped))

  const notStopped = renderBudgetSection({ tokens: 500, wallSeconds: 0 }, { tokens: 1000 }, false)
  ok(notStopped.every(l => !l.includes('Stopped:')),
    'not stopped -> no stop explanation')
}

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
