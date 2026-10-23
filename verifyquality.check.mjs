// Verifies the progress-quality verify contract (see src/bullettrain/verifyquality.ts).
// Follows the check.mjs pattern: a standalone assertion script, no test framework.
// Run after a build:  npm run build && node verifyquality.check.mjs
//
// It unit-tests the pure logic behind frontier item 14 (F2, "no progress-quality
// notion beyond 'verify command exited 0'"):
//   1. assessVerifyCommand -- does the verify command check behavior, or is it
//      trivial (always-passes / existence-only / print-only)?
//   2. parseVerifyReport   -- extract a structured "VERIFY <name> PASS|FAIL|SKIP"
//      report the command may emit.
//   3. summarizeVerifyQuality -- render the run-report "Verify quality" section.
// All three are pure (no LLM, no execution) so they can be asserted deterministically.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const MODULE = process.env.VERIFYQUALITY_MODULE || path.join(here, 'dist', 'bullettrain', 'verifyquality.js')

const {
  assessVerifyCommand,
  parseVerifyReport,
  summarizeVerifyQuality,
} = await import(pathToFileURL(MODULE).href)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}
// Convenience: assert an assessment's quality.
function quality(cmd, expected, label) {
  const a = assessVerifyCommand(cmd)
  ok(a.quality === expected, label, `got ${a.quality} (${a.reasons.join('; ')})`)
}

// -- assessVerifyCommand: manual / empty -----------------------------------------

console.log('assessVerifyCommand (manual / empty):')
quality('', 'trivial', 'empty -> trivial')
quality('   \n  ', 'trivial', 'whitespace-only -> trivial')
quality('manual', 'manual', 'literal "manual" sentinel -> manual')
quality('MANUAL', 'manual', 'case-insensitive "manual" -> manual')

// -- assessVerifyCommand: behavioral ---------------------------------------------

console.log('\nassessVerifyCommand (behavioral):')
quality('pytest', 'behavioral', 'pytest -> behavioral')
quality('python -m pytest', 'behavioral', 'python -m pytest -> behavioral')
quality('python3 -m unittest', 'behavioral', 'python3 -m unittest -> behavioral')
quality('npm test', 'behavioral', 'npm test -> behavioral')
quality('npm run test', 'behavioral', 'npm run test -> behavioral')
quality('npx jest', 'behavioral', 'npx jest -> behavioral')
quality('mocha', 'behavioral', 'bare mocha -> behavioral')
quality('go test ./...', 'behavioral', 'go test -> behavioral')
quality('cargo test', 'behavioral', 'cargo test -> behavioral')
quality('make test', 'behavioral', 'make test -> behavioral')
quality('curl http://localhost:8000/health', 'behavioral', 'curl endpoint -> behavioral')
quality('wget http://localhost:8000/', 'behavioral', 'wget endpoint -> behavioral')
quality('python app.py', 'behavioral', 'invoke python artifact -> behavioral')
quality('node server.js', 'behavioral', 'invoke node artifact -> behavioral')
quality('bash run.sh', 'behavioral', 'run a shell script -> behavioral')
quality('node --test', 'behavioral', 'node --test -> behavioral')

// -- assessVerifyCommand: trivial ------------------------------------------------

console.log('\nassessVerifyCommand (trivial):')
quality('true', 'trivial', 'true -> trivial (always passes)')
quality(':', 'trivial', ': -> trivial (no-op)')
quality('exit 0', 'trivial', 'exit 0 -> trivial (always passes)')
quality('test -f app.py', 'trivial', 'test -f -> trivial (existence only)')
quality('[ -f app.py ]', 'trivial', '[ -f ] -> trivial (existence only)')
quality('echo done', 'trivial', 'echo -> trivial (print only)')
quality('printf "ok"', 'trivial', 'printf -> trivial (print only)')
quality('ls', 'trivial', 'ls -> trivial (list only)')
quality('cat output.txt', 'trivial', 'cat -> trivial (read only)')

// -- assessVerifyCommand: compound + other ----------------------------------------

