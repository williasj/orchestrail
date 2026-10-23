// Verifies the independent evaluation suite contract (see src/utils/evaluation.ts,
// frontier item 9). Follows the check.mjs pattern: a standalone assertion script,
// no test framework. Run after a build:  npm run build && node evaluation.check.mjs
//
// It unit-tests the pure scoring / comparison logic behind the evaluation suite:
// grader-output parsing, per-config aggregation, config-vs-baseline comparison,
// and report rendering. The live-run part (actual baseline runs against a live
// model) is in benchmarks/baselines.mjs and is an operational follow-up.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const EVAL = process.env.EVAL_MODULE || path.join(here, 'dist', 'utils', 'evaluation.js')

const {
  EVAL_DEFAULTS,
  CONFIG_SINGLE_AGENT,
  CONFIG_TWO_AGENT,
  CONFIG_FULL_PIPELINE,
  parseGraderOutput,
  aggregateRuns,
  compareConfigs,
  buildReport,
  renderReport,
} = await import(pathToFileURL(EVAL).href)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}

// -- exports -------------------------------------------------------------------

console.log('exports:')
ok(EVAL_DEFAULTS.qualityThreshold === 0.05, 'default qualityThreshold is 0.05')
ok(CONFIG_SINGLE_AGENT === 'single-agent', 'CONFIG_SINGLE_AGENT constant')
ok(CONFIG_TWO_AGENT === 'two-agent', 'CONFIG_TWO_AGENT constant')
ok(CONFIG_FULL_PIPELINE === 'full-pipeline', 'CONFIG_FULL_PIPELINE constant')
ok(typeof parseGraderOutput === 'function', 'parseGraderOutput is exported')
ok(typeof aggregateRuns === 'function', 'aggregateRuns is exported')
ok(typeof compareConfigs === 'function', 'compareConfigs is exported')
ok(typeof buildReport === 'function', 'buildReport is exported')
ok(typeof renderReport === 'function', 'renderReport is exported')

// -- parseGraderOutput: FAIL-only grader (fib / lru / rl) -----------------------

console.log('\nparseGraderOutput (FAIL-only grader, all pass):')
{
  // Simulates grade_fib.py when every check passes: no FAIL lines, just SCORE.
  const out = 'SCORE 14/14'
  const r = parseGraderOutput(out, 'fib')
  ok(r.grader === 'fib', 'grader name preserved')
  ok(r.passed === 14, 'passed = 14')
  ok(r.failed === 0, 'failed = 0')
  ok(r.total === 14, 'total = 14')
  ok(r.hasScore === true, 'hasScore is true')
  ok(r.scoreLine === 'SCORE 14/14', 'scoreLine captured')
  ok(r.failedChecks.length === 0, 'no failed checks')
  ok(r.passedChecks.length === 0, 'no passed checks (FAIL-only grader)')
  ok(r.diagnostics.length === 0, 'no diagnostics')
}

console.log('\nparseGraderOutput (FAIL-only grader, partial pass):')
{
  // Simulates grade_fib.py with 3 of 14 checks failing.
  const out = [
    'FAIL F(0..30) correct',
    'FAIL memo reused across calls',
    'FAIL docstrings',
    'SCORE 11/14',
  ].join('\n')
  const r = parseGraderOutput(out, 'fib')
  ok(r.passed === 11, 'passed = 11 (from SCORE line)')
  ok(r.failed === 3, 'failed = 3 (total - passed)')
  ok(r.total === 14, 'total = 14')
  ok(r.failedChecks.length === 3, '3 failed checks captured')
  ok(r.failedChecks[0] === 'F(0..30) correct', 'first failed check name correct')
  ok(r.failedChecks[2] === 'docstrings', 'third failed check name correct')
  ok(r.passedChecks.length === 0, 'no PASS lines in FAIL-only grader')
  ok(r.diagnostics.length === 0, 'no diagnostics')
}

// -- parseGraderOutput: diagnostic lines ----------------------------------------

console.log('\nparseGraderOutput (diagnostic lines):')
{
  // Simulates grade_rl.py: a `clock injection:` diagnostic line plus FAIL lines.
  const out = [
    'clock injection: True',
    'FAIL token bucket: burst of capacity then deny',
    'SCORE 9/11',
  ].join('\n')
  const r = parseGraderOutput(out, 'rl')
  ok(r.passed === 9, 'passed = 9')
  ok(r.failed === 2, 'failed = 2')
  ok(r.total === 11, 'total = 11')
  ok(r.diagnostics.length === 1, 'one diagnostic line captured')
  ok(r.diagnostics[0] === 'clock injection: True', 'diagnostic content correct')
  ok(r.failedChecks.length === 1, 'one failed check')
}

