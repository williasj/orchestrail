// -- Supervisor ------------------------------------------------------------------
// Drives one run through its state machine. ALPHA CUT (see config.ts): runs
// in-process as an async function kicked off by the route handler, not a
// detached child process -- so there is no crash isolation and no PID reattach
// yet. If the Orchestrail process restarts mid-run, the run is stuck in
// "running" with a stale pid; project.json.current_run needs a manual clear.
// That gap is real and is exactly why the contract specifies a child process --
// flagged here rather than glossed over.
//
// Also cut for the alpha: no task fission, no full_suite_every_session, no
// acceptance-criteria gate/replan. DONE = every task verified or manual.

import {
  readProject, writeProject, readRuntime, readStatus, writeStatus, readTasks, writeTasks,
  writeReport, writeSessionRecord, nextRunNo, readBrief, writeDeliverableZip,
} from './store.js'
import { btExecHealthy, btBash, btWorkbenchRunId } from './execClient.js'
import { planTasks } from './planner.js'
import { runSession } from './session.js'
import { runVerify } from './verify.js'
import { packageDeliverableZip } from './zip.js'
import type { BTStatus, BTTask, BTHaltReason } from './types.js'

function findReadyTask(tasks: BTTask[]): BTTask | null {
  const doneIds = new Set(tasks.filter(t => t.mark === 'x').map(t => t.id))
  for (const t of tasks) {
    if (t.mark !== ' ') continue
    if (t.depends.every(d => doneIds.has(d))) return t
  }
  return null
}

function countMark(tasks: BTTask[], mark: BTTask['mark']): number {
  return tasks.filter(t => t.mark === mark).length
}

function allSettled(tasks: BTTask[]): boolean {
  return tasks.every(t => t.mark === 'x' || t.mark === '?' || t.mark === '!')
}

function setPhase(status: BTStatus, phase: BTStatus['phase'], message: string): void {
  status.phase = phase
  status.message = message
  writeStatus(status)
}

function halt(status: BTStatus, reason: BTHaltReason, message: string): void {
  status.state = 'halted'
  status.phase = null
  status.halt_reason = reason
  status.ended_at = new Date().toISOString()
  status.message = message
  writeStatus(status)
}

