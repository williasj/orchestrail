// -- Synthesis and meta-memory reflection --------------------------------------
// synthesize: assembles final response from stage outputs.
// reflectAndStoreMetaMemory: stores a reflective summary after each run.
// extractGoal: pulls the last user message from a conversation.

import { v4 as uuidv4 } from 'uuid'
import { cols } from '../utils/config.js'
import { extractCodeBlock, extractCodeFromToolCalls } from '../utils/text.js'
import { wbGet } from './workbench.js'
import { memoryEnabled, qdrantUpsert } from './memory.js'
import { callCoordinatorLLM } from './llm.js'
import { DEFAULT_SYNTHESIS_PROMPT } from './prompts.js'
import { appendToolLog } from './tools.js'
import type { AgentResult, CoordinatorConfig, AgenticMessage } from '../types/index.js'

// -- Module init ---------------------------------------------------------------

type SynthesizeDeps = {
  getCoordinator: () => CoordinatorConfig
}

let _deps: SynthesizeDeps | null = null

export function initSynthesize(deps: SynthesizeDeps): void {
  _deps = deps
}

// -- synthesize ----------------------------------------------------------------

export async function synthesize(
  goal:       string,
  results:    AgentResult[],
  wbSnapshot: Record<string, string> = {},
): Promise<string> {
  const t0 = Date.now()
  const coordinator = _deps?.getCoordinator()
  const systemPrompt = coordinator?.synthesisPrompt?.trim() || DEFAULT_SYNTHESIS_PROMPT

  // SAFETY: reject workbench slot if it looks like a test harness.
  // Fall back to extracting code directly from the senior-engineer stage result.
  function looksLikeTestHarness(code: string): boolean {
    return (
      /\bimport\s+implementation\b/.test(code) ||
      /\bassert\s+hasattr\s*\(\s*implementation\b/.test(code) ||
      /\bassert\s+implementation\./.test(code) ||
      /^import sys\b[\s\S]*?\bimport implementation\b/m.test(code)
    )
  }

  let wbImpl: string | null = wbSnapshot['implementation'] ?? wbGet('implementation')
  if (wbImpl && looksLikeTestHarness(wbImpl)) {
    console.warn('[synthesize] implementation slot contains test harness -- discarding and falling back to stage output')
    wbImpl = null
    const implResult = results.find(r => r.assignee === 'senior-engineer' || r.title === 'Implementation')
    if (implResult) {
      const recovered = extractCodeBlock(implResult.output)
        ?? extractCodeFromToolCalls((implResult as { _messages?: AgenticMessage[] })._messages ?? [])
      if (recovered && !looksLikeTestHarness(recovered)) {
        wbImpl = recovered
        console.log(`[synthesize] recovered ${recovered.length}b of real implementation code from stage output`)
      }
    }
  }

  const truncatedSections = results
    .filter(r => r.success)
    .map(r => {
      const isImplementation = r.title === 'Implementation' || r.assignee === 'senior-engineer'
      const isDesign         = r.title === 'Design'         || r.assignee === 'software-architect'
      if (isImplementation && wbImpl) {
        return `### ${r.title} (${r.assignee})\n\`\`\`\n${wbImpl}\n\`\`\``
      }
      const limit = isDesign ? 2400 : 800
      return `### ${r.title} (${r.assignee})\n${r.output.slice(0, limit)}`
    })
    .join('\n\n')

  const synthReview = wbSnapshot['review_report'] ?? wbGet('review_report')
  const synthTest   = wbSnapshot['test_report']   ?? wbGet('test_report')
  const wbSections  = [
    synthReview ? `## Adversarial Review Report (from workbench)\n${synthReview.slice(0, 1200)}` : '',
    synthTest   ? `## Test Report (from workbench)\n${synthTest.slice(0, 2000)}`                 : '',
  ].filter(Boolean).join('\n\n')

  // Collapse multi-attempt stages to their TERMINAL result. `results` (allResults
  // from the pipeline) accumulates EVERY attempt: a stage that escalates on attempt 1
  // then closes DONE on retry pushes both its ESCALATE attempt and its later DONE
  // attempt, and intermediate "Fix:" helper agents are pushed too. Reporting all of
  // them makes a stage that recovered look UNRESOLVED -- which both poisons the
  // Stage Outcomes block AND trips the unresolved-stage directive below, driving the
  // model to invent a failure to reconcile "escalated" against a passing test_report.
  // The real terminal state of a stage is the LAST own-attempt for that stage; the
  // "Fix:" helpers are intermediate and are not stages, so they are excluded.
  const terminalStageResults: AgentResult[] = (() => {
    const byStage = new Map<string, AgentResult>()
    for (const r of results) {
      if (!r.completion) continue
      if (/^Fix:/i.test(r.title ?? '')) continue   // helper agent, not a pipeline stage
      byStage.set(r.title || r.assignee || '', r)   // insertion order preserved; last write == terminal attempt
    }
    return [...byStage.values()]
  })()

  // -- Deterministic verification hard-gate (Option A) -------------------------
  // A requiresVerifiedExecution stage that never recorded a PASSING execution must
  // NOT be laundered into a clean success -- regardless of what the non-executing
  // reviewer wrote, or whether the synthesizer model honors the prose notices below.
  // This keys on AgentResult.verification.passed: the ground truth captured directly
  // from the real execution result, immune to any "all tests passed" prose a weak
  // model might write into test_report. nonzeroFailCounts on the rendered report is a
  // secondary belt-and-suspenders signal. When this fires, a machine-authored banner
  // is prepended to the final output (see assembled, below) so the failure is visible
  // even if the model ignores every instruction. The test-engineer's fix-your-own-test
  // rule is the pressure-relief valve: a self-buggy harness should be fixed and re-run
  // rather than left to trip this gate against a correct implementation.
  function nonzeroFailCounts(report: string): boolean {
    for (const m of report.matchAll(/(\d+)\s+(?:failed|errored)/gi)) {
      if (parseInt(m[1] ?? '0', 10) > 0) return true
    }
    return false
  }
  const verificationNeverPassed = terminalStageResults.some(
    r => r.verification?.required === true && r.verification.passed === false)
  const hardVerificationFailure = verificationNeverPassed || nonzeroFailCounts(synthTest ?? '')

  // Authoritative per-stage outcomes. Without this, synthesis assumes every stage
  // converged and narrates a fabricated found->fixed->confirmed arc. An ESCALATE
  // (especially a terminal one that hit max retries) means the issue was NOT
  // resolved -- the model must say so rather than invent a fix or a passing re-run.
  const stageOutcomes = terminalStageResults
    .map(r => {
      const st     = r.completion!.status
      const detail = st === 'ESCALATE'
        ? ` -- UNRESOLVED: ${(r.completion!.escalation_reason ?? r.completion!.summary ?? '').slice(0, 280)}`
        : ''
      return `- ${r.title} (${r.assignee}): ${st}${detail}`
    })
    .join('\n')
  const outcomesBlock = stageOutcomes
    ? `## Stage Outcomes (authoritative -- the real terminal state of each stage)\n${stageOutcomes}`
    : ''

  // Hard guard against fabricated test results: test_report is only ever written by
  // the test-engineer (or the orchestrator's deterministic verification) from a real
  // execution. If it is empty, verification did not complete -- the model must say so
  // rather than invent passing counts.
  const verificationNotice = (!synthTest || !synthTest.trim())
    ? '\n\nIMPORTANT: No test report was produced. Verification did NOT complete and no tests were executed. '
      + 'The Test Report section MUST state plainly that automated tests were not run and results are unavailable. '
      + 'Do NOT invent, infer, or report any test counts, pass/fail numbers, or "all tests passed" -- there is no '
      + 'execution to report.'
    : ''

  // Unresolved-stage guard: if the testing stage ended ESCALATE, the run did NOT
  // reach a clean pass. Forbid claiming a fix or a later passing run unless the Test
  // Report itself shows a clean pass, and forbid adopting the reviewer's speculation
  // about a failure cause as established fact.
  const testEscalated = terminalStageResults.some(r =>
    (r.assignee === 'test-engineer' || r.title === 'Testing') && r.completion?.status === 'ESCALATE')
    || verificationNeverPassed
  const unresolvedNotice = testEscalated
    ? '\n\nIMPORTANT: The testing stage ended UNRESOLVED (it escalated and a clean passing run was not reached). '
      + 'The Test Report section MUST report the actual failing result and state plainly that the issue was NOT resolved. '
      + 'Do NOT claim any fix was applied, any correction was made, or that tests later passed, unless the Test Report '
      + 'slot itself shows a clean pass. Attribute failure causes ONLY as stated in the Test Report or Stage Outcomes -- '
      + "never adopt the reviewer's hypothesis about a cause as fact."
    : ''

  // Coverage-fidelity guard (the PASSING-path complement to the two notices above).
  // The historical failure mode is not a fabricated FAILURE but fabricated COVERAGE:
  // a Test Report that records a clean pass but lists specific executed cases, after
  // which the synthesizer narrates input types/ranges (floats, booleans, large n)
  // that were never tested. The Test Report slot now carries the COMPLETE executed-
  // case roster, so coverage claims can be bound to it exactly. This fires whenever a
  // roster is present, regardless of pass/fail, and forbids claiming any input class
  // not evidenced by a listed case name.
  const hasCaseRoster = /Cases executed/i.test(synthTest ?? '')
  const coverageNotice = hasCaseRoster
    ? '\n\nIMPORTANT: The Test Report slot lists the COMPLETE set of cases that were executed -- '
      + 'no other inputs were tested. In the Test Report section you may describe coverage ONLY by '
      + 'referring to those listed cases. Do NOT claim that any input type, value, or range was tested, '
      + 'verified, or rejected unless a listed case name evidences it. In particular, do NOT assert that '
      + 'floats, booleans, strings, negative numbers, zero, or large inputs were "verified" or "safely '
      + 'rejected" unless a case for that input appears in the executed list. If an input class is absent '
      + 'from the list, it was NOT tested -- say nothing about it, or state explicitly that it was not covered.'
    : ''

  const output = await callCoordinatorLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: `## Original Goal\n${goal}\n\n## Specialist Results\n${truncatedSections}\n\n${wbSections}\n\n${outcomesBlock}\n\nSynthesize into a final answer with THREE sections: Product Description, Adversarial Review Report, Test Report. Do NOT output an Implementation Code section.${verificationNotice}${unresolvedNotice}${coverageNotice}` },
  ], 16384)

  // Prepend verbatim implementation code as section 1 — done after the LLM call
  // so the model cannot rewrite or reformat the code.
  const implHeader = wbImpl ? `## Implementation Code\n\`\`\`\n${wbImpl}\n\`\`\`\n\n` : ''
  // Machine-authored hard-gate banner. Independent of the synthesizer model: if a
  // required verification never passed, the run is marked UNVERIFIED here, in code,
  // so a rubber-stamped review or a non-compliant synthesizer cannot present it as
  // complete. This is the deterministic half of Option A; the prose notices above are
  // the model-facing half.
  const failureBanner = hardVerificationFailure
    ? '> [!WARNING]\n> **VERIFICATION FAILED — UNVERIFIED RESULT.** This run did not reach a clean passing '
      + 'verification (a required execution stage reported failures/errors or never produced a passing run). '
      + 'Treat the output below as unverified: do not ship it without re-running verification to a clean pass.\n\n'
    : ''
  const finalOutput = output.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  const assembled   = failureBanner + implHeader + finalOutput
  const durationMs  = Date.now() - t0

  appendToolLog({
    ts: Date.now(), agent: 'coordinator', tool: 'synthesize',
    args: {
      goal:       goal.slice(0, 500),
      agentCount: results.filter(r => r.success).length,
      agents:     [...new Set(results.map(r => r.assignee))],
    },
    result: JSON.stringify({ preview: assembled.slice(0, 300) }),
    ok: true, durationMs,
  })
  return assembled
}

