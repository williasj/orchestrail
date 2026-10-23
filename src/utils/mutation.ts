// -- Mutation-probe contract ---------------------------------------------------
// Pure, dependency-free helpers for the test-engineer's mutation-robustness probe
// (frontier item 8). The unit-test harness proves the implementation PASSES its
// own tests; the mutation probe asks the harder question: are those tests STRONG
// enough to catch a plausible defect? The orchestrator generates single-line
// mutants of the implementation, runs the captured harness against each, and
// classifies each as killed / survived / invalid. A suite that survives valid
// mutants is weak -- it passes on code that is subtly wrong -- and the stage is
// escalated with a `mutation_probe:` reason so the test-engineer writes stronger
// tests.
//
// This is a cheap, deterministic adversary substitute, NOT the full independent
// adversarial verifier (frontier item 11). Kept in a leaf module (pure functions,
// no LLM, no execution) so the operator set and classification can be unit-tested
// standalone (mutation.check.mjs).

/** Tunable caps for the probe. maxMutants bounds the per-stage execution cost. */
export const MUTATION_DEFAULTS = {
  maxMutants:  8,
  // A suite is "robust enough" when it kills at least this share of the valid
  // mutants. Zero tolerance is wrong in practice: some single-line mutants are
  // semantically equivalent to the original and no test can kill them.
  minKillRate: 0.6,
} as const

/**
 * How the probe affects completion. 'advisory' (default): run it, log it and
 * record it in the verification record, but never block DONE. 'block': a
 * verdict below minKillRate downgrades DONE to ESCALATE. 'off': do not run.
 * Promote to 'block' only once benchmarks show it does not tank completion.
 */
export type MutationMode = 'off' | 'advisory' | 'block'
export function mutationMode(env: string | undefined = process.env.MUTATION_PROBE): MutationMode {
  const v = (env ?? '').trim().toLowerCase()
  return v === 'off' || v === 'block' ? v : 'advisory'
}

/** The five single-edit operators the probe applies to an implementation. */
export type MutantOperator =
  | 'comparison-flip'   // non-guard line: flip a comparison operator
  | 'boundary-flip'     // if/elif/while guard: flip the comparison in the condition
  | 'off-by-one'        // +1 -> +2, -1 -> -0 (and spaced / compound variants)
  | 'guard-removal'     // if/elif/while guard: negate the whole condition
  | 'literal-flip'      // boolean literal True <-> False

/** A single generated mutant: one line of the implementation, edited once. */
export interface Mutant {
  operator: MutantOperator
  line:     number   // 1-indexed line number in the implementation
  original: string   // the original line text
  mutated:  string   // the mutated line text
  code:     string   // the full implementation with this one line replaced
}

/** How the harness fared against one mutant. */
export type MutantOutcome = 'killed' | 'survived' | 'invalid'

export interface MutantResult {
  mutant:  Mutant
  outcome: MutantOutcome
  ran:     number
  failed:  number
  errored: number
  error:   string | null
}

/** Aggregated outcome of running a batch of mutants. */
export interface MutationResult {
  total:    number
  killed:   number
  survived: number
  invalid:  number
  mutants:  MutantResult[]
}

export interface MutationVerdict {
  required:  boolean
  satisfied: boolean
  /** Empty when satisfied or not required; otherwise the greppable `mutation_probe:` reason. */
  reason:    string
  result:    MutationResult | null
}

// Comparison-operator flip map. Ordered so multi-char operators are tried before
// their single-char substrings (<= before <, >= before >).
const COMPARE_FLIP: Record<string, string> = {
  '<=': '<',
  '>=': '>',
  '<':  '<=',
  '>':  '>=',
  '==': '!=',
  '!=': '==',
}

/** True when the (trimmed) line is an if / elif / while guard. */
function isGuardLine(line: string): boolean {
  return /^(if|elif|while)\b/.test(line.trim())
}

/**
 * Mask string literals and comments with spaces so operator matching only ever
 * sees executable code. Length-preserving (indexes in the mask map 1:1 onto the
 * original line). Tracks triple-quoted strings (docstrings) across lines.
 * Returns one masked line per input line.
 */
export function maskPythonSource(lines: string[]): string[] {
  const out: string[] = []
  let triple: string | null = null          // open triple-quote delimiter, if any
  for (const line of lines) {
    let m = ''
    let i = 0
    let quote: string | null = null          // open single-line quote
    while (i < line.length) {
      const ch = line[i]
      const three = line.slice(i, i + 3)
      if (triple) {
        if (three === triple) { triple = null; m += '   '; i += 3; continue }
        m += ' '; i++; continue
      }
      if (quote) {
        if (ch === '\\') { m += '  '.slice(0, Math.min(2, line.length - i)); i += 2; continue }
        if (ch === quote) quote = null
        m += ' '; i++; continue
      }
      if (three === '"""' || three === "'''") { triple = three; m += '   '; i += 3; continue }
      if (ch === '"' || ch === "'") { quote = ch; m += ' '; i++; continue }
      if (ch === '#') { m += ' '.repeat(line.length - i); break }
      m += ch; i++
    }
    out.push(m.slice(0, line.length).padEnd(line.length, ' '))
  }
  return out
}

