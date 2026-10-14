// -- BulletTrain configuration --------------------------------------------------
// All environment variables and constants for the BulletTrain tab live here.
// No logic -- pure configuration. Mirrors the style of utils/config.ts.
//
// ALPHA SCOPE NOTE: this is the alpha cut of the run-directory contract
// (bullettrain-run-contract.md v1). Deliberately deferred vs the full contract:
//   - supervisor runs in-process (async, not a detached child process) --
//     no crash isolation, no PID reattach. Section 3 of the contract.
//   - no task fission (bt_subtask) -- the task list is fixed after planning.
//   - no acceptance-criteria gate / replan -- DONE means every task is
//     verified or manual, full stop.
//   - no full_suite_every_session regression re-run.
//   - vector memory: not built (matches the real contract -- deferred there too).
// Each of these is a real gap for a production run, not a hidden shortcut.

import * as path from 'path'
import { DATA_DIR, CODE_EXEC_URL } from '../utils/config.js'
import { OLLAMA_BASE_URL, OLLAMA_MODEL } from '../agents.js'

// Control plane root -- lives inside the same /data volume already bind-mounted
// into the Orchestrail container. Never touched by the agent: the agent's exec
// tools are scoped to /workbench/{runId} in a DIFFERENT container, and that
// mount does not exist in this container at all (see docker-compose.yml --
// /data/bullettrain has no counterpart bind into orchestrail-exec). That
// container boundary, not application logic, is what makes the two-root split
// real rather than a convention the agent could talk its way around.
export const BT_DATA_DIR = process.env.BT_DATA_DIR || path.join(DATA_DIR, 'bullettrain')
export const BT_PROJECTS_DIR = path.join(BT_DATA_DIR, 'projects')

// Data-plane exec endpoint -- same orchestrail-exec sidecar Orchestrail already
// uses, reused as a peer over HTTP (own envelope, not through core/tools.ts).
export const BT_EXEC_URL = process.env.BT_EXEC_URL || CODE_EXEC_URL

// Default RUNTIME.md front matter for newly created projects. Defaults to the
// same model/endpoint Orchestrail's other agents use so an alpha run works
// out of the box; per-project RUNTIME.md is user-editable after that.
export const BT_DEFAULT_MODEL = process.env.BT_DEFAULT_MODEL || OLLAMA_MODEL
export const BT_DEFAULT_ENDPOINT = process.env.BT_DEFAULT_ENDPOINT || OLLAMA_BASE_URL

export const BT_DEFAULT_RUNTIME = {
  model: BT_DEFAULT_MODEL,
  endpoint: BT_DEFAULT_ENDPOINT,
  num_ctx: 65536,
  temperature: 0.6,
  soft_checkpoint_pct: 65,
  hard_kill_pct: 80,
  max_turns_per_session: 60,
  max_sessions: 200,
  max_tasks: 60,
  max_attempts_per_task: 3,
  stall_sessions: 8,
  wall_clock_hours: 12,
  exec_timeout_ms: 300000,
}

// Reconstruction-prompt halt threshold (Section 11 of the contract): if the
// assembled prompt exceeds this fraction of num_ctx, halt with brief_mismatch
// rather than silently drop or truncate sections.
export const BT_RECON_PROMPT_MAX_PCT = 45

export const BT_HANDOFF_MAX_BYTES = 8 * 1024
export const BT_DECISION_LINE_MAX_CHARS = 200
export const BT_DECISIONS_MAX_LINES = 400

// Consecutive zero-tool-call turns before a session is ended as "napping".
export const BT_NAP_TURN_LIMIT = 3

export const BT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
