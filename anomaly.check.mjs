// Verifies the synthesis anomaly register (see src/utils/anomaly.ts, wired into
// src/core/synthesize.ts). Follows the check.mjs pattern: a standalone
// assertion script, no test framework.
// Run after a build:  npm run build && node anomaly.check.mjs
//
// It unit-tests the pure contract behind frontier issue A4 (P2, "[1]"): the
// synthesis narrative is model-authored and can misreport the run's HISTORY --
// e.g. "no test corrections needed" after a test was actually rewritten, or a
// "found -> fixed -> confirmed" arc on a run that never reworked. The run
// record (AgentResult[]) is the ground truth: every escalation, every "Fix:"
// helper agent, every re-run, and every verification outcome is recorded by the
// orchestrator, not the model. describeRunFacts derives the facts,
// detectSynthesisAnomalies checks the narrative's history claims against them
// (each anomaly requires BOTH a factual condition AND an unambiguous claim),
// and renderAnomalyRegister renders a machine-authored advisory note. All pure
// string logic -- no LLM, no execution -- so it can be asserted deterministically.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ANOM = process.env.ANOMALY_MODULE || path.join(here, 'dist', 'utils', 'anomaly.js')

const {
  FIX_AGENT_TITLE_RE,
  describeRunFacts,
  detectSynthesisAnomalies,
  renderAnomalyRegister,
} = await import(pathToFileURL(ANOM).href)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}

// -- helpers to build hand-crafted run records ------------------------------------

function stage(title, assignee, status, { completion: completionExtra = {}, ...rest } = {}) {
  return {
    title, assignee, output: `${title} output`, success: status === 'DONE',
    completion: { status, summary: `${title} summary`, ...completionExtra },
    ...rest,
  }
}
function fixAgent(stageName, assignee) {
  return {
    title: `Fix: ${stageName}`, assignee, output: 'fix output', success: true,
    completion: { status: 'DONE', summary: 'fixed it' },
  }
}

// A clean 4-stage run: every stage DONE on the first attempt, no fix agents.
function cleanRun() {
  return [
    stage('Design', 'software-architect', 'DONE'),
    stage('Implementation', 'senior-engineer', 'DONE'),
    stage('Testing', 'test-engineer', 'DONE'),
    stage('Review', 'adversarial-reviewer', 'DONE'),
  ]
}

// The canonical A4 shape: the test stage escalated, a fix agent ran, the stage
// re-ran and closed DONE (a test was rewritten).
function reworkedRun() {
  return [
    stage('Design', 'software-architect', 'DONE'),
    stage('Implementation', 'senior-engineer', 'DONE'),
    stage('Testing', 'test-engineer', 'ESCALATE', { completion: { escalation_reason: 'test harness bug' } }),
    fixAgent('Testing', 'test-engineer'),
    stage('Testing', 'test-engineer', 'DONE'),
    stage('Review', 'adversarial-reviewer', 'DONE'),
  ]
}

// The test stage escalated and never recovered (terminal ESCALATE).
function testEscalatedRun() {
  return [
    stage('Design', 'software-architect', 'DONE'),
    stage('Implementation', 'senior-engineer', 'DONE'),
    stage('Testing', 'test-engineer', 'ESCALATE', { completion: { escalation_reason: 'overflow unhandled' } }),
    fixAgent('Testing', 'test-engineer'),
    stage('Testing', 'test-engineer', 'ESCALATE', { completion: { escalation_reason: 'still failing' } }),
    stage('Review', 'adversarial-reviewer', 'DONE'),
  ]
}

// -- exports ------------------------------------------------------------------------

console.log('exports:')
ok(FIX_AGENT_TITLE_RE instanceof RegExp, 'FIX_AGENT_TITLE_RE is exported')
ok(FIX_AGENT_TITLE_RE.test('Fix: Testing') === true,  'matches a Fix: helper title')
ok(FIX_AGENT_TITLE_RE.test('Fix:implementation') === true, 'matches regardless of case after Fix')
ok(FIX_AGENT_TITLE_RE.test('Testing') === false,       'does not match a plain stage title')
ok(FIX_AGENT_TITLE_RE.test('Fixed: Testing') === false, 'does not match a near-miss title')

// -- describeRunFacts: clean run -------------------------------------------------------

console.log('\ndescribeRunFacts (clean run):')
{
  const f = describeRunFacts(cleanRun())
  ok(f.stages.length === 4, 'four stages recorded')
  ok(f.stages.every(s => s.attempts === 1), 'every stage ran exactly once')
  ok(f.stages.every(s => s.terminalStatus === 'DONE'), 'every stage terminal DONE')
  ok(f.totalEscalations === 0, 'no escalations')
  ok(f.fixAgentCount === 0, 'no fix agents')
  ok(f.selfContractEscalations === 0, 'no self-contract escalations')
  ok(f.verificationFailed === false, 'no verification failure')
  ok(f.testStageEscalated === false, 'test stage did not escalate')
  ok(f.hadRework === false, 'hadRework is false')
}

