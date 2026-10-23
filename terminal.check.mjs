// Verifies the terminal-signal contract and fail-closed state transitions
// (see src/utils/terminal.ts, used by src/core/agent.ts and src/core/pipeline.ts).
// Follows the check.mjs pattern: a standalone assertion script, no test framework.
// Run after a build:  npm run build && node terminal.check.mjs
//
// It (1) unit-tests noTerminalSignalCompletion -- a stage that ends without
// calling complete_stage must ALWAYS escalate (reason no_terminal_signal),
// even when the finalization checks pass; (2) normalizeCompletion -- a
// malformed completion status fails closed to a self-contract ESCALATE
// instead of being read as DONE; (3) invalidDecisionReason -- the pipeline's
// fail-closed guard on coordinator decisions (unknown action, REWIND without
// a target).

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const TERMINAL = process.env.TERMINAL_MODULE || path.join(here, 'dist', 'utils', 'terminal.js')

const {
  NO_TERMINAL_SIGNAL_REASON,
  noTerminalSignalCompletion,
  normalizeCompletion,
  invalidDecisionReason,
} = await import(pathToFileURL(TERMINAL).href)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}

// -- noTerminalSignalCompletion -------------------------------------------------

console.log('noTerminalSignalCompletion:')

// The leak case: finalization checks pass (finalReason null) but the agent
// never called complete_stage. Must still escalate -- never undefined/DONE.
const clean = noTerminalSignalCompletion(null)
ok(clean.status === 'ESCALATE', 'no terminal signal -> ESCALATE even when finalization checks pass', clean.status)
ok(clean.selfContract === true, 'selfContract: re-run the SAME stage, do not route to escalateTo')
ok(clean.escalation_reason.startsWith('no_terminal_signal:'), 'reason carries the greppable no_terminal_signal token', clean.escalation_reason)
ok(clean.escalation_reason.includes('complete_stage'), 'reason tells the agent to call complete_stage')
ok(clean.summary.includes('without calling complete_stage'), 'summary names the missing terminal signal', clean.summary)
ok(NO_TERMINAL_SIGNAL_REASON.startsWith('no_terminal_signal:'), 'exported constant leads with the token')

// The finalization checks fail too: their concrete reason must be appended,
// with no_terminal_signal still leading (it is the primary failure).
const withFinal = noTerminalSignalCompletion('Required output slot(s) not written: blueprint')
ok(withFinal.status === 'ESCALATE' && withFinal.selfContract === true, 'still a self-contract ESCALATE')
ok(withFinal.escalation_reason.startsWith('no_terminal_signal:'), 'no_terminal_signal leads when a finalization reason is present')
ok(withFinal.escalation_reason.includes('Required output slot(s) not written: blueprint'), 'finalization reason is appended, not replaced')

// -- normalizeCompletion ---------------------------------------------------------

console.log('\nnormalizeCompletion:')

const done = { status: 'DONE', summary: 'ok' }
ok(normalizeCompletion(done) === done, 'DONE passes through unchanged (same reference)')

const esc = { status: 'ESCALATE', summary: 'bad', escalation_reason: 'x' }
ok(normalizeCompletion(esc) === esc, 'ESCALATE passes through unchanged (same reference)')

const bad = normalizeCompletion({ status: 'MAYBE', summary: '' })
ok(bad.status === 'ESCALATE', 'malformed status fails closed to ESCALATE', bad.status)
ok(bad.selfContract === true, 'malformed status is a self-contract (re-run this stage, bounded by maxRetries)')
ok(String(bad.escalation_reason).includes('invalid_completion_status'), 'reason names the invalid-status failure')
ok(String(bad.escalation_reason).includes('MAYBE'), 'reason echoes the offending value')
ok(bad.summary.length > 0, 'summary falls back to a non-empty placeholder')

const badKept = normalizeCompletion({ status: 'MAYBE', summary: 'kept' })
ok(badKept.summary === 'kept', 'original summary preserved when present')

// -- invalidDecisionReason --------------------------------------------------------

console.log('\ninvalidDecisionReason:')

ok(invalidDecisionReason({ action: 'ESCALATE', reason: 'x' }) === null, 'ESCALATE is well-formed')
ok(invalidDecisionReason({ action: 'NEXT', reason: 'x' }) === null, 'NEXT is well-formed')
ok(invalidDecisionReason({ action: 'SYNTHESIZE', reason: 'x' }) === null, 'SYNTHESIZE is well-formed')
ok(invalidDecisionReason({ action: 'REWIND', rewindTo: 'Design', reason: 'x' }) === null, 'REWIND with a target is well-formed')

const noTarget = invalidDecisionReason({ action: 'REWIND', reason: 'x' })
ok(typeof noTarget === 'string' && noTarget.length > 0, 'REWIND without a target is invalid', String(noTarget))
ok(String(noTarget).includes('REWIND'), 'invalid-REWIND reason names the action')

const garbage = invalidDecisionReason({ action: 'TELEPORT', reason: 'x' })
ok(typeof garbage === 'string' && garbage.includes('TELEPORT'), 'unknown action is invalid and echoed', String(garbage))

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
