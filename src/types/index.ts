// -- Shared TypeScript types for Orchestrail -----------------------------------
// Single barrel export. All other modules import from '../types/index.js'.
// This file must have zero imports from the rest of the codebase to stay
// circular-dependency-free as the foundation layer.

// -- Agent / LLM configuration -------------------------------------------------

export interface AgentLLM {
  provider: 'local' | 'openai' | 'anthropic' | 'custom'
  url: string       // base URL (e.g. http://localhost:11434/v1)
  apiKey: string    // Bearer key
  model: string
}

export interface TeamAgent {
  name: string
  systemPrompt: string
  llm: AgentLLM
  temperature: number
  maxTokens: number
  tools: string[]                         // tool IDs assigned to this agent
  toolCollections: Record<string, string> // toolId -> collection name (for qdrant_rag)
  order?: number                          // pipeline stage order (1=first); undefined = use array position
  stageName?: string                      // canonical pipeline stage name for this role (e.g. 'Testing').
                                          // decompose canonicalizes stage.name to this so an LLM-mislabeled
                                          // stage cannot scramble display, rewind targeting, or task framing.
  requiredOutputSlots?: string[]          // workbench slots that MUST be written before complete_stage is accepted
  injectCodeFromSlot?: string             // wb slot holding the impl under test; read by the orchestrator's deterministic
                                          // python-run-tests verification (default 'implementation'). NOT auto-injected
                                          // into agent calls -- agents read the impl themselves via read_file/workbench_read.
  readOnlySlots?: string[]                // workbench slots this agent can only read (never write)
  requiresVerifiedExecution?: boolean     // if set, complete_stage DONE on a CODE task (runtimes slot populated)
                                          // is rejected unless a real execution (use_skill or a bash run) actually
                                          // ran AND passed. Outcome-based verification gate; capability-agnostic.
}

export interface ToolConfig {
  id: string
  name: string
  type: 'qdrant_rag' | 'openai_tools' | 'rag_manager' | 'searxng' | 'self_improve'
  enabled: boolean
  config: Record<string, string>
}

// -- Task decomposition --------------------------------------------------------

export interface TaskSpec {
  title: string
  description: string
  assignee: string
  dependsOn: string[]
}

export interface PipelineStage {
  name:        string
  assignee:    string
  description: string
  escalateTo?: string   // agent the executor routes ESCALATE directives to
  maxRetries:  number   // max escalation cycles per stage (default 3)
}

export type DecomposeResult =
  | { mode: 'dag';      specs:  TaskSpec[]      }
  | { mode: 'pipeline'; stages: PipelineStage[] }

// -- Execution results ---------------------------------------------------------

export interface StageCompletion {
  status:             'DONE' | 'ESCALATE'
  summary:            string
  escalation_reason?: string
  selfContract?:      boolean   // ESCALATE was synthesized because the agent failed its OWN contract (no slot / no execution) -- re-run the same agent, do not route to escalateTo
}

export interface AgentResult {
  assignee:   string
  title:      string
  output:     string
  success:    boolean
  completion?: StageCompletion
  tokens?:    number          // total tokens consumed by this agent's stage (delta of the per-request accumulator)
  _messages?: AgenticMessage[]
  // Capability-based verification outcome for this stage. Populated only when the
  // agent was flagged requiresVerifiedExecution AND this was a CODE task (runtimes
  // slot present). `passed` is the deterministic ground truth captured from the real
  // execution result (bash exit / skill result), independent of any prose the model
  // wrote into test_report -- so the synthesis hard-gate can key on it without
  // trusting model narration. Absent for non-verification stages.
  verification?: {
    required: boolean
    passed:   boolean
    detail:   string
  }
}

// -- LLM message types ---------------------------------------------------------

// Extended message type that covers tool call turns in the agentic loop
export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface AgenticMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string   // required when role === 'tool'
}

// Kept as a narrow type for coordinator/synthesis calls that never use tools
export interface ChatMessage {
  role: string
  content: string
}

