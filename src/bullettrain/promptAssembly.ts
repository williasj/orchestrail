// -- Reconstruction prompt assembly ----------------------------------------------
// Section 11 of the contract. Fixed order, supervisor-assembled, agent has no
// influence over it. If assembled size exceeds BT_RECON_PROMPT_MAX_PCT of
// num_ctx, halt with brief_mismatch rather than dropping sections -- silent
// truncation is the failure mode that produces a run which looks fine and
// rebuilds work it already finished.

import { readProjectMd, readBrief, readDecisions, readTasks, renderTasksMd, readHandoff } from './store.js'
import { btBash, btWorkbenchRunId } from './execClient.js'
import { BT_RECON_PROMPT_MAX_PCT, BT_DECISIONS_MAX_LINES, BT_HANDOFF_MAX_BYTES } from './config.js'
import { estimateTokens } from './llm.js'
import type { BTTask, BTRuntime } from './types.js'

function capLines(text: string, maxLines: number): string {
  const lines = text.split('\n')
  return lines.length <= maxLines ? text : lines.slice(-maxLines).join('\n')
}

function capBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  return buf.length <= maxBytes ? text : buf.subarray(buf.length - maxBytes).toString('utf8')
}

export interface ReconResult {
  prompt: string
  estTokens: number
  overBudget: boolean
  budgetTokens: number
}

export async function assembleReconstructionPrompt(
  slug: string, runNo: string, currentTask: BTTask | null, runtime: BTRuntime,
): Promise<ReconResult> {
  const runId = btWorkbenchRunId(slug)
  const parts: string[] = []

  parts.push('## PROJECT.md\n' + readProjectMd(slug))
  parts.push('## BRIEF.md\n' + readBrief(slug, runNo))
  parts.push('## DECISIONS.md\n' + capLines(readDecisions(slug), BT_DECISIONS_MAX_LINES))

  const tasks = readTasks(slug, runNo)
  parts.push('## tasks.md\n' + renderTasksMd(tasks))

  let gitLog = '(git log unavailable)'
  let gitStatus = '(git status unavailable)'
  let fileList = '(file listing unavailable)'
  try {
    const logR = await btBash(runId, 'git log --oneline -30 2>/dev/null || echo "(no commits yet)"')
    gitLog = String(logR.stdout ?? '').trim() || '(no commits yet)'
    const statusR = await btBash(runId, 'git status --short 2>/dev/null || echo "(not a git repo yet)"')
    gitStatus = String(statusR.stdout ?? '').trim() || '(clean)'
    const findR = await btBash(runId, "find . -type f -not -path './.git/*' | head -200")
    fileList = String(findR.stdout ?? '').trim() || '(empty workspace)'
  } catch (err) {
    // exec_unreachable is handled by the caller (health check before this call);
    // this catch is defense-in-depth so a transient failure degrades the
    // reconstruction prompt instead of throwing mid-assembly.
    gitLog = gitStatus = fileList = `(exec error: ${String(err)})`
  }
  parts.push('## git log --oneline -30\n' + gitLog)
  parts.push('## git status --short\n' + gitStatus)
  parts.push("## find . -type f -not -path './.git/*' | head -200\n" + fileList)

  parts.push('## HANDOFF.md\n' + capBytes(readHandoff(slug, runNo), BT_HANDOFF_MAX_BYTES))

  if (currentTask) {
    const block = [
      `## Current task ${currentTask.id}: ${currentTask.title}`,
      `verify: ${currentTask.verify}`,
      currentTask.depends.length ? `depends: ${currentTask.depends.join(',')}` : '',
      `attempts so far: ${currentTask.attempts}`,
      currentTask.error ? `last error: ${currentTask.error}` : '',
    ].filter(Boolean).join('\n')
    parts.push(block)
  } else {
    parts.push('## Current task\n(none selected -- planning phase)')
  }

  const prompt = parts.join('\n\n')
  const estTokens = estimateTokens(prompt)
  const budgetTokens = Math.floor(runtime.num_ctx * (BT_RECON_PROMPT_MAX_PCT / 100))

  return { prompt, estTokens, overBudget: estTokens > budgetTokens, budgetTokens }
}
