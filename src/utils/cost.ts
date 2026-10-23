// -- Per-stage & run cost formatting (pure leaf) --------------------------------
// Pure, dependency-free helpers for surfacing per-stage cost (tokens + wall-time)
// in the Agentic Team UI (frontier item 17 / B3). No I/O, no LLM -- unit-testable
// in isolation (cost.check.mjs), following the terminal.ts / budget.ts leaf
// pattern.
//
// The pipeline captures each stage's wall-time (durationMs) and token delta
// (tokens) on the AgentResult; these helpers turn those numbers into the compact
// strings the UI renders. Wh/energy is deliberately NOT surfaced here -- there is
// no honest model->Wh table (same decision as item 14 sub-part 3).

import type { AgentResult } from '../types/index.js'

// Format a token count with thousands separators. Non-finite / negative -> '0'.
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  return Math.floor(n).toLocaleString('en-US')
}

// Format a wall-time duration (ms) into a compact human string:
//   <= 0        -> '0s'
//   < 1000      -> '850ms'
//   < 60s       -> '3.4s'   (one decimal)
//   >= 60s      -> '2m 05s' (minutes + zero-padded seconds)
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSec = ms / 1000
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`
  const m = Math.floor(totalSec / 60)
  const s = Math.round(totalSec - m * 60)
  return `${m}m ${String(s).padStart(2, '0')}s`
}

// A compact per-stage cost suffix for the done-line, e.g. '(12,345 tokens · 3.4s)'.
// Omits any dimension that is absent or zero. Returns '' when neither is present,
// so a stage with no usage data renders exactly as before (no trailing '()').
export function costSuffix(r: { tokens?: number; durationMs?: number }): string {
  const parts: string[] = []
  if (typeof r.tokens === 'number' && r.tokens > 0) parts.push(`${formatTokens(r.tokens)} tokens`)
  if (typeof r.durationMs === 'number' && r.durationMs > 0) parts.push(formatDuration(r.durationMs))
  return parts.length ? `(${parts.join(' · ')})` : ''
}

// Sum tokens and wall-time across a run's stage results (missing -> 0).
export function summarizeRunCost(results: AgentResult[]): { tokens: number; durationMs: number } {
  let tokens = 0
  let durationMs = 0
  for (const r of results) {
    tokens += r.tokens ?? 0
    durationMs += r.durationMs ?? 0
  }
  return { tokens, durationMs }
}

// Render the run-level cost line used in the agents footer, e.g.
// 'total 6,912 tokens · 10.4s'. Returns '' when both dimensions are zero/absent.
export function renderRunCostLine(tokens: number, durationMs: number): string {
  const parts: string[] = []
  if (tokens > 0) parts.push(`${formatTokens(tokens)} tokens`)
  if (durationMs > 0) parts.push(formatDuration(durationMs))
  return parts.length ? `total ${parts.join(' · ')}` : ''
}
