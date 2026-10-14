// -- Verify execution --------------------------------------------------------------
// Runs a task's verify command through the exec sidecar and records the log.
// The verify string itself is immutable once written to tasks.md (Section 7 /
// Invariant 3) -- nothing here can edit it, only run it.

import { btBash, btWorkbenchRunId } from './execClient.js'
import { writeVerifyLog } from './store.js'
import type { BTRuntime } from './types.js'

export interface VerifyOutcome {
  passed: boolean
  exit_code: number
  stdout: string
  stderr: string
  logPath: string
}

export async function runVerify(
  slug: string, runNo: string, taskId: string, attempt: number,
  verifyCommand: string, runtime: BTRuntime,
): Promise<VerifyOutcome> {
  if (verifyCommand.trim() === 'manual') {
    return { passed: false, exit_code: -1, stdout: '', stderr: 'manual verification -- not auto-runnable', logPath: '' }
  }
  const runId = btWorkbenchRunId(slug)
  const r = await btBash(runId, verifyCommand, undefined, runtime.exec_timeout_ms)
  const exit_code = typeof r.exit_code === 'number' ? r.exit_code : 1
  const stdout = String(r.stdout ?? '')
  const stderr = String(r.stderr ?? '')
  const log = [
    `$ ${verifyCommand}`,
    `exit_code: ${exit_code}`,
    '--- stdout ---', stdout,
    '--- stderr ---', stderr,
  ].join('\n')
  const logPath = writeVerifyLog(slug, runNo, taskId, attempt, log)
  return { passed: exit_code === 0, exit_code, stdout, stderr, logPath }
}
