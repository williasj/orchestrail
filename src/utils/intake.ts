// -- Intake fast-path heuristic -------------------------------------------------
// Pure, dependency-free pre-classifier for incoming goals. It runs BEFORE the
// LLM intake classifier (core/intake.ts) so the obvious cases are routed with
// no model round-trip:
//
//   DIRECT     trivial / conversational request -> a single direct answer
//   PROCEED    specific build/code/fix request  -> straight to the pipeline
//   AMBIGUOUS  anything it cannot confidently call -> defer to the LLM classifier
//
// The bias is toward the pipeline. A goal is only routed DIRECT when it carries
// NO build/code/work signal at all: misrouting a code task to Direct Chat is
// worse than the reverse, so any work verb or artifact request disqualifies
// DIRECT. A work request that lacks a concrete target (no tech, no filename,
// no IP, no number) is left AMBIGUOUS so the LLM classifier can still CLARIFY
// it rather than committing the team to the wrong build.
//
// Kept in a leaf module (no imports) so it is unit-testable standalone
// (intake.check.mjs), following the secrets.ts / terminal.ts pattern.

export type IntakeRoute = 'DIRECT' | 'PROCEED' | 'AMBIGUOUS'

export interface IntakeHeuristic {
  route:  IntakeRoute
  reason: string
}

// Strong, unambiguous "do work" verbs. Any of these means the request wants
// something BUILT / WRITTEN / FIXED, not merely answered.
const WORK_VERBS =
  /\b(write|build|create|generate|implement|code|coding|script|fix|debug|refactor|develop|deploy|configure|produce)\b/i

// A request for a concrete artifact: a give/show/make verb aimed at a file-
// like object ("give me a config", "show me a sample", "produce a report").
const REQUEST_VERBS = /\b(give|show|make|produce|get|send|deliver|return|output|print)\b/i
const ARTIFACTS =
  /\b(file|files|document|documents|report|spreadsheet|config|configuration|yaml|yml|json|csv|xml|pdf|xlsx|zip|image|images|chart|graph|template|boilerplate|snippet|demo|example|examples|sample|samples|function|class|module|library|endpoint|endpoints|api|server|database|app|application|program|tool|utility|code)\b/i

// Multi-step / multi-part phrasing that signals more than a one-line answer.
const MULTI_STEP =
  /\b(step ?\d|first,|then,|and then|in addition|also,|furthermore|additionally|multiple|each of|for each|a list|list of|numbered|several|separate)\b/i

// Concrete-target signals that make a work request specific enough to run
// without clarification.
const TECH        =
  /\b(python|javascript|typescript|java|golang|\bgo\b|rust|c\+\+|c#|ruby|php|sql|html|css|react|vue|svelte|node|nodejs|express|django|flask|fastapi|kubernetes|docker|prometheus|grafana|nginx|caddy|rest|graphql|grpc|cli|web|postgres|mysql|redis|sqlite|linux|bash|shell|powershell|excel|openpyxl|pandas|numpy|matplotlib|regex|pdf|csv|json|yaml|yml)\b/i
const IP_RE       = /(\d{1,3}\.){3}\d{1,3}/
const FILENAME_RE = /\b[\w.-]+\.[a-z]{1,5}\b/i
const NUMBER_RE   = /\b\d+\b/

// A trivial Direct-Chat candidate must be short and single-step.
const DIRECT_MAX_CHARS = 200
const DIRECT_MAX_WORDS = 30

function isQuestion(g: string): boolean {
  if (/\?\s*$/.test(g)) return true
  return /^(what|why|how|when|where|who|whom|whose|which|can|could|would|should|does|do|is|are|was|were|explain|define|describe|compare|difference|tell|list|summarize)\b/i.test(g)
}

function isArithmetic(g: string): boolean {
  return g.length <= 80 && /\d\s*[+\-*/=%]\s*\d/.test(g)
}

function hasSpecifics(g: string): boolean {
  return TECH.test(g) || IP_RE.test(g) || FILENAME_RE.test(g) || NUMBER_RE.test(g)
}

// The OpenWebUI path wraps the goal as "[Requested by: X]\n\nContext: ...\n\nGoal: <goal>".
// Classify on the actual goal, not the wrapper.
function extractSubject(g: string): string {
  let s = g.replace(/^\s*\[Requested by:[^\]]*\]\s*/i, '')
  const m = s.match(/Goal:\s*([\s\S]+)\s*$/i)
  if (m) s = m[1]
  return s
}

