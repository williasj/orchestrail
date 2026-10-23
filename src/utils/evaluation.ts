// -- Independent evaluation suite contract --------------------------------------
// Pure, dependency-free helpers for the independent evaluation suite (frontier
// item 9). The suite compares the full multi-agent pipeline against single-agent
// and two-agent baselines on the existing benchmark tasks, using the independent
// Python graders in benchmarks/graders/ as the scoring authority.
//
// The graders emit a fixed output format:
//   - `FAIL <name>` lines for failed checks (all graders),
//   - `PASS <name>` lines for passed checks (some graders: sales, compose),
//   - a final `SCORE <n>/<total>` line (all graders),
//   - optional diagnostic lines (e.g. `clock injection: True`, `helper: None`).
//
// This module parses that output, aggregates per-config run records, compares
// configs against a baseline, and renders a human-readable report. Kept in a
// leaf module (pure functions, no LLM, no execution, no I/O) so the scoring and
// comparison logic can be unit-tested standalone (evaluation.check.mjs).

/** Tunable defaults for the evaluation suite. */
export const EVAL_DEFAULTS = {
  /**
   * A score delta within this fraction (of the 0..1 scale) is considered noise,
   * not a meaningful quality difference. 0.05 = 5 percentage points.
   */
  qualityThreshold: 0.05,
} as const

/** Canonical config names used across the suite. */
export const CONFIG_SINGLE_AGENT   = 'single-agent'
export const CONFIG_TWO_AGENT      = 'two-agent'
export const CONFIG_FULL_PIPELINE  = 'full-pipeline'

/** Parsed result of one grader run. */
export interface GraderResult {
  /** The grader / benchmark task name (e.g. 'fib', 'lru', 'rl', 'sales', 'compose'). */
  grader: string
  /** Number of checks that passed (authoritative: from the SCORE line when present). */
  passed: number
  /** Number of checks that failed. */
  failed: number
  /** Total number of checks (passed + failed). */
  total: number
  /** True when the grader emitted a valid `SCORE <n>/<total>` line. */
  hasScore: boolean
  /** The raw SCORE line as emitted, or null when absent. */
  scoreLine: string | null
  /** Names of the failed checks (from FAIL lines). */
  failedChecks: string[]
  /** Names of the passed checks (from PASS lines; empty for FAIL-only graders). */
  passedChecks: string[]
  /** Non-PASS/FAIL/SCORE lines (diagnostics, tracebacks, etc.). */
  diagnostics: string[]
}

/** One pipeline run on one benchmark task under one config. */
export interface RunRecord {
  /** The benchmark task name. */
  task: string
  /** The config name (e.g. 'single-agent', 'two-agent', 'full-pipeline'). */
  config: string
  /** The grader result for this run. */
  grader: GraderResult
  /** Wall-clock duration in milliseconds. */
  durationMs: number
  /** True when the pipeline run completed and produced an artifact. */
  completed: boolean
  /** Error message when the pipeline run failed, or null. */
  error: string | null
  /** Total tokens (prompt + completion) for this run, when the model reports usage. */
  tokens?: number
  /** 1-based rep index when the same task is run multiple times (frontier item 12). */
  rep?: number
}

/** Aggregated statistics for one config across all its runs. */
export interface ConfigAggregate {
  config: string
  runs: RunRecord[]
  totalRuns: number
  completedRuns: number
  /** Mean score fraction (0..1) across completed runs. 0 when no completed runs. */
  meanScore: number
  /** Mean duration in ms across completed runs. 0 when no completed runs. */
  meanDurationMs: number
  /** Per-task mean score fraction (0..1). */
  perTask: Record<string, number>
}

/** Comparison of one config against the baseline config. */
export interface ConfigComparison {
  config: string
  baseline: string
  /** Mean score for this config (0..1). */
  score: number
  /** Mean score for the baseline (0..1). */
  baselineScore: number
  /** score - baselineScore. */
  delta: number
  /** True when |delta| <= threshold (i.e. the difference is within noise). */
  withinThreshold: boolean
  /** The quality threshold used. */
  threshold: number
}

/** The full evaluation report. */
export interface EvalReport {
  /** ISO-8601 timestamp of when the report was built. */
  timestamp: string
  /** Aggregates for every config that was run. */
  aggregates: ConfigAggregate[]
  /** Comparisons of each non-baseline config against the baseline. */
  comparisons: ConfigComparison[]
  /** The baseline config name. */
  baseline: string
}

// -- parseGraderOutput ----------------------------------------------------------

const SCORE_RE = /^SCORE (\d+)\/(\d+)\s*$/

/**
 * Parse the stdout of a grader run into a structured GraderResult.
 *
 * The SCORE line is authoritative for the passed/total counts. When it is
 * absent (grader crashed), counts are derived from the PASS/FAIL lines.
 * Lines that are neither PASS, FAIL, nor SCORE are captured as diagnostics.
 */
