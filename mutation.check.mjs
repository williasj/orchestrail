// Verifies the mutation-probe contract (see src/utils/mutation.ts, used by
// src/core/agent.ts). Follows the check.mjs pattern: a standalone assertion
// script, no test framework. Run after a build:  npm run build && node mutation.check.mjs
//
// It unit-tests the pure contract behind frontier item 8 (mutation-robustness
// probe): the unit-test harness proves the implementation PASSES its own tests;
// the probe asks whether those tests are STRONG enough to catch a plausible
// defect. The orchestrator generates single-line mutants, runs the captured
// harness against each, and classifies each as killed / survived / invalid. A
// suite that survives valid mutants is weak and the stage is escalated with a
// `mutation_probe:` reason. The operators and classification are pure (no LLM,
// no execution) so they can be asserted here deterministically.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const MUTATION = process.env.MUTATION_MODULE || path.join(here, 'dist', 'utils', 'mutation.js')

const {
  MUTATION_DEFAULTS,
  generateMutants,
  classifyMutantOutcome,
  interpretMutationResults,
  evaluateMutationProbe,
  mutationEscalationReason,
  mutationProbeRequired,
  mutationMode,
} = await import(pathToFileURL(MUTATION).href)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}
// Find a generated mutant by operator + line; return it or null.
function find(mutants, operator, line) {
  return mutants.find(m => m.operator === operator && m.line === line) ?? null
}

// A 14-line implementation that exercises all five operators:
//   line 2  `if x < lo:`      -> boundary-flip + guard-removal
//   line 4  `elif x > hi:`    -> boundary-flip + guard-removal
//   line 9  `if i >= n:`      -> boundary-flip + guard-removal
//   line 10 `return -1`       -> off-by-one
//   line 11 `return i + 1`    -> off-by-one
//   line 14 `return a if a > b else b` -> comparison-flip (non-guard)
//   line 17 `return ok if ok else True` -> literal-flip
const IMPL = [
  'def clamp(x, lo, hi):',
  '    if x < lo:',
  '        return lo',
  '    elif x > hi:',
  '        return hi',
  '    return x',
  '',
  'def step(i, n):',
  '    if i >= n:',
  '        return -1',
  '    return i + 1',
  '',
  'def pick(a, b):',
  '    return a if a > b else b',
  '',
  'def flag(ok):',
  '    return ok if ok else True',
].join('\n')

// -- exports -------------------------------------------------------------------

console.log('exports:')
ok(MUTATION_DEFAULTS.maxMutants === 8, 'default maxMutants is 8')
ok(MUTATION_DEFAULTS.minKillRate === 0.6, 'default minKillRate is 0.6')
ok(typeof generateMutants === 'function', 'generateMutants is exported')
ok(typeof classifyMutantOutcome === 'function', 'classifyMutantOutcome is exported')
ok(typeof interpretMutationResults === 'function', 'interpretMutationResults is exported')
ok(typeof evaluateMutationProbe === 'function', 'evaluateMutationProbe is exported')
ok(typeof mutationEscalationReason === 'function', 'mutationEscalationReason is exported')
ok(typeof mutationProbeRequired === 'function', 'mutationProbeRequired is exported')

// -- mutationProbeRequired -----------------------------------------------------

console.log('\nmutationProbeRequired:')
ok(mutationProbeRequired(true, true) === true,  'code task + requiresVerifiedExecution -> required')
ok(mutationProbeRequired(false, true) === false, 'non-code task -> not required (nothing to mutate)')
ok(mutationProbeRequired(true, false) === false, 'code task but not a verification agent -> not required')
ok(mutationProbeRequired(false, false) === false, 'neither -> not required')

// -- generateMutants: all five operators ----------------------------------------

