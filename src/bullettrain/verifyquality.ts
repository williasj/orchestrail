// -- Verify quality assessment ---------------------------------------------------
// Pure, dependency-free leaf module (types only) so the progress-quality logic is
// unit-testable in isolation, following the runtime.ts / store.ts leaf pattern.
//
// Closes the F2 gap "no progress-quality notion beyond 'verify command exited 0'".
// Today a task's verify is a single shell command and pass/fail is `exit_code === 0`
// (verify.ts). Nothing asks whether that command actually checks behavior, and
// nothing reads any structured detail the command might emit. This module adds two
// advisory (never a hard gate -- see the supervisor wiring) dimensions:
//
//   1. assessVerifyCommand -- does the verify command check behavior, or is it
//      trivial (always passes / existence-only / print-only)? A `true` or
//      `test -f app.py` verify passes on a broken build, so it provides no
//      quality signal and is flagged in the run report.
//
//   2. parseVerifyReport   -- if the verify command prints a structured check
//      report (one "VERIFY <name> PASS|FAIL|SKIP" line per check it performs),
//      extract it so the run report can show which checks ran and which failed.
//      The exit code still decides pass/fail; the report is advisory detail.
//
// The classification is deliberately conservative: a command is only called
// "trivial" when it provably cannot fail on a real defect. Anything unrecognized
// is "other" (neutral) -- never falsely flagged, so the report does not churn on
// legitimate checks we simply do not recognize.

export type VerifyCommandQuality = 'behavioral' | 'other' | 'trivial' | 'manual'

export interface VerifyCommandAssessment {
  quality: VerifyCommandQuality
  reasons: string[]
}

export interface VerifyCheck {
  name: string
  status: 'pass' | 'fail' | 'skip'
}

export interface VerifyReport {
  hasReport: boolean
  checks: VerifyCheck[]
  summary: 'pass' | 'fail' | null
}

/**
 * Classify a verify command by how much it actually checks.
 *
 * - 'manual'     -- the "manual" sentinel, case-insensitive (no auto check, by design).
 * - 'behavioral' -- runs tests, invokes the artifact, or checks a live endpoint;
 *                   can genuinely fail on a defect.
 * - 'trivial'    -- passes without checking behavior (no-op, existence-only,
 *                   print/list/read-only). Flagged in the report.
 * - 'other'      -- unrecognized; neutral, not flagged (bias against false
 *                   positives).
 *
 * Behavioral is checked before trivial so a compound command like
 * `test -f app.py && pytest` is read as behavioral (the pytest is the real check),
 * not trivial (the leading test -f).
 */