console.log('\nparseGraderOutput (lru helper diagnostic):')
{
  // Simulates grade_lru.py: a `helper:` diagnostic line.
  const out = [
    'helper: None',
    'FAIL operations helper returns state after each step',
    'SCORE 12/13',
  ].join('\n')
  const r = parseGraderOutput(out, 'lru')
  ok(r.diagnostics.length === 1, 'one diagnostic line')
  ok(r.diagnostics[0] === 'helper: None', 'helper diagnostic captured')
  ok(r.passed === 12, 'passed = 12')
  ok(r.failed === 1, 'failed = 1')
}

// -- parseGraderOutput: PASS-line grader (sales / compose) -----------------------

console.log('\nparseGraderOutput (PASS-line grader):')
{
  // Simulates grade_sales.py: both PASS and FAIL lines.
  const out = [
    'PASS sample generator works',
    'FAIL report runs on real data',
    'PASS three sheets By Region / By Month / Top Products',
    'FAIL region revenue correct',
    'SCORE 8/10',
  ].join('\n')
  const r = parseGraderOutput(out, 'sales')
  ok(r.passed === 8, 'passed = 8 (from SCORE line, not PASS-line count)')
  ok(r.failed === 2, 'failed = 2')
  ok(r.total === 10, 'total = 10')
  ok(r.passedChecks.length === 2, '2 PASS lines captured')
  ok(r.passedChecks[0] === 'sample generator works', 'first PASS check name')
  ok(r.failedChecks.length === 2, '2 FAIL lines captured')
  ok(r.failedChecks[0] === 'report runs on real data', 'first FAIL check name')
}

// -- parseGraderOutput: no SCORE line (grader crashed) ---------------------------

console.log('\nparseGraderOutput (no SCORE line, grader crashed):')
{
  // Simulates a grader that crashed with a traceback before emitting SCORE.
  const out = [
    'Traceback (most recent call last):',
    '  File "grade_fib.py", line 5, in <module>',
    '    spec.loader.exec_module(m)',
    '  File "impl.py", line 1',
    '    def fibonacci(n, memo=None):',
    'SyntaxError: invalid syntax',
  ].join('\n')
  const r = parseGraderOutput(out, 'fib')
  ok(r.hasScore === false, 'hasScore is false')
  ok(r.scoreLine === null, 'scoreLine is null')
  ok(r.passed === 0, 'passed = 0 (no PASS lines)')
  ok(r.failed === 0, 'failed = 0 (no FAIL lines)')
  ok(r.total === 0, 'total = 0')
  ok(r.diagnostics.length === 6, '6 diagnostic lines (traceback)')
}

// -- parseGraderOutput: empty output ---------------------------------------------

console.log('\nparseGraderOutput (empty output):')
{
  const r = parseGraderOutput('', 'fib')
  ok(r.hasScore === false, 'hasScore false')
  ok(r.passed === 0, 'passed = 0')
  ok(r.failed === 0, 'failed = 0')
  ok(r.total === 0, 'total = 0')
  ok(r.diagnostics.length === 0, 'no diagnostics')
}

// -- parseGraderOutput: SCORE 0/0 edge case --------------------------------------

console.log('\nparseGraderOutput (SCORE 0/0):')
{
  const r = parseGraderOutput('SCORE 0/0', 'fib')
  ok(r.hasScore === true, 'hasScore true')
  ok(r.passed === 0, 'passed = 0')
  ok(r.failed === 0, 'failed = 0')
  ok(r.total === 0, 'total = 0')
}

// -- parseGraderOutput: trailing whitespace / blank lines ------------------------

console.log('\nparseGraderOutput (blank lines ignored):')
{
  const out = [
    '',
    'FAIL check one',
    '',
    'SCORE 1/2',
    '',
  ].join('\n')
  const r = parseGraderOutput(out, 'fib')
  ok(r.passed === 1, 'passed = 1')
  ok(r.failed === 1, 'failed = 1')
  ok(r.total === 2, 'total = 2')
  ok(r.diagnostics.length === 0, 'blank lines not captured as diagnostics')
}

// -- aggregateRuns: empty --------------------------------------------------------

console.log('\naggregateRuns (empty):')
{
  const agg = aggregateRuns([])
  ok(agg.config === '', 'empty config name')
  ok(agg.totalRuns === 0, 'totalRuns = 0')
  ok(agg.completedRuns === 0, 'completedRuns = 0')
  ok(agg.meanScore === 0, 'meanScore = 0')
  ok(agg.meanDurationMs === 0, 'meanDurationMs = 0')
  ok(Object.keys(agg.perTask).length === 0, 'perTask is empty')
}

// -- aggregateRuns: known records ------------------------------------------------