console.log('\ngenerateMutants (operator coverage):')
{
  const mutants = generateMutants(IMPL, 100)
  ok(Array.isArray(mutants) && mutants.length > 0, 'generates a non-empty mutant set')
  ok(mutants.length <= 100, 'respects an explicit maxMutants cap')

  const b1 = find(mutants, 'boundary-flip', 2)
  ok(!!b1 && b1.mutated === '    if x <= lo:', 'boundary-flip on guard `if x < lo:` -> `if x <= lo:`',
    b1 ? JSON.stringify(b1.mutated) : 'not found')

  const b2 = find(mutants, 'boundary-flip', 4)
  ok(!!b2 && b2.mutated === '    elif x >= hi:', 'boundary-flip on guard `elif x > hi:` -> `elif x >= hi:`',
    b2 ? JSON.stringify(b2.mutated) : 'not found')

  const b3 = find(mutants, 'boundary-flip', 9)
  ok(!!b3 && b3.mutated === '    if i > n:', 'boundary-flip on guard `if i >= n:` -> `if i > n:`',
    b3 ? JSON.stringify(b3.mutated) : 'not found')

  const g1 = find(mutants, 'guard-removal', 2)
  ok(!!g1 && g1.mutated === '    if not (x < lo):', 'guard-removal negates `if x < lo:` -> `if not (x < lo):`',
    g1 ? JSON.stringify(g1.mutated) : 'not found')

  const o1 = find(mutants, 'off-by-one', 11)
  ok(!!o1 && o1.mutated === '    return i + 2', 'off-by-one on `return i + 1` -> `return i + 2`',
    o1 ? JSON.stringify(o1.mutated) : 'not found')

  const o2 = find(mutants, 'off-by-one', 10)
  ok(!!o2 && o2.mutated === '        return -0', 'off-by-one on `return -1` -> `return -0`',
    o2 ? JSON.stringify(o2.mutated) : 'not found')

  const c1 = find(mutants, 'comparison-flip', 14)
  ok(!!c1 && c1.mutated === '    return a if a >= b else b', 'comparison-flip on non-guard ternary `a > b` -> `a >= b`',
    c1 ? JSON.stringify(c1.mutated) : 'not found')

  const l1 = find(mutants, 'literal-flip', 17)
  ok(!!l1 && l1.mutated === '    return ok if ok else False', 'literal-flip on `True` -> `False`',
    l1 ? JSON.stringify(l1.mutated) : 'not found')

  const ops = new Set(mutants.map(m => m.operator))
  ok(ops.has('comparison-flip') && ops.has('boundary-flip') && ops.has('off-by-one')
    && ops.has('guard-removal') && ops.has('literal-flip'),
    'all five operators are represented in the generated set')
}

// -- generateMutants: single-edit + code integrity ------------------------------

console.log('\ngenerateMutants (single-edit + code integrity):')
{
  const mutants = generateMutants(IMPL, 100)
  const m = mutants[0]
  ok(!!m, 'first mutant exists')
  if (m) {
    // Exactly one line differs from the original.
    const origLines = IMPL.split('\n')
    const mutLines  = m.code.split('\n')
    const diffs = mutLines.map((l, i) => (l !== origLines[i] ? i : -1)).filter(i => i >= 0)
    ok(diffs.length === 1 && diffs[0] === m.line - 1, 'exactly one line changed, at the mutant line',
      `diffs=${JSON.stringify(diffs)} line=${m.line}`)
    ok(mutLines[m.line - 1] === m.mutated, 'the changed line equals mutant.mutated')
    ok(m.original === origLines[m.line - 1], 'mutant.original is the untouched line')
  }
}

// -- generateMutants: dedup + cap ----------------------------------------------

console.log('\ngenerateMutants (dedup + cap):')
{
  // A line with a single comparison yields at most one comparison mutant, even
  // though the operator could in principle be applied repeatedly.
  const single = generateMutants('x = a > b')
  const compMutants = single.filter(m => m.operator === 'comparison-flip')
  ok(compMutants.length === 1, 'one comparison mutant per line (no duplicate edits)',
    `count=${compMutants.length}`)

  // The cap is respected on a dense implementation.
  const dense = Array.from({ length: 60 }, (_, i) => `if v${i} > 1:\n    return v${i} + 1`).join('\n')
  const capped = generateMutants(dense, MUTATION_DEFAULTS.maxMutants)
  ok(capped.length === MUTATION_DEFAULTS.maxMutants, 'dense input is capped at maxMutants',
    `len=${capped.length}`)
}

