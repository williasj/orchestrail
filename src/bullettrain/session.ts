// -- Session loop -------------------------------------------------------------------
// Drives one task through the tool-calling loop. Ends when: the model stops
// requesting tools (assumed task_complete -- the supervisor verifies
// independently after), the turn cap is hit, three consecutive turns produce no
// tool calls (nap_detected), or an LLM/exec error occurs.
//
// ALPHA CUT: no separate detached-process checkpoint/respawn cycle (Section 3 of
// the contract, config.ts note). The turn cap is this alpha's stand-in for the
// checkpoint trigger -- a session simply ends and the supervisor's select/session
// loop starts a fresh one with a freshly assembled reconstruction prompt, which
// gets the "dies and respawns with reconstructed context" behavior without the
// separate process boundary.

import { btCallLLM, estimateTokens } from './llm.js'
import { buildBtTools, dispatchBtTool, type BtToolContext } from './tools.js'
import { assembleReconstructionPrompt } from './promptAssembly.js'
import { BT_NAP_TURN_LIMIT } from './config.js'
import type { AgenticMessage } from '../types/index.js'
import type { BTRuntime, BTTask, BTSessionRecord, BTHaltReason } from './types.js'

export interface SessionOutcome {
  record: BTSessionRecord
  haltReason: BTHaltReason
  reconOverBudget: boolean
}

const SESSION_SYSTEM_PROMPT = `You are the build agent for this project. You have a working directory with
persistent state (files, installed packages) and a fixed current task. Use
bash/write_file/read_file/list_files to do the work. Call bt_verify to check
your progress against the task's verify command. Call bt_handoff before you
expect to run out of room to leave notes for whoever (possibly a fresh
instance of you) picks this up next. Call bt_decision to record any
architectural choice future sessions need to know about (library choice,
config format, etc) -- not routine progress notes, those go in bt_handoff.

Your working directory contains ONLY project files. tasks.md, HANDOFF.md and
DECISIONS.md are control-plane files that live outside it and are NOT readable
with read_file -- your current task and prior handoff notes are already
included in this prompt, and bt_handoff/bt_decision are how you write to them.
Do not try to read or write them as files.

Git is already initialized in this directory. Commit your work with git
(git add -A && git commit -m "...") whenever you finish a meaningful chunk --
git history is the authoritative record of progress across sessions, more
than anything you write in prose.

Focus ONLY on the current task. Do not modify code from other tasks unless the
current task genuinely requires it. When you believe the task is complete and
bt_verify passes, stop calling tools -- the session ends and the supervisor
takes over from there.`

export async function runSession(
  slug: string, runNo: string, sessionNo: number,
  task: BTTask, runtime: BTRuntime,
): Promise<SessionOutcome> {
  const startedAt = new Date().toISOString()
  const recon = await assembleReconstructionPrompt(slug, runNo, task, runtime)

  if (recon.overBudget) {
    return {
      record: emptyRecord(sessionNo, task.id, startedAt, 'llm_error'),
      haltReason: 'brief_mismatch',
      reconOverBudget: true,
    }
  }

  const messages: AgenticMessage[] = [
    { role: 'system', content: SESSION_SYSTEM_PROMPT },
    { role: 'user', content: recon.prompt },
  ]
  const tools = buildBtTools()
  const ctx: BtToolContext = { slug, runNo, runtime, currentTask: task, verifyAttemptCounter: { n: task.attempts } }

  let turns = 0
  let toolCalls = 0
  let napTurns = 0
  let handoffWritten = false
  let promptTokensPeak = 0
  let endReason: BTSessionRecord['end_reason'] = 'task_complete'

  while (turns < runtime.max_turns_per_session) {
    turns++
    let res
    try {
      res = await btCallLLM(messages, runtime, tools)
    } catch (err) {
      endReason = 'llm_error'
      return { record: buildRecord(), haltReason: 'llm_unreachable', reconOverBudget: false }
    }

    const usage = res.usage
    const promptTok = usage?.prompt_tokens ?? estimateTokens(messages.map(m => m.content ?? '').join('\n'))
    promptTokensPeak = Math.max(promptTokensPeak, promptTok)
    const ctxPct = (promptTok / runtime.num_ctx) * 100

    const choice = res.choices[0]
    const assistantMsg = choice?.message
    const calls = assistantMsg?.tool_calls ?? []

    messages.push({ role: 'assistant', content: assistantMsg?.content ?? null, tool_calls: calls.length ? calls : undefined })

    if (calls.length === 0) {
      napTurns++
      if (napTurns >= BT_NAP_TURN_LIMIT) { endReason = 'nap_detected'; break }
      if (choice?.finish_reason === 'stop') { endReason = 'task_complete'; break }
      // No tool calls but not an explicit stop -- nudge once rather than ending
      // the session on a single quiet turn.
      messages.push({ role: 'user', content: 'Continue the task, or call bt_verify if you believe it is done.' })
      continue
    }
    napTurns = 0

    for (const call of calls) {
      toolCalls++
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(call.function.arguments || '{}') } catch { /* malformed args -> empty */ }
      if (call.function.name === 'bt_handoff') handoffWritten = true
      // A failing tool call is DATA FOR THE MODEL, not control flow for the
      // supervisor. The exec sidecar answers non-2xx for entirely ordinary
      // conditions -- a missing file, a path outside the run dir -- and
      // btExecPost throws on any non-2xx. Without this catch a single
      // read_file on a file that happens not to exist escapes the turn loop,
      // escapes runSession, and fails the whole run as a supervisor internal
      // error. The model can recover from an error it can see; it cannot
      // recover from one that kills the process.
      let result: string
      try {
        result = await dispatchBtTool(call.function.name, args, ctx)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error(`[bullettrain] ${slug}/${runNo} session ${sessionNo}: tool '${call.function.name}' failed: ${msg}`)
        result = JSON.stringify({ error: msg, recoverable: true })
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result })
    }

    if (ctxPct >= runtime.hard_kill_pct) { endReason = 'hard_kill'; break }
    if (ctxPct >= runtime.soft_checkpoint_pct) { endReason = 'soft_checkpoint'; break }
  }

  if (turns >= runtime.max_turns_per_session && endReason === 'task_complete' && toolCalls > 0) {
    // Loop exited on the turn cap, not a deliberate stop.
    endReason = 'turn_cap'
  }

  function buildRecord(): BTSessionRecord {
    return {
      n: sessionNo, task: task.id, started_at: startedAt, ended_at: new Date().toISOString(),
      end_reason: endReason, turns, tool_calls: toolCalls,
      prompt_tokens_peak: promptTokensPeak, ctx_pct_peak: (promptTokensPeak / runtime.num_ctx) * 100,
      handoff_written: handoffWritten, commits: [], nap_turns: napTurns,
    }
  }

  return { record: buildRecord(), haltReason: null, reconOverBudget: false }
}

function emptyRecord(n: number, task: string, startedAt: string, endReason: BTSessionRecord['end_reason']): BTSessionRecord {
  return {
    n, task, started_at: startedAt, ended_at: new Date().toISOString(), end_reason: endReason,
    turns: 0, tool_calls: 0, prompt_tokens_peak: 0, ctx_pct_peak: 0, handoff_written: false, commits: [], nap_turns: 0,
  }
}
