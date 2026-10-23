// Verifies the repeat-run benchmark contract (see src/utils/repeat.ts,
// frontier item 12). Follows the check.mjs pattern: a standalone assertion
// script, no test framework. Run after a build:  npm run build && node repeat.check.mjs
//
// It unit-tests the pure statistics behind repeat-run benchmarks: spread
// (mean / sample std-dev / min / max), per-config-x-task aggregation across
// reps, two-group A/B comparison (e.g. wiki-on vs wiki-off), and report
// rendering. The live-run part (driving N reps per config x task against a
// live model, capturing tokens, running the graders) is in
// benchmarks/baselines.mjs and is an operational follow-up.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPEAT = process.env.REPEAT_MODULE || path.join(here, 'dist', 'utils', 'repeat.js')

const {
  describeSpread,
  aggregateReps,
  compareRepGroups,
  renderRepTable,
  renderRepComparison,
} = await import(pathToFileURL(REPEAT).href)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}

// -- helpers ---------------------------------------------------------------------

/** Hand-crafted RunRecord with a SCORE-style grader result. */
function mkRecord({ task, config, passed, total, durationMs, completed = true, error = null, tokens, rep }) {
  return {
    task,
    config,
    grader: {
      grader: task, passed, failed: total - passed, total,
      hasScore: total > 0, scoreLine: total > 0 ? `SCORE ${passed}/${total}` : null,
      failedChecks: [], passedChecks: [], diagnostics: [],
    },
    durationMs,
    completed,
    error,
    ...(typeof tokens === 'number' ? { tokens } : {}),
    ...(typeof rep === 'number' ? { rep } : {}),
  }
}

// -- exports ---------------------------------------------------------------------

console.log('exports:')
ok(typeof describeSpread === 'function', 'describeSpread is exported')
ok(typeof aggregateReps === 'function', 'aggregateReps is exported')
ok(typeof compareRepGroups === 'function', 'compareRepGroups is exported')
ok(typeof renderRepTable === 'function', 'renderRepTable is exported')
ok(typeof renderRepComparison === 'function', 'renderRepComparison is exported')

// -- describeSpread ----------------------------------------------------------------

console.log('\ndescribeSpread (empty):')
{
  const s = describeSpread([])
  ok(s.n === 0, 'n = 0')
  ok(s.mean === 0, 'mean = 0')
  ok(s.stdDev === 0, 'stdDev = 0')
  ok(s.min === 0, 'min = 0')
  ok(s.max === 0, 'max = 0')
}

console.log('\ndescribeSpread (single value):')
{
  const s = describeSpread([5])
  ok(s.n === 1, 'n = 1')
  ok(s.mean === 5, 'mean = 5')
  ok(s.stdDev === 0, 'stdDev = 0 (n < 2)')
  ok(s.min === 5, 'min = 5')
  ok(s.max === 5, 'max = 5')
}

console.log('\ndescribeSpread (two values):')
{
  const s = describeSpread([2, 4])
  ok(s.n === 2, 'n = 2')
  ok(Math.abs(s.mean - 3) < 1e-12, 'mean = 3')
  ok(Math.abs(s.stdDev - Math.SQRT2) < 1e-12, 'sample stdDev = sqrt(2)')
  ok(s.min === 2, 'min = 2')
  ok(s.max === 4, 'max = 4')
}

console.log('\ndescribeSpread (three values):')
{
  const s = describeSpread([1, 2, 3])
  ok(s.n === 3, 'n = 3')
  ok(Math.abs(s.mean - 2) < 1e-12, 'mean = 2')
  ok(Math.abs(s.stdDev - 1) < 1e-12, 'sample stdDev = 1')
  ok(s.min === 1, 'min = 1')
  ok(s.max === 3, 'max = 3')
}

console.log('\ndescribeSpread (four values):')
{
  const s = describeSpread([10, 20, 30, 40])
  ok(s.n === 4, 'n = 4')
  ok(Math.abs(s.mean - 25) < 1e-12, 'mean = 25')
  // ss = 225 + 25 + 25 + 225 = 500; 500 / 3 = 166.666...; sqrt = 12.909944487...
  ok(Math.abs(s.stdDev - Math.sqrt(500 / 3)) < 1e-12, 'sample stdDev = sqrt(500/3)')
  ok(s.min === 10, 'min = 10')
  ok(s.max === 40, 'max = 40')
}