console.log('\nassessVerifyCommand (compound / other):')
quality('test -f app.py && pytest', 'behavioral', 'compound test -f && pytest -> behavioral (real check wins)')
quality('some unknown tool --flag', 'other', 'unrecognized -> other (neutral, not flagged)')
quality('mycustomchecker --strict', 'other', 'custom tool -> other (bias against false positives)')

// -- parseVerifyReport: no report ------------------------------------------------

console.log('\nparseVerifyReport (no report):')
{
  const r = parseVerifyReport('')
  ok(r.hasReport === false && r.checks.length === 0 && r.summary === null, 'empty stdout -> no report')
  const r2 = parseVerifyReport('just some output\nno structured checks here')
  ok(r2.hasReport === false && r2.checks.length === 0, 'prose only -> no report')
}

// -- parseVerifyReport: reports --------------------------------------------------

console.log('\nparseVerifyReport (reports):')
{
  const r = parseVerifyReport('VERIFY build PASS')
  ok(r.hasReport === true && r.checks.length === 1 && r.checks[0].name === 'build' && r.checks[0].status === 'pass',
    'single PASS check parsed')
  ok(r.summary === 'pass', 'all-pass summary -> pass')

  const r2 = parseVerifyReport('VERIFY a PASS\nVERIFY b PASS')
  ok(r2.checks.length === 2 && r2.summary === 'pass', 'two PASS checks -> pass')

  const r3 = parseVerifyReport('VERIFY a PASS\nVERIFY b FAIL')
  ok(r3.checks.length === 2 && r3.summary === 'fail', 'a FAIL check -> fail (failure takes precedence)')

  const r4 = parseVerifyReport('VERIFY a PASS\nVERIFY b FAIL\nVERIFY c SKIP')
  ok(r4.checks.length === 3 && r4.summary === 'fail', 'mixed pass/fail/skip -> fail')

  const r5 = parseVerifyReport('VERIFY a SKIP\nVERIFY b SKIP')
  ok(r5.checks.length === 2 && r5.summary === null, 'only skips -> null summary')

  const r6 = parseVerifyReport('  verify x pass  ')
  ok(r6.hasReport === true && r6.checks.length === 1 && r6.checks[0].name === 'x' && r6.checks[0].status === 'pass',
    'case-insensitive + leading whitespace tolerated')

  const r7 = parseVerifyReport('noise line\nVERIFY a PASS\nmore noise')
  ok(r7.hasReport === true && r7.checks.length === 1, 'surrounding noise ignored, only check line extracted')
}

// -- summarizeVerifyQuality ------------------------------------------------------

console.log('\nsummarizeVerifyQuality:')
{
  const none = summarizeVerifyQuality([{ id: 't1', verify: 'pytest' }], {})
  ok(none.length === 1 && none[0].startsWith('No trivial verify commands detected'),
    'no trivial + no reports -> single neutral line')

  const trivial = summarizeVerifyQuality([{ id: 't1', verify: 'true' }], {})
  ok(trivial.some(l => l.startsWith('WARNING: trivial verify command(s)'))
    && trivial.some(l => l.includes('task t1')),
    'trivial verify command -> WARNING section names the task')

  const reports = summarizeVerifyQuality(
    [{ id: 't1', verify: 'pytest' }],
    { t1: { hasReport: true, checks: [{ name: 'build', status: 'pass' }], summary: 'pass' } },
  )
  ok(reports.some(l => l.startsWith('Structured verify reports:'))
    && reports.some(l => l.includes('task t1') && l.includes('build=pass')),
    'structured report -> listed with per-check detail')

  const both = summarizeVerifyQuality(
    [{ id: 't1', verify: 'true' }, { id: 't2', verify: 'pytest' }],
    { t2: { hasReport: true, checks: [{ name: 'build', status: 'fail' }], summary: 'fail' } },
  )
  ok(both.some(l => l.startsWith('WARNING: trivial verify command(s)'))
    && both.some(l => l.startsWith('Structured verify reports:')),
    'both a trivial warning and a structured report -> both sections rendered')
}

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