/** Indexes of lines that belong to an `if __name__ == '__main__':` block (header included). */
function mainBlockLines(lines: string[]): Set<number> {
  const skip = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*if\s+__name__\s*==\s*['"]__main__['"]\s*:/.test(lines[i])) continue
    const indent = lines[i].length - lines[i].trimStart().length
    skip.add(i)
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (l.trim() === '') { skip.add(j); continue }
      if (l.length - l.trimStart().length <= indent) break
      skip.add(j)
    }
  }
  return skip
}

/** Replace `len` chars at `idx` in `line` with `rep`. */
function splice(line: string, idx: number, len: number, rep: string): string {
  return line.slice(0, idx) + rep + line.slice(idx + len)
}

/** First comparison operator in the executable part of the line (skips ->, <<, >>, =>). */
function flipFirstComparison(line: string, masked: string): string | null {
  const re = /(<=|>=|==|!=|<|>)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(masked)) !== null) {
    const op = m[0]; const idx = m.index
    const prev = idx > 0 ? masked[idx - 1] : ''
    const next = masked[idx + op.length] ?? ''
    if (op === '>' && prev === '-') continue            // return annotation ->
    if ((op === '<' && (next === '<' || prev === '<')) || (op === '>' && (next === '>' || prev === '>'))) continue
    if (op === '<=' && prev === '<') continue           // <<=
    if (op === '>=' && prev === '>') continue           // >>=
    return splice(line, idx, op.length, COMPARE_FLIP[op])
  }
  return null
}