export function classifyIntakeHeuristic(goal: string): IntakeHeuristic {
  const raw = (goal ?? '').replace(/\s+/g, ' ').trim()
  if (!raw) return { route: 'AMBIGUOUS', reason: 'empty goal' }

  const g     = extractSubject(raw)
  const words = g.split(' ').length
  const short = g.length <= DIRECT_MAX_CHARS && words <= DIRECT_MAX_WORDS

  const hasWorkVerb        = WORK_VERBS.test(g)
  const hasArtifactRequest = REQUEST_VERBS.test(g) && ARTIFACTS.test(g)
  const hasMultiStep       = MULTI_STEP.test(g)

  // 1) Any build/code/work signal disqualifies DIRECT (bias toward the pipeline).
  //    A specific work request fast-paths straight to the pipeline; a vague one
  //    stays AMBIGUOUS so the LLM classifier can still CLARIFY it.
  if (hasWorkVerb || hasArtifactRequest) {
    if (hasSpecifics(g)) {
      return { route: 'PROCEED', reason: 'work request with a concrete target' }
    }
    return { route: 'AMBIGUOUS', reason: 'work request without a concrete target -- defer to the classifier (may CLARIFY)' }
  }

  // 2) No work signal: a short, single-step question or calculation is a
  //    confident Direct-Chat candidate.
  // A request that refers to an attached/provided file needs the team (it has the
  // file context); a coordinator one-shot answer would never see the file.
  const refersToFile = /\b(attach(ed|ment)?|uploaded|this (file|document|report|spreadsheet|pdf|csv))\b/i.test(g)
  if (short && !hasMultiStep && !refersToFile && (isQuestion(g) || isArithmetic(g))) {
    return { route: 'DIRECT', reason: 'short question/calculation with no work signal' }
  }

  // 3) Everything else is ambiguous -> the LLM classifier decides.
  return { route: 'AMBIGUOUS', reason: 'not confidently trivial or specific' }
}

// -- Consequential-ambiguity clarification (Issue 10) --------------------------
// When a build request leaves a *consequential* dimension unspecified -- one
// whose answer changes the implementation (interface type, language, platform,
// scope, constraints) -- intake asks a bounded set of multiple-choice questions
// (each with a write-in escape) instead of guessing. The gate, scaffolding,
// rendering, and answer-folding are pure and unit-testable (intake.check.mjs);
// the LLM only refines phrasing / adds domain options (best-effort, see
// core/intake.ts), and the free-form classifier remains the fallback for novel
// ambiguity the pure gate does not capture.
//
// Bias: toward proceeding. A dimension is only asked when it is genuinely
// unspecified AND consequential; a fully-specified goal asks nothing.

export type ClarificationDimension = 'interface' | 'language' | 'platform' | 'scope' | 'constraints'

export interface ClarificationOption {
  id: string
  label: string
  description?: string
  fold?: string
}

export interface ClarificationQuestion {
  dimension: ClarificationDimension | 'other'
  header: string
  question: string
  options: ClarificationOption[]
  multiple?: boolean
}

export interface ConsequentialAmbiguity {
  isConsequential: boolean
  dimensions: ClarificationDimension[]
  reason: string
}

export const CLARIFY_MAX_QUESTIONS = 5

const DIMENSION_ORDER: ClarificationDimension[] = ['interface', 'language', 'platform', 'scope', 'constraints']

interface DimensionMeta {
  header: string
  question: string
  options: ClarificationOption[]
  multiple?: boolean
}