// -- describeRunFacts: reworked run (escalate -> fix -> recovered) ----------------------

console.log('\ndescribeRunFacts (reworked run, recovered):')
{
  const f = describeRunFacts(reworkedRun())
  const testing = f.stages.find(s => s.name === 'Testing')
  ok(testing.attempts === 2, 'Testing recorded two own attempts')
  ok(testing.terminalStatus === 'DONE', 'terminal status is the LAST own-attempt (DONE)')
  ok(testing.escalatedAtLeastOnce === true, 'escalatedAtLeastOnce is true')
  ok(f.stages.length === 4, 'the Fix: helper is NOT counted as a stage')
  ok(f.fixAgentCount === 1, 'one fix agent counted')
  ok(f.totalEscalations === 1, 'one escalation counted')
  ok(f.hadRework === true, 'hadRework is true (escalation + fix agent + re-run)')
  ok(f.testStageEscalated === false, 'test stage recovered -> NOT terminal-escalated')
}

// -- describeRunFacts: terminal test escalation ------------------------------------------

console.log('\ndescribeRunFacts (test stage terminal-escalated):')
{
  const f = describeRunFacts(testEscalatedRun())
  const testing = f.stages.find(s => s.name === 'Testing')
  ok(testing.terminalStatus === 'ESCALATE', 'terminal status ESCALATE')
  ok(testing.attempts === 2, 'two own attempts')
  ok(f.testStageEscalated === true, 'testStageEscalated is true')
  ok(f.totalEscalations === 2, 'both attempts counted as escalations')
  ok(f.fixAgentCount === 1, 'fix agent counted')
  ok(f.hadRework === true, 'hadRework is true')
}

// -- describeRunFacts: verification + self-contract + no-completion -----------------------

console.log('\ndescribeRunFacts (verification / self-contract / no completion):')
{
  const f = describeRunFacts([
    stage('Implementation', 'senior-engineer', 'DONE', { verification: { required: true, passed: false, detail: 'exit 1' } }),
    stage('Testing', 'test-engineer', 'ESCALATE', { completion: { selfContract: true, escalation_reason: 'no_terminal_signal' } }),
    { title: 'Review', assignee: 'adversarial-reviewer', output: 'x', success: true }, // no completion
  ])
  ok(f.verificationFailed === true, 'required verification that never passed -> verificationFailed')
  ok(f.selfContractEscalations === 1, 'self-contract escalation counted')
  ok(f.totalEscalations === 1, 'total escalations counted')
  const review = f.stages.find(s => s.name === 'Review')
  ok(review.attempts === 1 && review.terminalStatus === 'DONE', 'a result with no completion is an attempt, terminal DONE')
}
{
  const f = describeRunFacts([
    stage('Implementation', 'senior-engineer', 'DONE', { verification: { required: true, passed: true, detail: 'ok' } }),
    stage('Testing', 'test-engineer', 'DONE'),
  ])
  ok(f.verificationFailed === false, 'a passing required verification is not a failure')
  ok(f.hadRework === false, 'clean run stays clean')
}

// -- describeRunFacts: purity --------------------------------------------------------------

console.log('\ndescribeRunFacts (purity):')
{
  const results = reworkedRun()
  const snapshot = JSON.stringify(results)
  describeRunFacts(results)
  ok(JSON.stringify(results) === snapshot, 'input array is not mutated')
}

// -- detectSynthesisAnomalies: the canonical A4 case -----------------------------------------

console.log('\ndetectSynthesisAnomalies (canonical A4: "no test corrections needed" after a rewrite):')
{
  const f = describeRunFacts(reworkedRun())
  const a = detectSynthesisAnomalies(f, 'The suite passed cleanly. No test corrections were needed; the original harness was sound.')
  ok(a.length === 1, 'exactly one anomaly')
  ok(a[0].code === 'no_correction_claimed', 'code is no_correction_claimed')
  ok(/no test corrections were needed/i.test(a[0].claim), 'claim is the matched text')
  ok(a[0].evidence.includes('escalation') && a[0].evidence.includes('fix agent'), 'evidence names the rework the record shows')
}
{
  const f = describeRunFacts(reworkedRun())
  const a = detectSynthesisAnomalies(f, 'No test corrections needed.')
  ok(a.length === 1 && a[0].code === 'no_correction_claimed', 'the bare A4 phrasing "no test corrections needed" is caught')
}

// -- detectSynthesisAnomalies: the claim is fine when the record is clean ---------------------

console.log('\ndetectSynthesisAnomalies (clean record, same claim -> no anomaly):')
{
  const f = describeRunFacts(cleanRun())
  const a = detectSynthesisAnomalies(f, 'No test corrections were needed; the suite passed on the first run.')
  ok(a.length === 0, 'a true "no corrections" claim on a clean run is NOT flagged')
}

// -- detectSynthesisAnomalies: clean-pass claim vs terminal test escalation -------------------