/** Off-by-one on the executable part: +1 -> +2, -1 -> -0 (spaced / compound variants). */
function flipOffByOne(line: string, masked: string): string | null {
  const rules: Array<[RegExp, string]> = [
    [/\+=\s*1(?![\d.])/, '2'],
    [/-=\s*1(?![\d.])/, '0'],
    [/(?<![=\w])\+\s*1(?![\d.])/, '2'],
    [/(?<![=\w(,\[])-\s*1(?![\d.])/, '0'],
  ]
  for (const [re, digit] of rules) {
    const m = masked.match(re)
    if (!m || m.index === undefined) continue
    const end = m.index + m[0].length - 1                // position of the literal '1'
    return splice(line, end, 1, digit)
  }
  return null
}

/** Negate a guard's whole condition: `if cond:` -> `if not (cond):` (no trailing comment). */
function negateGuard(line: string, masked: string): string | null {
  if (masked.trimEnd().length !== line.trimEnd().length) return null   // trailing comment present
  const m = line.match(/^(\s*)(if|elif|while)\s+(.+?)\s*:\s*$/)
  if (!m) return null
  const [, indent, kw, cond] = m
  const c = cond.trim()
  if (!c || /^not\s/.test(c)) return null
  return `${indent}${kw} not (${c}):`
}

/** Flip the first executable boolean literal. */
function flipBoolean(line: string, masked: string): string | null {
  const m = masked.match(/\b(True|False)\b/)
  if (!m || m.index === undefined) return null
  return splice(line, m.index, m[0].length, m[0] === 'True' ? 'False' : 'True')
}

/**
 * Generate the bounded set of single-line mutants for an implementation.
 * Only executable code is mutated: comments, string literals, docstrings, the
 * `if __name__ == '__main__':` demo block, decorators and def/class signature
 * lines are skipped (mutating them yields mutants no unit test can or should
 * kill). Candidates are collected over the whole file and then sampled evenly,
 * so the cap does not concentrate every mutant at the top of the file.
 * Deterministic for a given input.
 */
export function generateMutants(implCode: string, maxMutants: number = MUTATION_DEFAULTS.maxMutants): Mutant[] {
  const lines  = implCode.split('\n')
  const masked = maskPythonSource(lines)
  const skip   = mainBlockLines(lines)
  const seen   = new Set<string>()
  const all:   Mutant[] = []

  const push = (operator: MutantOperator, idx: number, mutatedLine: string | null): void => {
    if (mutatedLine === null) return
    const original = lines[idx]
    if (mutatedLine === original) return
    const key = `${idx}::${mutatedLine}`
    if (seen.has(key)) return
    seen.add(key)
    const code = lines.map((l, i) => (i === idx ? mutatedLine : l)).join('\n')
    all.push({ operator, line: idx + 1, original, mutated: mutatedLine, code })
  }

  for (let idx = 0; idx < lines.length; idx++) {
    if (skip.has(idx)) continue
    const line = lines[idx]
    const mk   = masked[idx]
    const t    = mk.trim()
    if (!t) continue
    if (/^(def|class|async\s+def|@|import|from)\b/.test(t) || t.startsWith('@')) continue
    const guard = isGuardLine(mk)
    push(guard ? 'boundary-flip' : 'comparison-flip', idx, flipFirstComparison(line, mk))
    push('off-by-one', idx, flipOffByOne(line, mk))
    if (guard) push('guard-removal', idx, negateGuard(line, mk))
    push('literal-flip', idx, flipBoolean(line, mk))
  }

  if (all.length <= maxMutants) return all
  // Even sample across the file so coverage is not front-loaded.
  const out: Mutant[] = []
  const step = all.length / maxMutants
  for (let k = 0; k < maxMutants; k++) out.push(all[Math.floor(k * step)])
  return out
}

/**
 * Classify how the harness fared against one mutant.
 *   - invalid:  the harness/impl could not run at all (error set OR ran === 0).
 *               An invalid mutant is NOT evidence of a weak suite -- it is a
 *               mutant the probe itself broke (e.g. a syntax error), so it is
 *               excluded from the killed/survived tally.
 *   - killed:   at least one test failed or errored (the suite caught the defect).
 *   - survived: every test passed (the suite missed the defect).
 */
export function classifyMutantOutcome(r: {
  ok:      boolean
  ran:     number
  failed:  number
  errored: number
  error:   string | null
}): MutantOutcome {
  if (r.error || r.ran === 0) return 'invalid'
  if (r.failed > 0 || r.errored > 0) return 'killed'
  return 'survived'
}

/** Aggregate per-mutant outcomes into a single MutationResult. */
export function interpretMutationResults(results: MutantResult[]): MutationResult {
  let killed = 0
  let survived = 0
  let invalid = 0
  for (const r of results) {
    if (r.outcome === 'killed') killed++
    else if (r.outcome === 'survived') survived++
    else invalid++
  }
  return { total: results.length, killed, survived, invalid, mutants: results }
}

/**
 * The greppable escalation reason. Leads with the `mutation_probe:` token (matching
 * the entry_point_probe: / no_terminal_signal: convention) and names the surviving
 * mutants so the re-run has a concrete target.
 */
export function mutationEscalationReason(result: MutationResult): string {
  const survivors = result.mutants.filter(m => m.outcome === 'survived')
  const detail = survivors.slice(0, 5).map(m =>
    `${m.mutant.operator}@line${m.mutant.line} (${JSON.stringify(m.mutant.original.trim())} -> ${JSON.stringify(m.mutant.mutated.trim())})`,
  ).join('; ')
  return `mutation_probe: ${survivors.length} of ${result.killed + result.survived} valid mutants survived the test suite `
    + `(killed ${result.killed}, survived ${result.survived}, invalid ${result.invalid}). `
    + 'The tests pass on subtly-wrong code -- the suite is not strong enough to catch these defects. '
    + `Strengthen the tests so each of these is killed: ${detail}.`
}

/**
 * Evaluate the mutation probe against the contract.
 *   - not required -> satisfied by definition.
 *   - no result (probe did not run) -> satisfied (nothing to show).
 *   - no VALID mutants (all invalid, or none generated) -> satisfied: there was
 *     nothing the suite could have killed, so no evidence of weakness.
 *   - all valid mutants killed -> satisfied.
 *   - at least one valid mutant survived -> NOT satisfied: the suite has a hole,
 *     and the reason names the survivors.
 */
export function evaluateMutationProbe(
  result:   MutationResult | null,
  required: boolean,
): MutationVerdict {
  if (!required) return { required: false, satisfied: true, reason: '', result }
  if (!result)   return { required: true, satisfied: true, reason: '', result: null }
  const valid = result.killed + result.survived
  if (valid === 0) return { required: true, satisfied: true, reason: '', result }
  if (result.survived === 0) return { required: true, satisfied: true, reason: '', result }
  if (result.killed / valid >= MUTATION_DEFAULTS.minKillRate) return { required: true, satisfied: true, reason: '', result }
  return {
    required:  true,
    satisfied: false,
    reason:    mutationEscalationReason(result),
    result,
  }
}

/**
 * The mutation probe is required only for a CODE task (the `runtimes` slot is
 * populated) on an agent flagged `requiresVerifiedExecution` -- mirroring the
 * entry-point probe. Non-code artifacts have no implementation to mutate.
 */
export function mutationProbeRequired(isCodeTask: boolean, requiresVerifiedExecution: boolean): boolean {
  return isCodeTask && requiresVerifiedExecution
}
