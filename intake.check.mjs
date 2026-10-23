// Verifies the intake fast-path heuristic (see src/utils/intake.ts, wired into
// src/core/intake.ts). Follows the check.mjs pattern: a standalone assertion
// script, no test framework. Run after a build:  npm run build && node intake.check.mjs
//
// It unit-tests classifyIntakeHeuristic across the three routes and, most
// importantly, asserts the safety property the whole design rests on: a goal
// that carries a build/code/work signal is NEVER routed DIRECT (misrouting a
// code task to Direct Chat is worse than the reverse).

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const INTAKE = process.env.INTAKE_MODULE || path.join(here, 'dist', 'utils', 'intake.js')

// Windows absolute paths are not valid ESM import specifiers; use file:// URLs.
const {
  classifyIntakeHeuristic,
  detectConsequentialAmbiguity,
  buildClarificationQuestions,
  renderClarificationQuestions,
  foldClarificationAnswers,
  validateClarificationQuestions,
  extractJsonArray,
} = await import(pathToFileURL(INTAKE).href)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + JSON.stringify(extra) : '')) }
}
const route = (g) => classifyIntakeHeuristic(g).route

// -- DIRECT: trivial questions / calculations, no work signal ------------------

console.log('DIRECT (trivial, no work signal):')
ok(route('what is the capital of France?') === 'DIRECT', 'factual question', route('what is the capital of France?'))
ok(route('how does TCP handshake work?') === 'DIRECT', 'explanation question', route('how does TCP handshake work?'))
ok(route("if a cat = 2 and dog = 5, how much is cat + dog?") === 'DIRECT', 'word-probe calculation', route("if a cat = 2 and dog = 5, how much is cat + dog?"))
ok(route('what is 10 + 15?') === 'DIRECT', 'plain arithmetic', route('what is 10 + 15?'))
ok(route('explain the difference between a process and a thread') === 'DIRECT', 'explain (no question mark)', route('explain the difference between a process and a thread'))
ok(route('why is the sky blue?') === 'DIRECT', 'why question', route('why is the sky blue?'))
ok(route("what's the difference between REST and GraphQL?") === 'DIRECT', 'question naming tech but no work verb', route("what's the difference between REST and GraphQL?"))

// -- PROCEED: specific build/code/fix requests --------------------------------

console.log('\nPROCEED (specific work request):')
ok(route('write a python function to parse CSV files') === 'PROCEED', 'write + language', route('write a python function to parse CSV files'))
ok(route('generate a prometheus scrape config for 192.168.1.1') === 'PROCEED', 'generate + IP', route('generate a prometheus scrape config for 192.168.1.1'))
ok(route('fix the bug in login.js') === 'PROCEED', 'fix + filename', route('fix the bug in login.js'))
ok(route('build a REST API in node') === 'PROCEED', 'build + tech', route('build a REST API in node'))
ok(route('create a docker compose file for postgres') === 'PROCEED', 'create + tech', route('create a docker compose file for postgres'))
ok(route('give me a sample config yaml') === 'PROCEED', 'artifact request + tech', route('give me a sample config yaml'))
ok(route('refactor utils.py to be faster') === 'PROCEED', 'refactor + filename', route('refactor utils.py to be faster'))

// -- AMBIGUOUS: vague work / not confidently trivial ---------------------------

console.log('\nAMBIGUOUS (defer to the LLM classifier):')
ok(route('build me a monitoring system') === 'AMBIGUOUS', 'vague build (no target) -> may CLARIFY', route('build me a monitoring system'))
ok(route('create an API') === 'AMBIGUOUS', 'vague build (no target)', route('create an API'))
ok(route('help me with my project') === 'AMBIGUOUS', 'vague, no work verb, not a question', route('help me with my project'))
ok(route('explain in detail the complete and comprehensive history of the internet from its very earliest origins in the late 1960s all the way through to the present day, including every single major protocol, its evolution over time, and the key people involved in each step of the way') === 'AMBIGUOUS', 'long question -> not a one-liner', route('explain in detail the complete and comprehensive history of the internet from its very earliest origins in the late 1960s all the way through to the present day, including every single major protocol, its evolution over time, and the key people involved in each step of the way'))
ok(route('explain step 1, then step 2, and then step 3 of the algorithm') === 'AMBIGUOUS', 'multi-step phrasing blocks DIRECT', route('explain step 1, then step 2, and then step 3 of the algorithm'))
ok(route('') === 'AMBIGUOUS', 'empty goal', route(''))
ok(route('   ') === 'AMBIGUOUS', 'whitespace-only goal', route('   '))

// -- Safety: a work signal NEVER routes DIRECT ---------------------------------
// This is the invariant the bias-toward-pipeline design exists to guarantee.

console.log('\nSAFETY (work signal never -> DIRECT):')
const codeTasks = [
  'write a function',
  'build an app',
  'create a database',
  'fix the bug',
  'implement a parser',
  'generate some code',
  'how do I implement a binary search?',
  'how do I write a regex to match email addresses?',
]
for (const g of codeTasks) {
  const r = route(g)
  ok(r !== 'DIRECT', `never DIRECT: "${g}"`, r)
}

// -- OpenWebUI wrapper extraction ---------------------------------------------

console.log('\nwrapper extraction (OpenWebUI [Requested by] / Goal: format):')
ok(route('[Requested by: Alice]\n\nContext: some context\n\nGoal: what is the capital of France?') === 'DIRECT', 'wrapped trivial question -> DIRECT', route('[Requested by: Alice]\n\nContext: some context\n\nGoal: what is the capital of France?'))
ok(route('[Requested by: Bob]\n\nGoal: write a python script') === 'PROCEED', 'wrapped work request -> PROCEED', route('[Requested by: Bob]\n\nGoal: write a python script'))

