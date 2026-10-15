// -- Agent execution -----------------------------------------------------------
// runAgent: main agentic loop -- tool calls, retries, pipeline completion.
// currentGeneration: monotonic counter used to abort stale requests.

import {
  HANDOFF_DONE, HANDOFF_FOOTER, MAX_TOOL_ROUNDS,
} from '../utils/config.js'
import {
  stripThinkBlocks, extractCodeBlock, extractCodeFromToolCalls, ensurePyFutureAnnotations,
} from '../utils/text.js'
import { wbGet, wbSet } from './workbench.js'
import { defaultLLM } from './persistence.js'
import { callLLMRaw, buildFlagPrefix, usageStorage } from './llm.js'
import {
  buildCompleteStageTool, COMPLETE_STAGE_FN, COMPLETE_STAGE_URL,
} from './prompts.js'
import {
  fetchAgentTools, executeToolCall, appendToolLog,
} from './tools.js'
import { recallSkillCaps } from './skillexec.js'
import { recallFailures } from './ragspecs.js'
import type { TeamAgent, TaskSpec, AgentResult, StageCompletion, AgenticMessage } from '../types/index.js'

// -- Module init ---------------------------------------------------------------

type AgentDeps = {
  getAgents: () => TeamAgent[]
}

let _deps: AgentDeps | null = null

export function initAgent(deps: AgentDeps): void {
  _deps = deps
}

function agentMap(): Map<string, TeamAgent> {
  return new Map((_deps?.getAgents() ?? []).map(a => [a.name, a]))
}

/** Slot ownership, for routing fixes to an agent that can actually write the slot. */
export function agentCanWriteSlot(agentName: string, slot: string): boolean {
  const a = agentMap().get(agentName)
  return !!a && !(a.readOnlySlots ?? []).includes(slot)
}
export function slotOwner(slot: string): string | null {
  return (_deps?.getAgents() ?? []).find(a => (a.requiredOutputSlots ?? []).includes(slot))?.name ?? null
}

// -- Generation counter --------------------------------------------------------
// Each new /v1/chat/completions request bumps this. runAgent checks it each
// round and aborts if stale so superseded agents don't keep running.

let currentGeneration = 0
export function bumpGeneration(): number { return ++currentGeneration }
export function getGeneration():  number { return currentGeneration }

// -- runAgent ------------------------------------------------------------------

// Outcome-gate helpers. A use_skill result is the JSON of a SkillRunResult:
// { ok, exit_code, result, stdout, stderr, error? }. The wrapper `ok` only means
// the skill harness executed; the authoritative pass signal is the skill's parsed
// `result` (e.g. python-run-tests sets result.ok = failed==0 && errored==0 &&
// ran>0). Inspect result first; fall back to the wrapper ok when a skill returns
// no structured pass field. Never throws -- a parse failure reads as "not passed".
function skillResultPassed(resultJson: string): boolean {
  try {
    const parsed = JSON.parse(resultJson) as {
      ok?: boolean; error?: unknown
      result?: { ok?: boolean; failed?: number; errored?: number; ran?: number }
    }
    if (parsed.error) return false
    const r = parsed.result
    if (r && typeof r === 'object') {
      if (typeof r.ok === 'boolean') return r.ok
      if (typeof r.failed === 'number' || typeof r.errored === 'number') {
        return (r.failed ?? 0) === 0 && (r.errored ?? 0) === 0
      }
    }
    return parsed.ok === true
  } catch { return false }
}

function skillResultDetail(resultJson: string): string {
  try {
    const parsed = JSON.parse(resultJson) as {
      error?: unknown; stderr?: string
      result?: { failed?: number; errored?: number; ran?: number; error?: unknown }
    }
    const r = parsed.result
    if (r && typeof r === 'object') {
      if (r.error) return String(r.error).slice(0, 300)
      if ((r.failed ?? 0) > 0 || (r.errored ?? 0) > 0) {
        return `${r.failed ?? 0} failed, ${r.errored ?? 0} errored of ${r.ran ?? 0} tests`
      }
    }
    if (parsed.error) return String(parsed.error).slice(0, 300)
    return (parsed.stderr ?? '').slice(0, 300) || 'skill reported failure'
  } catch { return 'skill returned an unparseable result' }
}

// Distinguishes a HARD skill error (the harness/executor failed, or nothing ran)
// from a VALID test outcome where tests executed and some failed. A run that
// reports ran>0 with failures is a successful use of the test tool -- it must NOT
// be recorded as a use_skill failure or it pollutes the failure store with
// non-failures (e.g. an honest "7 passed, 2 failed" run). Only genuine errors --
// a wrapper/transport error, a skill-level error, or ran==0 -- count as failures.
function skillHardErrored(resultJson: string): boolean {
  try {
    const parsed = JSON.parse(resultJson) as {
      ok?: boolean; error?: unknown
      result?: { ran?: number; error?: unknown }
    }
    if (parsed.error) return true
    const r = parsed.result
    if (r && typeof r === 'object') {
      if (r.error) return true
      return (r.ran ?? 0) === 0   // ran>0 => tests executed; pass OR fail is valid
    }
    return parsed.ok === false    // no structured result -> trust the wrapper
  } catch { return true }
}

