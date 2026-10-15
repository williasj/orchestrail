// -- Linear pipeline execution engine -----------------------------------------
// Runs a sequence of agent stages. After each stage, the coordinator decides
// whether to advance (NEXT), escalate (ESCALATE), rewind (REWIND), or
// declare the work complete early (SYNTHESIZE).

import { v4 as uuidv4 } from 'uuid'
import type {
  PipelineStage, AgentResult, TaskSpec, StageCompletion,
  AgenticMessage, PipelineCallbacks, CoordinatorDecision,
} from '../types/index.js'
import {
  HANDOFF_FOOTER, MAX_REWINDS_PER_STAGE,
  MAX_PIPELINE_ESCALATIONS,
} from '../utils/config.js'
import { extractCodeBlock, extractCodeFromToolCalls, wroteWorkbenchSlot } from '../utils/text.js'
import { agentCanWriteSlot, slotOwner } from './agent.js'
import {
  workbenchIdStorage, wbIdToConversationId,
  wbGet, wbSet, wbList, wbClear,
} from './workbench.js'

// -- Dependency types ----------------------------------------------------------

export type RunAgentFn = (spec: TaskSpec, generation: number) => Promise<AgentResult>

export type CoordinatorRouteFn = (
  goal:           string,
  stage:          PipelineStage,
  output:         string,
  completion:     StageCompletion,
  history:        Array<{ name: string; assignee: string; summary: string }>,
  remainingNames: string[],
) => Promise<CoordinatorDecision>

export type RehydrateFn = (conversationId: string, goal: string) => Promise<void>

export interface PipelineDeps {
  runAgent:            RunAgentFn
  coordinatorRoute:    CoordinatorRouteFn
  rehydrateWorkbench:  RehydrateFn
  getGeneration:       () => number
}

// -- Handoff signal parsing ----------------------------------------------------

/**
 * Parses the agent's HANDOFF footer from a stage output. Returns 'escalate'
 * if HANDOFF: ESCALATE is present or CRITICAL findings are detected; otherwise 'done'.
 */
export function parseHandoff(output: string): { status: 'done' | 'escalate'; reason: string } {
  const upper = output.toUpperCase()
  if (upper.includes('HANDOFF: ESCALATE')) {
    const match = output.match(/HANDOFF:\s*ESCALATE\s*[ -]\s*(.+)/i)
    return { status: 'escalate', reason: match?.[1]?.trim() ?? 'unspecified issue' }
  }
  // Also treat CRITICAL findings as implicit escalation
  if (upper.includes('\n## CRITICAL') || upper.includes('\n**CRITICAL**')) {
    return { status: 'escalate', reason: 'CRITICAL findings detected' }
  }
  return { status: 'done', reason: '' }
}

// -- Pipeline executor ---------------------------------------------------------