console.log('\naggregateRuns (known records):')
{
  const mkGrader = (passed, total) => ({
    grader: 'fib', passed, failed: total - passed, total,
    hasScore: true, scoreLine: `SCORE ${passed}/${total}`,
    failedChecks: [], passedChecks: [], diagnostics: [],
  })
  const records = [
    { task: 'fib', config: 'full-pipeline', grader: mkGrader(14, 14), durationMs: 1000, completed: true,  error: null },
    { task: 'lru', config: 'full-pipeline', grader: mkGrader(12, 13), durationMs: 2000, completed: true,  error: null },
    { task: 'fib', config: 'full-pipeline', grader: mkGrader(0, 0),   durationMs: 500,  completed: false, error: 'pipeline timeout' },
  ]
  const agg = aggregateRuns(records)
  ok(agg.config === 'full-pipeline', 'config name from first record')
  ok(agg.totalRuns === 3, 'totalRuns = 3')
  ok(agg.completedRuns === 2, 'completedRuns = 2')
  // meanScore = (14/14 + 12/13) / 2 = (1 + 0.923077) / 2 = 0.961538
  ok(Math.abs(agg.meanScore - (1 + 12/13) / 2) < 1e-9, 'meanScore is correct',
    `got ${agg.meanScore}`)
  ok(Math.abs(agg.meanDurationMs - 1500) < 1e-9, 'meanDurationMs = 1500')
  ok(agg.perTask['fib'] === 1, 'perTask fib = 1.0 (only completed run)')
  ok(Math.abs(agg.perTask['lru'] - 12/13) < 1e-9, 'perTask lru = 12/13')
  ok(agg.runs.length === 3, 'all runs preserved in aggregate')
}

// -- aggregateRuns: all failed ---------------------------------------------------

console.log('\naggregateRuns (all runs failed):')
{
  const records = [
    { task: 'fib', config: 'single-agent', grader: { grader: 'fib', passed: 0, failed: 0, total: 0, hasScore: false, scoreLine: null, failedChecks: [], passedChecks: [], diagnostics: [] }, durationMs: 100, completed: false, error: 'no artifact' },
  ]
  const agg = aggregateRuns(records)
  ok(agg.completedRuns === 0, 'completedRuns = 0')
  ok(agg.meanScore === 0, 'meanScore = 0 (no completed runs)')
  ok(agg.meanDurationMs === 0, 'meanDurationMs = 0')
}

// -- compareConfigs ---------------------------------------------------------------

console.log('\ncompareConfigs (above threshold):')
{
  const mkAgg = (config, meanScore) => ({
    config, runs: [], totalRuns: 1, completedRuns: 1,
    meanScore, meanDurationMs: 1000, perTask: {},
  })
  const full = mkAgg('full-pipeline', 0.95)
  const single = mkAgg('single-agent', 0.70)
  const c = compareConfigs(single, full)
  ok(c.config === 'single-agent', 'config name')
  ok(c.baseline === 'full-pipeline', 'baseline name')
  ok(c.score === 0.70, 'score = 0.70')
  ok(c.baselineScore === 0.95, 'baselineScore = 0.95')
  ok(Math.abs(c.delta - (-0.25)) < 1e-9, 'delta = -0.25')
  ok(c.withinThreshold === false, '0.25 > 0.05 -> exceeds threshold')
  ok(c.threshold === 0.05, 'default threshold used')
}

console.log('\ncompareConfigs (within threshold):')
{
  const mkAgg = (config, meanScore) => ({
    config, runs: [], totalRuns: 1, completedRuns: 1,
    meanScore, meanDurationMs: 1000, perTask: {},
  })
  const full = mkAgg('full-pipeline', 0.90)
  const two = mkAgg('two-agent', 0.88)
  const c = compareConfigs(two, full)
  ok(Math.abs(c.delta - (-0.02)) < 1e-9, 'delta = -0.02')
  ok(c.withinThreshold === true, '0.02 <= 0.05 -> within threshold')
}

console.log('\ncompareConfigs (exact threshold boundary):')
{
  const mkAgg = (config, meanScore) => ({
    config, runs: [], totalRuns: 1, completedRuns: 1,
    meanScore, meanDurationMs: 1000, perTask: {},
  })
  // Use exactly-representable binary fractions to avoid FP imprecision at the boundary.
  const full = mkAgg('full-pipeline', 0.5)
  const single = mkAgg('single-agent', 0.25)
  const c = compareConfigs(single, full, 0.25)
  ok(c.delta === -0.25, 'delta = -0.25 (exact)')
  ok(c.withinThreshold === true, '0.25 <= 0.25 -> within threshold (boundary)')
}