const DIMENSION_META: Record<ClarificationDimension, DimensionMeta> = {
  interface: {
    header: 'Interface',
    question: 'What kind of interface should this have?',
    options: [
      { id: 'cli', label: 'Command-line (CLI)', description: 'Runs in a terminal; text in/out.' },
      { id: 'desktop', label: 'Desktop app (GUI)', description: 'Windowed app with a graphical interface.' },
      { id: 'web', label: 'Web app', description: 'Browser-based; served over HTTP.' },
      { id: 'api', label: 'API / service', description: 'HTTP/REST endpoint; programmatic access.' },
      { id: 'library', label: 'Library / module', description: 'Importable code; no standalone entry point.' },
      { id: 'team', label: "Team's choice", description: 'Pick a sensible default.', fold: "team's choice" },
    ],
  },
  language: {
    header: 'Language',
    question: 'Which language or stack should it be built in?',
    options: [
      { id: 'python', label: 'Python' },
      { id: 'js', label: 'JavaScript / TypeScript' },
      { id: 'go', label: 'Go' },
      { id: 'rust', label: 'Rust' },
      { id: 'java', label: 'Java / Kotlin' },
      { id: 'team', label: "Team's choice", description: 'Pick a sensible default.', fold: "team's choice" },
    ],
  },
  platform: {
    header: 'Platform',
    question: 'Which platform(s) must it run on?',
    options: [
      { id: 'windows', label: 'Windows' },
      { id: 'linux', label: 'Linux' },
      { id: 'macos', label: 'macOS' },
      { id: 'cross', label: 'Cross-platform' },
      { id: 'team', label: "Team's choice", description: 'Pick a sensible default.', fold: "team's choice" },
    ],
  },
  scope: {
    header: 'Scope',
    question: 'How much scope do you want for the first version?',
    options: [
      { id: 'mvp', label: 'Minimal / MVP', description: 'Smallest useful version.' },
      { id: 'full', label: 'Full-featured', description: 'Complete, production-ready.' },
      { id: 'team', label: "Team's choice", description: 'Pick a sensible default.', fold: "team's choice" },
    ],
  },
  constraints: {
    header: 'Constraints',
    question: 'Any hard constraints I should design around?',
    multiple: true,
    options: [
      { id: 'none', label: 'No special constraints', description: 'Reasonable defaults.' },
      { id: 'offline', label: 'Offline / no external deps' },
      { id: 'secure', label: 'Security-focused' },
      { id: 'team', label: "Team's choice", description: 'Pick sensible defaults.', fold: "team's choice" },
    ],
  },
}

// -- Dimension detectors (pure) ------------------------------------------------
// A dimension is "unspecified" when the goal names no signal for it. The
// detectors are deliberately conservative so a typical goal raises 0-2
// questions, not five: platform only for platform-sensitive builds, scope only
// for multi-component systems, constraints only for an explicit hard constraint.

const IFACE_CLI      = /\b(cli|command.?line|terminal|console|script)\b/i
const IFACE_DESKTOP  = /\b(desktop|gui|graphical|windowed|window|electron|tkinter|wxpython|\bqt\b|\.exe|native)\b/i
const IFACE_WEB      = /\b(web|website|web ?site|webapp|web ?app|browser|frontend|front.?end|react|vue|svelte|next\.?js|django|flask|html|css)\b/i
const IFACE_API      = /\b(api|rest|http|https|endpoint|endpoints|graphql|grpc|microservice)\b/i
const IFACE_LIB      = /\b(library|module|package|sdk|class|function|utility|snippet)\b/i

