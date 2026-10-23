// Verifies the independent adversarial-verifier contract
// (see src/utils/adversarial.ts, used by src/core/agent.ts, tools.ts, pipeline.ts).
// Follows the check.mjs pattern: a standalone assertion script, no test framework.
// Run after a build:  npm run build && node adversarial.check.mjs
//
// It unit-tests the pure contract behind frontier item 11 (C1/A1, "the team
// grades its own homework", option b): the adversarial-reviewer is converted
// into an independent verifier whose inputs are the requester's spec +
// implementation ONLY. The team's test_report / test_harness are withheld from
// it (isWithheldFromVerifier), it authors its OWN probes, runs them, and records
// a structured verdict [{probe, expected, actual, status}]. DONE requires at
// least one probe and ZERO failures (fail or error). The verdict is computed by
// pure string logic (no LLM, no execution) so it can be asserted here
// deterministically.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ADV = process.env.ADVERSARIAL_MODULE || path.join(here, 'dist', 'utils', 'adversarial.js')

const {
  ADVERSARIAL_VERDICT_SLOT,
  ADVERSARIAL_WITHHELD_SLOTS,
  isAdversarialWithheldSlot,
  isWithheldFromVerifier,
  filterWithheldSlots,
  parseAdversarialVerdict,
  aggregateAdversarialVerdict,
  adversarialEscalationReason,
  adversarialVerdictRequired,
  evaluateAdversarialVerdict,
} = await import(pathToFileURL(ADV).href)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}
// Convenience: assert a verdict is unsatisfied with a reason leading the token.
function rejected(v, label, extra) {
  ok(v.required === true && v.satisfied === false && v.reason.startsWith('adversarial_probe:'),
    label, extra ? `${extra} | ${JSON.stringify(v)}` : JSON.stringify(v))
}
function accepted(v, label, extra) {
  ok(v.required === true && v.satisfied === true && v.reason === '', label, extra ? `${extra} | ${JSON.stringify(v)}` : JSON.stringify(v))
}

// -- exports -------------------------------------------------------------------

console.log('exports:')
ok(ADVERSARIAL_VERDICT_SLOT === 'adversarial_verdict', 'slot name is adversarial_verdict')
ok(Array.isArray(ADVERSARIAL_WITHHELD_SLOTS)
  && ADVERSARIAL_WITHHELD_SLOTS.includes('test_report')
  && ADVERSARIAL_WITHHELD_SLOTS.includes('test_harness'),
  'withheld slots name the team\'s test_report and test_harness')

// -- isAdversarialWithheldSlot ---------------------------------------------------

console.log('\nisAdversarialWithheldSlot:')
ok(isAdversarialWithheldSlot('test_report') === true,  'test_report is a named team artifact')
ok(isAdversarialWithheldSlot('test_harness') === true, 'test_harness is a named team artifact')
ok(isAdversarialWithheldSlot('implementation') === false, 'implementation is NOT withheld (the artifact under verification)')
ok(isAdversarialWithheldSlot('blueprint') === false,    'blueprint is NOT withheld (the spec)')
ok(isAdversarialWithheldSlot('review_report') === false, 'review_report is NOT withheld')

// -- isWithheldFromVerifier ------------------------------------------------------

console.log('\nisWithheldFromVerifier:')
ok(isWithheldFromVerifier('test_report') === true,  'test_report withheld')
ok(isWithheldFromVerifier('test_harness') === true, 'test_harness withheld')
ok(isWithheldFromVerifier('__captured_harness') === true, 'internal (__-prefixed) slots are private by design')
ok(isWithheldFromVerifier('__anything') === true,   'any __-prefixed slot withheld')
ok(isWithheldFromVerifier('implementation') === false, 'implementation visible')
ok(isWithheldFromVerifier('blueprint') === false,    'blueprint visible')
ok(isWithheldFromVerifier('runtimes') === false,     'runtimes visible')

// -- filterWithheldSlots ---------------------------------------------------------

console.log('\nfilterWithheldSlots:')
{
  const all = ['blueprint', 'runtimes', 'implementation', 'test_harness', 'test_report', 'entry_point_probe', '__captured_harness']
  const nonVerifier = filterWithheldSlots(all, false)
  ok(nonVerifier === all, 'non-verifier sees the list unchanged (same reference)')
  const verifier = filterWithheldSlots(all, true)
  ok(verifier.length !== all.length, 'verifier sees a filtered list')
  ok(!verifier.includes('test_report'), 'verifier: test_report removed')
  ok(!verifier.includes('test_harness'), 'verifier: test_harness removed')
  ok(!verifier.includes('__captured_harness'), 'verifier: internal slot removed')
  ok(verifier.includes('implementation'), 'verifier: implementation kept')
  ok(verifier.includes('blueprint'), 'verifier: blueprint kept')
  ok(verifier.includes('entry_point_probe'), 'verifier: entry_point_probe kept (the team\'s probe record is not its test suite)')
  ok(all.length === 7, 'input list not mutated')
}

