// -- Adversarial verification contract ------------------------------------------
// Pure, dependency-free helpers for the independent adversarial verifier
// (frontier item 11 / C1 / A1, "the team grades its own homework").
//
// The entry-point probe (item 7) and the mutation probe (item 8) are
// deterministic stand-ins: they check the team's own record and the team's own
// suite. The deeper fix is a verifier that does not anchor on the team's tests
// at all: its input is the REQUESTER'S SPEC + IMPLEMENTATION ONLY, and the
// team's test_report and test_harness are WITHHELD from it (enforced in
// tools.ts / pipeline.ts via isWithheldFromVerifier). It authors its OWN
// probes, runs them, and records a structured verdict
// {probe, expected, actual, status}. DONE requires zero adversarial failures.
//
// Kept in a leaf module (types only) so the contract logic can be unit-tested
// standalone (adversarial.check.mjs) with no LLM.

/** Workbench slot the adversarial verifier writes its structured verdict into. */
export const ADVERSARIAL_VERDICT_SLOT = 'adversarial_verdict'

/**
 * The team's verification artifacts, withheld from the adversarial verifier so
 * it cannot anchor on them. A probe derived from the team's tests is the team
 * grading its own homework again; the verifier must derive its probes from the
 * requester's spec and the implementation itself.
 */
export const ADVERSARIAL_WITHHELD_SLOTS = ['test_report', 'test_harness'] as const

/** True when the slot is one of the named team artifacts withheld from the verifier. */
export function isAdversarialWithheldSlot(slot: string): boolean {
  return (ADVERSARIAL_WITHHELD_SLOTS as readonly string[]).includes(slot)
}

/**
 * True when the slot must not be READ by the adversarial verifier: a named team
 * artifact (test_report / test_harness) OR any orchestrator-internal slot
 * (`__`-prefixed), which is private by design (e.g. the captured-harness slot
 * that mirrors the team's test code).
 */
export function isWithheldFromVerifier(slot: string): boolean {
  return isAdversarialWithheldSlot(slot) || slot.startsWith('__')
}

/**
 * The slots visible to an agent, with the withheld team artifacts (and internal
 * slots) removed for the adversarial verifier. Pure; never mutates the input.
 * Non-verifier agents see the list unchanged (same reference).
 */
export function filterWithheldSlots(slots: string[], isVerifier: boolean): string[] {
  if (!isVerifier) return slots
  return slots.filter(s => !isWithheldFromVerifier(s))
}

/** The observed outcome of one adversarial probe. */
export type AdversarialStatus = 'pass' | 'fail' | 'error'

/** One adversarial probe: what was probed, what the spec requires, what was observed. */
export interface AdversarialProbe {
  /** What was invoked / probed, with the exact input. */
  probe:    string
  /** The behaviour the requester's spec requires. */
  expected: string
  /** The behaviour actually observed (the real output of the run). */
  actual:   string
  /** pass = observed matches spec; fail = it does not; error = the run crashed / could not execute. */
  status:   AdversarialStatus
}

export interface AdversarialAggregate {
  total:    number
  passed:   number
  failed:   number
  errors:   number
  /** The failing probes (status fail or error), in record order. */
  failures: AdversarialProbe[]
}

export interface AdversarialVerdict {
  /** Whether an adversarial verdict is required for this stage at all. */
  required:  boolean
  /** Whether the recorded verdict satisfies the contract. */
  satisfied: boolean
  /** Empty when satisfied or not required; otherwise the concrete, actionable complaint. */
  reason:    string
}

// Canonical status spellings the model may use, normalized to AdversarialStatus.
const STATUS_MAP: Record<string, AdversarialStatus> = {
  pass:    'pass',
  passed:  'pass',
  fail:    'fail',
  failed:  'fail',
  error:   'error',
  errored: 'error',
}

// Extract the first balanced JSON array from free text (prose / code-fence
// tolerant -- the model records the slot by hand and may wrap it in a fence).
function extractFirstJsonArray(text: string): string {
  const start = text.indexOf('[')
  if (start === -1) return text
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return text.slice(start)
}

/**
 * Parse a recorded adversarial_verdict slot into probes. Tolerant of prose /
 * code fences around the JSON array. Returns { ok: true, probes } on success;
 * { ok: false, reason } on any malformed shape. Pure -- never throws.
 */
