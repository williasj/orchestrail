// -- RUNTIME.md front matter ----------------------------------------------------
// Flat "key: value" front matter between --- markers. Not a YAML parser --
// the contract's RUNTIME.md is deliberately flat scalars only, so a tiny
// purpose-built parser is more honest than pulling in a YAML dependency for
// six lines of syntax. Anything below the closing --- is prose and ignored.

import type { BTRuntime } from './types.js'
import { BT_DEFAULT_RUNTIME } from './config.js'

const NUMERIC_KEYS = new Set<keyof BTRuntime>([
  'num_ctx', 'temperature', 'soft_checkpoint_pct', 'hard_kill_pct',
  'max_turns_per_session', 'max_sessions', 'max_tasks', 'max_attempts_per_task',
  'stall_sessions', 'wall_clock_hours', 'exec_timeout_ms',
])

export function renderRuntimeMd(runtime: BTRuntime, prose = ''): string {
  const lines = ['---']
  for (const [k, v] of Object.entries(runtime)) lines.push(`${k}: ${v}`)
  lines.push('---')
  if (prose) lines.push('', prose)
  return lines.join('\n') + '\n'
}

export function parseRuntimeMd(text: string): BTRuntime {
  const runtime: Record<string, unknown> = { ...BT_DEFAULT_RUNTIME }
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return runtime as unknown as BTRuntime

  let i = 1
  for (; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '---') break
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
    if (!m) continue
    const key = m[1]!
    const raw = m[2]!.trim()
    if (!(key in runtime)) continue // unknown keys ignored, not errored
    runtime[key] = NUMERIC_KEYS.has(key as keyof BTRuntime) ? Number(raw) : raw
  }
  return runtime as unknown as BTRuntime
}
