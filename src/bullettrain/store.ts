// -- BulletTrain control-plane store ---------------------------------------------
// Every read/write of a control-plane file goes through here. This is the only
// module that touches /data/bullettrain directly, so ownership rules (Section 2
// of the contract) are enforced by which functions exist, not by convention:
// there is no exported function that lets a caller write tasks.md, status.json,
// report.md, or sessions/*.json except the supervisor's own call sites.

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  BT_PROJECTS_DIR, BT_HANDOFF_MAX_BYTES, BT_DECISION_LINE_MAX_CHARS, BT_DECISIONS_MAX_LINES,
  BT_DEFAULT_RUNTIME,
} from './config.js'
import { renderRuntimeMd, parseRuntimeMd } from './runtime.js'
import type { BTProject, BTStatus, BTTask, BTTaskMark, BTRuntime, BTSessionRecord } from './types.js'

// -- Paths -----------------------------------------------------------------------

export function projectDir(slug: string): string {
  return path.join(BT_PROJECTS_DIR, slug)
}
export function runDir(slug: string, runNo: string): string {
  return path.join(projectDir(slug), 'runs', runNo)
}
function projectJsonPath(slug: string): string { return path.join(projectDir(slug), 'project.json') }
function projectMdPath(slug: string): string { return path.join(projectDir(slug), 'PROJECT.md') }
function runtimeMdPath(slug: string): string { return path.join(projectDir(slug), 'RUNTIME.md') }
function decisionsMdPath(slug: string): string { return path.join(projectDir(slug), 'DECISIONS.md') }
function briefMdPath(slug: string, runNo: string): string { return path.join(runDir(slug, runNo), 'BRIEF.md') }
function statusJsonPath(slug: string, runNo: string): string { return path.join(runDir(slug, runNo), 'status.json') }
function tasksMdPath(slug: string, runNo: string): string { return path.join(runDir(slug, runNo), 'tasks.md') }
function handoffMdPath(slug: string, runNo: string): string { return path.join(runDir(slug, runNo), 'HANDOFF.md') }
function reportMdPath(slug: string, runNo: string): string { return path.join(runDir(slug, runNo), 'report.md') }
function sessionsDir(slug: string, runNo: string): string { return path.join(runDir(slug, runNo), 'sessions') }
function verifyDir(slug: string, runNo: string): string { return path.join(runDir(slug, runNo), 'verify') }
export function deliverableZipPath(slug: string, runNo: string): string {
  return path.join(runDir(slug, runNo), 'deliverable.zip')
}

// -- Atomic write ------------------------------------------------------------------

function atomicWrite(dest: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = dest + '.tmp-' + process.pid + '-' + Date.now()
  fs.writeFileSync(tmp, content)
  const fd = fs.openSync(tmp, 'r')
  fs.fsyncSync(fd)
  fs.closeSync(fd)
  fs.renameSync(tmp, dest)
}

// -- Slug / listing ------------------------------------------------------------

export function listProjects(): BTProject[] {
  if (!fs.existsSync(BT_PROJECTS_DIR)) return []
  return fs.readdirSync(BT_PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => readProject(d.name))
    .filter((p): p is BTProject => p !== null)
}

export function projectExists(slug: string): boolean {
  return fs.existsSync(projectJsonPath(slug))
}

// -- project.json ----------------------------------------------------------------

export function readProject(slug: string): BTProject | null {
  const p = projectJsonPath(slug)
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf8')) as BTProject
}

export function writeProject(project: BTProject): void {
  atomicWrite(projectJsonPath(project.slug), JSON.stringify(project, null, 2))
}

export function createProject(slug: string, title: string, briefContent: string, runtimeOverride?: Partial<BTRuntime>, owner?: string): BTProject {
  fs.mkdirSync(projectDir(slug), { recursive: true })
  const project: BTProject = {
    slug, title,
    created_at: new Date().toISOString(),
    runs: 0,
    current_run: null,
    last_run: null,
    workspace_run_id: 'bt-' + slug,
    ...(owner ? { owner } : {}),
  }
  writeProject(project)
  atomicWrite(projectMdPath(slug), briefContent)
  atomicWrite(runtimeMdPath(slug), renderRuntimeMd({ ...BT_DEFAULT_RUNTIME, ...runtimeOverride }))
  if (!fs.existsSync(decisionsMdPath(slug))) atomicWrite(decisionsMdPath(slug), '')
  return project
}