// Render a real python-run-tests result into an authoritative test_report. Used
// when the orchestrator executes the harness on the agent's behalf so the slot
// always reflects a genuine run rather than the model's prose.
function formatTestReport(resultJson: string): string {
  try {
    const parsed = JSON.parse(resultJson) as {
      error?: unknown
      result?: {
        ran?: number; passed?: number; failed?: number; errored?: number
        tests?: Array<{ name?: unknown; outcome?: unknown }>
        error?: unknown
      }
    }
    const r = parsed.result
    if (r && typeof r === 'object' && typeof r.ran === 'number') {
      const tail = r.error ? ` Error: ${String(r.error).slice(0, 200)}` : ''
      const summary = `Ran ${r.ran} tests: ${r.passed ?? 0} passed, ${r.failed ?? 0} failed, `
        + `${r.errored ?? 0} errored. (verification executed by orchestrator)${tail}`
      // Render the per-method roster the skill returned. This is the provenance
      // that lets synthesis report the cases that ACTUALLY ran instead of
      // inventing coverage. Markers avoid the literal "N failed/errored" shape
      // so the synthesis hard-gate's failure regex keys only on the summary line.
      const roster = Array.isArray(r.tests) ? r.tests : []
      if (roster.length === 0) return summary
      const MAX = 40
      const lines = roster.slice(0, MAX).map(t => {
        const name = String(t?.name ?? '').slice(0, 120) || '(unnamed)'
        const oc = String(t?.outcome ?? '')
        const mark = oc === 'failed' ? '[FAIL]' : oc === 'errored' ? '[ERR]' : '[pass]'
        return `  ${mark} ${name}`
      })
      const more = roster.length > MAX ? `\n  ...and ${roster.length - MAX} more` : ''
      return summary
        + `\nCases executed (the COMPLETE list -- no other inputs or cases were tested):\n`
        + lines.join('\n') + more
    }
    if (parsed.error) return `Verification could not run: ${String(parsed.error).slice(0, 200)}`
    return 'Verification executed but returned no structured result.'
  } catch { return 'Verification executed but returned an unparseable result.' }
}

// True when a use_skill result carries real test counts (python-run-tests shape:
// result.ran is a number). Gates the orchestrator's test_report auto-write so an
// unrelated skill result is never rendered into the test_report slot.
function resultHasTestCounts(resultJson: string): boolean {
  try {
    const parsed = JSON.parse(resultJson) as { result?: { ran?: unknown } }
    return typeof parsed.result?.ran === 'number'
  } catch { return false }
}

// Extract the public symbol surface (top-level/method def + class signatures) of a
// Python implementation, for the focused verification re-ask prompt. We give the
// test-engineer ONLY the names/signatures to test, not the whole file -- a minimal
// single-imperative prompt is materially more reliable at forcing one specific tool
// call than the large enriched prompt that the stage intermittently naps on.
// Underscore-prefixed names (private/dunder) are dropped so the surface is the public
// API a test should exercise. De-duped and capped to keep the prompt small. Output is
// plain ASCII; never throws.
function extractPublicSignatures(code: string): string {
  const out: string[] = []
  for (const raw of code.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const m = line.match(/^\s*(?:async\s+)?(def|class)\s+([A-Za-z]\w*)\s*(\([^)]*\))?/)
    if (!m) continue
    const kind = m[1]; const name = m[2]
    if (!name || name.startsWith('_')) continue
    out.push(m[3] ? `${kind} ${name}${m[3]}` : `${kind} ${name}`)
  }
  return [...new Set(out)].slice(0, 40).join('\n')
}

// Internal workbench slot (double-underscore prefix) holding the latest test
// harness the model emitted as a use_skill test_code argument. It persists across
// stage retries so the orchestrator can deterministically re-run the harness
// against the current implementation even if the model writes-and-stops on a
// later attempt. Hidden from the model (filtered out of the workbench notice).
const HARNESS_SLOT = '__test_harness__'

// -- Finalization gate ---------------------------------------------------------
// The verification gate and required-slot check inside the complete_stage handler
// only run when an agent actually CALLS complete_stage. An agent that finishes by
// emitting a plain-text response (or by exhausting its tool rounds) bypasses both,
// and pipeline.ts defaults a missing completion to DONE -- so a requiresVerifiedExecution
// reviewer could write a prose "all tests passed" and ship it without running anything.
// finalizationEscalation re-applies the same checks at those exit points. It is
// capability/config-based (no role strings), mirroring the complete_stage gate:
//   1. Every required output slot must be populated. `runtimes` is exempt because it
//      is conditional by design (non-code artifacts skip it); the execution gate below
//      already covers the code-task case, which is the only time runtimes is expected.
//   2. A requiresVerifiedExecution agent on a CODE task (runtimes slot populated) must
//      have a real execution that actually passed.
// Returns a concrete ESCALATE reason, or null to let the stage complete normally.
function finalizationEscalation(
  agent:              TeamAgent | undefined,
  executionAttempted: boolean,
  executionPassed:    boolean,
  lastExecutionDetail: string,
): string | null {
  const reasons: string[] = []

  // `runtimes` is conditional by design (non-code artifacts skip it). `test_harness`
  // is the inverse: it is only meaningful for CODE tasks (the senior-engineer authors a
  // unittest harness the orchestrator re-runs deterministically), so it is required ONLY
  // when runtimes is present -- otherwise a non-code stage (YAML/Dockerfile/etc.) could
  // never satisfy it and would be blocked forever.
  const isCodeTask = !!wbGet('runtimes')
  const required = (agent?.requiredOutputSlots ?? [])
    .filter(s => s !== 'runtimes')
    .filter(s => s !== 'test_harness' || isCodeTask)
  const missing  = required.filter(s => !wbGet(s))
  if (missing.length > 0) {
    reasons.push(`Required output slot(s) not written: ${missing.join(', ')} -- call workbench_write for each before completing.`)
  }

  if (agent?.requiresVerifiedExecution && wbGet('runtimes')) {
    if (!executionAttempted) {
      reasons.push('You finished without executing anything. This is a code task: verify it by running it -- '
        + 'call use_skill with python-run-tests (pass the implementation as code and your unittest.TestCase as '
        + 'test_code), or write the code with write_file and run it with bash -- and report the actual result.')
    } else if (!executionPassed) {
      reasons.push(`Verification did not pass: ${lastExecutionDetail || 'execution reported failures'}. Fix the implementation and re-verify before completing.`)
    }
  }

  return reasons.length ? reasons.join(' ') : null
}