console.log('\ncompareConfigs (custom threshold):')
{
  const mkAgg = (config, meanScore) => ({
    config, runs: [], totalRuns: 1, completedRuns: 1,
    meanScore, meanDurationMs: 1000, perTask: {},
  })
  const full = mkAgg('full-pipeline', 0.90)
  const single = mkAgg('single-agent', 0.80)
  const c = compareConfigs(single, full, 0.10)
  ok(c.threshold === 0.10, 'custom threshold used')
  ok(c.withinThreshold === true, '0.10 <= 0.10 -> within threshold')
}

// -- buildReport ------------------------------------------------------------------

console.log('\nbuildReport (baseline present):')
{
  const mkAgg = (config, meanScore) => ({
    config, runs: [], totalRuns: 1, completedRuns: 1,
    meanScore, meanDurationMs: 1000, perTask: {},
  })
  const aggs = [
    mkAgg('full-pipeline', 0.95),
    mkAgg('two-agent', 0.90),
    mkAgg('single-agent', 0.70),
  ]
  const report = buildReport(aggs)
  ok(report.baseline === 'full-pipeline', 'default baseline is full-pipeline')
  ok(report.aggregates.length === 3, 'all aggregates preserved')
  ok(report.comparisons.length === 2, 'two comparisons (non-baseline configs)')
  const twoComp = report.comparisons.find(c => c.config === 'two-agent')
  const singleComp = report.comparisons.find(c => c.config === 'single-agent')
  ok(!!twoComp, 'two-agent comparison present')
  ok(!!singleComp, 'single-agent comparison present')
  ok(twoComp && twoComp.baseline === 'full-pipeline', 'two-agent baseline is full-pipeline')
  ok(report.comparisons.every(c => c.config !== 'full-pipeline'), 'baseline not compared against itself')
}

console.log('\nbuildReport (baseline missing):')
{
  const mkAgg = (config, meanScore) => ({
    config, runs: [], totalRuns: 1, completedRuns: 1,
    meanScore, meanDurationMs: 1000, perTask: {},
  })
  const aggs = [mkAgg('single-agent', 0.70), mkAgg('two-agent', 0.90)]
  const report = buildReport(aggs, 'full-pipeline')
  ok(report.baseline === 'full-pipeline', 'baseline name preserved')
  ok(report.comparisons.length === 0, 'no comparisons when baseline missing')
  ok(report.aggregates.length === 2, 'aggregates still present')
}

console.log('\nbuildReport (custom baseline):')
{
  const mkAgg = (config, meanScore) => ({
    config, runs: [], totalRuns: 1, completedRuns: 1,
    meanScore, meanDurationMs: 1000, perTask: {},
  })
  const aggs = [
    mkAgg('full-pipeline', 0.95),
    mkAgg('two-agent', 0.90),
    mkAgg('single-agent', 0.70),
  ]
  const report = buildReport(aggs, 'two-agent')
  ok(report.baseline === 'two-agent', 'custom baseline')
  ok(report.comparisons.length === 2, 'two comparisons vs two-agent')
  ok(report.comparisons.every(c => c.baseline === 'two-agent'), 'all comparisons use two-agent baseline')
  ok(!report.comparisons.some(c => c.config === 'two-agent'), 'two-agent not compared against itself')
}

// -- renderReport -----------------------------------------------------------------

console.log('\nrenderReport:')
{
  const mkAgg = (config, meanScore, perTask) => ({
    config, runs: [], totalRuns: 1, completedRuns: 1,
    meanScore, meanDurationMs: 1500, perTask,
  })
  const aggs = [
    mkAgg('full-pipeline', 0.95, { fib: 1.0, lru: 0.92 }),
    mkAgg('single-agent', 0.70, { fib: 0.65, lru: 0.75 }),
  ]
  const report = buildReport(aggs)
  const rendered = renderReport(report)
  ok(rendered.includes('# Evaluation Report'), 'has title')
  ok(rendered.includes('Baseline: full-pipeline'), 'has baseline line')
  ok(rendered.includes('## full-pipeline'), 'has full-pipeline section')
  ok(rendered.includes('## single-agent'), 'has single-agent section')
  ok(rendered.includes('Mean score: 95.0%'), 'full-pipeline mean score rendered')
  ok(rendered.includes('Mean score: 70.0%'), 'single-agent mean score rendered')
  ok(rendered.includes('fib: 100.0%'), 'per-task fib rendered')
  ok(rendered.includes('## Comparison vs full-pipeline'), 'has comparison section')
  ok(rendered.includes('single-agent:'), 'comparison line for single-agent')
  ok(rendered.includes('exceeds threshold'), 'single-agent exceeds threshold (0.25 > 0.05)')
  ok(rendered.includes('Generated:'), 'has timestamp line')
}

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