// -- classifyMutantOutcome ------------------------------------------------------

console.log('\nclassifyMutantOutcome:')
{
  // invalid: error set OR ran === 0 (a mutant the probe itself broke)
  ok(classifyMutantOutcome({ ok: false, ran: 0, failed: 0, errored: 0, error: 'impl raised SyntaxError: ...' }) === 'invalid',
    'error set -> invalid')
  ok(classifyMutantOutcome({ ok: false, ran: 0, failed: 0, errored: 0, error: null }) === 'invalid',
    'ran === 0 -> invalid (even with no error string)')
  // killed: at least one test failed or errored
  ok(classifyMutantOutcome({ ok: false, ran: 5, failed: 1, errored: 0, error: null }) === 'killed',
    'a failed test -> killed')
  ok(classifyMutantOutcome({ ok: false, ran: 5, failed: 0, errored: 2, error: null }) === 'killed',
    'an errored test -> killed')
  // survived: all passed, ran > 0
  ok(classifyMutantOutcome({ ok: true, ran: 5, failed: 0, errored: 0, error: null }) === 'survived',
    'all tests passed -> survived')
}

// -- interpretMutationResults ---------------------------------------------------

console.log('\ninterpretMutationResults:')
{
  const mk = (outcome, line) => ({ mutant: { operator: 'boundary-flip', line, original: 'x', mutated: 'y', code: 'z' }, outcome, ran: 1, failed: 0, errored: 0, error: null })
  const r = interpretMutationResults([
    mk('killed', 1), mk('killed', 2), mk('survived', 3), mk('invalid', 4),
  ])
  ok(r.total === 4, 'total counts all mutants')
  ok(r.killed === 2, 'killed count is correct')
  ok(r.survived === 1, 'survived count is correct')
  ok(r.invalid === 1, 'invalid count is correct')
  ok(r.mutants.length === 4, 'per-mutant roster is preserved')
}

// -- evaluateMutationProbe ------------------------------------------------------

console.log('\nevaluateMutationProbe:')
{
  const mkResult = (killed, survived, invalid) => ({
    total: killed + survived + invalid, killed, survived, invalid,
    mutants: [
      ...Array.from({ length: killed },   (_, i) => ({ mutant: { operator: 'boundary-flip', line: i + 1, original: 'o', mutated: 'k', code: 'c' }, outcome: 'killed',   ran: 1, failed: 1, errored: 0, error: null })),
      ...Array.from({ length: survived }, (_, i) => ({ mutant: { operator: 'literal-flip',  line: i + 1, original: 'o', mutated: 's', code: 'c' }, outcome: 'survived', ran: 1, failed: 0, errored: 0, error: null })),
      ...Array.from({ length: invalid },  (_, i) => ({ mutant: { operator: 'off-by-one',    line: i + 1, original: 'o', mutated: 'i', code: 'c' }, outcome: 'invalid',  ran: 0, failed: 0, errored: 0, error: 'x' })),
    ],
  })

  const notReq = evaluateMutationProbe(mkResult(0, 3, 0), false)
  ok(notReq.required === false && notReq.satisfied === true && notReq.reason === '',
    'not required -> satisfied by definition, empty reason')

  const noResult = evaluateMutationProbe(null, true)
  ok(noResult.required === true && noResult.satisfied === true,
    'required but probe did not run (null result) -> satisfied')

  const allInvalid = evaluateMutationProbe(mkResult(0, 0, 4), true)
  ok(allInvalid.satisfied === true,
    'all mutants invalid (nothing valid to kill) -> satisfied, not evidence of weakness')

  const allKilled = evaluateMutationProbe(mkResult(4, 0, 0), true)
  ok(allKilled.satisfied === true,
    'all valid mutants killed -> satisfied')

  const someSurvived = evaluateMutationProbe(mkResult(2, 2, 0), true)
  ok(someSurvived.satisfied === false && someSurvived.reason.startsWith('mutation_probe:'),
    'a surviving valid mutant -> not satisfied, reason leads with mutation_probe:')
  ok(someSurvived.reason.length > 'mutation_probe:'.length,
    'rejection reason carries actionable detail, not just the token')
}

