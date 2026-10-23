// Verifies the entry-point / end-to-end verification contract
// (see src/utils/verify.ts, used by src/core/agent.ts).
// Follows the check.mjs pattern: a standalone assertion script, no test framework.
// Run after a build:  npm run build && node verify.check.mjs
//
// It unit-tests the pure contract behind frontier item 7 (C1/A1, "the team
// grades its own homework"): the unit-test execution gate is NECESSARY but not
// SUFFICIENT, so a code task's DONE now also requires a passing entry-point
// probe -- the artifact driven end-to-end the way the requester will use it,
// with at least one boundary case. The verdict is computed by pure string
// logic (no LLM, no execution) so it can be asserted here deterministically.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const VERIFY = process.env.VERIFY_MODULE || path.join(here, 'dist', 'utils', 'verify.js')

const {
  ENTRY_POINT_PROBE_SLOT,
  ENTRY_POINT_PROBE_CHECKLIST,
  entryPointProbeRequired,
  evaluateEntryPointProbe,
} = await import(pathToFileURL(VERIFY).href)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}
// Convenience: assert a verdict is unsatisfied with a reason leading the token.
function rejected(v, label, extra) {
  ok(v.required === true && v.satisfied === false && v.reason.startsWith('entry_point_probe:'),
    label, extra ? `${extra} | ${JSON.stringify(v)}` : JSON.stringify(v))
}
function accepted(v, label, extra) {
  ok(v.required === true && v.satisfied === true && v.reason === '', label, extra ? `${extra} | ${JSON.stringify(v)}` : JSON.stringify(v))
}

// -- exports -------------------------------------------------------------------

console.log('exports:')
ok(ENTRY_POINT_PROBE_SLOT === 'entry_point_probe', 'slot name is entry_point_probe')
ok(Array.isArray(ENTRY_POINT_PROBE_CHECKLIST)
  && ENTRY_POINT_PROBE_CHECKLIST.includes('entry_point_invoked')
  && ENTRY_POINT_PROBE_CHECKLIST.includes('normal_case')
  && ENTRY_POINT_PROBE_CHECKLIST.includes('boundary_case'),
  'checklist names the three required probe dimensions')

// -- entryPointProbeRequired ---------------------------------------------------

console.log('\nentryPointProbeRequired:')
ok(entryPointProbeRequired(true, true) === true,  'code task + requiresVerifiedExecution -> required')
ok(entryPointProbeRequired(false, true) === false, 'non-code task -> not required (no executable entry point)')
ok(entryPointProbeRequired(true, false) === false, 'code task but not a verification agent -> not required')
ok(entryPointProbeRequired(false, false) === false, 'neither -> not required')

// -- evaluateEntryPointProbe: not required --------------------------------------

console.log('\nevaluateEntryPointProbe (not required):')
{
  const v = evaluateEntryPointProbe('anything at all', false)
  ok(v.required === false && v.satisfied === true && v.reason === '', 'not required -> satisfied by definition, empty reason')
  const v2 = evaluateEntryPointProbe(null, false)
  ok(v2.required === false && v2.satisfied === true, 'not required with no record -> still satisfied')
}

// -- evaluateEntryPointProbe: required, empty -----------------------------------

console.log('\nevaluateEntryPointProbe (required, empty/missing):')
rejected(evaluateEntryPointProbe('', true),        'empty string -> rejected (slot empty)')
rejected(evaluateEntryPointProbe(null, true),      'null -> rejected')
rejected(evaluateEntryPointProbe(undefined, true), 'undefined -> rejected')
rejected(evaluateEntryPointProbe('   \n  ', true), 'whitespace-only -> rejected')

// -- required, no command recorded ----------------------------------------------

console.log('\nevaluateEntryPointProbe (required, no command):')
rejected(
  evaluateEntryPointProbe('result: PASS\n- normal_case: PASS\n- boundary_case: PASS (empty input)', true),
  'pass + boundary but no command -> rejected (must show the entry point was actually run)',
)
rejected(
  evaluateEntryPointProbe('I ran the tests and everything looks fine.', true),
  'prose with no command token -> rejected',
)

// -- required, command present but reports a failure ----------------------------

console.log('\nevaluateEntryPointProbe (required, failure reported):')
rejected(
  evaluateEntryPointProbe('command: python implementation.py\nTraceback (most recent call last):\nOverflowError', true),
  'traceback -> rejected',
)
rejected(
  evaluateEntryPointProbe('command: python implementation.py\nexit code: 1', true),
  'non-zero exit -> rejected',
)
rejected(
  evaluateEntryPointProbe('command: python implementation.py\nRan 3 tests: 2 passed, 1 failed', true),
  'a failing case in the probe -> rejected (failure takes precedence over the pass signal)',
)
rejected(
  evaluateEntryPointProbe('command: python implementation.py\nresult: FAIL\nboundary: overflow', true),
  'explicit result: FAIL -> rejected',
)
// A passing probe that says "did not crash" must NOT be read as a failure --
// "crash" is ambiguous and is deliberately not a failure marker.
accepted(
  evaluateEntryPointProbe('command: python implementation.py\nresult: PASS\nboundary: very large input did not crash', true),
  '"did not crash" in a passing probe -> not a false failure',
)

// -- required, command + pass but no boundary -----------------------------------

console.log('\nevaluateEntryPointProbe (required, no boundary case):')
rejected(
  evaluateEntryPointProbe('command: python implementation.py\nresult: PASS\n- normal_case: PASS', true),
  'invoked + passing but no boundary -> rejected (the gap unit tests of library functions leave)',
)

// -- required, fully satisfied -------------------------------------------------

console.log('\nevaluateEntryPointProbe (required, satisfied):')
accepted(
  evaluateEntryPointProbe(
    'ENTRY-POINT PROBE\ncommand: python implementation.py\nresult: PASS\n'
    + '- entry_point_invoked: PASS\n- normal_case: PASS\n'
    + '- boundary_case: PASS (empty input and very large input did not crash)',
    true,
  ),
  'command + passing + boundary -> satisfied',
)
accepted(
  evaluateEntryPointProbe('command: python implementation.py\n$ python implementation.py\nexit 0\nboundary: empty input ok', true),
  'shell-prompt command + exit 0 + boundary -> satisfied',
)
accepted(
  evaluateEntryPointProbe('command: python implementation.py\nRan 3 tests: 3 passed, 0 failed\nempty input: no crash', true),
  'zero-failure run (0 failed is not a failure) + boundary -> satisfied',
)

// -- reason format -------------------------------------------------------------

console.log('\nreason format:')
{
  const v = evaluateEntryPointProbe('', true)
  ok(v.reason.startsWith('entry_point_probe:'), 'rejection reason leads with the greppable entry_point_probe: token')
  ok(v.reason.length > 'entry_point_probe:'.length, 'rejection reason carries an actionable detail, not just the token')
}


// -- Regression: the exact record format the prompt mandates must satisfy the gate --
{
  const mandated = 'ENTRY-POINT PROBE\ncommand: python implementation.py\nresult: PASS\n- entry_point_invoked: PASS\n- normal_case: PASS\n- boundary_case: PASS'
  const v = evaluateEntryPointProbe(mandated, true)
  ok(v.satisfied === true, 'the prompt-mandated probe format (boundary_case: PASS) satisfies the gate', v.reason)
}

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