// -- Consequential-ambiguity gate (Issue 10) -----------------------------------

console.log('\nconsequential gate (detectConsequentialAmbiguity):')
const det = (g) => detectConsequentialAmbiguity(g)
ok(det('build me a monitoring system').isConsequential === true, 'vague build -> consequential', det('build me a monitoring system'))
ok(det('build me a monitoring system').dimensions.includes('interface'), 'unspecified interface flagged', det('build me a monitoring system').dimensions)
ok(det('build me a monitoring system').dimensions.includes('language'), 'unspecified language flagged', det('build me a monitoring system').dimensions)
ok(det('create an API').isConsequential === true, 'API build -> consequential', det('create an API'))
ok(!det('create an API').dimensions.includes('interface'), 'API build: interface specified (api)', det('create an API').dimensions)
ok(det('create an API').dimensions.includes('language'), 'API build: language flagged', det('create an API').dimensions)
ok(det('write a python function to parse CSV files').isConsequential === false, 'specific build -> not consequential', det('write a python function to parse CSV files'))
ok(det('build a python REST API for linux, full-featured').isConsequential === false, 'fully specified -> asks nothing', det('build a python REST API for linux, full-featured'))
ok(det('what is the capital of France?').isConsequential === false, 'question -> not a build request', det('what is the capital of France?'))
ok(det('').isConsequential === false, 'empty goal -> not consequential', det(''))
ok(det('build a desktop app').dimensions.includes('platform'), 'platform-sensitive (desktop) -> platform flagged', det('build a desktop app').dimensions)
ok(!det('build a desktop app').dimensions.includes('interface'), 'desktop build: interface specified', det('build a desktop app').dimensions)

console.log('\nscaffold (buildClarificationQuestions):')
const qs = buildClarificationQuestions(['interface', 'language'])
ok(qs.length === 2, '2 dims -> 2 questions', qs.length)
ok(qs[0].dimension === 'interface' && qs[1].dimension === 'language', 'canonical dimension order', qs.map(q => q.dimension))
ok(qs[0].options.length > 0 && qs[0].options.every(o => o.label), 'options carry labels', qs[0].options)
ok(buildClarificationQuestions(['interface', 'language', 'platform', 'scope', 'constraints']).length === 5, 'capped at 5', buildClarificationQuestions(['interface', 'language', 'platform', 'scope', 'constraints']).length)
ok(buildClarificationQuestions([]).length === 0, 'no dims -> no questions', buildClarificationQuestions([]).length)

console.log('\nrender (renderClarificationQuestions):')
const rendered = renderClarificationQuestions(qs)
ok(typeof rendered === 'string' && rendered.length > 0, 'non-empty render', rendered.length)
ok(rendered.includes('Interface') && rendered.includes('Language'), 'headers present', rendered)
ok(rendered.includes('A.') && rendered.includes('B.'), 'lettered options', rendered)
ok(renderClarificationQuestions([]) === '', 'empty -> empty string', renderClarificationQuestions([]))

console.log('\nfold (foldClarificationAnswers):')
const foldQs = buildClarificationQuestions(['interface', 'language'])
const folded1 = foldClarificationAnswers('build me a monitoring system', foldQs, '1a, 2b')
ok(folded1.includes('Interface = Command-line (CLI)'), 'letter 1a -> cli', folded1)
ok(folded1.includes('Language = JavaScript / TypeScript'), 'letter 2b -> js', folded1)
const folded2 = foldClarificationAnswers('build me a monitoring system', foldQs, 'web app, python')
ok(folded2.includes('Interface = Web app'), 'label "web app" -> web', folded2)
ok(folded2.includes('Language = Python'), 'label "python" -> python', folded2)
ok(foldClarificationAnswers('build a system', foldQs, 'I have no idea') === 'build a system', 'no match -> unchanged', foldClarificationAnswers('build a system', foldQs, 'I have no idea'))

console.log('\nvalidate (validateClarificationQuestions):')
const vOk = validateClarificationQuestions([{ dimension: 'interface', header: 'Interface', question: 'What interface?', options: [{ id: 'cli', label: 'CLI' }] }])
ok(Array.isArray(vOk) && vOk.length === 1 && vOk[0].question === 'What interface?', 'good input passes', vOk)
ok(validateClarificationQuestions('not an array') === null, 'non-array -> null', validateClarificationQuestions('not an array'))
ok(validateClarificationQuestions([{ question: '' }]) === null, 'empty question -> null')
ok(validateClarificationQuestions([{ question: 'q', options: [{ label: '' }] }]) === null, 'empty option label -> null')
ok(validateClarificationQuestions([]) === null, 'empty array -> null')

console.log('\nextract (extractJsonArray):')
ok(extractJsonArray('[{"a":1}]') === '[{"a":1}]', 'plain array', extractJsonArray('[{"a":1}]'))
ok(extractJsonArray('here you go: [1,2,3] done') === '[1,2,3]', 'array in prose', extractJsonArray('here you go: [1,2,3] done'))
ok(extractJsonArray('```json\n[{"x":1}]\n```') === '[{"x":1}]', 'array in code fence', extractJsonArray('```json\n[{"x":1}]\n```'))
ok(extractJsonArray('no array here') === 'no array here', 'no array -> whole string', extractJsonArray('no array here'))

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