export function readProjectMd(slug: string): string {
  return fs.existsSync(projectMdPath(slug)) ? fs.readFileSync(projectMdPath(slug), 'utf8') : ''
}

export function readRuntime(slug: string): BTRuntime {
  const p = runtimeMdPath(slug)
  if (!fs.existsSync(p)) return parseRuntimeMd('')
  return parseRuntimeMd(fs.readFileSync(p, 'utf8'))
}

// -- DECISIONS.md (append-only, project-scoped) -----------------------------------

export function readDecisions(slug: string): string {
  return fs.existsSync(decisionsMdPath(slug)) ? fs.readFileSync(decisionsMdPath(slug), 'utf8') : ''
}

export function appendDecision(slug: string, runNo: string, line: string): { ok: boolean; error?: string } {
  const clean = line.replace(/\n/g, ' ').trim().slice(0, BT_DECISION_LINE_MAX_CHARS)
  if (!clean) return { ok: false, error: 'empty decision line' }
  const current = readDecisions(slug)
  const lineCount = current ? current.split('\n').filter(l => l.trim()).length : 0
  if (lineCount >= BT_DECISIONS_MAX_LINES) {
    return { ok: false, error: `DECISIONS.md at ${BT_DECISIONS_MAX_LINES}-line cap -- run halts for manual curation` }
  }
  const date = new Date().toISOString().slice(0, 10)
  const entry = `${date} run ${runNo}  ${clean}\n`
  fs.mkdirSync(projectDir(slug), { recursive: true })
  fs.appendFileSync(decisionsMdPath(slug), entry, 'utf8')
  return { ok: true }
}

export function decisionsAtCap(slug: string): boolean {
  const current = readDecisions(slug)
  const lineCount = current ? current.split('\n').filter(l => l.trim()).length : 0
  return lineCount >= BT_DECISIONS_MAX_LINES
}

// -- runs/{runNo} bootstrap --------------------------------------------------------

export function nextRunNo(project: BTProject): string {
  return String(project.runs + 1).padStart(3, '0')
}

export function createRun(slug: string, runNo: string, briefContent: string, runtime: BTRuntime): void {
  fs.mkdirSync(runDir(slug, runNo), { recursive: true })
  fs.mkdirSync(sessionsDir(slug, runNo), { recursive: true })
  fs.mkdirSync(verifyDir(slug, runNo), { recursive: true })
  atomicWrite(briefMdPath(slug, runNo), briefContent)
  atomicWrite(handoffMdPath(slug, runNo), '')
  const status: BTStatus = {
    schema: 1, slug, run: runNo,
    state: 'queued', phase: null, pid: process.pid,
    started_at: new Date().toISOString(), updated_at: new Date().toISOString(), ended_at: null,
    halt_reason: null, runtime,
    current_task: null, session_no: 0,
    counters: {
      tasks_total: 0, tasks_verified: 0, tasks_blocked: 0, tasks_manual: 0,
      sessions_run: 0, replans: 0, prompt_tokens: 0, completion_tokens: 0, wall_seconds: 0,
    },
    last_verify: null, git_head: null, message: 'Run created',
  }
  writeStatus(status)
  writeTasks(slug, runNo, [])
}

export function readBrief(slug: string, runNo: string): string {
  return fs.readFileSync(briefMdPath(slug, runNo), 'utf8')
}

// -- status.json (supervisor-only writer) ------------------------------------------

export function readStatus(slug: string, runNo: string): BTStatus {
  return JSON.parse(fs.readFileSync(statusJsonPath(slug, runNo), 'utf8')) as BTStatus
}

export function statusExists(slug: string, runNo: string): boolean {
  return fs.existsSync(statusJsonPath(slug, runNo))
}

export function writeStatus(status: BTStatus): void {
  status.updated_at = new Date().toISOString()
  atomicWrite(statusJsonPath(status.slug, status.run), JSON.stringify(status, null, 2))
}

// -- tasks.md (supervisor-only writer; grammar from Section 7 of the contract) -----

const MARK_CHARS: Record<BTTaskMark, string> = { ' ': ' ', '>': '>', x: 'x', '!': '!', '?': '?', '-': '-' }

