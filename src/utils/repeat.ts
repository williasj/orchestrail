// -- Repeat-run benchmark contract ------------------------------------------------
// Pure, dependency-free helpers for repeat-run benchmarks (frontier item 12:
// "3+ reps for the MoE comparison and the wiki-playbook A/B").
//
// H1: single-run comparisons are unreliable — time/tokens vary up to 70% between
// runs, so "2.5x faster, 4x less energy" rested on one run each. E1: the
// wiki-playbook effect (compose 9/12 -> 12/12) is an n=1 benchmark. This module
// computes mean +/- spread across repeated runs of the same task under the same
// config, and compares two rep groups (e.g. wiki-on vs wiki-off) against the
// quality threshold from evaluation.ts.
//
// Kept in a leaf module (pure functions, no LLM, no execution, no I/O) so the
// statistics can be unit-tested standalone (repeat.check.mjs). The live-run part
// (driving N reps per config x task, capturing tokens, running the graders) is in
// benchmarks/baselines.mjs.

import { EVAL_DEFAULTS } from './evaluation.js'
import type { RunRecord } from './evaluation.js'

/** Spread statistics for a set of numeric observations. */
export interface SpreadStats {
  /** Number of observations. */
  n: number
  /** Arithmetic mean. 0 when n = 0. */
  mean: number
  /** Sample standard deviation (n-1 denominator). 0 when n < 2. */
  stdDev: number
  /** Minimum. 0 when n = 0. */
  min: number
  /** Maximum. 0 when n = 0. */
  max: number
}

/**
 * Compute mean / sample std-dev / min / max for a list of observations.
 * Empty input yields all zeros; a single observation has stdDev 0.
 */
export function describeSpread(values: number[]): SpreadStats {
  const n = values.length
  if (n === 0) return { n: 0, mean: 0, stdDev: 0, min: 0, max: 0 }

  let sum = 0
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    sum += v
    if (v < min) min = v
    if (v > max) max = v
  }
  const mean = sum / n

  let stdDev = 0
  if (n > 1) {
    let ss = 0
    for (const v of values) ss += (v - mean) * (v - mean)
    stdDev = Math.sqrt(ss / (n - 1))
  }
  return { n, mean, stdDev, min, max }
}

/** Aggregated statistics for one config x task across its reps. */
export interface RepTaskAggregate {
  config: string
  task: string
  /** Total reps recorded for this config x task (completed or not). */
  reps: number
  /** Reps that completed and produced a gradable artifact. */
  completedReps: number
  /** Score fraction (0..1) across completed reps. */
  score: SpreadStats
  /** Wall-clock duration (ms) across completed reps. */
  durationMs: SpreadStats
  /** Total tokens across completed reps; null when no completed rep has tokens. */
  tokens: SpreadStats | null
}

/**
 * Group RunRecords by (config, task) and compute spread statistics per group.
 * Only completed reps contribute to score / duration / tokens; failed reps are
 * counted in `reps` but excluded from the statistics. Group order is
 * first-seen order in the input.
 */
export function aggregateReps(records: RunRecord[]): RepTaskAggregate[] {
  const groups = new Map<string, { config: string; task: string; records: RunRecord[] }>()
  for (const r of records) {
    const key = r.config + '\u0000' + r.task
    let g = groups.get(key)
    if (!g) {
      g = { config: r.config, task: r.task, records: [] }
      groups.set(key, g)
    }
    g.records.push(r)
  }

  const out: RepTaskAggregate[] = []
  for (const g of groups.values()) {
    const completed = g.records.filter(r => r.completed)
    const scores = completed.map(r => (r.grader.total > 0 ? r.grader.passed / r.grader.total : 0))
    const durations = completed.map(r => r.durationMs)
    const withTokens = completed.filter(r => typeof r.tokens === 'number')
    const tokens = withTokens.length > 0
      ? describeSpread(withTokens.map(r => r.tokens!))
      : null
    out.push({
      config: g.config,
      task: g.task,
      reps: g.records.length,
      completedReps: completed.length,
      score: describeSpread(scores),
      durationMs: describeSpread(durations),
      tokens,
    })
  }
  return out
}