const LANGUAGE = /\b(python|javascript|typescript|java|golang|\bgo\b|rust|c\+\+|c#|ruby|php|swift|kotlin|sql|scala|perl|lua)\b/i

const PLATFORM           = /\b(windows|linux|macos|mac os|osx|cross.?platform|browser|mobile|ios|android|unix)\b/i
const PLATFORM_SENSITIVE = /\b(desktop|gui|graphical|windowed|window|electron|native|installer|\.exe)\b/i

const SYSTEM = /\b(system|platform|service|application|app|dashboard|website|webapp|web ?app|engine|framework|tool|bot)\b/i
const SCOPE  = /\b(mvp|minimal|minimum|basic|simple|full|complete|production|feature|features|prototype|poc|proof of concept)\b/i

const CONSTRAINT_HINT = /\b(offline|no dependencies|no external dependencies|dependency.?free|standalone|air.?gapped)\b/i

function hasWorkSignal(g: string): boolean {
  return WORK_VERBS.test(g) || (REQUEST_VERBS.test(g) && ARTIFACTS.test(g))
}

export function detectConsequentialAmbiguity(goal: string): ConsequentialAmbiguity {
  const g = extractSubject((goal ?? '').replace(/\s+/g, ' ').trim())
  if (!g) return { isConsequential: false, dimensions: [], reason: 'empty goal' }
  if (!hasWorkSignal(g)) return { isConsequential: false, dimensions: [], reason: 'not a build request' }

  const dims: ClarificationDimension[] = []
  const ifaceSpecified = IFACE_CLI.test(g) || IFACE_DESKTOP.test(g) || IFACE_WEB.test(g) || IFACE_API.test(g) || IFACE_LIB.test(g)
  if (!ifaceSpecified) dims.push('interface')
  if (!LANGUAGE.test(g)) dims.push('language')
  if (PLATFORM_SENSITIVE.test(g) && !PLATFORM.test(g)) dims.push('platform')
  if (SYSTEM.test(g) && !SCOPE.test(g)) dims.push('scope')
  if (CONSTRAINT_HINT.test(g)) dims.push('constraints')

  return {
    isConsequential: dims.length > 0,
    dimensions: dims,
    reason: dims.length ? 'consequential dimension(s) unspecified: ' + dims.join(', ') : 'all consequential dimensions specified',
  }
}

export function buildClarificationQuestions(dims: ClarificationDimension[]): ClarificationQuestion[] {
  const ordered = DIMENSION_ORDER.filter(d => dims.includes(d))
  return ordered.slice(0, CLARIFY_MAX_QUESTIONS).map(d => {
    const meta = DIMENSION_META[d]
    return {
      dimension: d,
      header: meta.header,
      question: meta.question,
      options: meta.options.map(o => ({ ...o })),
      multiple: meta.multiple,
    }
  })
}

export function renderClarificationQuestions(questions: ClarificationQuestion[]): string {
  if (!questions.length) return ''
  return questions.map((q, i) => {
    const opts = q.options.length
      ? q.options.map((o, j) => '  ' + String.fromCharCode(65 + j) + '. ' + o.label + (o.description ? ' - ' + o.description : '')).join('\n')
      : '  (open question - type your answer)'
    return (i + 1) + '. **' + q.header + '** - ' + q.question + '\n' + opts + '\n   (pick one, or type your own answer)'
  }).join('\n\n')
}

// -- Answer folding (pure) -----------------------------------------------------
// Folds the user's reply back into the goal. A reply is matched per question,
// first by a bare letter ("1a", "2: b"), then by a label/id mention ("web app,
// python"). Unmatched questions are dropped from the folded line; the raw reply
// is always preserved separately by the caller (buildEnrichedGoal), so a
// best-effort fold never loses information.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, c => '\\' + c)
}

function wordMentioned(term: string, hay: string): boolean {
  if (!term) return false
  const re = new RegExp('(?<![a-z0-9])' + escapeRegex(term) + '(?![a-z0-9])', 'i')
  return re.test(hay)
}

function optionTerms(o: ClarificationOption): string[] {
  const terms = new Set<string>()
  terms.add(o.id.toLowerCase())
  for (const w of o.label.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 3) terms.add(w)
  }
  return [...terms]
}