export function assessVerifyCommand(cmd: string): VerifyCommandAssessment {
  const raw = (cmd ?? '').trim()
  if (!raw) return { quality: 'trivial', reasons: ['empty verify command'] }
  const lower = raw.toLowerCase()
  if (lower === 'manual') return { quality: 'manual', reasons: ['manual verification (no auto check)'] }

  // Behavioral signals: the command can actually fail when the build is wrong.
  const behavioral: string[] = []
  if (/\bpytest\b/.test(lower) || /python3?\s+-m\s+(pytest|unittest|nose)\b/.test(lower) || /\bunittest\b/.test(lower)) {
    behavioral.push('runs a Python test runner')
  }
  if (/\bnode\s+--test\b/.test(lower) || /\bnpm\s+(test|run\s+test)\b/.test(lower) || /\bnpx\s+(jest|mocha)\b/.test(lower) || /\b(jest|mocha)\b/.test(lower)) {
    behavioral.push('runs a JS test runner')
  }
  if (/\b(go\s+test|cargo\s+test|make\s+test|rspec|phpunit)\b/.test(lower)) {
    behavioral.push('runs a test runner')
  }
  if (/\b(curl|wget)\b/.test(lower)) {
    behavioral.push('checks a live endpoint (curl / wget)')
  }
  if (/\bpython3?\s+[\w./-]+\.py\b/.test(lower) || /\bnode\s+[\w./-]+\.js\b/.test(lower)) {
    behavioral.push('invokes the artifact (python X.py / node X.js)')
  }
  if (/\b(bash|sh|zsh)\s+[\w./-]+\.sh\b/.test(lower)) {
    behavioral.push('runs a shell script')
  }
  if (behavioral.length > 0) return { quality: 'behavioral', reasons: behavioral }

  // Trivial signals: the command passes without checking behavior.
  const trivial: string[] = []
  if (/^(true|:|exit\s*0)\s*$/.test(lower)) {
    trivial.push('always-succeeds no-op (true / : / exit 0)')
  }
  if (/^(test\s+-(f|e|s|d|r|w|x|z|u|g|k|L|p|t|n)\b|\[\s*-)/.test(lower)) {
    trivial.push('existence/attribute check only (test -f / [ -f ])')
  }
  if (/^(echo|printf)\b/.test(lower)) {
    trivial.push('only prints (echo / printf)')
  }
  if (/^ls\b/.test(lower)) {
    trivial.push('only lists (ls)')
  }
  if (/^cat\b/.test(lower)) {
    trivial.push('only reads a file (cat)')
  }
  if (trivial.length > 0) return { quality: 'trivial', reasons: trivial }

  return { quality: 'other', reasons: ['unrecognized -- confirm it checks behavior, not just existence'] }
}

/**
 * One "VERIFY <name> PASS|FAIL|SKIP" line, case-insensitive, at the start of a
 * line (leading whitespace tolerated). The name is a single non-whitespace token;
 * the status is one of the three keywords. Surrounding output is ignored.
 */
const CHECK_LINE_RE = /^\s*VERIFY\s+(\S+)\s+(PASS|FAIL|SKIP)\b/i

/**
 * Extract a structured verify report from a verify command's stdout, if present.
 * Returns hasReport: false (empty checks, null summary) when no check lines are
 * found -- a command that does not emit the format simply has no report, which is
 * fine (the exit code is still the pass/fail signal).
 *
 * summary: 'fail' if any check failed, else 'pass' if at least one passed, else
 * null (only skips, or an empty report).
 */
export function parseVerifyReport(stdout: string): VerifyReport {
  const checks: VerifyCheck[] = []
  for (const line of (stdout ?? '').split('\n')) {
    const m = line.match(CHECK_LINE_RE)
    if (!m) continue
    checks.push({ name: m[1]!, status: m[2]!.toLowerCase() as VerifyCheck['status'] })
  }
  if (checks.length === 0) return { hasReport: false, checks: [], summary: null }
  const summary = checks.some(c => c.status === 'fail') ? 'fail'
    : checks.some(c => c.status === 'pass') ? 'pass'
    : null
  return { hasReport: true, checks, summary }
}

/**
 * Render the run-report "Verify quality" section. Pure: takes a minimal task
 * shape ({ id, verify }) and the per-task parsed reports, returns report lines.
 *
 * Flags trivial verify commands (the real F2 concern) and lists any structured
 * reports the commands emitted. Advisory only -- it never changes pass/fail.
 */
export function summarizeVerifyQuality(
  tasks: { id: string; verify: string }[],
  reports: Record<string, VerifyReport>,
): string[] {
  const lines: string[] = []

  const trivial = tasks.filter(t => assessVerifyCommand(t.verify).quality === 'trivial')
  if (trivial.length > 0) {
    lines.push('WARNING: trivial verify command(s) -- these pass without checking behavior:')
    for (const t of trivial) {
      const a = assessVerifyCommand(t.verify)
      lines.push(`  - task ${t.id}: \`${t.verify}\` (${a.reasons.join('; ')})`)
    }
    lines.push('')
  }

  const withReport = tasks.filter(t => reports[t.id]?.hasReport)
  if (withReport.length > 0) {
    lines.push('Structured verify reports:')
    for (const t of withReport) {
      const r = reports[t.id]!
      const detail = r.checks.map(c => `${c.name}=${c.status}`).join(', ')
      lines.push(`  - task ${t.id}: ${r.summary ?? 'mixed'}${detail ? ` (${detail})` : ''}`)
    }
    lines.push('')
  }

  if (lines.length === 0) {
    lines.push('No trivial verify commands detected; no structured verify reports emitted.')
  }
  return lines
}