console.log('\ndescribeSpread (negative values):')
{
  const s = describeSpread([-1, 1])
  ok(Math.abs(s.mean) < 1e-12, 'mean = 0')
  ok(Math.abs(s.stdDev - Math.SQRT2) < 1e-12, 'sample stdDev = sqrt(2)')
  ok(s.min === -1, 'min = -1')
  ok(s.max === 1, 'max = 1')
}

// -- aggregateReps -----------------------------------------------------------------

console.log('\naggregateReps (empty):')
{
  const aggs = aggregateReps([])
  ok(aggs.length === 0, 'no groups')
}

console.log('\naggregateReps (single group, 3 reps):')
{
  const records = [
    mkRecord({ task: 'fib', config: 'full-pipeline', passed: 14, total: 14, durationMs: 1000, tokens: 100, rep: 1 }),
    mkRecord({ task: 'fib', config: 'full-pipeline', passed: 14, total: 14, durationMs: 2000, tokens: 200, rep: 2 }),
    mkRecord({ task: 'fib', config: 'full-pipeline', passed: 7,  total: 14, durationMs: 3000, tokens: 300, rep: 3 }),
  ]
  const aggs = aggregateReps(records)
  ok(aggs.length === 1, 'one group')
  const a = aggs[0]
  ok(a.config === 'full-pipeline', 'config name')
  ok(a.task === 'fib', 'task name')
  ok(a.reps === 3, 'reps = 3')
  ok(a.completedReps === 3, 'completedReps = 3')
  // scores [1, 1, 0.5]: mean = 0.83333..., sample stdDev = 0.288675...
  ok(Math.abs(a.score.mean - 2.5 / 3) < 1e-12, 'score mean = 2.5/3', `got ${a.score.mean}`)
  ok(Math.abs(a.score.stdDev - 0.2886751345948129) < 1e-12, 'score sample stdDev correct', `got ${a.score.stdDev}`)
  ok(a.score.min === 0.5, 'score min = 0.5')
  ok(a.score.max === 1, 'score max = 1')
  ok(a.score.n === 3, 'score n = 3')
  // durations [1000, 2000, 3000]: mean 2000, sample stdDev 1000
  ok(Math.abs(a.durationMs.mean - 2000) < 1e-12, 'duration mean = 2000')
  ok(Math.abs(a.durationMs.stdDev - 1000) < 1e-12, 'duration sample stdDev = 1000')
  ok(a.durationMs.min === 1000, 'duration min = 1000')
  ok(a.durationMs.max === 3000, 'duration max = 3000')
  // tokens [100, 200, 300]: mean 200, sample stdDev 100
  ok(a.tokens !== null, 'tokens stats present')
  ok(Math.abs(a.tokens.mean - 200) < 1e-12, 'tokens mean = 200')
  ok(Math.abs(a.tokens.stdDev - 100) < 1e-12, 'tokens sample stdDev = 100')
  ok(a.tokens.n === 3, 'tokens n = 3')
}

console.log('\naggregateReps (failed rep excluded from stats):')
{
  const records = [
    mkRecord({ task: 'fib', config: 'full-pipeline', passed: 14, total: 14, durationMs: 1000, tokens: 100, rep: 1 }),
    mkRecord({ task: 'fib', config: 'full-pipeline', passed: 14, total: 14, durationMs: 2000, tokens: 200, rep: 2 }),
    mkRecord({ task: 'fib', config: 'full-pipeline', passed: 0,  total: 0,  durationMs: 500,  tokens: 50,  rep: 3, completed: false, error: 'pipeline timeout' }),
  ]
  const aggs = aggregateReps(records)
  const a = aggs[0]
  ok(a.reps === 3, 'reps = 3 (failed rep counted)')
  ok(a.completedReps === 2, 'completedReps = 2')
  ok(a.score.n === 2, 'score stats use 2 completed reps')
  ok(Math.abs(a.score.mean - 1) < 1e-12, 'score mean = 1.0 (failed rep excluded)')
  ok(a.tokens.n === 2, 'tokens stats use 2 completed reps (failed rep tokens excluded)')
  ok(Math.abs(a.tokens.mean - 150) < 1e-12, 'tokens mean = 150')
}