/** Comparison of two rep groups (e.g. wiki-on vs wiki-off) on mean score. */
export interface RepGroupComparison {
  withLabel: string
  withoutLabel: string
  withScore: SpreadStats
  withoutScore: SpreadStats
  /** withScore.mean - withoutScore.mean. */
  delta: number
  /** True when |delta| <= threshold (i.e. the difference is within noise). */
  withinThreshold: boolean
  /** The quality threshold used. */
  threshold: number
}

/**
 * Compare two sets of rep records on mean score fraction (completed reps only).
 * The delta is (with - without); withinThreshold is true when |delta| <=
 * threshold, meaning the difference is within noise.
 */
export function compareRepGroups(
  withReps: RunRecord[],
  withoutReps: RunRecord[],
  withLabel = 'with',
  withoutLabel = 'without',
  threshold: number = EVAL_DEFAULTS.qualityThreshold,
): RepGroupComparison {
  const scoreOf = (records: RunRecord[]) =>
    describeSpread(
      records
        .filter(r => r.completed)
        .map(r => (r.grader.total > 0 ? r.grader.passed / r.grader.total : 0)),
    )
  const w = scoreOf(withReps)
  const wo = scoreOf(withoutReps)
  const delta = w.mean - wo.mean
  return {
    withLabel,
    withoutLabel,
    withScore: w,
    withoutScore: wo,
    delta,
    withinThreshold: Math.abs(delta) <= threshold,
    threshold,
  }
}

// -- rendering --------------------------------------------------------------------

/**
 * Format a SpreadStats as `mean+/-std (min..max, n=N)` with the given decimal
 * places (0 = rounded to integer). `n/a` when there are no observations.
 */
function fmtSpread(s: SpreadStats, digits: number): string {
  if (s.n === 0) return 'n/a'
  const f = (v: number) => (digits === 0 ? String(Math.round(v)) : v.toFixed(digits))
  return `${f(s.mean)}+/-${f(s.stdDev)} (${f(s.min)}..${f(s.max)}, n=${s.n})`
}

/**
 * Render a per-config-x-task repeat table: one greppable line per group with
 * mean +/- spread for score, duration, and tokens.
 */
export function renderRepTable(records: RunRecord[]): string {
  const aggs = aggregateReps(records)
  const lines: string[] = []
  lines.push('# Repeat-Run Table (per config x task)')
  if (aggs.length === 0) {
    lines.push('(no runs)')
    return lines.join('\n')
  }
  lines.push('')
  for (const a of aggs) {
    lines.push(
      `${a.config} / ${a.task}: ` +
      `reps=${a.completedReps}/${a.reps} ` +
      `score=${fmtSpread(a.score, 3)} ` +
      `duration=${fmtSpread(a.durationMs, 0)}ms ` +
      `tokens=${a.tokens ? fmtSpread(a.tokens, 0) : 'n/a'}`,
    )
  }
  return lines.join('\n')
}

/**
 * Render a two-group A/B comparison (e.g. wiki-on vs wiki-off) as a short
 * human-readable block with the delta and the threshold verdict.
 */
export function renderRepComparison(c: RepGroupComparison): string {
  const lines: string[] = []
  lines.push(`# A/B Comparison (threshold: ${(c.threshold * 100).toFixed(0)}% score delta)`)
  lines.push(`${c.withLabel}:    score=${fmtSpread(c.withScore, 3)}`)
  lines.push(`${c.withoutLabel}: score=${fmtSpread(c.withoutScore, 3)}`)
  lines.push(
    `delta=${c.delta >= 0 ? '+' : ''}${c.delta.toFixed(4)} (${c.withLabel} - ${c.withoutLabel}) -> ` +
    (c.withinThreshold
      ? 'within threshold (difference is within noise)'
      : 'beyond threshold (difference exceeds noise)'),
  )
  return lines.join('\n')
}