// Match a bare-letter answer for question qIndex (0-based): "1a", "1: a", "1. a", "1) a".
function letterIndexFor(ansLower: string, qIndex: number): number | null {
  const n = qIndex + 1
  const re = new RegExp('(?<![0-9])' + n + '\\s*[:.)]\\s*([a-z])\\b|(?<![0-9])' + n + '([a-z])\\b', 'i')
  const m = ansLower.match(re)
  if (!m) return null
  const letter = (m[1] ?? m[2] ?? '').toLowerCase()
  if (!letter) return null
  const idx = letter.charCodeAt(0) - 97
  return idx >= 0 && idx < 26 ? idx : null
}

export function foldClarificationAnswers(goal: string, questions: ClarificationQuestion[], answerText: string): string {
  if (!questions.length) return goal
  const ans = (answerText ?? '').toLowerCase()
  if (!ans.trim()) return goal

  const clauses: string[] = []
  questions.forEach((q, i) => {
    if (!q.options.length) return
    const li = letterIndexFor(ans, i)
    if (li !== null && li < q.options.length) {
      const o = q.options[li]!
      clauses.push(q.header + ' = ' + (o.fold ?? o.label))
      return
    }
    // Score each option by how many of its terms the reply mentions. A shared
    // generic word (e.g. "app" in "Desktop app" / "Web app") no longer wins by
    // option order -- the option with the most mentioned terms does.
    const scored = q.options
      .map(o => ({ o, score: optionTerms(o).filter(t => wordMentioned(t, ans)).length }))
      .filter(s => s.score > 0)
    if (!scored.length) return
    if (q.multiple) {
      clauses.push(q.header + ' = ' + scored.map(s => (s.o.fold ?? s.o.label)).join(', '))
    } else {
      const best = scored.reduce((a, b) => (b.score > a.score ? b : a))
      clauses.push(q.header + ' = ' + (best.o.fold ?? best.o.label))
    }
  })

  if (!clauses.length) return goal
  return goal + '\n\nClarified: ' + clauses.join('; ')
}

// -- Refine validation (pure) --------------------------------------------------
// The LLM refine (core/intake.ts) is best-effort: its output is validated here
// and any malformed shape falls back to the code scaffold. A question must carry
// a non-empty `question`; options (when present) must each carry a `label`. The
// result is capped at CLARIFY_MAX_QUESTIONS.

export function validateClarificationQuestions(input: unknown): ClarificationQuestion[] | null {
  if (!Array.isArray(input)) return null
  const out: ClarificationQuestion[] = []
  for (const item of input) {
    if (typeof item !== 'object' || item === null) return null
    const q = item as Record<string, unknown>
    if (typeof q.question !== 'string' || !q.question.trim()) return null
    const header = typeof q.header === 'string' && q.header.trim() ? q.header.trim().slice(0, 30) : 'Question'
    const options: ClarificationOption[] = []
    if (q.options !== undefined) {
      if (!Array.isArray(q.options)) return null
      for (const o of q.options) {
        if (typeof o !== 'object' || o === null) return null
        const opt = o as Record<string, unknown>
        if (typeof opt.label !== 'string' || !opt.label.trim()) return null
        options.push({
          id: typeof opt.id === 'string' && opt.id.trim()
            ? opt.id.trim().toLowerCase()
            : opt.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          label: opt.label.trim(),
          description: typeof opt.description === 'string' ? opt.description : undefined,
          fold: typeof opt.fold === 'string' ? opt.fold : undefined,
        })
      }
    }
    out.push({
      dimension: typeof q.dimension === 'string' ? (q.dimension as ClarificationQuestion['dimension']) : 'other',
      header,
      question: q.question.trim(),
      options,
      multiple: q.multiple === true,
    })
    if (out.length >= CLARIFY_MAX_QUESTIONS) break
  }
  return out.length ? out : null
}

// Extract the first balanced JSON array from a string (the refine LLM may wrap
// the array in prose or code fences).
export function extractJsonArray(text: string): string {
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