console.log('\naggregateReps (no tokens -> null):')
{
  const records = [
    mkRecord({ task: 'fib', config: 'single-agent', passed: 14, total: 14, durationMs: 1000, rep: 1 }),
  ]
  const aggs = aggregateReps(records)
  ok(aggs[0].tokens === null, 'tokens is null when no completed rep has tokens')
  ok(aggs[0].score.n === 1, 'score stats still present')
}

console.log('\naggregateReps (multiple groups, first-seen order):')
{
  const records = [
    mkRecord({ task: 'fib', config: 'full-pipeline', passed: 14, total: 14, durationMs: 1000, rep: 1 }),
    mkRecord({ task: 'lru', config: 'full-pipeline', passed: 12, total: 13, durationMs: 2000, rep: 1 }),
    mkRecord({ task: 'fib', config: 'single-agent',  passed: 11, total: 14, durationMs: 900,  rep: 1 }),
    mkRecord({ task: 'fib', config: 'full-pipeline', passed: 14, total: 14, durationMs: 1100, rep: 2 }),
  ]
  const aggs = aggregateReps(records)
  ok(aggs.length === 3, 'three groups (config x task)')
  ok(aggs[0].config === 'full-pipeline' && aggs[0].task === 'fib', 'first group is full-pipeline/fib (first-seen)')
  ok(aggs[1].config === 'full-pipeline' && aggs[1].task === 'lru', 'second group is full-pipeline/lru')
  ok(aggs[2].config === 'single-agent' && aggs[2].task === 'fib', 'third group is single-agent/fib')
  ok(aggs[0].reps === 2, 'full-pipeline/fib has 2 reps')
  ok(aggs[0].score.n === 2, 'full-pipeline/fib score n = 2')
  ok(aggs[2].score.n === 1, 'single-agent/fib score n = 1')
  ok(Math.abs(aggs[2].score.mean - 11 / 14) < 1e-12, 'single-agent/fib score mean = 11/14')
}

// -- compareRepGroups ----------------------------------------------------------------

console.log('\ncompareRepGroups (beyond threshold — the E1 playbook case):')
{
  // compose: 12/12 with the playbook (3 reps) vs 9/12 without (3 reps)
  const withReps = [
    mkRecord({ task: 'compose', config: 'full-pipeline', passed: 12, total: 12, durationMs: 180000, rep: 1 }),
    mkRecord({ task: 'compose', config: 'full-pipeline', passed: 12, total: 12, durationMs: 190000, rep: 2 }),
    mkRecord({ task: 'compose', config: 'full-pipeline', passed: 12, total: 12, durationMs: 170000, rep: 3 }),
  ]
  const withoutReps = [
    mkRecord({ task: 'compose', config: 'full-pipeline', passed: 9, total: 12, durationMs: 200000, rep: 1 }),
    mkRecord({ task: 'compose', config: 'full-pipeline', passed: 9, total: 12, durationMs: 210000, rep: 2 }),
    mkRecord({ task: 'compose', config: 'full-pipeline', passed: 9, total: 12, durationMs: 195000, rep: 3 }),
  ]
  const c = compareRepGroups(withReps, withoutReps, 'wiki-on', 'wiki-off')
  ok(c.withLabel === 'wiki-on', 'with label preserved')
  ok(c.withoutLabel === 'wiki-off', 'without label preserved')
  ok(c.withScore.n === 3, 'with score n = 3')
  ok(c.withoutScore.n === 3, 'without score n = 3')
  ok(Math.abs(c.withScore.mean - 1) < 1e-12, 'with mean = 1.0')
  ok(Math.abs(c.withoutScore.mean - 0.75) < 1e-12, 'without mean = 0.75')
  ok(Math.abs(c.delta - 0.25) < 1e-12, 'delta = +0.25')
  ok(c.withinThreshold === false, '0.25 > 0.05 -> beyond threshold')
  ok(c.threshold === 0.05, 'default threshold used')
}