console.log('\ndetectSynthesisAnomalies (clean-pass claim vs terminal test escalation):')
{
  const f = describeRunFacts(testEscalatedRun())
  const a = detectSynthesisAnomalies(f, 'All tests passed (23/23).')
  ok(a.length === 1 && a[0].code === 'clean_pass_claimed', 'a clean-pass claim after a terminal test ESCALATE is flagged')
  ok(/ESCALATE/.test(a[0].evidence), 'evidence states the test stage ended ESCALATE')
}
{
  // Recovered test stage: the final run genuinely passed -> the claim is true.
  const f = describeRunFacts(reworkedRun())
  const a = detectSynthesisAnomalies(f, 'All tests passed (23/23).')
  ok(a.length === 0, 'a clean-pass claim after a RECOVERED test stage is NOT flagged')
}
{
  const f = describeRunFacts([
    stage('Implementation', 'senior-engineer', 'DONE', { verification: { required: true, passed: false, detail: 'exit 1' } }),
  ])
  const a = detectSynthesisAnomalies(f, 'Result: 100% pass rate.')
  ok(a.length === 1 && a[0].code === 'clean_pass_claimed', 'a 100%-pass claim with a failed required verification is flagged')
}

// -- detectSynthesisAnomalies: fabricated rework on a clean run ---------------------------------

console.log('\ndetectSynthesisAnomalies (fabricated rework on a clean run):')
{
  const f = describeRunFacts(cleanRun())
  const a = detectSynthesisAnomalies(f, 'After multiple rounds of fixes, the team converged on a stable implementation.')
  ok(a.length === 1 && a[0].code === 'rework_claimed', 'a rework narrative on a no-rework run is flagged')
  ok(a[0].evidence.includes('no rework'), 'evidence states the record shows no rework')
}
{
  const f = describeRunFacts(reworkedRun())
  const a = detectSynthesisAnomalies(f, 'After multiple rounds of fixes, the team converged on a stable implementation.')
  ok(a.length === 0, 'a rework narrative on a run that DID rework is NOT flagged')
}

// -- detectSynthesisAnomalies: no false alarms ---------------------------------------------------

console.log('\ndetectSynthesisAnomalies (no false alarms):')
{
  const f = describeRunFacts(reworkedRun())
  const a = detectSynthesisAnomalies(f, 'The calculator accepts integer and float input and rejects empty input with a clear error message.')
  ok(a.length === 0, 'ordinary product description on a reworked run -> no anomaly')
}
{
  const f = describeRunFacts(cleanRun())
  const a = detectSynthesisAnomalies(f, 'The implementation uses a single pass over the input to compute the result.')
  ok(a.length === 0, '"single pass" describing an ALGORITHM (not the run) -> no anomaly')
}
{
  const f = describeRunFacts(reworkedRun())
  const a = detectSynthesisAnomalies(f, 'The implementation uses a single pass over the input to compute the result.')
  ok(a.length === 0, 'algorithmic "single pass" on a reworked run -> still no anomaly (only the run-referencing form is matched)')
}
{
  const f = describeRunFacts(reworkedRun())
  const a = detectSynthesisAnomalies(f, '')
  ok(a.length === 0, 'empty synthesis -> no anomalies')
  const b = detectSynthesisAnomalies(f, null)
  ok(b.length === 0, 'null synthesis -> no anomalies')
}

// -- detectSynthesisAnomalies: case-insensitivity + multiple rules --------------------------------

console.log('\ndetectSynthesisAnomalies (case-insensitivity, multiple rules):')
{
  const f = describeRunFacts(testEscalatedRun())
  const a = detectSynthesisAnomalies(f, 'NO TEST CORRECTIONS NEEDED. All tests passed.')
  ok(a.length === 2, 'two independent contradictions -> two anomalies')
  ok(a.some(x => x.code === 'no_correction_claimed') && a.some(x => x.code === 'clean_pass_claimed'), 'both rules fire')
}
{
  const f = describeRunFacts(reworkedRun())
  const a = detectSynthesisAnomalies(f, 'The run completed in a single pass.')
  ok(a.length === 1 && a[0].code === 'no_correction_claimed', 'a "single pass" claim on a reworked run is flagged')
}

// -- renderAnomalyRegister --------------------------------------------------------------------------

console.log('\nrenderAnomalyRegister:')
{
  ok(renderAnomalyRegister([]) === '', 'no anomalies -> empty string')
}
{
  const f = describeRunFacts(reworkedRun())
  const a = detectSynthesisAnomalies(f, 'No test corrections were needed.')
  const rendered = renderAnomalyRegister(a)
  ok(rendered.includes('> [!NOTE]'), 'renders as a markdown note block')
  ok(rendered.includes('ANOMALY REGISTER'), 'names itself')
  ok(rendered.includes('no_correction_claimed'), 'names the anomaly code')
  ok(rendered.includes('No test corrections were needed'), 'quotes the claim')
  ok(rendered.includes('authoritative'), 'defers to the run record as authoritative')
  ok(rendered.startsWith('\n\n'), 'leading newlines keep it off the preceding line')
}

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
