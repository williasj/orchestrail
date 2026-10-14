// -- Orchestrail configuration and constants -----------------------------------
// All environment variables and shared constants live here.
// No logic -- pure configuration.

import * as path from "path"

export const PORT               = process.env.PORT || 8080
export const MODEL_ID           = "orchestrail"
export const DATA_DIR           = process.env.DATA_DIR || "/data"
export const PIPELINES_API_KEY  = process.env.PIPELINES_API_KEY || "change-me"
export const SKILLS_DIR         = process.env.SKILLS_DIR || path.join(DATA_DIR, "skills")

export const AGENTS_FILE           = path.join(DATA_DIR, "agents.json")
export const TOOLS_FILE            = path.join(DATA_DIR, "tools.json")
export const COORDINATOR_FILE      = path.join(DATA_DIR, "coordinator.json")
export const PENDING_CHANGES_FILE  = path.join(DATA_DIR, "pending-changes.json")

// Absolute path to the Orchestrail source tree (read-only by self-improvement
// agent; writable only via the approved-change apply path in admin.ts).
// Override with SOURCE_ROOT env var if the container mount differs.
export const SOURCE_ROOT = process.env.SOURCE_ROOT || "/app/src"

// Qdrant collection names
export const cols = {
  conversation: "orchestrail_conversations",
  users:        "orchestrail_users",
  meta:         "orchestrail_meta",
  skills:       "orchestrail_skills",
  failures:     "orchestrail_failures",  // split-storage lessons library (file-backed)
  skillCaps:    "orchestrail_skill_caps", // executable-skill capability index (folder-backed)
}

// Optional explicit code-execution endpoint (the orchestrail-exec server). When
// unset, the executor resolves the URL of the registered exec tool (the one
// advertising `bash`) from the tool registry.
export const CODE_EXEC_URL = process.env.CODE_EXEC_URL || ""

// RAG split-storage canonical root. Matches the deployed mount /data/rag
// (sibling to /data/skills); users overlay lives at /data/rag/users.
export const RAG_DIR = process.env.RAG_DIR || path.join(DATA_DIR, "rag")

export const RAG_MANAGER_CACHE_TTL = 5 * 60 * 1000  // 5 minutes

// Workbench tool sentinel -- used to detect workbench-only agent responses
export const WORKBENCH_SENTINEL = "__workbench__"

// Agent execution limits
export const MAX_TOOL_ROUNDS       = 10  // prevent infinite loops on misbehaving models
export const MAX_REWINDS_PER_STAGE = 2   // prevent infinite rewind loops
export const MAX_PIPELINE_ESCALATIONS = 6  // global fix/escalation budget across all stages -- hard backstop so one non-converging stage cannot run up unbounded cost

// Pipeline handoff directives -- injected by runAgent into stage completions
export const HANDOFF_DONE     = "HANDOFF: DONE"
export const HANDOFF_ESCALATE = "HANDOFF: ESCALATE"

export const HANDOFF_FOOTER =
  `

---
RULE: Do NOT modify, correct, or second-guess any value supplied by the user in the original request ` +   `(IP addresses, hostnames, port numbers, names, paths, credentials, parameters, or any other configuration value). ` +   `Treat every user-supplied value as intentional and correct. Your job is to produce the deliverable -- not to re-interpret user requirements.

` +   `At the end of your response add exactly one of:
` +   `${HANDOFF_DONE}
` +   `${HANDOFF_ESCALATE}   <specific defect that blocks the next stage>. Fix needed: <what must change>. May affect: <list any prior stage names whose approvals the fix could invalidate, or "none">`