// Build a synthesized ESCALATE completion for a pipeline stage that ended WITHOUT
// calling complete_stage. Returns undefined when the stage is not a pipeline stage
// or when all finalization checks pass -- in which case the caller falls back to the
// existing behavior (pipeline defaults a missing completion to DONE). This is the
// piece that closes the bypass: the intelligence lives here, where executionAttempted/
// executionPassed are known, rather than in pipeline.ts which cannot see them.
function finalizeBypass(
  agent:              TeamAgent | undefined,
  isPipelineStage:    boolean,
  assignee:           string,
  executionAttempted: boolean,
  executionPassed:    boolean,
  lastExecutionDetail: string,
): StageCompletion | undefined {
  if (!isPipelineStage) return undefined
  const reason = finalizationEscalation(agent, executionAttempted, executionPassed, lastExecutionDetail)
  if (!reason) return undefined
  console.log(`[finalize] ${assignee} ended without complete_stage -> ESCALATE (${reason.slice(0, 80)})`)
  return {
    status:            'ESCALATE',
    summary:           '(stage ended without calling complete_stage)',
    escalation_reason: reason,
    selfContract:      true,
  }
}

// Public entry point. Wraps the agent run to capture its token usage as the
// delta of the per-request usage accumulator across the call. Stages run
// sequentially in a pipeline (coordinator clarify/route/synthesize calls happen
// OUTSIDE runAgent), so the delta is attributable to this agent alone. Concurrent
// DAG fan-out within one request would smear attribution -- accurate for the
// sequential pipeline path, which is what the footer reports against.
export async function runAgent(spec: TaskSpec, generation: number): Promise<AgentResult> {
  const before = usageStorage.getStore()?.total_tokens ?? 0
  const result = await runAgentInner(spec, generation)
  const after  = usageStorage.getStore()?.total_tokens ?? 0
  const delta  = Math.max(0, after - before)
  return delta > 0 ? { ...result, tokens: delta } : result
}