// -- adversarialVerdictRequired ---------------------------------------------------

console.log('\nadversarialVerdictRequired:')
ok(adversarialVerdictRequired(true, true) === true,  'code task + requiresAdversarialVerdict -> required')
ok(adversarialVerdictRequired(false, true) === false, 'non-code task -> not required (no executable behaviour to probe)')
ok(adversarialVerdictRequired(true, false) === false, 'code task but not the verifier -> not required')
ok(adversarialVerdictRequired(false, false) === false, 'neither -> not required')

// -- parseAdversarialVerdict: valid ----------------------------------------------

console.log('\nparseAdversarialVerdict (valid):')
{
  const p = parseAdversarialVerdict(
    '[{"probe": "f(0)", "expected": "0", "actual": "0", "status": "pass"},'
    + '{"probe": "f(-1)", "expected": "ValueError", "actual": "ValueError raised", "status": "pass"}]')
  ok(p.ok === true && p.probes.length === 2, 'plain JSON array parses')
  ok(p.probes[0].status === 'pass' && p.probes[1].probe === 'f(-1)', 'probe fields preserved')
}
{
  const p = parseAdversarialVerdict('Here are my probes:\n```json\n[{"probe": "x", "expected": "y", "actual": "y", "status": "pass"}]\n```\nDone.')
  ok(p.ok === true && p.probes.length === 1, 'prose + code fence around the array parses (tolerant)')
}
{
  const p = parseAdversarialVerdict('[{"probe": "a", "expected": "b", "actual": "b", "status": "passed"}]')
  ok(p.ok === true && p.probes[0].status === 'pass', 'status "passed" normalizes to pass')
  const q = parseAdversarialVerdict('[{"probe": "a", "expected": "b", "actual": "c", "status": "failed"}]')
  ok(q.ok === true && q.probes[0].status === 'fail', 'status "failed" normalizes to fail')
  const r = parseAdversarialVerdict('[{"probe": "a", "expected": "b", "actual": "crash", "status": "errored"}]')
  ok(r.ok === true && r.probes[0].status === 'error', 'status "errored" normalizes to error')
}

// -- parseAdversarialVerdict: malformed ------------------------------------------

console.log('\nparseAdversarialVerdict (malformed):')
ok(parseAdversarialVerdict('').ok === false, 'empty string -> not ok')
ok(parseAdversarialVerdict(null).ok === false, 'null -> not ok')
ok(parseAdversarialVerdict(undefined).ok === false, 'undefined -> not ok')
ok(parseAdversarialVerdict('all good, no probes recorded').ok === false, 'prose with no JSON array -> not ok')
ok(parseAdversarialVerdict('{"probe": "x"}').ok === false, 'JSON object (not array) -> not ok')
{
  const p = parseAdversarialVerdict('[42]')
  ok(p.ok === false && /not an object/.test(p.reason), 'array element that is not an object -> not ok')
}
{
  const p = parseAdversarialVerdict('[{"expected": "b", "actual": "b", "status": "pass"}]')
  ok(p.ok === false && /probe/.test(p.reason), 'missing probe field -> not ok, names the field')
}
{
  const p = parseAdversarialVerdict('[{"probe": "x", "actual": "b", "status": "pass"}]')
  ok(p.ok === false && /expected/.test(p.reason), 'missing expected field -> not ok, names the field')
}
{
  const p = parseAdversarialVerdict('[{"probe": "x", "expected": "b", "status": "pass"}]')
  ok(p.ok === false && /actual/.test(p.reason), 'missing actual -> not ok (a probe with no observed output was not run)')
}
{
  const p = parseAdversarialVerdict('[{"probe": "x", "expected": "b", "actual": "b", "status": "maybe"}]')
  ok(p.ok === false && /status/.test(p.reason), 'unknown status -> not ok, names the field')
}

// -- aggregateAdversarialVerdict ---------------------------------------------------

console.log('\naggregateAdversarialVerdict:')
{
  const agg = aggregateAdversarialVerdict([
    { probe: 'p1', expected: 'e', actual: 'a', status: 'pass' },
    { probe: 'p2', expected: 'e', actual: 'a', status: 'pass' },
    { probe: 'p3', expected: 'e', actual: 'a', status: 'fail' },
    { probe: 'p4', expected: 'e', actual: 'a', status: 'error' },
  ])
  ok(agg.total === 4 && agg.passed === 2 && agg.failed === 1 && agg.errors === 1, 'counts partition the probes')
  ok(agg.failures.length === 2 && agg.failures[0].probe === 'p3' && agg.failures[1].probe === 'p4',
    'failures = fail + error probes, in record order')
}
{
  const agg = aggregateAdversarialVerdict([])
  ok(agg.total === 0 && agg.failures.length === 0, 'empty record aggregates to zeros')
}

// -- adversarialEscalationReason ----------------------------------------------------