export async function executePipeline(
  stages:          PipelineStage[],
  fullGoal:        string,
  generation:      number,
  callbacks:       PipelineCallbacks,
  deps:            PipelineDeps,
  conversationId?: string,
): Promise<{ results: AgentResult[]; synthesizeEarly: boolean; wbSnapshot: Record<string, string>; rewindCount: number }> {
  const { runAgent, coordinatorRoute, rehydrateWorkbench, getGeneration } = deps

  const pipelineId    = uuidv4()
  const allResults:   AgentResult[]                                         = []
  const history:      { name: string; assignee: string; summary: string }[] = []
  const rewindCounts: Record<string, number>                                = {}
  let previousOutput      = ''
  let implementationCode: string | null = null
  let stageIdx            = 0
  let totalEscalations    = 0   // global fix/escalation budget counter (backstop vs. one stage thrashing)

  if (conversationId) wbIdToConversationId.set(pipelineId, conversationId)

  return await workbenchIdStorage.run(pipelineId, async () => {
    await rehydrateWorkbench(conversationId ?? '', fullGoal)

    while (stageIdx < stages.length) {
      const stage      = stages[stageIdx]!
      const maxRetries = stage.maxRetries ?? 3
      let attempt      = 0
      let lastFix      = ''
      let selfCorrection = ''   // feedback for re-running THIS stage after it failed its own contract
      let advanceIdx   = true   // normally advance to stageIdx+1 after inner loop

      while (true) {
        if (generation !== getGeneration()) return { results: allResults, synthesizeEarly: false, wbSnapshot: {}, rewindCount: 0 }

        callbacks.onStageStart(stage, attempt)

        const prevSection = previousOutput
          ? `\n\n## Previous Stage Output\n\n${previousOutput.slice(0, 800)}${previousOutput.length > 800 ? '\n[...truncated — full output available to coordinator]' : ''}`
          : ''
        // Role detection keys on ASSIGNEE only. The stage NAME is LLM-authored and
        // can be mislabeled (the decompose model has emitted the reviewer's stage as
        // "Testing" and the test stage as "Review"); a name-based check then handed
        // test-execution instructions to the adversarial-reviewer, which has no exec
        // tools, and it thrashed. Assignee is canonical after decompose's per-position
        // correction, so it is the authoritative signal for what kind of stage this is.
        const isReviewOrTestEarly = stage.assignee === 'adversarial-reviewer' || stage.assignee === 'test-engineer'
        const isTestStageEarly = stage.assignee === 'test-engineer'
        const rawFixSection = lastFix
          ? `\n\n## Fix Applied (attempt ${attempt})\n\n${lastFix.slice(0, 1200)}${lastFix.length > 1200 ? '\n[...truncated]' : ''}`
          : ''
        const fixSection = (isTestStageEarly && rawFixSection)
          ? rawFixSection.replace(/```[\s\S]*?```/g, '[code omitted -- see Implementation API above]')
          : rawFixSection

        const isReviewOrTest = isReviewOrTestEarly
        const isTestStage    = isTestStageEarly
        const wbSlots   = wbList().filter(s => !s.startsWith('__'))
        const wbImpl    = wbGet('implementation')
        const wbNotice  = wbSlots.length
          ? `\n\n## Workbench\nAvailable slots: ${wbSlots.join(', ')}\n` +
            `IMPORTANT: Call workbench_read('implementation') to fetch the authoritative code. Do NOT use code from elsewhere in this context.\n`
          : ''
        const implInline = isTestStage && wbImpl
          ? `\n\n## Implementation under test (read from the workbench)\n\`\`\`\n${wbImpl}\n\`\`\`\n` +
            `Call use_skill(python-run-tests) with your unittest.TestCase as the \`test_code\` argument. The implementation shown above is supplied to the skill automatically as the \`code\` argument from the workbench -- you do NOT need to pass \`code\` yourself (if you do, it is respected). Reference the implementation's functions directly in your tests. Do NOT write your tests to a workbench slot; tests go only inside the use_skill call.\n`
          : ''
        const implSection       = isTestStage ? (implInline || wbNotice) : (isReviewOrTest ? wbNotice : '')
        const contextPrevSection = isReviewOrTest ? '' : prevSection

        const selfCorrectionSection = selfCorrection
          ? `\n\n## You did not complete this stage correctly -- fix this now\n\n${selfCorrection}\n`
          : ''

        const taskDesc =
          `## Goal\n\n${fullGoal}${implSection}${contextPrevSection}${fixSection}${selfCorrectionSection}\n\n## Your Task\n\n${stage.description}` +
          HANDOFF_FOOTER

        const result = await runAgent({
          title: stage.name, description: taskDesc, assignee: stage.assignee, dependsOn: [],
        }, generation)

        // After second retry, strip previousOutput down to code block only to keep context manageable
        if (attempt >= 2) {
          const extracted = extractCodeBlock(previousOutput)
          previousOutput = extracted
            ? `\`\`\`\n${extracted}\n\`\`\``
            : previousOutput.slice(0, 600)
        }

        const completion: StageCompletion = result.completion ?? (() => {
          const parsed = parseHandoff(result.output)
          return {
            status:            parsed.status === 'escalate' ? 'ESCALATE' as const : 'DONE' as const,
            summary:           parsed.reason || result.output.slice(0, 120),
            escalation_reason: parsed.status === 'escalate' ? parsed.reason : undefined,
          }
        })()

        callbacks.onStageDone(stage, result, completion.status === 'DONE' ? 'done' : 'escalate')
        allResults.push(result)

        // Self-contract failure: the agent ended without producing its OWN required
        // slot or without executing (synthesized by the finalization gate). Routing
        // this to escalateTo (e.g. senior-engineer) is wrong -- that agent often
        // cannot even write this stage's slot (test_report is read-only to it), which
        // produced the escalate/re-run churn. Re-run THIS stage with the feedback
        // instead of summoning a fix agent or asking the coordinator to route.
        if (completion.status === 'ESCALATE' && completion.selfContract) {
          if (attempt >= maxRetries) {
            callbacks.onMaxRetries(stage)
            previousOutput = result.output
            history.push({ name: stage.name, assignee: stage.assignee, summary: completion.summary })
            break
          }
          selfCorrection = completion.escalation_reason ?? completion.summary ?? ''
          attempt++
          continue
        }

        const remainingNames = stages.slice(stageIdx + 1).map(s => s.name)

        // Terminal-DONE-is-final. When the LAST stage (the acceptance gate) returns
        // DONE, the in-agent complete_stage gate has already enforced its required
        // slots (and verified execution if flagged). Do NOT hand that DONE to the
        // coordinator, which can second-guess it and manufacture a discretionary
        // ESCALATE on a subjective spec reading -- the loop that produced a DONE
        // immediately re-escalated and never converged. A real defect still surfaces
        // as the agent's own ESCALATE, which is unaffected.
        if (completion.status === 'DONE' && !completion.selfContract && remainingNames.length === 0) {
          history.push({ name: stage.name, assignee: stage.assignee, summary: completion.summary })
          const wbSnapshot: Record<string, string> = {}
          const _i = wbGet('implementation'); if (_i) wbSnapshot['implementation'] = _i
          const _r = wbGet('review_report');  if (_r) wbSnapshot['review_report']  = _r
          const _t = wbGet('test_report');    if (_t) wbSnapshot['test_report']    = _t
          wbClear(pipelineId)
          const totalRewindsT = Object.values(rewindCounts).reduce((a, b) => a + b, 0)
          return { results: allResults, synthesizeEarly: true, wbSnapshot, rewindCount: totalRewindsT }
        }

        const decision = await coordinatorRoute(
          fullGoal, stage, result.output, completion, history, remainingNames,
        )
        callbacks.onCoordinatorRoute(decision)

        // SYNTHESIZE — coordinator says all work is done
        if (decision.action === 'SYNTHESIZE') {
          history.push({ name: stage.name, assignee: stage.assignee, summary: completion.summary })
          const wbSnapshot: Record<string, string> = {}
          const _impl = wbGet('implementation'); if (_impl) wbSnapshot['implementation'] = _impl
          const _rev  = wbGet('review_report');  if (_rev)  wbSnapshot['review_report']  = _rev
          const _tst  = wbGet('test_report');    if (_tst)  wbSnapshot['test_report']    = _tst
          wbClear(pipelineId)
          const totalRewinds = Object.values(rewindCounts).reduce((a, b) => a + b, 0)
          return { results: allResults, synthesizeEarly: true, wbSnapshot, rewindCount: totalRewinds }
        }

        // NEXT — move forward
        if (decision.action === 'NEXT') {
          const isImplStage = stage.name === 'Implementation' || stage.assignee === 'senior-engineer'
          if (isImplStage && !wbGet('implementation')) {
            console.warn(`[pipeline] Implementation stage NEXT but workbench slot 'implementation' is empty -- forcing escalation`)
            const escalateTarget2 = stage.escalateTo ?? 'senior-engineer'
            if (attempt < maxRetries) {
              const fixResult2 = await runAgent({
                title:       `Fix: ${stage.name}`,
                description: `## Goal\n\n${fullGoal}\n\n## Issue to Fix\n\nYour implementation was accepted but you did not call workbench_write(slot='implementation'). ` +
                             `Write your code to the workbench now.\n\n` +
                             `## Your Task\n\nCall workbench_write with slot='implementation' and your complete code. Then call complete_stage DONE.`,
                assignee:    escalateTarget2,
                dependsOn:   [],
              }, generation)
              callbacks.onFixDone(escalateTarget2, fixResult2)
              allResults.push(fixResult2)
              const recoveredCode = wbGet('implementation')
                ?? extractCodeBlock(fixResult2.output)
                ?? extractCodeFromToolCalls((fixResult2 as { _messages?: AgenticMessage[] })._messages ?? [])
              if (recoveredCode) {
                implementationCode = recoveredCode
                wbSet('implementation', recoveredCode)
              }
            }
          }
          const slotName = stage.name.toLowerCase().replace(/\s+/g, '_')
          if (result.output && slotName !== 'test_report' && !wbGet(slotName)) wbSet(slotName, result.output)
          if (stage.assignee === 'software-architect'  && !wbGet('blueprint'))     wbSet('blueprint',     result.output)
          if (stage.assignee === 'adversarial-reviewer' && !wbGet('review_report')) wbSet('review_report', result.output)
          // NOTE: test_report is deliberately NOT backfilled from stage output. It must
          // contain ONLY real executed results written by the test-engineer; backfilling
          // it with narration is what let an un-run "test report" reach synthesis and be
          // reported as passing. If the test-engineer never writes it, it stays empty and
          // synthesis reports that verification did not complete.
          const stageMsgs = (result as { _messages?: AgenticMessage[] })._messages ?? []
          if ((stage.name === 'Implementation' || stage.assignee === 'senior-engineer') &&
              wroteWorkbenchSlot(stageMsgs, 'implementation')) {
            implementationCode = wbGet('implementation') ?? implementationCode
            console.log(`[pipeline] Implementation slot written by the agent (${implementationCode?.length ?? 0} bytes) -- kept as is`)
          } else if (stage.name === 'Implementation' || stage.assignee === 'senior-engineer') {
            let extractedCode = extractCodeBlock(result.output)
            if (!extractedCode) {
              const toolCode = extractCodeFromToolCalls(
                (result as { _messages?: AgenticMessage[] })._messages ?? []
              )
              if (toolCode) {
                extractedCode = toolCode
                console.log(`[pipeline] Implementation code extracted from write_file tool calls`)
              }
            }
            if (extractedCode) {
              implementationCode = extractedCode
              wbSet('implementation', extractedCode)
              console.log(`[pipeline] Implementation slot updated from stage output (${extractedCode.length} bytes)`)
            } else {
              console.warn(`[pipeline] Implementation stage completed but no code block found in output or tool calls`)
            }
          }
          previousOutput = result.output
          history.push({ name: stage.name, assignee: stage.assignee, summary: completion.summary })
          break
        }

        // REWIND — coordinator wants a prior stage to re-run
        if (decision.action === 'REWIND' && decision.rewindTo) {
          const rewindIdx = stages.findIndex(s => s.name === decision.rewindTo)
          const count     = (rewindCounts[decision.rewindTo!] ?? 0) + 1

          if (rewindIdx < 0 || rewindIdx >= stageIdx || count > MAX_REWINDS_PER_STAGE) {
            console.warn(`[pipeline] REWIND to "${decision.rewindTo}" invalid or limit reached — treating as NEXT`)
            previousOutput = result.output
            history.push({ name: stage.name, assignee: stage.assignee, summary: completion.summary })
            break
          }

          rewindCounts[decision.rewindTo!] = count
          callbacks.onRewind(stage.name, decision.rewindTo!, decision.reason)
          history.splice(rewindIdx)
          previousOutput = result.output
          stageIdx       = rewindIdx
          advanceIdx     = false
          break
        }

        // ESCALATE — run fix agent then retry this stage
        let   escalateTarget = decision.targetAgent ?? stage.escalateTo
        const escalateReason = decision.reason
        // Route by slot ownership. A defect in a slot the chosen fixer may only READ
        // (e.g. test_report -> senior-engineer) can never be fixed by it; one benchmark
        // run burned four fix rounds that way. Send it to the slot's owner instead.
        const FIX_SLOTS   = ['implementation', 'test_harness', 'test_report', 'blueprint', 'runtimes', 'review_report']
        const namedSlots  = FIX_SLOTS.filter(sl => new RegExp(`\\b${sl}\\b`).test(escalateReason ?? ''))
        if (escalateTarget && namedSlots.length && !namedSlots.some(sl => agentCanWriteSlot(escalateTarget!, sl))) {
          const owner = namedSlots.map(sl => slotOwner(sl)).find(o => o && o !== stage.assignee)
          if (owner && owner !== escalateTarget) {
            console.log(`[pipeline] escalation names ${namedSlots.join(', ')} which ${escalateTarget} cannot write -- routing the fix to ${owner}`)
            escalateTarget = owner
          }
        }
        const fixWriteSlots = escalateTarget
          ? (namedSlots.filter(sl => agentCanWriteSlot(escalateTarget!, sl) && sl !== 'review_report').length
              ? namedSlots.filter(sl => agentCanWriteSlot(escalateTarget!, sl) && sl !== 'review_report')
              : (agentCanWriteSlot(escalateTarget, 'implementation') ? ['implementation'] : []))
          : []

        if (!escalateTarget || attempt >= maxRetries || totalEscalations >= MAX_PIPELINE_ESCALATIONS) {
          if (attempt >= maxRetries || totalEscalations >= MAX_PIPELINE_ESCALATIONS) callbacks.onMaxRetries(stage)
          if (totalEscalations >= MAX_PIPELINE_ESCALATIONS) {
            console.warn(`[pipeline] global escalation budget (${MAX_PIPELINE_ESCALATIONS}) exhausted -- proceeding with current output`)
          }
          previousOutput = result.output
          history.push({ name: stage.name, assignee: stage.assignee, summary: completion.summary })
          break
        }
        totalEscalations++

        const escalateSlot = stage.name.toLowerCase().replace(/\s+/g, '_')
        if (result.output && escalateSlot !== 'test_report' && !wbGet(escalateSlot))  wbSet(escalateSlot,     result.output)
        if (stage.assignee === 'software-architect'  && !wbGet('blueprint'))     wbSet('blueprint',     result.output)
        if (stage.assignee === 'adversarial-reviewer' && !wbGet('review_report')) wbSet('review_report', result.output)
        // test_report intentionally not backfilled -- see DONE path note above.
        callbacks.onFixStart(stage, escalateTarget, escalateReason)

        const fixWbCode        = wbGet('implementation')
        const fixImplSection   = fixWbCode
          ? `## Current Implementation (from workbench -- fix THIS code)\n\n\`\`\`\n${fixWbCode}\n\`\`\`\n\n`
          : implementationCode
            ? `## Implementation Code (fix THIS code)\n\n\`\`\`\n${implementationCode}\n\`\`\`\n\n`
            : ''
        const fixReportSlot    = stage.assignee === 'test-engineer' ? 'test_report' : 'review_report'
        const fixReport        = wbGet(fixReportSlot)
        const fixReportSection = fixReport
          ? `## ${fixReportSlot === 'test_report' ? 'Test' : 'Review'} Report (what failed)\n\n${fixReport.slice(0, 800)}\n\n`
          : ''
        const fixResult = await runAgent({
          title:       `Fix: ${stage.name}`,
          description: `## Goal\n\n${fullGoal}\n\n${fixImplSection}${fixReportSection}## Issue to Fix\n\n${escalateReason}\n\n` +
                       `## Your Task\n\nFix ONLY the issue described above. ` +
                       `After fixing, you MUST: (1) verify it by running it -- write the code with write_file and run it with bash, or call use_skill with python-run-tests -- ` +
                       (fixWriteSlots.length
                         ? `(2) call workbench_write for ${fixWriteSlots.map(sl => `'${sl}'`).join(' and ')} with the corrected content` +
                           (fixWriteSlots.includes('test_report') ? ` (test_report must contain the real test command output with its counts)` : '') + `. `
                         : `(2) record what you verified. `) +
                       `Do not rewrite from scratch. Minimal targeted fix only.`,
          assignee:    escalateTarget,
          dependsOn:   [],
        }, generation)

        callbacks.onFixDone(escalateTarget, fixResult)
        allResults.push(fixResult)
        lastFix = fixResult.output
        const fixMsgs   = (fixResult as { _messages?: AgenticMessage[] })._messages ?? []
        // Only an agent that may write the implementation can change it; a test-engineer's
        // fix output is full of test code that must never be scraped into that slot.
        const fixedCode = !agentCanWriteSlot(escalateTarget, 'implementation') ? null
          : wroteWorkbenchSlot(fixMsgs, 'implementation')
            ? wbGet('implementation')
            : (extractCodeBlock(fixResult.output) ?? extractCodeFromToolCalls(fixMsgs))
        if (fixedCode) {
          implementationCode = fixedCode
          wbSet('implementation', fixedCode)
        }
        attempt++
      }

      if (advanceIdx) stageIdx++
    }

    const wbSnapshot: Record<string, string> = {}
    const _impl2 = wbGet('implementation'); if (_impl2) wbSnapshot['implementation'] = _impl2
    const _rev2  = wbGet('review_report');  if (_rev2)  wbSnapshot['review_report']  = _rev2
    const _tst2  = wbGet('test_report');    if (_tst2)  wbSnapshot['test_report']    = _tst2
    wbClear(pipelineId)
    const totalRewinds2 = Object.values(rewindCounts).reduce((a, b) => a + b, 0)
    return { results: allResults, synthesizeEarly: false, wbSnapshot, rewindCount: totalRewinds2 }
  }) // workbenchIdStorage.run
}