export function parseAdversarialVerdict(
  raw: string | null | undefined,
): { ok: true; probes: AdversarialProbe[] } | { ok: false; reason: string } {
  const text = (raw ?? '').trim()
  if (!text) return { ok: false, reason: 'the adversarial_verdict slot is empty' }

  let arr: unknown
  try {
    arr = JSON.parse(extractFirstJsonArray(text))
  } catch {
    return {
      ok:    false,
      reason: 'adversarial_verdict is not a JSON array of probes. Record it as: '
        + '[{"probe": "<what you invoked, with the exact input>", "expected": "<what the spec requires>", '
        + '"actual": "<what you observed>", "status": "pass" | "fail" | "error"}]',
    }
  }
  if (!Array.isArray(arr)) {
    return { ok: false, reason: 'adversarial_verdict must be a JSON ARRAY of probe objects' }
  }

  const probes: AdversarialProbe[] = []
  for (let i = 0; i < arr.length; i++) {
    const el = arr[i] as Record<string, unknown> | null
    if (!el || typeof el !== 'object' || Array.isArray(el)) {
      return { ok: false, reason: `adversarial_verdict[${i}] is not an object` }
    }
    const probe     = typeof el['probe']    === 'string' ? el['probe'].trim()    : ''
    const expected  = typeof el['expected'] === 'string' ? el['expected'].trim() : ''
    const actual    = typeof el['actual']   === 'string' ? el['actual'].trim()   : ''
    const statusRaw = typeof el['status']   === 'string' ? el['status'].trim().toLowerCase() : ''
    const status    = STATUS_MAP[statusRaw]
    if (!probe) {
      return { ok: false, reason: `adversarial_verdict[${i}].probe is missing or empty -- name what you invoked, with the exact input` }
    }
    if (!expected) {
      return { ok: false, reason: `adversarial_verdict[${i}].expected is missing or empty -- state what the spec requires` }
    }
    if (!actual) {
      return { ok: false, reason: `adversarial_verdict[${i}].actual is missing or empty -- record what you OBSERVED (a probe with no observed output was not run)` }
    }
    if (!status) {
      return { ok: false, reason: `adversarial_verdict[${i}].status must be "pass", "fail", or "error" (got ${statusRaw ? `"${statusRaw}"` : 'nothing'})` }
    }
    probes.push({ probe, expected, actual, status })
  }
  return { ok: true, probes }
}

/**
 * Aggregate a probe record into pass/fail counts. A probe is a FAILURE when its
 * status is 'fail' (the implementation did not do what the spec requires) or
 * 'error' (the run crashed / could not execute). Pure.
 */
export function aggregateAdversarialVerdict(probes: AdversarialProbe[]): AdversarialAggregate {
  const failures = probes.filter(p => p.status !== 'pass')
  return {
    total:    probes.length,
    passed:   probes.length - failures.length,
    failed:   probes.filter(p => p.status === 'fail').length,
    errors:   probes.filter(p => p.status === 'error').length,
    failures,
  }
}

/**
 * The greppable `adversarial_probe:` escalation reason, naming the failing
 * probes (probe -- expected vs actual) so the re-run / fix has a concrete
 * target. Bounded: at most 5 failures are named.
 */
export function adversarialEscalationReason(agg: AdversarialAggregate): string {
  const named = agg.failures.slice(0, 5).map(f =>
    `"${f.probe.slice(0, 80)}" -- expected: ${f.expected.slice(0, 80)}; actual: ${f.actual.slice(0, 80)}`).join('; ')
  const more = agg.failures.length > 5 ? `; ...and ${agg.failures.length - 5} more` : ''
  return `adversarial_probe: ${agg.failures.length} of ${agg.total} adversarial probes failed `
    + `(${agg.failed} failed, ${agg.errors} errored of ${agg.total} probed). `
    + 'Fix the implementation (or correct an over-strict probe that encodes an assumption the spec does not make) and re-run: '
    + named + more + '.'
}

/**
 * An adversarial verdict is required only for a CODE task (the `runtimes` slot
 * is populated) on an agent flagged `requiresAdversarialVerdict` -- mirroring
 * the entry-point / mutation probe gates. Non-code artifacts have no
 * executable behaviour to probe and are exempt.
 */
export function adversarialVerdictRequired(isCodeTask: boolean, requiresAdversarialVerdict: boolean): boolean {
  return isCodeTask && requiresAdversarialVerdict
}

/**
 * Evaluate a recorded adversarial verdict against the contract.
 *
 * Returns a verdict. When `required` is false the verdict is satisfied by
 * definition (nothing to check). Otherwise the record must, in order:
 *   1. be present (non-empty),
 *   2. parse as a JSON array of well-formed probes,
 *   3. contain at least one probe (a verdict with no probes is vacuous), and
 *   4. contain ZERO failures (status fail or error) -- DONE requires zero
 *      adversarial failures.
 * Each unmet condition yields a concrete, greppable (`adversarial_probe:`)
 * reason the re-run can act on. Pure -- never throws, never mutates.
 */
export function evaluateAdversarialVerdict(
  raw:      string | null | undefined,
  required: boolean,
): AdversarialVerdict {
  if (!required) return { required: false, satisfied: true, reason: '' }

  const text = (raw ?? '').trim()
  if (!text) {
    return {
      required:  true,
      satisfied: false,
      reason:    'adversarial_probe: the adversarial_verdict slot is empty. Author your own probes from the '
        + "requester's spec and the implementation (the team's test_report and test_harness are withheld from you), "
        + 'run each one, and record the verdict as a JSON array of {probe, expected, actual, status}.',
    }
  }

  const parsed = parseAdversarialVerdict(text)
  if (!parsed.ok) {
    return {
      required:  true,
      satisfied: false,
      reason:    `adversarial_probe: ${parsed.reason}. Record a well-formed verdict and re-run the probes.`,
    }
  }
  if (parsed.probes.length === 0) {
    return {
      required:  true,
      satisfied: false,
      reason:    'adversarial_probe: the verdict contains no probes. A verdict with zero probes proves nothing -- '
        + 'probe at least the entry point, a boundary case, and the error contract the spec names.',
    }
  }

  const agg = aggregateAdversarialVerdict(parsed.probes)
  if (agg.failures.length > 0) {
    return { required: true, satisfied: false, reason: adversarialEscalationReason(agg) }
  }
  return { required: true, satisfied: true, reason: '' }
}