export async function runSupervisor(slug: string, runNo: string): Promise<void> {
  const project = readProject(slug)
  if (!project) throw new Error(`no such project: ${slug}`)
  const runtime = readRuntime(slug)
  let status = readStatus(slug, runNo)
  const startWall = Date.now()

  try {
    // -- recon --------------------------------------------------------------
    status.state = 'running'
    setPhase(status, 'recon', 'Checking exec sidecar')
    if (!(await btExecHealthy())) {
      halt(status, 'exec_unreachable', 'orchestrail-exec health check failed')
      return
    }
    // Git is Invariant 2's ground truth -- nothing else initializes it, so do
    // it here, once, before the first session ever runs. Idempotent: a
    // new-stage run against an existing project workspace just no-ops.
    try {
      const runId = btWorkbenchRunId(slug)
      await btBash(
        runId,
        'git init -q 2>/dev/null; ' +
        'git config user.email bullettrain@local 2>/dev/null; ' +
        'git config user.name BulletTrain 2>/dev/null; true',
      )
    } catch { /* non-fatal -- session's own bash calls will surface a clearer error if git is truly missing */ }

    // -- plan -----------------------------------------------------------------
    setPhase(status, 'plan', 'Planning tasks from BRIEF.md')
    let tasks: BTTask[]
    try {
      tasks = await planTasks(readBrief(slug, runNo), runtime, runtime.max_tasks)
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err)
      const reason: BTHaltReason = /exceeds max_tasks/.test(msg) ? 'task_cap' : 'no_tasks'
      halt(status, reason, `Planning failed: ${msg}`)
      return
    }
    writeTasks(slug, runNo, tasks)
    status.counters.tasks_total = tasks.length
    writeStatus(status)

    // -- select / session / verify loop ----------------------------------------
    let sessionsSinceVerification = 0
    let verifyAttemptCounters: Record<string, number> = {}

    while (true) {
      tasks = readTasks(slug, runNo)

      if (allSettled(tasks)) {
        if (countMark(tasks, '!') > 0 && countMark(tasks, 'x') === 0 && countMark(tasks, '?') === 0) {
          halt(status, 'all_blocked', 'Every task ended up blocked')
          return
        }
        break // proceed to done
      }

      const wallSeconds = Math.floor((Date.now() - startWall) / 1000)
      status.counters.wall_seconds = wallSeconds
      if (wallSeconds / 3600 >= runtime.wall_clock_hours) {
        halt(status, 'wall_clock', `wall_clock_hours (${runtime.wall_clock_hours}) reached`)
        return
      }
      if (status.session_no >= runtime.max_sessions) {
        halt(status, 'session_cap', `max_sessions (${runtime.max_sessions}) reached`)
        return
      }

      setPhase(status, 'select', 'Selecting next ready task')
      const task = findReadyTask(tasks)
      if (!task) {
        const remaining = tasks.filter(t => t.mark === ' ' || t.mark === '>')
        if (remaining.length === 0) break // everything settled by mark, loop top will catch it
        // Tasks remain but none are ready -- either a manual-only queue or a
        // dependency on a blocked task. Distinguish the two.
        const onlyManualLeft = remaining.every(t => t.mark === '?')
        halt(status, onlyManualLeft ? 'manual_queue' : 'all_blocked', 'No ready task and unsettled tasks remain')
        return
      }

      status.current_task = task.id
      status.session_no += 1
      writeStatus(status)

      setPhase(status, 'session', `Running session ${status.session_no} on task ${task.id}`)
      const outcome = await runSession(slug, runNo, status.session_no, task, runtime)
      writeSessionRecord(slug, runNo, outcome.record)
      status.counters.sessions_run += 1

      if (outcome.haltReason) {
        halt(status, outcome.haltReason, outcome.reconOverBudget
          ? 'Reconstruction prompt exceeded the num_ctx budget'
          : `Session ended in error: ${outcome.record.end_reason}`)
        return
      }

      setPhase(status, 'verify', `Verifying task ${task.id}`)
      verifyAttemptCounters[task.id] = (verifyAttemptCounters[task.id] ?? task.attempts) + 1
      const attemptN = verifyAttemptCounters[task.id]!
      const verifyOutcome = await runVerify(slug, runNo, task.id, attemptN, task.verify, runtime)

      const freshTasks = readTasks(slug, runNo)
      const idx = freshTasks.findIndex(t => t.id === task.id)
      if (idx === -1) { halt(status, 'no_tasks', `task ${task.id} vanished from tasks.md`); return }
      const t = freshTasks[idx]!
      t.attempts = attemptN

      if (task.verify.trim() === 'manual') {
        t.mark = '?'
      } else if (verifyOutcome.passed) {
        t.mark = 'x'
        delete t.error
        status.counters.tasks_verified += 1
        sessionsSinceVerification = 0
      } else if (t.attempts >= runtime.max_attempts_per_task) {
        t.mark = '!'
        t.error = `verify failed after ${t.attempts} attempts (exit ${verifyOutcome.exit_code}) -- see ${verifyOutcome.logPath}`
        status.counters.tasks_blocked += 1
      } else {
        t.mark = ' ' // back to pending, will be retried
        t.error = `attempt ${t.attempts} failed (exit ${verifyOutcome.exit_code}) -- see ${verifyOutcome.logPath}`
      }
      writeTasks(slug, runNo, freshTasks)

      status.counters.tasks_manual = countMark(freshTasks, '?')
      status.last_verify = { task: task.id, exit_code: verifyOutcome.exit_code, at: new Date().toISOString(), log: verifyOutcome.logPath }
      status.current_task = null
      writeStatus(status)

      if (!verifyOutcome.passed && task.verify.trim() !== 'manual') {
        sessionsSinceVerification += 1
        if (sessionsSinceVerification >= runtime.stall_sessions) {
          halt(status, 'stall', `${runtime.stall_sessions} sessions with no new verification`)
          return
        }
      }
    }

    // -- done: package + report ------------------------------------------------
    setPhase(status, 'gate', 'Packaging deliverable')
    const zipResult = await packageDeliverableZip(slug, runtime)
    if (zipResult.ok && zipResult.buffer) {
      writeDeliverableZip(slug, runNo, zipResult.buffer)
    }

    const finalTasks = readTasks(slug, runNo)
    const report = buildReport(slug, runNo, finalTasks, status, zipResult.ok, zipResult.error, zipResult.truncated)
    writeReport(slug, runNo, report)

    status.state = 'done'
    status.phase = null
    status.ended_at = new Date().toISOString()
    status.message = zipResult.ok
      ? `Done -- ${status.counters.tasks_verified} verified, deliverable packaged`
      : `Done -- ${status.counters.tasks_verified} verified, but zip packaging failed: ${zipResult.error}`
    writeStatus(status)
  } catch (err) {
    status = readStatus(slug, runNo)
    status.state = 'failed'
    status.ended_at = new Date().toISOString()
    status.message = `Supervisor internal error: ${String(err instanceof Error ? err.message : err)}`
    writeStatus(status)
  } finally {
    const p = readProject(slug)
    if (p && p.current_run === runNo) {
      p.current_run = null
      writeProject(p)
    }
  }
}

function buildReport(
  slug: string, runNo: string, tasks: BTTask[], status: BTStatus,
  zipOk: boolean, zipError: string | undefined, zipTruncated: boolean | undefined,
): string {
  const lines = [
    `# BulletTrain run report -- ${slug} run ${runNo}`,
    '',
    `State: ${status.state}${status.halt_reason ? ` (${status.halt_reason})` : ''}`,
    `Sessions run: ${status.counters.sessions_run}`,
    `Tasks: ${status.counters.tasks_verified}/${status.counters.tasks_total} verified, ` +
      `${status.counters.tasks_blocked} blocked, ${status.counters.tasks_manual} manual`,
    '',
    '## Tasks',
    ...tasks.map(t => `- [${t.mark}] ${t.id} ${t.title}${t.error ? ` -- ${t.error}` : ''}`),
    '',
    '## Deliverable',
    zipOk
      ? `Packaged at runs/${runNo}/deliverable.zip${zipTruncated ? ' (WARNING: likely truncated at the exec stdout cap -- raise MAX_OUTPUT_BYTES on orchestrail-exec)' : ''}`
      : `Packaging failed: ${zipError}`,
  ]
  return lines.join('\n') + '\n'
}

/** Kick off a run without blocking the HTTP request that started it. Errors
 *  are caught inside runSupervisor itself (state -> failed); this wrapper only
 *  guards against a truly unexpected throw escaping the promise chain. */
export function startSupervisorInBackground(slug: string, runNo: string): void {
  runSupervisor(slug, runNo).catch(err => {
    console.error(`[bullettrain] supervisor crashed for ${slug} run ${runNo}:`, err)
  })
}

export function ensureRunNoForNewRun(slug: string): { runNo: string } {
  const project = readProject(slug)
  if (!project) throw new Error(`no such project: ${slug}`)
  return { runNo: nextRunNo(project) }
}