console.log('\ncompareRepGroups (within threshold):')
{
  const withReps = [mkRecord({ task: 'compose', config: 'full-pipeline', passed: 9, total: 10, durationMs: 1000 })]
  const withoutReps = [mkRecord({ task: 'compose', config: 'full-pipeline', passed: 44, total: 50, durationMs: 1100 })]
  const c = compareRepGroups(withReps, withoutReps)
  ok(Math.abs(c.delta - 0.02) < 1e-12, 'delta = +0.02')
  ok(c.withinThreshold === true, '0.02 <= 0.05 -> within threshold')
  ok(c.withLabel === 'with', 'default with label')
  ok(c.withoutLabel === 'without', 'default without label')
}

console.log('\ncompareRepGroups (exact threshold boundary):')
{
  const withReps = [mkRecord({ task: 'fib', config: 'full-pipeline', passed: 5, total: 10, durationMs: 1000 })]
  const withoutReps = [mkRecord({ task: 'fib', config: 'full-pipeline', passed: 1, total: 4, durationMs: 1000 })]
  const c = compareRepGroups(withReps, withoutReps, 'a', 'b', 0.25)
  ok(c.delta === 0.25, 'delta = +0.25 (exact)')
  ok(c.withinThreshold === true, '0.25 <= 0.25 -> within threshold (boundary)')
}

console.log('\ncompareRepGroups (custom threshold):')
{
  const withReps = [mkRecord({ task: 'fib', config: 'full-pipeline', passed: 9, total: 10, durationMs: 1000 })]
  const withoutReps = [mkRecord({ task: 'fib', config: 'full-pipeline', passed: 8, total: 10, durationMs: 1000 })]
  const c = compareRepGroups(withReps, withoutReps, 'a', 'b', 0.10)
  ok(c.threshold === 0.10, 'custom threshold used')
  ok(c.withinThreshold === true, '0.10 <= 0.10 -> within threshold')
}

console.log('\ncompareRepGroups (negative delta):')
{
  const withReps = [mkRecord({ task: 'compose', config: 'full-pipeline', passed: 9, total: 12, durationMs: 1000 })]
  const withoutReps = [mkRecord({ task: 'compose', config: 'full-pipeline', passed: 12, total: 12, durationMs: 1000 })]
  const c = compareRepGroups(withReps, withoutReps)
  ok(Math.abs(c.delta + 0.25) < 1e-12, 'delta = -0.25')
  ok(c.withinThreshold === false, 'beyond threshold')
}

console.log('\ncompareRepGroups (empty groups):')
{
  const c = compareRepGroups([], [])
  ok(c.withScore.n === 0, 'with n = 0')
  ok(c.withoutScore.n === 0, 'without n = 0')
  ok(c.delta === 0, 'delta = 0')
  ok(c.withinThreshold === true, '0 <= 0.05 -> within threshold')
}

console.log('\ncompareRepGroups (failed reps excluded):')
{
  const withReps = [
    mkRecord({ task: 'compose', config: 'full-pipeline', passed: 12, total: 12, durationMs: 1000, rep: 1 }),
    mkRecord({ task: 'compose', config: 'full-pipeline', passed: 0, total: 0, durationMs: 500, rep: 2, completed: false, error: 'timeout' }),
  ]
  const c = compareRepGroups(withReps, [])
  ok(c.withScore.n === 1, 'only the completed rep contributes')
  ok(Math.abs(c.withScore.mean - 1) < 1e-12, 'with mean = 1.0')
}

// -- renderRepTable ------------------------------------------------------------------

console.log('\nrenderRepTable (known group):')
{
  const records = [
    mkRecord({ task: 'fib', config: 'full-pipeline', passed: 14, total: 14, durationMs: 1000, tokens: 100, rep: 1 }),
    mkRecord({ task: 'fib', config: 'full-pipeline', passed: 14, total: 14, durationMs: 2000, tokens: 200, rep: 2 }),
    mkRecord({ task: 'fib', config: 'full-pipeline', passed: 7,  total: 14, durationMs: 3000, tokens: 300, rep: 3 }),
  ]
  const rendered = renderRepTable(records)
  ok(rendered.includes('# Repeat-Run Table (per config x task)'), 'has title')
  ok(rendered.includes('full-pipeline / fib:'), 'has group line')
  ok(rendered.includes('reps=3/3'), 'reps rendered as completed/total')
  ok(rendered.includes('score=0.833+/-0.289 (0.500..1.000, n=3)'), 'score spread rendered', rendered)
  ok(rendered.includes('duration=2000+/-1000 (1000..3000, n=3)'), 'duration spread rendered')
  ok(rendered.includes('tokens=200+/-100 (100..300, n=3)'), 'tokens spread rendered')
}

