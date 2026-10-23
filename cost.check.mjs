// Verifies the per-stage & run cost formatting contract
// (see src/utils/cost.ts, a pure leaf following the terminal.ts / budget.ts
// pattern). Follows the check.mjs pattern: a standalone assertion script, no test
// framework. Run after a build:  npm run build && node cost.check.mjs
//
// It unit-tests the pure logic behind item 17 / B3 (surface per-stage cost):
// how a token count is formatted, how a wall-time duration is rendered across the
// ms / s / m boundaries, the compact per-stage cost suffix, the run-level cost
// summary, and the run-level cost line. All pure (no I/O, no LLM) so they can be
// asserted deterministically.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const MODULE = process.env.COST_MODULE || path.join(here, 'dist', 'utils', 'cost.js')

const {
  formatTokens, formatDuration, costSuffix, summarizeRunCost, renderRunCostLine,
} = await import(pathToFileURL(MODULE).href)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}

// -- formatTokens ---------------------------------------------------------------

console.log('formatTokens:')
{
  ok(formatTokens(0) === '0', '0 -> "0"', formatTokens(0))
  ok(formatTokens(999) === '999', '999 -> "999"', formatTokens(999))
  ok(formatTokens(1000) === '1,000', '1000 -> "1,000"', formatTokens(1000))
  ok(formatTokens(123456) === '123,456', '123456 -> "123,456"', formatTokens(123456))
  ok(formatTokens(1234.9) === '1,234', 'fractional floors to integer', formatTokens(1234.9))
  ok(formatTokens(-5) === '0', 'negative -> "0"', formatTokens(-5))
  ok(formatTokens(NaN) === '0', 'NaN -> "0"', formatTokens(NaN))
  ok(formatTokens(Infinity) === '0', 'Infinity -> "0"', formatTokens(Infinity))
}

// -- formatDuration -------------------------------------------------------------

console.log('\nformatDuration:')
{
  ok(formatDuration(0) === '0s', '0 -> "0s"', formatDuration(0))
  ok(formatDuration(-100) === '0s', 'negative -> "0s"', formatDuration(-100))
  ok(formatDuration(NaN) === '0s', 'NaN -> "0s"', formatDuration(NaN))
  ok(formatDuration(500) === '500ms', 'sub-second -> ms', formatDuration(500))
  ok(formatDuration(999) === '999ms', 'just under a second -> ms', formatDuration(999))
  ok(formatDuration(1000) === '1.0s', 'exactly one second -> "1.0s"', formatDuration(1000))
  ok(formatDuration(3400) === '3.4s', '3.4s', formatDuration(3400))
  ok(formatDuration(59999) === '60.0s', 'just under a minute -> seconds (60.0s)', formatDuration(59999))
  ok(formatDuration(60000) === '1m 00s', 'exactly one minute -> "1m 00s"', formatDuration(60000))
  ok(formatDuration(125000) === '2m 05s', '2m 05s', formatDuration(125000))
  ok(formatDuration(3723000) === '62m 03s', '62m 03s', formatDuration(3723000))
}

// -- costSuffix -----------------------------------------------------------------

console.log('\ncostSuffix:')
{
  ok(costSuffix({}) === '', 'no data -> empty (renders as before)', JSON.stringify(costSuffix({})))
  ok(costSuffix({ tokens: 0, durationMs: 0 }) === '', 'zeros -> empty', JSON.stringify(costSuffix({ tokens: 0, durationMs: 0 })))
  ok(costSuffix({ tokens: 12345 }) === '(12,345 tokens)', 'tokens only', costSuffix({ tokens: 12345 }))
  ok(costSuffix({ durationMs: 3400 }) === '(3.4s)', 'duration only', costSuffix({ durationMs: 3400 }))
  ok(costSuffix({ tokens: 12345, durationMs: 3400 }) === '(12,345 tokens · 3.4s)', 'both -> "tokens · duration"', costSuffix({ tokens: 12345, durationMs: 3400 }))
  ok(costSuffix({ tokens: 0, durationMs: 3400 }) === '(3.4s)', 'zero tokens ignored, duration kept', costSuffix({ tokens: 0, durationMs: 3400 }))
  ok(costSuffix({ tokens: 12345, durationMs: 0 }) === '(12,345 tokens)', 'zero duration ignored, tokens kept', costSuffix({ tokens: 12345, durationMs: 0 }))
}

// -- summarizeRunCost -----------------------------------------------------------

console.log('\nsummarizeRunCost:')
{
  const empty = summarizeRunCost([])
  ok(empty.tokens === 0 && empty.durationMs === 0, 'empty -> zeros', JSON.stringify(empty))
  const mixed = summarizeRunCost([
    { assignee: 'a', title: 't', output: '', success: true, tokens: 100, durationMs: 1000 },
    { assignee: 'b', title: 't', output: '', success: true, tokens: 200, durationMs: 2000 },
    { assignee: 'c', title: 't', output: '', success: true },  // no usage data
  ])
  ok(mixed.tokens === 300, 'sums tokens (missing -> 0)', String(mixed.tokens))
  ok(mixed.durationMs === 3000, 'sums durationMs (missing -> 0)', String(mixed.durationMs))
}

// -- renderRunCostLine ----------------------------------------------------------

console.log('\nrenderRunCostLine:')
{
  ok(renderRunCostLine(0, 0) === '', 'both zero -> empty', JSON.stringify(renderRunCostLine(0, 0)))
  ok(renderRunCostLine(6912, 0) === 'total 6,912 tokens', 'tokens only', renderRunCostLine(6912, 0))
  ok(renderRunCostLine(0, 10400) === 'total 10.4s', 'duration only', renderRunCostLine(0, 10400))
  ok(renderRunCostLine(6912, 10400) === 'total 6,912 tokens · 10.4s', 'both', renderRunCostLine(6912, 10400))
}

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