export function parseGraderOutput(output: string, grader: string): GraderResult {
  const failedChecks: string[] = []
  const passedChecks: string[] = []
  const diagnostics: string[] = []
  let scoreLine: string | null = null
  let scorePassed = 0
  let scoreTotal = 0
  let hasScore = false

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.startsWith('PASS ')) {
      passedChecks.push(line.slice(5))
    } else if (line.startsWith('FAIL ')) {
      failedChecks.push(line.slice(5))
    } else {
      const m = line.match(SCORE_RE)
      if (m) {
        scoreLine = line
        scorePassed = Number(m[1])
        scoreTotal  = Number(m[2])
        hasScore = true
      } else if (line.length > 0) {
        diagnostics.push(line)
      }
    }
  }

  let passed: number
  let total: number
  let failed: number

  if (hasScore) {
    passed = scorePassed
    total  = scoreTotal
    failed = total - passed
  } else {
    passed = passedChecks.length
    failed = failedChecks.length
    total  = passed + failed
  }

  return {
    grader,
    passed,
    failed,
    total,
    hasScore,
    scoreLine,
    failedChecks,
    passedChecks,
    diagnostics,
  }
}

// -- aggregateRuns --------------------------------------------------------------

/**
 * Aggregate a set of RunRecords (all for the same config) into a ConfigAggregate.
 * meanScore is the mean of (passed/total) across completed runs only.
 */
export function aggregateRuns(records: RunRecord[]): ConfigAggregate {
  const config = records.length > 0 ? records[0]!.config : ''
  const completed = records.filter(r => r.completed)

  let meanScore = 0
  let meanDurationMs = 0
  const perTaskSums: Record<string, number> = {}
  const perTaskCounts: Record<string, number> = {}

  if (completed.length > 0) {
    let scoreSum = 0
    let durSum = 0
    for (const r of completed) {
      const s = r.grader.total > 0 ? r.grader.passed / r.grader.total : 0
      scoreSum += s
      durSum   += r.durationMs
      perTaskSums[r.task]     = (perTaskSums[r.task]     ?? 0) + s
      perTaskCounts[r.task]   = (perTaskCounts[r.task]   ?? 0) + 1
    }
    meanScore      = scoreSum / completed.length
    meanDurationMs = durSum / completed.length
  }

  const perTask: Record<string, number> = {}
  for (const task of Object.keys(perTaskSums)) {
    perTask[task] = perTaskSums[task]! / perTaskCounts[task]!
  }

  return {
    config,
    runs: records,
    totalRuns: records.length,
    completedRuns: completed.length,
    meanScore,
    meanDurationMs,
    perTask,
  }
}

// -- compareConfigs -------------------------------------------------------------

/**
 * Compare one config's aggregate against the baseline aggregate.
 * The delta is (config meanScore - baseline meanScore). withinThreshold is true
 * when |delta| <= threshold, meaning the difference is within noise.
 */
export function compareConfigs(
  aggregate: ConfigAggregate,
  baseline: ConfigAggregate,
  threshold: number = EVAL_DEFAULTS.qualityThreshold,
): ConfigComparison {
  const delta = aggregate.meanScore - baseline.meanScore
  return {
    config: aggregate.config,
    baseline: baseline.config,
    score: aggregate.meanScore,
    baselineScore: baseline.meanScore,
    delta,
    withinThreshold: Math.abs(delta) <= threshold,
    threshold,
  }
}

// -- buildReport ----------------------------------------------------------------

/**
 * Build an EvalReport from a set of config aggregates. The baseline config is
 * identified by name; every other config is compared against it.
 */
export function buildReport(
  aggregates: ConfigAggregate[],
  baseline: string = CONFIG_FULL_PIPELINE,
): EvalReport {
  const baselineAgg = aggregates.find(a => a.config === baseline)
  const comparisons = baselineAgg
    ? aggregates
        .filter(a => a.config !== baseline)
        .map(a => compareConfigs(a, baselineAgg))
    : []
  return {
    timestamp: new Date().toISOString(),
    aggregates,
    comparisons,
    baseline,
  }
}

// -- renderReport ---------------------------------------------------------------

/**
 * Render an EvalReport as a human-readable multi-line string.
 */
export function renderReport(report: EvalReport): string {
  const lines: string[] = []
  lines.push('# Evaluation Report')
  lines.push(`Generated: ${report.timestamp}`)
  lines.push(`Baseline: ${report.baseline}`)
  lines.push('')

  for (const agg of report.aggregates) {
    lines.push(`## ${agg.config}`)
    lines.push(`Runs: ${agg.completedRuns}/${agg.totalRuns} completed`)
    lines.push(`Mean score: ${(agg.meanScore * 100).toFixed(1)}%`)
    lines.push(`Mean duration: ${agg.meanDurationMs.toFixed(0)}ms`)
    for (const [task, score] of Object.entries(agg.perTask)) {
      lines.push(`  ${task}: ${(score * 100).toFixed(1)}%`)
    }
    lines.push('')
  }

  if (report.comparisons.length > 0) {
    lines.push(`## Comparison vs ${report.baseline}`)
    for (const c of report.comparisons) {
      const sign  = c.delta > 0 ? '+' : ''
      const label = c.withinThreshold ? '(within threshold)' : '(exceeds threshold)'
      lines.push(
        `${c.config}: ${(c.score * 100).toFixed(1)}% vs ${(c.baselineScore * 100).toFixed(1)}%`
        + ` (${sign}${(c.delta * 100).toFixed(1)}pp) ${label}`,
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}