console.log('\nadversarialEscalationReason:')
{
  const agg = aggregateAdversarialVerdict([
    { probe: 'entry', expected: 'runs', actual: 'crashed', status: 'error' },
    { probe: 'boundary', expected: 'ok', actual: 'wrong', status: 'fail' },
  ])
  const reason = adversarialEscalationReason(agg)
  ok(reason.startsWith('adversarial_probe:'), 'reason leads with the greppable adversarial_probe: token')
  ok(reason.includes('2 of 2'), 'reason states the failure fraction')
  ok(reason.includes('"entry"') && reason.includes('"boundary"'), 'reason names the failing probes')
  ok(reason.includes('expected:') && reason.includes('actual:'), 'reason carries expected vs actual for each')
}
{
  const many = Array.from({ length: 7 }, (_, i) => ({ probe: `p${i}`, expected: 'e', actual: 'a', status: 'fail' }))
  const reason = adversarialEscalationReason(aggregateAdversarialVerdict(many))
  ok(reason.includes('...and 2 more'), 'bounded: beyond 5 named failures the rest are counted, not spelled out')
}

// -- evaluateAdversarialVerdict: not required ----------------------------------------

console.log('\nevaluateAdversarialVerdict (not required):')
{
  const v = evaluateAdversarialVerdict('anything at all', false)
  ok(v.required === false && v.satisfied === true && v.reason === '', 'not required -> satisfied by definition, empty reason')
  const v2 = evaluateAdversarialVerdict(null, false)
  ok(v2.required === false && v2.satisfied === true, 'not required with no record -> still satisfied')
}

// -- required, empty / missing -------------------------------------------------------

console.log('\nevaluateAdversarialVerdict (required, empty/missing):')
rejected(evaluateAdversarialVerdict('', true),        'empty string -> rejected (slot empty)')
rejected(evaluateAdversarialVerdict(null, true),      'null -> rejected')
rejected(evaluateAdversarialVerdict(undefined, true), 'undefined -> rejected')
rejected(evaluateAdversarialVerdict('   \n  ', true), 'whitespace-only -> rejected')

// -- required, malformed --------------------------------------------------------------

console.log('\nevaluateAdversarialVerdict (required, malformed):')
rejected(
  evaluateAdversarialVerdict('I ran three probes and they all passed.', true),
  'prose verdict with no JSON array -> rejected (the gate never trusts model prose)',
)
rejected(
  evaluateAdversarialVerdict('[]', true),
  'empty array -> rejected (a verdict with zero probes proves nothing)',
)

// -- required, failures ------------------------------------------------------------------

console.log('\nevaluateAdversarialVerdict (required, failures):')
rejected(
  evaluateAdversarialVerdict('[{"probe": "f(0)", "expected": "0", "actual": "1", "status": "fail"}]', true),
  'a failing probe -> rejected (DONE requires zero adversarial failures)',
)
rejected(
  evaluateAdversarialVerdict('[{"probe": "f(0)", "expected": "0", "actual": "0", "status": "pass"},'
    + '{"probe": "f(-1)", "expected": "ValueError", "actual": "no error raised", "status": "fail"}]', true),
  'one pass + one fail -> rejected (one failure is enough)',
)
rejected(
  evaluateAdversarialVerdict('[{"probe": "entry", "expected": "runs", "actual": "crashed", "status": "error"}]', true),
  'an errored probe -> rejected (a crash is not a pass)',
)
{
  const v = evaluateAdversarialVerdict('[{"probe": "f(0)", "expected": "0", "actual": "1", "status": "fail"}]', true)
  ok(v.reason.includes('"f(0)"'), 'rejection reason names the failing probe so the re-run has a target')
}

// -- required, satisfied -------------------------------------------------------------------

console.log('\nevaluateAdversarialVerdict (required, satisfied):')
accepted(
  evaluateAdversarialVerdict(
    '[{"probe": "python implementation.py", "expected": "prints result", "actual": "printed result", "status": "pass"},'
    + '{"probe": "f(\'\')", "expected": "ValueError", "actual": "ValueError raised", "status": "pass"},'
    + '{"probe": "f(10**9)", "expected": "no crash", "actual": "returned in 0.4s", "status": "pass"}]',
    true,
  ),
  'all probes pass -> satisfied',
)
accepted(
  evaluateAdversarialVerdict('Verdict:\n```json\n[{"probe": "x", "expected": "y", "actual": "y", "status": "pass"}]\n```', true),
  'fenced verdict, all pass -> satisfied (parsing is fence-tolerant)',
)

// -- reason format --------------------------------------------------------------------------

console.log('\nreason format:')
{
  const v = evaluateAdversarialVerdict('', true)
  ok(v.reason.startsWith('adversarial_probe:'), 'rejection reason leads with the greppable adversarial_probe: token')
  ok(v.reason.length > 'adversarial_probe:'.length, 'rejection reason carries an actionable detail, not just the token')
}

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