export function renderTasksMd(tasks: BTTask[]): string {
  const lines = ['# tasks', '']
  for (const t of tasks) {
    lines.push(`- [${MARK_CHARS[t.mark]}] ${t.id} ${t.title}`)
    lines.push(`      verify: ${t.verify}`)
    if (t.depends.length) lines.push(`      depends: ${t.depends.join(',')}`)
    lines.push(`      attempts: ${t.attempts}`)
    if (t.artifacts.length) lines.push(`      artifacts: ${t.artifacts.join(', ')}`)
    if (t.error) lines.push(`      error: ${t.error}`)
    if (t.parent) lines.push(`      parent: ${t.parent}`)
    lines.push('')
  }
  return lines.join('\n')
}

export function parseTasksMd(text: string): BTTask[] {
  const tasks: BTTask[] = []
  const lines = text.split('\n')
  let current: BTTask | null = null
  const headerRe = /^-\s\[(.)\]\s(\d{3})\s(.*)$/
  const fieldRe = /^\s{6}([a-z]+):\s(.*)$/
  for (const line of lines) {
    const h = line.match(headerRe)
    if (h) {
      if (current) tasks.push(current)
      current = {
        id: h[2]!, mark: h[1] as BTTaskMark, title: h[3]!.trim(),
        verify: '', depends: [], attempts: 0, artifacts: [],
      }
      continue
    }
    const f = line.match(fieldRe)
    if (f && current) {
      const key = f[1]!
      const val = f[2]!.trim()
      if (key === 'verify') current.verify = val
      else if (key === 'depends') current.depends = val.split(',').map(s => s.trim()).filter(Boolean)
      else if (key === 'attempts') current.attempts = Number(val) || 0
      else if (key === 'artifacts') current.artifacts = val.split(',').map(s => s.trim()).filter(Boolean)
      else if (key === 'error') current.error = val
      else if (key === 'parent') current.parent = val
    }
  }
  if (current) tasks.push(current)
  return tasks
}

export function readTasks(slug: string, runNo: string): BTTask[] {
  const p = tasksMdPath(slug, runNo)
  if (!fs.existsSync(p)) return []
  return parseTasksMd(fs.readFileSync(p, 'utf8'))
}

export function writeTasks(slug: string, runNo: string, tasks: BTTask[]): void {
  atomicWrite(tasksMdPath(slug, runNo), renderTasksMd(tasks))
}

// -- HANDOFF.md (agent-owned, full rewrite via bt_handoff) -------------------------

export function readHandoff(slug: string, runNo: string): string {
  const p = handoffMdPath(slug, runNo)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

export function writeHandoff(slug: string, runNo: string, content: string): { ok: boolean; error?: string } {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > BT_HANDOFF_MAX_BYTES) {
    return { ok: false, error: `HANDOFF.md write rejected: ${bytes}b exceeds ${BT_HANDOFF_MAX_BYTES}b cap -- compress, do not truncate silently` }
  }
  atomicWrite(handoffMdPath(slug, runNo), content)
  return { ok: true }
}

// -- report.md (supervisor-only, terminal states) -----------------------------------

export function writeReport(slug: string, runNo: string, content: string): void {
  atomicWrite(reportMdPath(slug, runNo), content)
}

// -- sessions/{nnn}.json (supervisor-only, append-only within a run) ----------------

export function writeSessionRecord(slug: string, runNo: string, record: BTSessionRecord): void {
  const p = path.join(sessionsDir(slug, runNo), String(record.n).padStart(3, '0') + '.json')
  atomicWrite(p, JSON.stringify(record, null, 2))
}

export function listSessionRecords(slug: string, runNo: string): BTSessionRecord[] {
  const dir = sessionsDir(slug, runNo)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as BTSessionRecord)
}

// -- verify/{taskId}.{n}.log (supervisor-only) ---------------------------------------

export function writeVerifyLog(slug: string, runNo: string, taskId: string, attempt: number, log: string): string {
  const relName = `${taskId}.${attempt}.log`
  const abs = path.join(verifyDir(slug, runNo), relName)
  atomicWrite(abs, log)
  return path.join('verify', relName)
}

// -- deliverable.zip (supervisor-only, written on DONE) ------------------------------

export function writeDeliverableZip(slug: string, runNo: string, buf: Buffer): void {
  atomicWrite(deliverableZipPath(slug, runNo), buf)
}

export function readDeliverableZip(slug: string, runNo: string): Buffer | null {
  const p = deliverableZipPath(slug, runNo)
  return fs.existsSync(p) ? fs.readFileSync(p) : null
}