// -- reflectAndStoreMetaMemory -------------------------------------------------

export async function reflectAndStoreMetaMemory(
  goal:        string,
  mode:        'pipeline' | 'dag',
  agents:      string[],
  synthesis:   string,
  results:     AgentResult[],
  rewindCount: number = 0,
): Promise<void> {
  if (!memoryEnabled()) return
  const hadEscalations = results.some(r => r.completion?.status === 'ESCALATE')
  const prompt =
    'You coordinated a task. Write 2-3 concise sentences summarizing:\n' +
    '1. What the goal was\n' +
    '2. Which agents were used and what worked well\n' +
    '3. Any issues, escalations, or failures that occurred\n\n' +
    `Goal: ${goal.slice(0, 400)}\n` +
    `Mode: ${mode}\n` +
    `Agents: ${agents.join(', ')}\n` +
    `Escalations: ${hadEscalations}\n` +
    `Rewinds: ${rewindCount}\n` +
    `Synthesis preview: ${synthesis.slice(0, 400)}\n\n` +
    'Respond with ONLY the 2-3 sentence summary. No preamble.'
  try {
    const reflection = (await callCoordinatorLLM([{ role: 'user', content: prompt }], 256)).trim()
    if (!reflection) return
    await qdrantUpsert(cols.meta, `meta:${uuidv4()}`, goal, {
      goal:       goal.slice(0, 500),
      mode,
      agents,
      reflection,
      ts:         Date.now(),
    })
  } catch { /* non-fatal */ }

  // NOTE: the legacy post-SYNTHESIZE prose-skill auto-author (evaluateSkillCandidacy)
  // is intentionally disabled. It captured one-off run deliverables (e.g. the answer
  // to "write a memoized Fibonacci function") as "skills", which is the wrong concept:
  // a successful answer to a throwaway request is a deliverable, not a reusable
  // capability. Reusable capabilities are now authored deliberately by agents via the
  // create_skill tool (executable, self-tested) -> core/skillexec.ts.
}

// -- extractGoal ---------------------------------------------------------------

export function extractGoal(messages: { role: string; content: string }[]): string | null {
  return messages.filter(m => m.role === 'user').at(-1)?.content ?? null
}
