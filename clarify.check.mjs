// Verifies the BulletTrain brief-clarification contract
// (see src/bullettrain/clarify.ts, which reuses the consequential-ambiguity
// pattern from src/utils/intake.ts). Follows the check.mjs pattern: a standalone
// assertion script, no test framework. Run after a build:
//   npm run build && node clarify.check.mjs
//
// It unit-tests the pure logic behind item 14 sub-part 2 (explicit human
// checkpoints): a project brief that leaves a consequential dimension
// unspecified yields a bounded multi-choice question set (the same
// CLARIFY_MAX_QUESTIONS = 5 cap as the Agentic Team intake), and the user's
// selections fold back into the brief. Both are pure (no LLM, no execution) so
// they can be asserted deterministically.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const MODULE = process.env.CLARIFY_MODULE || path.join(here, 'dist', 'bullettrain', 'clarify.js')
const INTAKE = process.env.INTAKE_MODULE || path.join(here, 'dist', 'utils', 'intake.js')

const { clarifyBrief, foldSelections } = await import(pathToFileURL(MODULE).href)
const { CLARIFY_MAX_QUESTIONS } = await import(pathToFileURL(INTAKE).href)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}
function dims(c) { return JSON.stringify((c.questions || []).map(q => q.dimension)) }

// -- clarifyBrief ----------------------------------------------------------------

console.log('clarifyBrief:')
{
  const vague = clarifyBrief('Build me a tool to parse invoices')
  ok(vague.isConsequential === true && vague.questions.length > 0 && vague.questions.length <= CLARIFY_MAX_QUESTIONS,
    'vague brief -> consequential, question count within the cap', dims(vague))
  ok(vague.questions.some(q => q.dimension === 'interface') && vague.questions.some(q => q.dimension === 'language'),
    'vague brief asks interface + language')
  ok(vague.questions.every(q => Array.isArray(q.options) && q.options.length > 0),
    'every question carries options')

  const specific = clarifyBrief('Build a Python web app (MVP) that parses invoices')
  ok(specific.isConsequential === false && specific.questions.length === 0,
    'fully-specified brief -> not consequential, no questions', dims(specific))

  const empty = clarifyBrief('')
  ok(empty.isConsequential === false && empty.questions.length === 0, 'empty brief -> not consequential')

  const nonBuild = clarifyBrief('What is the weather today?')
  ok(nonBuild.isConsequential === false, 'non-build brief -> not consequential (no work signal)')

  const allFive = clarifyBrief('Build me a tool with an installer that runs offline')
  ok(allFive.isConsequential === true && allFive.questions.length === CLARIFY_MAX_QUESTIONS,
    'brief hitting all five dimensions -> exactly ' + CLARIFY_MAX_QUESTIONS + ' questions (cap holds)', dims(allFive))
}

// -- foldSelections --------------------------------------------------------------

console.log('\nfoldSelections:')
{
  const brief = 'Build me a tool to parse invoices'
  const { questions } = clarifyBrief(brief)
  const ifaceIdx = questions.findIndex(q => q.dimension === 'interface')
  ok(ifaceIdx !== -1, 'setup: the vague brief produces an interface question')

  ok(foldSelections(brief, [], { '0': 'web' }) === brief, 'no questions -> brief unchanged')
  ok(foldSelections(brief, questions, {}) === brief, 'no selections -> brief unchanged')

  const webOpt = questions[ifaceIdx].options.find(o => o.id === 'web')
  const folded = foldSelections(brief, questions, { [String(ifaceIdx)]: 'web' })
  ok(folded !== brief && folded.includes('Clarified:') && folded.includes('Interface = ' + (webOpt.fold ?? webOpt.label)),
    'single-select by id -> folded with the option label', folded)

  ok(foldSelections(brief, questions, { [String(ifaceIdx)]: 'WEB' }) === folded,
    'option id matched case-insensitively')

  ok(foldSelections(brief, questions, { [String(ifaceIdx)]: 'a Rust CLI' }).includes('Interface = a Rust CLI'),
    'free-text write-in (no matching id) passes through verbatim')

  ok(foldSelections(brief, questions, { [String(ifaceIdx)]: 'team' }).includes("Interface = team's choice"),
    'option with a fold value uses the fold text, not the raw label')

  const allFive = clarifyBrief('Build me a tool with an installer that runs offline')
  const consIdx = allFive.questions.findIndex(q => q.dimension === 'constraints')
  ok(consIdx !== -1 && allFive.questions[consIdx].multiple === true, 'setup: constraints question is multi-select')
  ok(foldSelections('x', allFive.questions, { [String(consIdx)]: 'offline,secure' })
      .includes('Constraints = Offline / no external deps, Security-focused'),
    'multiple-select folds each chosen option')

  const recheck = clarifyBrief(folded)
  ok(!recheck.questions.some(q => q.dimension === 'interface'),
    'after folding interface, re-detection no longer asks interface', dims(recheck))
}

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