console.log('\nrenderRepTable (no tokens):')
{
  const records = [
    mkRecord({ task: 'fib', config: 'single-agent', passed: 14, total: 14, durationMs: 1000, rep: 1 }),
  ]
  const rendered = renderRepTable(records)
  ok(rendered.includes('tokens=n/a'), 'tokens rendered as n/a')
  ok(rendered.includes('reps=1/1'), 'single rep rendered')
}

console.log('\nrenderRepTable (failed rep):')
{
  const records = [
    mkRecord({ task: 'fib', config: 'single-agent', passed: 14, total: 14, durationMs: 1000, rep: 1 }),
    mkRecord({ task: 'fib', config: 'single-agent', passed: 0, total: 0, durationMs: 500, rep: 2, completed: false, error: 'timeout' }),
  ]
  const rendered = renderRepTable(records)
  ok(rendered.includes('reps=1/2'), 'completed/total rendered with a failed rep')
}

console.log('\nrenderRepTable (empty):')
{
  const rendered = renderRepTable([])
  ok(rendered.includes('# Repeat-Run Table (per config x task)'), 'has title')
  ok(rendered.includes('(no runs)'), 'empty marker rendered')
}

// -- renderRepComparison ----------------------------------------------------------------

console.log('\nrenderRepComparison (beyond threshold):')
{
  const withReps = [
    mkRecord({ task: 'compose', config: 'full-pipeline', passed: 12, total: 12, durationMs: 1000, rep: 1 }),
    mkRecord({ task: 'compose', config: 'full-pipeline', passed: 12, total: 12, durationMs: 1100, rep: 2 }),
  ]
  const withoutReps = [
    mkRecord({ task: 'compose', config: 'full-pipeline', passed: 9, total: 12, durationMs: 1000, rep: 1 }),
    mkRecord({ task: 'compose', config: 'full-pipeline', passed: 9, total: 12, durationMs: 1100, rep: 2 }),
  ]
  const c = compareRepGroups(withReps, withoutReps, 'wiki-on', 'wiki-off')
  const rendered = renderRepComparison(c)
  ok(rendered.includes('# A/B Comparison (threshold: 5% score delta)'), 'has title with threshold')
  ok(rendered.includes('wiki-on:    score='), 'with group line')
  ok(rendered.includes('wiki-off: score='), 'without group line')
  ok(rendered.includes('delta=+0.2500 (wiki-on - wiki-off)'), 'delta line with sign and labels')
  ok(rendered.includes('beyond threshold (difference exceeds noise)'), 'beyond-threshold verdict')
}

console.log('\nrenderRepComparison (zero delta):')
{
  const withReps = [mkRecord({ task: 'compose', config: 'full-pipeline', passed: 9, total: 12, durationMs: 1000 })]
  const withoutReps = [mkRecord({ task: 'compose', config: 'full-pipeline', passed: 9, total: 12, durationMs: 1000 })]
  const c = compareRepGroups(withReps, withoutReps, 'a', 'b')
  const rendered = renderRepComparison(c)
  ok(rendered.includes('delta=+0.0000 (a - b)'), 'zero delta rendered with + sign')
  ok(rendered.includes('within threshold (difference is within noise)'), 'within-threshold verdict')
}

console.log('\nrenderRepComparison (negative delta, within threshold):')
{
  const withReps = [mkRecord({ task: 'compose', config: 'full-pipeline', passed: 44, total: 50, durationMs: 1000 })]
  const withoutReps = [mkRecord({ task: 'compose', config: 'full-pipeline', passed: 9, total: 10, durationMs: 1000 })]
  const c = compareRepGroups(withReps, withoutReps, 'a', 'b')
  const rendered = renderRepComparison(c)
  ok(rendered.includes('delta=-0.0200 (a - b)'), 'negative delta rendered with - sign')
  ok(rendered.includes('within threshold (difference is within noise)'), 'within-threshold verdict')
}

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
