// -- Entry-point / end-to-end verification contract ----------------------------
// Pure, dependency-free helpers for the test-engineer's entry-point probe
// requirement (frontier item 7 / C1 / A1, "the team grades its own homework").
//
// The unit-test harness proves the LIBRARY FUNCTIONS work; it does not prove the
// artifact works the way the requester will actually invoke it. The canonical
// failure (in the source doc) is the calculator that passed 23/23 unit tests yet
// crashed on overflow and end-of-input, because no test drove the interactive /
// user-facing entry point. The entry-point probe closes that gap: the test-
// engineer must drive the real entry point (CLI / demo / __main__ / public API
// the requester will use) end-to-end, including the boundary cases unit tests of
// library functions miss, and record the probe in a structured slot.
//
// The unit-test execution gate (agent.ts) is demoted from SUFFICIENT to
// NECESSARY: DONE now requires the execution gate to pass AND the entry-point
// probe to be satisfied. Kept in a leaf module (types only) so the contract
// logic can be unit-tested standalone (verify.check.mjs) with no LLM.

/** Workbench slot the test-engineer writes the entry-point probe into. */
export const ENTRY_POINT_PROBE_SLOT = 'entry_point_probe'

/**
 * The canonical checklist the test-engineer prompt references and the parser
 * expects. Each label is a short, greppable token. The probe is satisfied when
 * the record shows the entry point was invoked, a normal case passed, and at
 * least one boundary case was exercised without crashing.
 */
export const ENTRY_POINT_PROBE_CHECKLIST = [
  'entry_point_invoked',
  'normal_case',
  'boundary_case',
] as const

export interface EntryPointProbeVerdict {
  /** Whether an entry-point probe is required for this stage at all. */
  required:  boolean
  /** Whether the recorded probe satisfies the contract. */
  satisfied: boolean
  /** Empty when satisfied or not required; otherwise the concrete, actionable complaint. */
  reason:    string
}

// Evidence that a command was actually recorded (not just prose).
const COMMAND_RE  = /^\s*(?:command\s*:|[$]|python3?\b|node\s|\.\/)/im
// A failing outcome, from unambiguous signals only. Checked BEFORE the pass
// signal so a "2 passed, 1 failed" record is read as a failure, not a pass:
//   - an explicit failing result line (the mandated "result: FAIL" record),
//   - a Python Traceback,
//   - a non-zero exit ("exit code: N" / "exit N"),
//   - a NONZERO failure count ("2 failed" / "3 errors"). "0 failed" is a pass.
// Deliberately does NOT key on the bare words "crash" or "failed": a passing
// probe routinely says "did not crash" / "0 failed", so those are ambiguous and
// would false-positive. A real crash surfaces through one of the signals above
// (a Python crash prints a Traceback; a hard failure is a non-zero exit or "N failed").
const FAILURE_RE  = /result\s*:\s*(?:fail|failed)\b|\bTraceback\b|\bexit(?:\s+code)?\s*:\s*[1-9]\b|\bexit\s+[1-9]\b|\b[1-9]\d*\s+(?:failed|errors?)\b/i
// A passing outcome: an explicit PASS/PASSED/passed/ok, or an exit-0 signal.
const PASS_RE     = /\b(PASS|PASSED|passed|ok)\b|\bexit(?:\s+code)?\s*:\s*0\b|\bexit\s+0\b/i
// A boundary case the unit tests of library functions miss.
// boundary[_ -]?case matches the exact record format the test-engineer prompt
// mandates ("- boundary_case: PASS"); \bboundary\b alone never matches it
// because '_' is a word character.
const BOUNDARY_RE = /\b(empty|larg(e|est)|overflow|end[- ]of[- ]input|boundary|boundaries|boundary[_ -]?case|max(?:imum)?|limit(?:s|ed)?|huge|big)\b/i

/**
 * An entry-point probe is required only for a CODE task (the `runtimes` slot is
 * populated) on an agent flagged `requiresVerifiedExecution` — mirroring the
 * existing unit-test execution gate. Non-code artifacts (YAML / Dockerfile /
 * Markdown / ...) have no executable entry point and are exempt.
 */
export function entryPointProbeRequired(isCodeTask: boolean, requiresVerifiedExecution: boolean): boolean {
  return isCodeTask && requiresVerifiedExecution
}

/**
 * Evaluate a recorded entry-point probe against the contract.
 *
 * Returns a verdict. When `required` is false the probe is satisfied by
 * definition (nothing to check). Otherwise the record must, in order:
 *   1. be present (non-empty),
 *   2. show a command was actually run (not just prose),
 *   3. report a passing outcome (no crash / non-zero exit / failure),
 *   4. record a passing signal, and
 *   5. cover at least one boundary case.
 * Each unmet condition yields a concrete, greppable (`entry_point_probe:`)
 * reason the re-run can act on. Pure — never throws, never mutates.
 */
export function evaluateEntryPointProbe(
  raw:      string | null | undefined,
  required: boolean,
): EntryPointProbeVerdict {
  if (!required) return { required: false, satisfied: true, reason: '' }

  const text = (raw ?? '').trim()
  if (!text) {
    return {
      required:  true,
      satisfied: false,
      reason:    'entry_point_probe: the entry-point probe slot is empty. Drive the real entry point '
        + '(the CLI / demo / __main__ / public API the requester will use) and record the probe.',
    }
  }
  if (!COMMAND_RE.test(text)) {
    return {
      required:  true,
      satisfied: false,
      reason:    'entry_point_probe: no command is recorded. The probe must show the entry point was '
        + 'actually invoked -- record the exact command you ran (e.g. "command: python implementation.py").',
    }
  }
  if (FAILURE_RE.test(text)) {
    return {
      required:  true,
      satisfied: false,
      reason:    'entry_point_probe: the probe reports a failure (a failure marker, non-zero exit, or failing case). '
        + 'Fix the implementation or the probe and re-run until the entry point runs clean, then record the passing probe.',
    }
  }
  if (!PASS_RE.test(text)) {
    return {
      required:  true,
      satisfied: false,
      reason:    'entry_point_probe: no passing outcome is recorded. After the entry point runs, record '
        + 'the result (e.g. "result: PASS" or the exit-0 output).',
    }
  }
  if (!BOUNDARY_RE.test(text)) {
    return {
      required:  true,
      satisfied: false,
      reason:    'entry_point_probe: no boundary case was probed. Drive at least one boundary the unit '
        + 'tests of library functions miss -- empty input, very large input / overflow, or end-of-input -- and record it.',
    }
  }
  return { required: true, satisfied: true, reason: '' }
}