export interface UsageTotals {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface LLMResponse {
  choices: Array<{
    message: {
      content: string | null
      tool_calls?: ToolCall[]
    }
    finish_reason: string
  }>
  usage?: UsageTotals
}

// -- RAG Manager (HTTP RAG proxy) ---------------------------------------------

export interface RagManagerEndpoint {
  operationId: string
  summary:     string
  description: string
  path:        string
}

export interface RagManagerSpec {
  baseUrl:   string
  endpoints: RagManagerEndpoint[]
}

// -- Memory / coordinator config -----------------------------------------------

export interface MemoryConfig {
  qdrantUrl:  string   // e.g. http://localhost:6333
  teiUrl:     string   // text-embeddings-inference, e.g. http://localhost:8764
  vectorSize: number   // must match TEI model (e.g. 1024)
}

export interface SkillConfig {
  skillsDir: string   // container-internal path, e.g. /data/orchestrail/skills
                      // subdirs agent/, user/, deprecated/ are created automatically
  verifierRole?: string  // assignee name of the stage that verifies a run (e.g.
                         // 'adversarial-reviewer'). Used by candidacy scoring to
                         // find the pass/fail signal. If unset, a roster-agnostic
                         // name heuristic is used. See skills.ts scoreExecution().
}

export interface CoordinatorConfig {
  llm:                  AgentLLM
  flags:                string[]  // prepended to every system prompt -- coordinator and all agents
  decompositionPrompt?: string    // overrides coordinatorSystem(); use {{AGENT_ROSTER}}, {{PIPELINE_EXAMPLE}}, {{AGENT_COUNT}}, {{AGENT_NAMES}}
  routingPrompt?:       string    // overrides coordinatorRouteSystem(); use {{AGENT_ROSTER}}, {{GOAL}}, {{REMAINING_STAGES}}, {{COMPLETED_STAGES}}
  clarificationPrompt?: string    // overrides clarificationSystem(); no template vars needed
  synthesisPrompt?:     string    // overrides the synthesis system prompt; no template vars needed
  memory?:              MemoryConfig
  skills?:              SkillConfig
}

// -- Execution callbacks -------------------------------------------------------

export interface ExecCallbacks {
  onWaiting:  (spec: TaskSpec, waitingFor: string[]) => void
  onStart:    (spec: TaskSpec) => void
  onComplete: (result: AgentResult) => void
}

export interface CoordinatorDecision {
  action:       'NEXT' | 'ESCALATE' | 'SYNTHESIZE' | 'REWIND'
  targetAgent?: string   // set when action === 'ESCALATE'
  rewindTo?:    string   // set when action === 'REWIND'   stage name to return to
  reason:       string
}

export interface PipelineCallbacks {
  onStageStart:       (stage: PipelineStage, attempt: number) => void
  onStageDone:        (stage: PipelineStage, result: AgentResult, status: 'done' | 'escalate') => void
  onFixStart:         (stage: PipelineStage, fixAgent: string, reason: string) => void
  onFixDone:          (fixAgent: string, result: AgentResult) => void
  onMaxRetries:       (stage: PipelineStage) => void
  onCoordinatorRoute: (decision: CoordinatorDecision) => void
  onRewind:           (fromStage: string, toStage: string, reason: string) => void
}

// -- Tool log ------------------------------------------------------------------

export interface ToolLogEntry {
  id:             string
  ts:             number          // unix ms
  agent:          string
  tool:           string
  args:           Record<string, unknown>
  result:         string
  ok:             boolean         // false if result contains an error key
  durationMs:     number
  userId?:        string          // email of the user who triggered this entry
  conversationId?: string         // conversation this entry belongs to
}

// -- Pipelines protocol (OpenWebUI) -------------------------------------------

// OpenWebUI user context passed by the Pipelines protocol.
export interface PipelinesUser {
  id:    string
  name:  string
  email: string
  role:  'admin' | 'user' | string
}

// -- User / auth ---------------------------------------------------------------

export type UserRole = 'admin' | 'user'

export interface UserRecord {
  id:           string       // uuid
  email:        string       // primary identifier -- must match OpenWebUI email
  displayName:  string
  passwordHash: string       // bcrypt
  role:         UserRole
  createdAt:    string       // ISO8601
  lastActive:   string       // ISO8601
}

export interface SessionToken {
  token:     string
  userId:    string
  email:     string
  role:      UserRole
  createdAt: string
  expiresAt: string
}

// -- Self-improvement pending change record ------------------------------------
// Written by propose_edit tool; approved/rejected via admin UI.
// On approval the patch is applied to the source file in-place.
// The container must be rebuilt manually after approval.

export type PendingChangeStatus = 'pending' | 'approved' | 'rejected'

export type ChangeType =
  | 'src-change'
  | 'agent-prompt-change'
  | 'coordinator-prompt-change'
  | 'skill-create'

export type ReviewerVerdict = 'approved' | 'flagged'

export interface PendingChange {
  id:            string
  timestamp:     string          // ISO8601
  triggeredBy:   string          // conversation id that produced this change
  agent:         string          // which agent proposed it
  file:          string          // relative path e.g. src/core/prompts.ts (or agent/coord key for non-src types)
  original:      string          // exact text that must exist (validated at propose time); for skill-create: skill name
  replacement:   string          // text to substitute; for skill-create: skill spec JSON
  rationale:     string          // agent-authored explanation
  rubricGaps:    string[]        // which rubric items this targets e.g. ['#7', '#10']
  status:        PendingChangeStatus
  changeType:    ChangeType      // what kind of change this is
  reviewedAt?:   string          // ISO8601, set on approve/reject
  reviewNote?:   string          // optional human note on rejection
  // Populated async by background proposal-reviewer (deepseek-r1:671b)
  reviewerVerdict?: ReviewerVerdict  // 'approved' | 'flagged'
  reviewerNote?:    string           // R1's evaluation note
  reviewerAt?:      string           // ISO8601 when reviewer finished
}

export interface AuthContext {
  userId: string
  email:  string
  role:   UserRole
}
