// -- BulletTrain agent-facing tools -----------------------------------------------
// The session loop hands the model exactly these tools. bash/write_file/
// read_file/list_files pass straight through to the exec sidecar (data plane).
// bt_handoff and bt_decision are the ONLY control-plane writes available to the
// agent, and both go through validation here rather than a raw file write --
// enforced by the fact that no other tool in this list can touch /data at all.
// bt_verify lets the agent self-check against the immutable verify command
// mid-session; the supervisor also runs verify independently after the session
// ends, so the agent's own bt_verify calls are a convenience, never authority.

import { btBash, btWriteFile, btReadFile, btListFiles, btWorkbenchRunId } from './execClient.js'
import { writeHandoff, appendDecision, decisionsAtCap, readTasks } from './store.js'
import { runVerify } from './verify.js'
import type { BTRuntime, BTTask } from './types.js'

export function buildBtTools(): unknown[] {
  return [
    { type: 'function', function: {
      name: 'bash',
      description: 'Run a bash command in this project\'s working directory. State persists across calls: files stay, installed packages stay. Returns { stdout, stderr, exit_code }.',
      parameters: { type: 'object', properties: {
        command: { type: 'string' }, stdin: { type: 'string' },
      }, required: ['command'] },
    }},
    { type: 'function', function: {
      name: 'write_file',
      description: 'Write a UTF-8 text file into the project working directory (parent dirs created). Returns { ok, path, bytes }.',
      parameters: { type: 'object', properties: {
        path: { type: 'string' }, content: { type: 'string' },
      }, required: ['path', 'content'] },
    }},
    { type: 'function', function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file from the project working directory. Returns { content, bytes }.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }},
    { type: 'function', function: {
      name: 'list_files',
      description: 'List files/directories in the project working directory or a subpath. Returns { entries }.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
    }},
    { type: 'function', function: {
      name: 'bt_handoff',
      description: 'Overwrite HANDOFF.md with your current progress notes for the next session (full rewrite, not append). Hard cap 8KB -- an oversized write is rejected so you compress instead of being silently truncated. Git history is the real state; treat this as a convenience note, not the source of truth. (Note: HANDOFF.md is not a file in your working directory -- this tool is the only way to write it.)',
      parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
    }},
    { type: 'function', function: {
      name: 'bt_decision',
      description: 'Append one durable architectural decision (e.g. "Use pdfplumber, not PyPDF2, for text extraction") to the project\'s permanent decision log. One line, under 200 characters, no newlines. This is append-only and survives every future run of this project.',
      parameters: { type: 'object', properties: { line: { type: 'string' } }, required: ['line'] },
    }},
    { type: 'function', function: {
      name: 'bt_verify',
      description: 'Run the CURRENT task\'s verify command right now and see if it passes. Use this to check your own work before ending the session. This does not mark the task done by itself -- the supervisor re-runs verify independently after your session ends.',
      parameters: { type: 'object', properties: {}, required: [] },
    }},
  ]
}

export interface BtToolContext {
  slug: string
  runNo: string
  runtime: BTRuntime
  currentTask: BTTask | null
  verifyAttemptCounter: { n: number }
}

export async function dispatchBtTool(name: string, args: Record<string, unknown>, ctx: BtToolContext): Promise<string> {
  const runId = btWorkbenchRunId(ctx.slug)

  if (name === 'bash') {
    const r = await btBash(runId, String(args.command ?? ''), args.stdin !== undefined ? String(args.stdin) : undefined, ctx.runtime.exec_timeout_ms)
    return JSON.stringify(r)
  }
  if (name === 'write_file') {
    const r = await btWriteFile(runId, String(args.path ?? ''), String(args.content ?? ''))
    return JSON.stringify(r)
  }
  if (name === 'read_file') {
    const r = await btReadFile(runId, String(args.path ?? ''))
    return JSON.stringify(r)
  }
  if (name === 'list_files') {
    const r = await btListFiles(runId, args.path !== undefined ? String(args.path) : undefined)
    return JSON.stringify(r)
  }
  if (name === 'bt_handoff') {
    const r = writeHandoff(ctx.slug, ctx.runNo, String(args.content ?? ''))
    return JSON.stringify(r)
  }
  if (name === 'bt_decision') {
    const r = appendDecision(ctx.slug, ctx.runNo, String(args.line ?? ''))
    return JSON.stringify(r)
  }
  if (name === 'bt_verify') {
    if (!ctx.currentTask) return JSON.stringify({ error: 'no current task selected' })
    ctx.verifyAttemptCounter.n += 1
    const outcome = await runVerify(ctx.slug, ctx.runNo, ctx.currentTask.id, ctx.verifyAttemptCounter.n, ctx.currentTask.verify, ctx.runtime)
    return JSON.stringify(outcome)
  }
  return JSON.stringify({ error: `unknown tool: ${name}` })
}

/** True once DECISIONS.md is full -- session loop should stop offering bt_decision
 *  writes and the supervisor should halt for manual curation. */
export function btDecisionsFull(slug: string): boolean {
  return decisionsAtCap(slug)
}

export function readCurrentTasks(slug: string, runNo: string): BTTask[] {
  return readTasks(slug, runNo)
}
