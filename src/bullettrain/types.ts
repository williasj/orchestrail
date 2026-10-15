// -- BulletTrain shared types ----------------------------------------------------

export type BTRunState = 'queued' | 'running' | 'halted' | 'done' | 'failed' | 'cancelled'
export type BTPhase = 'recon' | 'plan' | 'select' | 'session' | 'verify' | 'suite' | 'gate' | 'replan'

export type BTHaltReason =
  | 'brief_mismatch' | 'no_tasks' | 'task_cap' | 'all_blocked' | 'stall'
  | 'session_cap' | 'wall_clock' | 'manual_queue' | 'criteria_unmet'
  | 'exec_unreachable' | 'llm_unreachable' | 'orchestrail_restart' | null

export interface BTRuntime {
  model: string
  endpoint: string
  num_ctx: number
  temperature: number
  soft_checkpoint_pct: number
  hard_kill_pct: number
  max_turns_per_session: number
  max_sessions: number
  max_tasks: number
  max_attempts_per_task: number
  stall_sessions: number
  wall_clock_hours: number
  exec_timeout_ms: number
}

export interface BTProject {
  slug: string
  title: string
  created_at: string
  runs: number
  current_run: string | null
  last_run: string | null
  workspace_run_id: string
  owner?: string            // user (email) who created the project; keys its AIWiki memory
}

export type BTTaskMark = ' ' | '>' | 'x' | '!' | '?' | '-'

export interface BTTask {
  id: string
  mark: BTTaskMark
  title: string
  verify: string
  depends: string[]
  attempts: number
  artifacts: string[]
  error?: string
  parent?: string
}

export interface BTCounters {
  tasks_total: number
  tasks_verified: number
  tasks_blocked: number
  tasks_manual: number
  sessions_run: number
  replans: number
  prompt_tokens: number
  completion_tokens: number
  wall_seconds: number
}

export interface BTStatus {
  schema: 1
  slug: string
  run: string
  state: BTRunState
  phase: BTPhase | null
  pid: number | null
  started_at: string
  updated_at: string
  ended_at: string | null
  halt_reason: BTHaltReason
  runtime: BTRuntime
  current_task: string | null
  session_no: number
  counters: BTCounters
  last_verify: { task: string; exit_code: number; at: string; log: string } | null
  git_head: string | null
  message: string
}

export interface BTSessionRecord {
  n: number
  task: string
  started_at: string
  ended_at: string
  end_reason: 'soft_checkpoint' | 'hard_kill' | 'turn_cap' | 'task_complete' | 'nap_detected' | 'llm_error' | 'cancelled'
  turns: number
  tool_calls: number
  prompt_tokens_peak: number
  ctx_pct_peak: number
  handoff_written: boolean
  commits: string[]
  nap_turns: number
}