// -- mutationEscalationReason ---------------------------------------------------

console.log('\nmutationEscalationReason:')
{
  const result = {
    total: 3, killed: 1, survived: 2, invalid: 0,
    mutants: [
      { mutant: { operator: 'boundary-flip', line: 2, original: '    if x < lo:', mutated: '    if x <= lo:', code: 'c' }, outcome: 'killed', ran: 1, failed: 1, errored: 0, error: null },
      { mutant: { operator: 'literal-flip',  line: 9, original: '    return True', mutated: '    return False', code: 'c' }, outcome: 'survived', ran: 1, failed: 0, errored: 0, error: null },
      { mutant: { operator: 'off-by-one',    line: 4, original: '    i + 1', mutated: '    i + 2', code: 'c' }, outcome: 'survived', ran: 1, failed: 0, errored: 0, error: null },
    ],
  }
  const reason = mutationEscalationReason(result)
  ok(reason.startsWith('mutation_probe:'), 'reason leads with the greppable mutation_probe: token')
  ok(reason.includes('2 of 3'), 'reason reports the survivor count vs valid mutants')
  ok(reason.includes('literal-flip@line9') && reason.includes('off-by-one@line4'),
    'reason names the surviving mutants (operator@line)')
  ok(!reason.includes('boundary-flip@line2'), 'reason does NOT name the killed mutant as a survivor')
}


// -- Executable-code-only mutation (Claude review fixes) -------------------------
console.log('\nexecutable-code-only mutation:')
{
  const code = [
    '"""Docstring with n + 1 and True and a >= b."""',
    'import sys',
    '',
    'def fib(n: int) -> int:',
    '    # n must be >= 0; True-ish',
    '    if n < 0:',
    '        raise ValueError("n must be >= 0")',
    '    a, b = 0, 1',
    '    for _ in range(n):',
    '        a, b = b, a + b',
    '    return a',
    '',
    "if __name__ == '__main__':",
    '    verbose = True',
    '    print(fib(3) > 1)',
  ].join('\n')
  const ms = generateMutants(code, 100)
  const lines = ms.map(m => m.line)
  ok(!lines.includes(1), 'docstring line is never mutated')
  ok(!lines.includes(4), 'def signature (-> annotation) is never mutated')
  ok(!lines.includes(5), 'comment line is never mutated')
  ok(!lines.includes(7), 'string literal inside raise is never mutated')
  ok(!lines.some(l => l >= 13), '__main__ block is never mutated')
  ok(lines.includes(6), 'the real guard `if n < 0:` is mutated')
  ok(ms.every(m => !m.mutated.includes('->=')), 'no mutant breaks a return annotation')
  const many = Array.from({ length: 40 }, (_, i) => `x${i} = a${i} > b${i}`).join('\n')
  const spread = generateMutants(many, 8).map(m => m.line)
  ok(Math.max(...spread) > 30, 'mutants are sampled across the whole file, not front-loaded', spread.join(','))
  const mk = (k, s) => ({ total: k + s, killed: k, survived: s, invalid: 0, mutants: [] })
  ok(evaluateMutationProbe(mk(7, 3), true).satisfied === true, 'kill rate 70% (>= 60%) -> satisfied')
  ok(evaluateMutationProbe(mk(5, 5), true).satisfied === false, 'kill rate 50% (< 60%) -> not satisfied')
  ok(mutationMode(undefined) === 'advisory' && mutationMode('') === 'advisory', 'default mode is advisory')
  ok(mutationMode('block') === 'block' && mutationMode('OFF') === 'off' && mutationMode('junk') === 'advisory', 'mode parsing')
}

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