async function runAgentInner(spec: TaskSpec, generation: number): Promise<AgentResult> {
  const agent            = agentMap().get(spec.assignee)
  const baseSystemPrompt = buildFlagPrefix() + (agent?.systemPrompt ?? `You are a ${spec.assignee} specialist.`)

  // Adversarial reviewer gets an explicit boundary: critique code logic, not user-supplied values.
  // Without this, reviewers trained on security/correctness tend to flag valid IPs, ports, names,
  // and other user-specified values as "incorrect" -- causing false escalations and the engineer
  // changing user requirements to match the reviewer's (wrong) expectations.
  const REVIEWER_GUARD = spec.assignee === 'adversarial-reviewer'
    ? '\n\nCRITICAL BOUNDARY: You MUST NOT flag, question, or request changes to any value that came from the user\'s original request.' +
      ' This includes: IP addresses, hostnames, port numbers, file paths, names, credentials, community strings, and all other parameters.' +
      ' These values are user requirements -- they are correct by definition.' +
      ' Only escalate for genuine code defects: logic errors, missing fields, syntax problems, or security vulnerabilities in the implementation itself.' +
      ' Do not escalate because a value "looks wrong" or "is unusual" -- if the user specified it, accept it.'
    : ''

  const systemPrompt = baseSystemPrompt + REVIEWER_GUARD
  const llm          = agent?.llm ?? defaultLLM()
  const temperature  = agent?.temperature ?? 0
  const maxTokens    = agent?.maxTokens ?? 4096

  // Pipeline stages include HANDOFF_FOOTER in their task description.
  // For these stages inject the complete_stage tool as a required termination signal.
  const isPipelineStage = spec.description.includes(HANDOFF_DONE)

  try {
    // Failure recall embeds the task, not the goal -- but strip the HANDOFF_FOOTER
    // first: it is identical boilerplate on every pipeline stage and would dominate
    // the embedding, collapsing all stages' queries toward the same vector.
    const recallQuery = spec.description.split(HANDOFF_FOOTER)[0] ?? spec.description

    // Skill recall needs the STAGE'S task, not the goal. The assembled description
    // leads with "## Goal\n\n<fullGoal>" (constant across every stage, and for a
    // build request it is write-framed: "write a function..."). embedText truncates
    // to 500 chars, so that constant preamble dominates the vector and the
    // stage-specific "## Your Task" intent ("verify / run tests / review...") -- the
    // text that actually matches an executable skill -- gets truncated off the end.
    // Querying the task section instead lets a test/review stage recall a test
    // skill. Falls back to the goal-stripped query when no task section is present
    // (e.g. DAG/non-pipeline runs). Scoped to skillcaps; failures query is unchanged.
    const taskSection = recallQuery.split('## Your Task')[1]
    const skillRecallQuery = (taskSection ?? recallQuery).replace(/^[\s\n]+/, '').trim() || recallQuery

    const [{ defs: externalDefs, urlMap: externalUrlMap }, failuresBlock] = await Promise.all([
      agent ? fetchAgentTools(agent) : Promise.resolve({ defs: [], urlMap: new Map<string, string>() }),
      recallFailures(recallQuery, 1),
    ])

    // Only recall executable skills for an agent that can actually invoke them.
    // fetchAgentTools sets `use_skill` in the urlMap ONLY for code-execution-capable
    // agents, so that one flag is the single source of truth: an agent without the
    // tool must not be told "you can run these skills, prefer them" -- the prompt
    // block plus the absent tool is exactly what lured the architect into running
    // python-run-tests. Pulled out of the Promise.all above because it now depends
    // on the resolved tool set; recall is fast, so the lost parallelism is noise.
    const skillCapsBlock = externalUrlMap.has('use_skill')
      ? await recallSkillCaps(skillRecallQuery, 3)
      : ''

    // Establish the filesystem convention for code-capable agents. Without it,
    // agents guess the implementation's filename (main.py / fibonacci.py),
    // invent directories (/testbed, /home/user), and write tests that
    // `from implementation import X` against a module that was never created --
    // the dominant cause of ModuleNotFoundError verification failures. The
    // implementation slot is materialized as implementation.<ext> in the run dir
    // (see materializeImplementation), so this tells agents to rely on that.
    const canExec = externalUrlMap.has('bash') || externalUrlMap.has('use_skill')
    const implPresent = ((wbGet('implementation') ?? '') as string).trim().length > 0
    const execConventionBlock = canExec
      ? '\n\n## Execution environment (read carefully)\n'
        + 'You have a private working directory (your current directory). Files you write with write_file persist there across bash calls. Do NOT cd elsewhere or invent paths like /testbed or /home/user.\n'
        + 'There is ONE canonical implementation file: `implementation.py`. It is materialized automatically from the `implementation` workbench slot. Rules:\n'
        + '- If you are implementing: put the implementation in the `implementation` workbench slot (workbench_write slot="implementation"). Do NOT scatter code across other files like main.py or fibonacci.py -- create no parallel source files.\n'
        + '- If you are testing or reviewing: import the code under test ONLY as `from implementation import <name>`. Never import from a different module name (not `from fibonacci import ...`, not `from main import ...`) -- those files are not the source of truth.\n'
        + '- Use the EXACT public symbol names defined in the implementation. If unsure of a name, read the `implementation` slot first (workbench_read or read_file implementation.py) and match it verbatim; do not assume a name from the blueprint prose.'
        + (implPresent
            ? '\nThe implementation is present now: `implementation.py` defines the current code. Verify by importing it (`from implementation import <name>`) and running with bash, or call use_skill python-run-tests with only your `test_code` (the implementation is supplied automatically).'
            : '')
      : ''

    const toolDefs = isPipelineStage
      ? [...externalDefs, buildCompleteStageTool()]
      : externalDefs
    const urlMap = new Map(externalUrlMap)
    if (isPipelineStage) urlMap.set(COMPLETE_STAGE_FN, COMPLETE_STAGE_URL)

    const messages: AgenticMessage[] = [
      { role: 'system', content: systemPrompt + failuresBlock + skillCapsBlock + execConventionBlock },
      { role: 'user',   content: spec.description },
    ]

    let pipelineCompletion: StageCompletion | null = null

    // Track the last bash execution so a lying DONE can be overridden. (Per-call
    // execution caps were removed with the move to the agentic bash model: agents
    // now legitimately make several bash calls per stage -- install, write, run,
    // inspect -- and MAX_TOOL_ROUNDS is the backstop against runaway loops.)
    let lastBashExitCode: number | null = null
    let lastBashStderr:   string        = ''

    // Outcome-based verification tracking (capability-agnostic). Set by ANY real
    // execution -- a bash run OR a use_skill invocation -- so the verification gate
    // at complete_stage can require that code was actually run and passed, without
    // caring which tool produced the result. Replaces the role-hardcoded guards.
    let executionAttempted = false
    let executionPassed    = false
    let lastExecutionDetail = ''
    // The most recent bash run that was a TEST run (unittest / pytest output). Its
    // outcome is the verification signal: a later `ls` or `cat` must not turn a
    // failed suite into a pass, and a `| tail` pipe must not hide failures behind
    // exit 0. Also the evidence written to test_report when the model's own
    // report has no counts (it once wrote only the __main__ printout after a
    // 22-test run, and the reviewer escalated four times).
    let lastTestRun: { out: string; exit: number; passed: boolean } | null = null
    const TEST_RUN_RE   = /\bRan \d+ tests? in\b|\b\d+ passed\b|\bcollected \d+ items?\b|\bno tests ran\b/
    const TEST_FAIL_RE  = /\bFAILED\b|\b[1-9]\d* (failed|errors?)\b|\b(failures|errors)=[1-9]|\bcollected 0 items\b|\bno tests ran\b|\bRan 0 tests\b/
    function reconcileTestReport(): void {
      if (!lastTestRun || !(agent?.requiredOutputSlots ?? []).includes('test_report')) return
      const cur = (wbGet('test_report') ?? '').trim()
      if (/\bRan \d+ tests?\b|\b\d+ (passed|failed)\b/.test(cur)) return
      const block = `## Captured test run (recorded by the orchestrator)\n` +
        `Outcome: ${lastTestRun.passed ? 'PASSED' : 'FAILED'} (exit ${lastTestRun.exit})\n\n` +
        '```\n' + lastTestRun.out.slice(-3000).trim() + '\n```'
      wbSet('test_report', cur ? `${cur}\n\n${block}` : block)
      console.log(`[verify] ${spec.assignee}: test_report had no test counts -- appended the captured test run`)
    }

    // Snapshot the capability-based verification outcome at return time. Used to
    // populate AgentResult.verification so the pipeline/synthesis hard-gate can tell
    // a requiresVerifiedExecution stage that never passed from one that did, without
    // role strings and without trusting model prose. Reads the live closure vars, so
    // it reflects whatever the final executionPassed state is at the moment of return.
    const mkVerification = (): AgentResult['verification'] =>
      (agent?.requiresVerifiedExecution && wbGet('runtimes'))
        ? { required: true, passed: executionPassed, detail: executionPassed ? '' : lastExecutionDetail }
        : undefined

    // Latest test harness the model emitted (use_skill test_code arg). Seeded from
    // the persisted internal slot so it survives across stage retries.
    let capturedTestCode = wbGet(HARNESS_SLOT) ?? ''

    // Deterministic verification: when a requiresVerifiedExecution code stage has
    // not produced a passing run, the orchestrator runs python-run-tests ITSELF
    // against the current implementation slot plus the captured harness -- instead
    // of re-asking the model and hoping it re-issues the tool call. This converts
    // "the test stage executes reliably" from a model-behavior gamble into an
    // orchestrator guarantee whenever a harness was ever produced. Idempotent: a
    // no-op once a pass is recorded, or when prerequisites are missing. Never
    // upgrades an explicit model ESCALATE -- it only supplies real execution flags
    // and an authoritative test_report so the existing gate can decide correctly.
    async function attemptDeterministicVerification(): Promise<void> {
      // Only fill the gap where the model did NOT execute this attempt. If it ran
      // anything (pass or fail), its own result is authoritative for this attempt
      // and the gate decides on it -- re-running would be redundant and would clobber
      // a model-authored test_report. The reliability hole this closes is the
      // write-and-stop / no-execution path that previously just re-asked the model.
      if (executionAttempted) return
      if (!agent?.requiresVerifiedExecution || !wbGet('runtimes')) return
      if (!urlMap.has('use_skill')) return
      // Harness source, in priority order: the model's own captured use_skill test_code,
      // the persisted internal slot, then the senior-engineer-authored `test_harness` slot.
      // The last is the deterministic FLOOR: the implementer reliably writes slots, so even
      // when the test-engineer never emits a tool call the orchestrator still has a real
      // harness to run -- verification no longer rides on the test stage cooperating.
      const harness  = (capturedTestCode || wbGet(HARNESS_SLOT) || wbGet('test_harness') || '').trim()
      const implCode = (wbGet(agent.injectCodeFromSlot ?? 'implementation') || '').trim()
      if (!harness || !implCode) return
      console.log(`[verify] ${spec.assignee}: orchestrator executing python-run-tests against current implementation (no passing run from the model)`)
      const verifyArgs = { name: 'python-run-tests', input: { code: ensurePyFutureAnnotations(implCode), test_code: harness } }
      const res = await executeToolCall('use_skill', verifyArgs, urlMap, agent.name, spec.assignee)
      executionAttempted  = true
      executionPassed     = skillResultPassed(res)
      lastExecutionDetail = executionPassed ? '' : skillResultDetail(res)
      if ((agent.requiredOutputSlots ?? []).includes('test_report')) {
        wbSet('test_report', formatTestReport(res))
      }
      appendToolLog({
        ts: Date.now(), agent: spec.assignee, tool: 'use_skill',
        args: { name: 'python-run-tests', orchestratorVerified: true },
        result: res, ok: !skillHardErrored(res), durationMs: 0,
      })
    }

    // Focused verification re-ask. attemptDeterministicVerification can only run when a
    // harness was captured from the model's use_skill test_code arg. The test-engineer
    // intermittently emits NO tool call at all on its full enriched prompt, so no harness
    // is ever produced and verification silently does not happen -- the run then trips the
    // UNVERIFIED gate against a correct implementation. This issues exactly ONE minimal,
    // stripped-down re-ask (no impl dump, no failures/skillcap/exec-convention blocks; a
    // single imperative to emit one use_skill(python-run-tests) call) offering ONLY the
    // use_skill tool. A minimal single-imperative prompt is materially more reliable at
    // forcing one specific tool call than the large enriched prompt. The agent still
    // AUTHORS the harness -- the orchestrator runs what agents make, it does not make
    // things for them -- we only capture its test_code and hand it to the deterministic
    // verifier. Strictly one shot, no loop: if it still emits nothing the run falls through
    // to the UNVERIFIED banner (no rescue that time, no regression). Capability-gated to the
    // same surface as the deterministic path, so non-code stages are unaffected.
    async function attemptVerificationReask(): Promise<void> {
      if (executionAttempted) return
      if (!isPipelineStage) return
      if (!agent?.requiresVerifiedExecution || !wbGet('runtimes')) return
      if (!urlMap.has('use_skill')) return
      if ((capturedTestCode || wbGet(HARNESS_SLOT) || wbGet('test_harness') || '').trim()) return
      const implCode = (wbGet(agent.injectCodeFromSlot ?? 'implementation') || '').trim()
      if (!implCode) return
      const useSkillDef = externalDefs.find(
        d => (d as { function?: { name?: string } })?.function?.name === 'use_skill')
      if (!useSkillDef) return
      const sigs = extractPublicSignatures(implCode)
      if (!sigs) return

      console.log(`[verify-reask] ${spec.assignee}: no harness captured -- issuing one focused use_skill re-ask`)
      const reaskMessages: AgenticMessage[] = [
        { role: 'system', content:
            'You are the test-engineer. Emit EXACTLY ONE tool call and nothing else: '
          + 'use_skill with name "python-run-tests" and input { test_code: <code> }, where '
          + '<code> is a complete Python unittest.TestCase. Import the code under test as '
          + '`from implementation import <name>` (the implementation module is supplied '
          + 'automatically; do NOT include the implementation itself in test_code). Write no '
          + 'prose. Call no other tool. Output only the single use_skill tool call.' },
        { role: 'user', content:
            'Public functions/classes to cover (import from the `implementation` module):\n\n'
          + sigs + '\n\n'
          + 'Respond now with exactly one use_skill(python-run-tests) call whose '
          + 'input.test_code is a unittest.TestCase exercising these. Nothing else.' },
      ]

      let resp
      try {
        resp = await callLLMRaw(reaskMessages, llm, maxTokens, temperature, [useSkillDef], `orchestrail/${spec.assignee}`)
      } catch (err) {
        console.warn(`[verify-reask] ${spec.assignee}: re-ask LLM call failed: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      const tc = resp.choices[0]?.message?.tool_calls?.find(c => c.function.name === 'use_skill')
      if (!tc) {
        console.log(`[verify-reask] ${spec.assignee}: re-ask produced no use_skill call -- falling through to UNVERIFIED`)
        return
      }
      let reaskArgs: Record<string, unknown> = {}
      try { reaskArgs = JSON.parse(stripThinkBlocks(tc.function.arguments || '{}')) } catch {}
      const inp   = reaskArgs['input']
      const tcode = (inp && typeof inp === 'object')
        ? (inp as Record<string, unknown>)['test_code']
        : reaskArgs['test_code']
      const harness = typeof tcode === 'string' ? tcode : ''
      if (harness.trim()) {
        capturedTestCode = harness
        wbSet(HARNESS_SLOT, harness)
        console.log(`[verify-reask] ${spec.assignee}: captured harness (${harness.length} chars) -- handing to deterministic verifier`)
      } else {
        console.log(`[verify-reask] ${spec.assignee}: re-ask use_skill call had empty test_code -- falling through to UNVERIFIED`)
      }
    }

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (generation !== currentGeneration) {
        console.log(`[abort] ${spec.assignee}:${spec.title} superseded`)
        return { assignee: spec.assignee, title: spec.title, output: '(aborted)', success: false }
      }

      const response = await callLLMRaw(messages, llm, maxTokens, temperature, toolDefs.length ? toolDefs : undefined, `orchestrail/${spec.assignee}`)
      const choice   = response.choices[0]
      if (!choice) break

      const { content, tool_calls } = choice.message

      // No tool calls -- plain text response
      if (!tool_calls || tool_calls.length === 0) {
        // A write-and-stop on a verifiable code stage still gets its captured
        // harness executed before finalization decides DONE vs ESCALATE. When the
        // stage napped and produced no harness at all, one focused re-ask tries to
        // obtain one first, then the deterministic verifier runs it.
        if (!pipelineCompletion) {
          await attemptVerificationReask()
          await attemptDeterministicVerification()
        }
        return {
          assignee:   spec.assignee,
          title:      spec.title,
          output:     stripThinkBlocks(content ?? ''),
          success:    true,
          completion: pipelineCompletion
            ?? finalizeBypass(agent, isPipelineStage, spec.assignee, executionAttempted, executionPassed, lastExecutionDetail),
          verification: mkVerification(),
          _messages:  messages,
        }
      }

      messages.push({ role: 'assistant', content, tool_calls })

      const toolResults = await Promise.all(
        tool_calls.map(async tc => {
          let parsedArgs: Record<string, unknown> = {}
          try { parsedArgs = JSON.parse(stripThinkBlocks(tc.function.arguments || '{}')) } catch {}
          const t0 = Date.now()

          // complete_stage is the pipeline termination tool -- handle inline
          if (tc.function.name === COMPLETE_STAGE_FN) {
            // Enforce required output slots before accepting complete_stage.
            // test_harness is code-only (see finalizationEscalation): exempt it on
            // non-code stages so a non-code artifact is not blocked on a harness.
            const isCodeTask    = !!wbGet('runtimes')
            const requiredSlots = (agent?.requiredOutputSlots ?? [])
              .filter(slot => slot !== 'test_harness' || isCodeTask)
            const missingSlots  = requiredSlots.filter(slot => !wbGet(slot))
            if (missingSlots.length > 0) {
              const msg = `BLOCKED: complete_stage rejected. You must call workbench_write for the following slots before completing: ${missingSlots.join(', ')}. Write them now, then call complete_stage again.`
              console.log(`[complete_stage] ${spec.assignee} blocked -- missing slots: ${missingSlots.join(', ')}`)
              appendToolLog({
                ts: Date.now(), agent: spec.assignee, tool: COMPLETE_STAGE_FN,
                args: parsedArgs, result: JSON.stringify({ blocked: true, missingSlots }), ok: false, durationMs: 0,
              })
              return { role: 'tool' as const, tool_call_id: tc.id, content: JSON.stringify({ error: msg }) }
            }

            let completionStatus: 'DONE' | 'ESCALATE' =
              (parsedArgs['status'] as string === 'ESCALATE') ? 'ESCALATE' : 'DONE'
            let escalationReason = parsedArgs['escalation_reason'] as string | undefined

            // Deterministic verification BEFORE the gate. If the model is completing
            // a requiresVerifiedExecution code stage without a passing run, the
            // orchestrator executes the captured harness against the current
            // implementation itself -- so executionPassed/lastExecutionDetail and the
            // test_report reflect a real run no matter what the model did. This
            // replaces the legacy execution-only guards (which force-escalated a
            // test-engineer that legitimately verified via use_skill, blocking the
            // happy path) with a single capability-agnostic path. Never upgrades an
            // explicit ESCALATE -- only the gate below may downgrade a DONE.
            reconcileTestReport()
            await attemptDeterministicVerification()

            // Outcome-based verification gate (capability-agnostic). When an agent is
            // flagged requiresVerifiedExecution AND this is a CODE task (architect
            // populated the runtimes slot), DONE is only accepted if a real execution
            // actually ran and passed -- whether via the python-run-tests skill,
            // a bash run, or the orchestrator's deterministic verification above.
            // Non-code artifacts (no runtimes slot) are exempt. A fabricated "all
            // tests passed" is impossible: the pass must be backed by a captured
            // execution result, not by prose.
            if (completionStatus === 'DONE' && agent?.requiresVerifiedExecution && wbGet('runtimes')) {
              if (!executionAttempted) {
                completionStatus = 'ESCALATE'
                escalationReason = 'You marked this stage DONE without executing anything. This is a code task: '
                  + 'verify the implementation by running it -- call use_skill with python-run-tests (pass the '
                  + 'implementation as code and your unittest.TestCase as test_code), or write the code with '
                  + 'write_file and run it with bash -- and report the actual result before completing.'
                console.log(`[complete_stage] ${spec.assignee} DONE -> ESCALATE (no verification executed)`)
              } else if (!executionPassed) {
                completionStatus = 'ESCALATE'
                escalationReason = `Verification did not pass: ${lastExecutionDetail || 'execution reported failures'}. `
                  + 'Fix the implementation and re-verify (re-run the skill or re-run via bash) before completing.'
                console.log(`[complete_stage] ${spec.assignee} DONE -> ESCALATE (verification failed: ${lastExecutionDetail})`)
              }
            }

            pipelineCompletion = {
              status:            completionStatus,
              summary:           String(parsedArgs['summary'] ?? ''),
              escalation_reason: escalationReason,
            }
            console.log(`[complete_stage] ${spec.assignee}: ${pipelineCompletion.status} -- ${pipelineCompletion.summary}`)
            appendToolLog({
              ts: Date.now(), agent: spec.assignee, tool: COMPLETE_STAGE_FN,
              args: parsedArgs, result: JSON.stringify(pipelineCompletion), ok: true, durationMs: 0,
            })
            return { role: 'tool' as const, tool_call_id: tc.id, content: '{"acknowledged":true}' }
          }

          const result     = await executeToolCall(tc.function.name, parsedArgs, urlMap, agent?.name, spec.assignee)
          const durationMs = Date.now() - t0

          // Capture bash outcome for downstream DONE validation. In the agentic
          // model the LAST bash exit code is the stage's execution signal; the
          // authoritative gate for requiresVerifiedExecution stages remains the
          // deterministic python-run-tests run below, this is the secondary signal.
          if (tc.function.name === 'bash') {
            try {
              const parsed = JSON.parse(result) as { exit_code?: number; stdout?: string; stderr?: string; error?: string }
              lastBashExitCode = typeof parsed.exit_code === 'number'
                ? parsed.exit_code
                : (parsed.error ? 1 : 0)
              lastBashStderr   = parsed.stderr ?? parsed.error ?? ''
              const out = `${parsed.stdout ?? ''}\n${parsed.stderr ?? ''}`
              if (TEST_RUN_RE.test(out)) {
                lastTestRun = { out, exit: lastBashExitCode, passed: lastBashExitCode === 0 && !TEST_FAIL_RE.test(out) }
              }
            } catch { lastBashExitCode = 1 }
            // Outcome gate: bash is a real execution. A test run decides it; other
            // commands only count while no test run has happened yet.
            executionAttempted = true
            executionPassed    = lastTestRun ? lastTestRun.passed : lastBashExitCode === 0
            if (!executionPassed) lastExecutionDetail = lastTestRun && !lastTestRun.passed
              ? lastTestRun.out.slice(-300)
              : (lastBashStderr.slice(0, 300) || `bash exit ${lastBashExitCode}`)
          }
          // Outcome gate: a use_skill invocation is also a real execution. The
          // wrapper `ok` only means the harness ran; the meaningful pass signal is
          // the skill's parsed result (e.g. python-run-tests sets result.ok =
          // failed==0 && errored==0 && ran>0). Inspect result first, fall back to ok.
          if (tc.function.name === 'use_skill') {
            executionAttempted = true
            executionPassed    = skillResultPassed(result)
            if (!executionPassed) lastExecutionDetail = skillResultDetail(result)
            // Authoritative test_report floor. When a verification agent self-executes
            // (use_skill) and then write-and-stops -- never reaching its own
            // workbench_write('test_report') step -- the deterministic path below
            // early-returns (executionAttempted is already true) and the slot would
            // stay EMPTY, letting the reviewer rubber-stamp an un-run verification.
            // So whenever THIS stage's own use_skill produced a real test result and
            // test_report is one of its required slots, render the real counts into
            // the slot immediately. The model may still refine it afterward, but the
            // slot is never empty after a genuine run. (executionPassed above is the
            // deterministic ground truth and is unaffected by any later prose.)
            if ((agent?.requiredOutputSlots ?? []).includes('test_report')
                && resultHasTestCounts(result)) {
              wbSet('test_report', formatTestReport(result))
            }
            // Capture the harness the model composed (the test_code argument) even
            // when this call errored on the envelope -- it persists across retries
            // so the orchestrator can re-run it deterministically against a fixed
            // implementation. Reads args, not result, so a name-missing slip still
            // yields a usable harness.
            const inp = parsedArgs['input']
            const tcode = (inp && typeof inp === 'object')
              ? (inp as Record<string, unknown>)['test_code']
              : parsedArgs['test_code']
            const harness = typeof tcode === 'string' ? tcode : ''
            if (harness.trim()) { capturedTestCode = harness; wbSet(HARNESS_SLOT, harness) }
          }
          let isError = false
          try { isError = !!JSON.parse(result)?.error } catch {}
          // A use_skill call counts as a FAILURE record only when it HARD-errored
          // (harness/executor failure, skill-level error, or nothing ran). A run
          // that executed tests and reported failures (ran>0) is a valid outcome --
          // recording it would pollute the failure store with non-failures, which
          // is what logged an honest "7 passed, 2 failed" run as use_skill__other.
          if (tc.function.name === 'use_skill') isError = skillHardErrored(result)
          appendToolLog({
            ts: Date.now(), agent: spec.assignee, tool: tc.function.name,
            args: parsedArgs, result, ok: !isError, durationMs,
          })
          console.log(`[tool] ${spec.assignee} called ${tc.function.name} (${durationMs}ms)`)
          return { role: 'tool' as const, tool_call_id: tc.id, content: result }
        }),
      )
      messages.push(...toolResults)

      // If complete_stage was called this round, return immediately
      if (pipelineCompletion) {
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
        let output = stripThinkBlocks(lastAssistant?.content ?? '')

        // When the Implementation stage completes DONE, ensure code is visible in output
        if ((pipelineCompletion as StageCompletion).status === 'DONE' &&
            (spec.title === 'Implementation' || spec.assignee === 'senior-engineer')) {
          const existingCode = extractCodeBlock(output)
          if (!existingCode) {
            const codeFromTools = extractCodeFromToolCalls(messages)
            if (codeFromTools) {
              output = output + `\n\n## Implementation Code\n\n\`\`\`\n${codeFromTools}\n\`\`\``
            }
          }
        }

        return {
          assignee:   spec.assignee,
          title:      spec.title,
          output,
          success:    true,
          completion: pipelineCompletion,
          verification: mkVerification(),
          _messages:  messages,
        }
      }

      // After round 2, inject a per-round completion reminder
      if (round >= 2) {
        const reminder = isPipelineStage
          ? `[Round ${round + 1}] Call complete_stage now if your work is done. ` +
            `Use status DONE if complete. Use ESCALATE if a specific defect blocks the next stage -- ` +
            `include what needs fixing and which prior stages the fix might affect. ` +
            `If one specific issue remains unresolved, make one more focused tool call then call complete_stage.`
          : `[Round ${round + 1}] If your task is complete, write your final response now. ` +
            `If one specific issue remains, make one more focused tool call.`
        messages.push({ role: 'user', content: reminder })
      }
    }

    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
    if (!pipelineCompletion) {
      await attemptVerificationReask()
      await attemptDeterministicVerification()
    }
    return {
      assignee:   spec.assignee,
      title:      spec.title,
      output:     stripThinkBlocks(lastAssistant?.content ?? ''),
      success:    true,
      completion: pipelineCompletion
        ?? finalizeBypass(agent, isPipelineStage, spec.assignee, executionAttempted, executionPassed, lastExecutionDetail),
      verification: mkVerification(),
      _messages:  messages,
    }

  } catch (err) {
    return {
      assignee:  spec.assignee,
      title:     spec.title,
      output:    `Error: ${err instanceof Error ? err.message : String(err)}`,
      success:   false,
      _messages: [],
    }
  }
}