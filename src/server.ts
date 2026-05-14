import express, { Request, Response } from 'express'
import { AsyncLocalStorage } from 'node:async_hooks'
import cors from 'cors'
import { v4 as uuidv4 } from 'uuid'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { DEFAULT_AGENTS, OLLAMA_BASE_URL, OLLAMA_MODEL } from './agents.js'
import { UI_HTML } from './ui.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 8080
const MODEL_ID = 'orchestrail'
const DATA_DIR = process.env.DATA_DIR || '/data'
const AGENTS_FILE      = path.join(DATA_DIR, 'agents.json')
const TOOLS_FILE       = path.join(DATA_DIR, 'tools.json')
const COORDINATOR_FILE = path.join(DATA_DIR, 'coordinator.json')

app.use(cors())
app.use(express.json({ limit: '10mb' }))

// -- Types ---------------------------------------------------------------------

export interface AgentLLM {
  provider: 'local' | 'openai' | 'anthropic' | 'custom'
  url: string       // base URL (e.g. http://10.20.0.27:11434/v1)
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
  requiredOutputSlots?: string[]          // workbench slots that MUST be written before complete_stage is accepted
  injectCodeFromSlot?: string             // for test stages: server prepends this wb slot to run_code code arg
  readOnlySlots?: string[]                // workbench slots this agent can only read (never write)
}

export interface ToolConfig {
  id: string
  name: string
  type: 'qdrant_rag' | 'openai_tools'
  enabled: boolean
  config: Record<string, string>
}

interface TaskSpec {
  title: string
  description: string
  assignee: string
  dependsOn: string[]
}

interface AgentResult {
  assignee:   string
  title:      string
  output:     string
  success:    boolean
  completion?: StageCompletion
  _messages?: AgenticMessage[]
}

interface StageCompletion {
  status:             'DONE' | 'ESCALATE'
  summary:            string
  escalation_reason?: string
}

interface PipelineStage {
  name:        string
  assignee:    string
  description: string
  escalateTo?: string   // agent the executor routes ESCALATE directives to
  maxRetries:  number   // max escalation cycles per stage (default 3)
}

type DecomposeResult =
  | { mode: 'dag';      specs:  TaskSpec[]      }
  | { mode: 'pipeline'; stages: PipelineStage[] }

// Extended message type that covers tool call turns in the agentic loop
interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface AgenticMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string   // required when role === 'tool'
}

// Kept as a narrow type for coordinator/synthesis calls that never use tools
interface ChatMessage {
  role: string
  content: string
}

interface UsageTotals {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

// Per-request usage accumulator   populated automatically by callLLMRaw
const usageStorage    = new AsyncLocalStorage<UsageTotals>()
const workbenchIdStorage = new AsyncLocalStorage<string>()

// -- Workbench ----------------------------------------------------------------
// Per-pipeline key-value scratchpad. Lives in memory; cleared after response.
// Agents call workbench_list / workbench_read / workbench_write to share
// artifacts without bloating each other's context windows.
const workbenchStore = new Map<string, Map<string, string>>()

function wbId(): string { return workbenchIdStorage.getStore() ?? 'default' }
function wbGet(slot: string): string | null { return workbenchStore.get(wbId())?.get(slot) ?? null }
function wbSet(slot: string, content: string): void {
  if (!workbenchStore.has(wbId())) workbenchStore.set(wbId(), new Map())
  workbenchStore.get(wbId())!.set(slot, content)
}
function wbList(): string[] { return Array.from(workbenchStore.get(wbId())?.keys() ?? []) }
function wbClear(id: string): void { workbenchStore.delete(id) }

// Validate that content looks like source code (not natural language)
function looksLikeCode(content: string, languageHint?: string): boolean {
  if (!content || content.length < 10) return false
  
  // Code indicators - presence of these suggests code, not natural language
  const codeIndicators = [
    /^(use |import |from |require\()/m,           // imports
    /^(pub |fn |impl |struct |enum |trait )/m,    // Rust keywords
    /^(def |class |if __name__)/m,                // Python
    /^(function |const |let |var |=>)/m,          // JS/TS
    /[{}\[\]();]/m,                               // Brackets/punctuation common in code
    /^(#include |#define |int |void |return )/m,  // C/C++
    /^(package |type |func |interface)/m,         // Go
  ]
  
  let codeScore = 0
  for (const pattern of codeIndicators) {
    if (pattern.test(content)) codeScore++
  }
  
  // Natural language indicators - suggest this is NOT code
  const naturalIndicators = [
    /^(I need to|I will|Here's|First,|Then|The implementation)/mi,
    /^(Error:|Warning:|Note:)/mi,
    /[.!?]$/m,  // Sentence punctuation
  ]
  
  let naturalScore = 0
  for (const pattern of naturalIndicators) {
    if (pattern.test(content)) naturalScore++
  }
  
  // Content is considered code if it has at least 2 code indicators and fewer natural indicators
  return codeScore >= 2 && naturalScore < codeScore
}

function stripCodeBlockDelimiters(content: string): string {
  // Remove markdown code block fences if present
  const fenceMatch = content.match(/```[\w]*\n([\s\S]*?)```/)
  if (fenceMatch) return fenceMatch[1]!.trim()
  return content.trim()
}

function detectDuplicateMain(code: string): boolean {
  // Count occurrences of 'fn main()' in Rust code
  const mainMatches = code.match(/fn\s+main\s*\(/g)
  return (mainMatches?.length ?? 0) > 1
}

function detectStructRedefinition(code: string, existingCode?: string): boolean {
  if (!existingCode) return false
  // Extract struct/class names from existing code
  const structPattern = /(?:pub\s+)?(?:struct|class|interface|type)\s+(\w+)/g
  const existingStructs = new Set<string>()
  let match
  while ((match = structPattern.exec(existingCode)) !== null) {
    existingStructs.add(match[1])
  }
  // Check if new code redefines any of them
  while ((match = structPattern.exec(code)) !== null) {
    if (existingStructs.has(match[1])) return true
  }
  return false
}

function buildWorkbenchTools(): unknown[] {
  return [
    { type: 'function', function: {
      name: 'workbench_list',
      description: 'List all artifact slots available on the shared workbench. Call this first to discover what prior stages produced.',
      parameters: { type: 'object', properties: {}, required: [] },
    }},
    { type: 'function', function: {
      name: 'workbench_read',
      description: 'Read an artifact from the workbench by slot name. Use slot "implementation" to get the authoritative code to review or test.',
      parameters: { type: 'object', properties: {
        slot: { type: 'string', description: 'Slot name to read (e.g. "implementation", "blueprint", "review")' },
      }, required: ['slot'] },
    }},
    { type: 'function', function: {
      name: 'workbench_write',
      description: 'Write an artifact to the workbench so downstream stages can access it.',
      parameters: { type: 'object', properties: {
        slot:    { type: 'string', description: 'Slot name to write' },
        content: { type: 'string', description: 'Content to store' },
      }, required: ['slot', 'content'] },
    }},
    { type: 'function', function: {
      name: 'list_runtimes',
      description: 'List available code execution runtimes. Returns cached result if the runtimes slot is already populated; otherwise fetches from Piston and caches. Always call this before run_code to confirm the language string.',
      parameters: { type: 'object', properties: {}, required: [] },
    }},
  ]
}
const WORKBENCH_SENTINEL = '__workbench__'

interface LLMResponse {
  choices: Array<{
    message: {
      content: string | null
      tool_calls?: ToolCall[]
    }
    finish_reason: string
  }>
  usage?: UsageTotals
}

interface CoordinatorConfig {
  llm:                  AgentLLM
  flags:                string[]  // prepended to every system prompt -- coordinator and all agents
  decompositionPrompt?: string    // overrides coordinatorSystem(); use {{AGENT_ROSTER}}, {{PIPELINE_EXAMPLE}}, {{AGENT_COUNT}}, {{AGENT_NAMES}}
  routingPrompt?:       string    // overrides coordinatorRouteSystem(); use {{AGENT_ROSTER}}, {{GOAL}}, {{REMAINING_STAGES}}, {{COMPLETED_STAGES}}
  clarificationPrompt?: string    // overrides clarificationSystem(); no template vars needed
  synthesisPrompt?:     string    // overrides the synthesis system prompt; no template vars needed
}

// -- Default LLM ---------------------------------------------------------------

function defaultLLM(): AgentLLM {
  return {
    provider: 'local',
    url: OLLAMA_BASE_URL,
    apiKey: 'ollama',
    model: OLLAMA_MODEL,
  }
}

// -- Default tools -------------------------------------------------------------

const DEFAULT_TOOLS: ToolConfig[] = [
  {
    id: 'qdrant-rag',
    name: 'Qdrant RAG',
    type: 'qdrant_rag',
    enabled: false,
    config: {
      url: 'http://10.20.0.27:6333',
      embeddingUrl: 'http://10.20.0.27:8764',
    },
  },
]

// -- Persistence ---------------------------------------------------------------

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch {}
}

function loadAgents(): TeamAgent[] {
  ensureDataDir()
  try {
    const raw = fs.readFileSync(AGENTS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as TeamAgent[]
  } catch {}
  // First boot -- build from hardcoded defaults and persist immediately
  const agents: TeamAgent[] = DEFAULT_AGENTS.map(a => ({
    name: a.name,
    systemPrompt: a.systemPrompt || '',
    llm: defaultLLM(),
    temperature: 0,
    maxTokens: 4096,
    tools: [],
    toolCollections: {},
    peers: [],
  }))
  try { fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2), 'utf8') } catch {}
  return agents
}

function loadTools(): ToolConfig[] {
  ensureDataDir()
  try {
    const raw = fs.readFileSync(TOOLS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as ToolConfig[]
  } catch {}
  try { fs.writeFileSync(TOOLS_FILE, JSON.stringify(DEFAULT_TOOLS, null, 2), 'utf8') } catch {}
  return DEFAULT_TOOLS
}

function saveAgents(agents: TeamAgent[]) {
  ensureDataDir()
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2), 'utf8')
}

function saveTools(tools: ToolConfig[]) {
  ensureDataDir()
  fs.writeFileSync(TOOLS_FILE, JSON.stringify(tools, null, 2), 'utf8')
}

function loadCoordinator(): CoordinatorConfig {
  ensureDataDir()
  try {
    const raw = fs.readFileSync(COORDINATOR_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed?.llm) return parsed as CoordinatorConfig
  } catch {}
  const cfg: CoordinatorConfig = {
    llm: defaultLLM(), flags: [],
    decompositionPrompt: '', routingPrompt: '', clarificationPrompt: '', synthesisPrompt: '',
  }
  try { fs.writeFileSync(COORDINATOR_FILE, JSON.stringify(cfg, null, 2), 'utf8') } catch {}
  return cfg
}

function saveCoordinator(cfg: CoordinatorConfig) {
  ensureDataDir()
  fs.writeFileSync(COORDINATOR_FILE, JSON.stringify(cfg, null, 2), 'utf8')
}

// -- State ---------------------------------------------------------------------

let AGENTS:       TeamAgent[]       = loadAgents()
let TOOLS:        ToolConfig[]      = loadTools()
let COORDINATOR:  CoordinatorConfig = loadCoordinator()

const agentMap       = () => new Map(AGENTS.map(a => [a.name, a]))
const agentNames     = () => AGENTS.map(a => a.name).join(', ')
// Agents sorted by their pipeline order field; undefined order sorts after numbered agents
const pipelineAgents = () => [...AGENTS].sort((a, b) => {
  const oa = a.order ?? Infinity
  const ob = b.order ?? Infinity
  return oa - ob
})

// -- Coordinator prompt --------------------------------------------------------

// Full system prompt per agent in pipeline order so coordinator understands each role
function agentRoleSummaries(): string {
  return pipelineAgents().map(a =>
    `### ${a.name}${a.order !== undefined ? ` (stage ${a.order})` : ''}\n${a.systemPrompt.trim()}`
  ).join('\n\n')
}

// complete_stage is a required terminal tool for pipeline stages.
// Agents MUST call it to finish   plain text alone does not end a stage.
const COMPLETE_STAGE_FN  = 'complete_stage'
const COMPLETE_STAGE_URL = '__complete_stage__'

function buildCompleteStageTool(): unknown {
  return {
    type: 'function',
    function: {
      name: COMPLETE_STAGE_FN,
      description:
        'REQUIRED: call this tool when your stage work is complete. ' +
        'This is the only way to signal completion   a plain text response alone does not end the stage. ' +
        'Use status DONE if the work is correct and complete. ' +
        'Use status ESCALATE if a specific issue was found that requires another agent to fix it.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['DONE', 'ESCALATE'],
            description: 'DONE = work complete. ESCALATE = issue found, fix needed.',
          },
          summary: {
            type: 'string',
            description: 'Brief summary of what was accomplished or what issue was found.',
          },
          escalation_reason: {
            type: 'string',
            description: 'Required when status is ESCALATE: specific description of the issue to fix.',
          },
        },
        required: ['status', 'summary'],
      },
    },
  }
}

function buildPipelineExample(): string {
  const ordered = pipelineAgents()
  if (ordered.length === 0) return '{"mode":"pipeline","stages":[]}'
  const implementer = (ordered[1] ?? ordered[0]).name
  const stageLabels = ['Design', 'Implementation', 'Review', 'Testing']
  const stages = ordered.slice(0, 4).map((agent, i) => {
    const base: Record<string, unknown> = {
      name:        stageLabels[i] ?? `Stage ${i + 1}`,
      assignee:    agent.name,
      description: `Describe the specific task for ${agent.name} based on their role`,
    }
    if (i > 0) { base['escalateTo'] = implementer; base['maxRetries'] = 3 }
    return base
  })
  return JSON.stringify({ mode: 'pipeline', stages }, null, 4)
}

// -- Template variable substitution -------------------------------------------
// Replaces {{VAR_NAME}} tokens in coordinator prompt overrides with runtime values.
function applyTemplateVars(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (str, [key, val]) => str.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val),
    template
  )
}

// -- Default coordinator prompt text ------------------------------------------
// Exported as constants so the UI /api/coordinator/defaults endpoint can serve
// them to the browser for the Reset-to-default buttons.

function defaultDecompositionPrompt(): string {
  const names = agentNames()
  const roles = agentRoleSummaries()
  return `You are a task coordinator. You know each team member's role and assign work accordingly.

## Team
${roles}

## MODE 1: PARALLEL (independent tasks)
Use for research, analysis, or content tasks where subtasks can run simultaneously.
- Distribute tasks across agents based on their specific expertise   never assign all tasks to the same agent.
- If the goal is simple enough for one agent to handle alone, produce exactly 1 task.
- Each task description must reference the specific agent skill that makes them the right assignee.
Respond with a JSON array in a \`\`\`json code fence:
\`\`\`json
[
  {"title":"Task name","description":"What to do","assignee":"agent-name","dependsOn":[]}
]
\`\`\`

## MODE 2: PIPELINE (sequential quality-gated workflow)
Use when the task involves implementation + review + testing. Stages run one at a time.
Each stage agent must call the complete_stage tool when done   DONE moves to the next stage, ESCALATE routes to escalateTo for a fix then re-runs.
Write precise role-specific descriptions for each stage based on each agent's expertise.
Respond with a JSON object in a \`\`\`json code fence:
\`\`\`json
${buildPipelineExample()}
\`\`\`

Choose PIPELINE for: writing code, building software, design -> implement -> review -> test.
Choose PARALLEL for: independent research, analysis, content generation.
ROUTING RULE: If the Design stage output is incomplete or cut off, the coordinator must REWIND to the architect -- never ESCALATE Design issues to the engineer. The engineer cannot fix a blueprint.
Agents MUST be assigned to pipeline stages in the EXACT ORDER they appear in the Team section above   do not reorder them.
Use exactly ${Math.min(AGENTS.length, 4)} stages. Do NOT add extra stages.
Available agents: ${names}`
}

function defaultDecompositionTemplate(): string {
  return `You are a task coordinator. You know each team member's role and assign work accordingly.

## Team
{{AGENT_ROSTER}}

## MODE 1: PARALLEL (independent tasks)
Use for research, analysis, or content tasks where subtasks can run simultaneously.
- Distribute tasks across agents based on their specific expertise   never assign all tasks to the same agent.
- If the goal is simple enough for one agent to handle alone, produce exactly 1 task.
- Each task description must reference the specific agent skill that makes them the right assignee.
Respond with a JSON array in a \`\`\`json code fence:
\`\`\`json
[
  {"title":"Task name","description":"What to do","assignee":"agent-name","dependsOn":[]}
]
\`\`\`

## MODE 2: PIPELINE (sequential quality-gated workflow)
Use when the task involves implementation + review + testing. Stages run one at a time.
Each stage agent must call the complete_stage tool when done   DONE moves to the next stage, ESCALATE routes to escalateTo for a fix then re-runs.
Write precise role-specific descriptions for each stage based on each agent's expertise.
Respond with a JSON object in a \`\`\`json code fence:
\`\`\`json
{{PIPELINE_EXAMPLE}}
\`\`\`

Choose PIPELINE for: writing code, building software, design -> implement -> review -> test.
Choose PARALLEL for: independent research, analysis, content generation.
Agents MUST be assigned to pipeline stages in the EXACT ORDER they appear in the Team section above   do not reorder them.
Use exactly {{AGENT_COUNT}} stages. Do NOT add extra stages.
Available agents: {{AGENT_NAMES}}`
}

function defaultRoutingTemplate(): string {
  return `You are a pipeline coordinator making a routing decision after reviewing a completed stage.

Goal: {{GOAL}}

Team:
{{AGENT_ROSTER}}

{{REMAINING_STAGES}}
{{COMPLETED_STAGES}}
Routing options:
NEXT -- the stage work is acceptable, proceed to the next pipeline stage
ESCALATE -- a blocking defect was found; the fix agent is pre-assigned in the pipeline spec
REWIND <stage-name> -- a fix has changed code that a prior stage already approved; re-run that stage on the updated code
SYNTHESIZE -- all required work is done, skip remaining stages and generate the final answer

ESCALATE routes to the pre-assigned fix agent for this stage. You do not choose the target.
REWIND can only target stages that have already completed (listed above). Use it when a fix could invalidate a prior stage's approval.
CRITICAL: If the Design stage output is incomplete, truncated, or cut off mid-sentence, always use REWIND Design -- never ESCALATE. The engineer cannot fix an architect's blueprint.
Only ESCALATE or REWIND for concrete blocking issues. Do not use them for style or optional improvements.
CRITICAL: If an agent's ESCALATE reason states that the previous stage output is missing, empty, or contains no code or implementation, always route ESCALATE   never NEXT. A missing artifact cannot be fixed by downstream stages and must be sent back to the responsible agent.

Respond with exactly one of these on its own line:
NEXT
ESCALATE -- <one sentence describing the specific blocking defect>
REWIND <stage-name> -- <one sentence explaining why that stage must re-run>
SYNTHESIZE`
}

function defaultClarificationPrompt(): string {
  return `You are a project coordinator intake specialist. Your job is to identify what is missing before a development team can begin work.
You will receive a goal from a user who may not know what technology stack, platform, or architecture their request requires.
Analyze the goal. If it contains enough information to assign work -- stack, platform, constraints, and intent are clear -- respond with exactly:
PROCEED
If information is missing that would change how the work is structured, respond with exactly:
CLARIFY
Then list 2-4 targeted questions, numbered. Ask only what changes the architecture. Do not ask about preferences that do not affect structure.
Focus on:
- What technology stack or platform (if not implied by the goal)
- Whether this is greenfield or extending something that already exists
- Scale and deployment context (local server, cloud, embedded device, etc.)
- Key integration requirements (what external systems does it talk to)
- Authentication or multi-user needs (if a user-facing product)
Examples of good questions:
- "What database are you using, or should the team choose one?"
- "Is this a new project or are you extending an existing codebase?"
- "Does this need user accounts and login?"
- "Where will this run -- local server, cloud, or a specific device?"
Do not ask more than 4 questions. Do not explain your reasoning. Do not produce JSON. Respond ONLY with the word PROCEED, or the word CLARIFY followed by numbered questions.`
}

function coordinatorSystem(): string {
  const override = COORDINATOR.decompositionPrompt?.trim()
  if (override) {
    return applyTemplateVars(override, {
      AGENT_ROSTER:     agentRoleSummaries(),
      PIPELINE_EXAMPLE: buildPipelineExample(),
      AGENT_COUNT:      String(Math.min(AGENTS.length, 4)),
      AGENT_NAMES:      agentNames(),
    })
  }
  return defaultDecompositionPrompt()
}

// -- LLM calls -----------------------------------------------------------------

// Raw call   returns full response object so callers can inspect tool_calls
async function callLLMRaw(
  messages: AgenticMessage[] | ChatMessage[],
  llm: AgentLLM,
  maxTokens: number,
  temperature: number,
  tools?: unknown[],
): Promise<LLMResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${llm.apiKey}`,
  }
  if (llm.provider === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01'
  }
  const body: Record<string, unknown> = { model: llm.model, messages, temperature, max_tokens: maxTokens }
  if (tools && tools.length > 0) body['tools'] = tools
  const res = await fetch(`${llm.url}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`LLM error: ${res.status} ${await res.text()}`)
  const data = await res.json() as LLMResponse
  const store = usageStorage.getStore()
  if (store && data.usage) {
    store.prompt_tokens    += data.usage.prompt_tokens    ?? 0
    store.completion_tokens += data.usage.completion_tokens ?? 0
    store.total_tokens     += data.usage.total_tokens     ?? 0
  }
  return data
}

// Convenience wrapper that returns only the text content
// Returns a newline-terminated prefix from active coordinator flags, or ''
function buildFlagPrefix(): string {
  if (!COORDINATOR.flags || COORDINATOR.flags.length === 0) return ''
  return COORDINATOR.flags.join('\n') + '\n'
}

async function callLLM(
  messages: ChatMessage[],
  llm: AgentLLM,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const data = await callLLMRaw(messages, llm, maxTokens, temperature)
  return data.choices[0]?.message?.content ?? ''
}

// Coordinator uses its own persisted LLM config.
// Flags are prepended to every system message so they apply to decomposition,
// clarification, and synthesis without touching the hardcoded prompt text.
async function callCoordinatorLLM(messages: ChatMessage[], maxTokens = 2048): Promise<string> {
  const prefix = buildFlagPrefix()
  const flagged = prefix
    ? messages.map(m => m.role === 'system' ? { ...m, content: prefix + m.content } : m)
    : messages
  return callLLM(flagged, COORDINATOR.llm, maxTokens, 0)
}

// -- Tool execution ------------------------------------------------------------

// Fetch OpenAI-format tool definitions from all enabled tools assigned to an agent.
// Returns the definitions array and a map of functionName ? tool server URL (or
// the special '__qdrant__:<toolId>' sentinel for RAG tools).
async function fetchAgentTools(agent: TeamAgent): Promise<{ defs: unknown[]; urlMap: Map<string, string> }> {
  const defs: unknown[] = []
  const urlMap = new Map<string, string>()

  const assignedTools = TOOLS.filter(t => t.enabled && agent.tools.includes(t.id))

  for (const tool of assignedTools) {
    if (tool.type === 'openai_tools') {
      const url = tool.config['url']
      if (!url) continue
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
        if (!res.ok) { console.warn(`[tools] ${tool.id}: GET ${url} returned ${res.status}`); continue }
        const toolDefs = await res.json() as unknown[]
        for (const def of toolDefs) {
          const name = (def as { function?: { name?: string } }).function?.name
          if (name) {
            defs.push(def)
            urlMap.set(name, url)
          }
        }
      } catch (err) {
        console.warn(`[tools] Failed to fetch defs from ${tool.id} (${url}): ${err}`)
      }
    } else if (tool.type === 'qdrant_rag') {
      // Generate a search function definition for this RAG tool
      const collection = agent.toolCollections?.[tool.id]
      const funcName = `search_${tool.id.replace(/-/g, '_')}`
      defs.push({
        type: 'function',
        function: {
          name: funcName,
          description: `Search the ${tool.name} knowledge base for relevant information.${collection ? ` Default collection: ${collection}.` : ' Specify a collection name.'}`,
          parameters: {
            type: 'object',
            properties: {
              query:      { type: 'string', description: 'Search query text' },
              collection: { type: 'string', description: `Collection to search${collection ? ` (default: ${collection})` : ''}` },
              limit:      { type: 'number', description: 'Max results to return (default 5)' },
            },
            required: ['query'],
          },
        },
      })
      urlMap.set(funcName, `__qdrant__:${tool.id}`)
    }
  }

  // Always inject workbench tools -- available to every pipeline agent
  defs.push(...buildWorkbenchTools())
  urlMap.set('workbench_list',  WORKBENCH_SENTINEL)
  urlMap.set('workbench_read',  WORKBENCH_SENTINEL)
  urlMap.set('workbench_write', WORKBENCH_SENTINEL)
  urlMap.set('list_runtimes',   WORKBENCH_SENTINEL)
  return { defs, urlMap }
}

// Execute a single tool call and return its result as a string
async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  urlMap: Map<string, string>,
  agentName?: string,
  specAssignee?: string,
): Promise<string> {
  const url = urlMap.get(name)
  if (!url) return JSON.stringify({ error: `No tool registered for function: ${name}` })

  // Workbench sentinel
  if (url === WORKBENCH_SENTINEL) {
    if (name === 'workbench_list') {
      const slots = wbList()
      return slots.length ? JSON.stringify(slots) : JSON.stringify(['(workbench is empty)'])
    }
    if (name === 'workbench_read') {
      const slot = String(args['slot'] ?? '')
      const content = wbGet(slot)
      if (content === null) {
        return JSON.stringify({ error: `No artifact at slot "${slot}". Call workbench_list to see available slots.` })
      }
      return content
    }
      if (name === 'workbench_write') {
        const slot    = String(args['slot'] ?? '')
        let content = String(args['content'] ?? '')
        
        if (!slot) return JSON.stringify({ error: 'slot is required' })
        
        // Strip markdown code block delimiters if present
        content = stripCodeBlockDelimiters(content)
        
        // ===== ADDED: Validate 'runtimes' slot =====
        if (slot === 'runtimes') {
          content = content.trim().toLowerCase()
          // Accept bare language name OR versioned string e.g. python-3.9.4, rust-1.70.0
          const validPattern = /^(python|rust|java|node|javascript|typescript|go|csharp|php|ruby|swift|kotlin)(-\d+\.\d+(\.\d+)?)?$/
          if (!validPattern.test(content)) {
            return JSON.stringify({
              error: `Invalid runtime '${content}'. Must be a language name or versioned string like 'python-3.9.4', 'rust-1.70.0', 'java-15.0.2'. Call list_runtimes and copy the exact language string plus version.`,
            })
          }
          wbSet(slot, content)
          return JSON.stringify({ ok: true, slot, bytes: content.length })
        }
        // ===== END ADDED =====
        
        // Only enforce code validation for slots that should contain code
        const codeSlots = ['implementation', 'blueprint']
        const isCodeSlot = codeSlots.includes(slot)
        
        // ENFORCEMENT 1: Content must look like source code for code slots only
        if (isCodeSlot && !looksLikeCode(content)) {
          const errorMsg = `BLOCKED: workbench_write('${slot}') rejected. Content does not appear to be valid source code. It contains natural language explanations. Write ONLY the raw source code.`
          console.log(`[workbench] ${agentName || specAssignee} blocked: content is not code for slot ${slot}`)
          return JSON.stringify({ error: errorMsg })
        }
        
        // ENFORCEMENT 2: For test engineer, check duplicate main and struct redefinition (only for code slots)
        if (specAssignee === 'test-engineer' && isCodeSlot) {
          const existingImpl = wbGet('implementation')
          if (detectDuplicateMain(content)) {
            const errorMsg = `BLOCKED: workbench_write('${slot}') rejected. Detected multiple 'fn main()' definitions. Write ONLY test code using #[cfg(test)] mod tests, not a main function.`
            console.log(`[workbench] test-engineer blocked: duplicate main`)
            return JSON.stringify({ error: errorMsg })
          }
          if (existingImpl && detectStructRedefinition(content, existingImpl)) {
            const errorMsg = `BLOCKED: workbench_write('${slot}') rejected. Test code redefines structs/types that are already defined in the implementation. Write ONLY test assertions, not implementation code.`
            console.log(`[workbench] test-engineer blocked: struct redefinition`)
            return JSON.stringify({ error: errorMsg })
          }
        }
        
        // ENFORCEMENT 3: Read-only slot enforcement (applies to all slots)
        const agent = agentName ? agentMap().get(agentName) : null
        const readOnlySlots = agent?.readOnlySlots ?? []
        if (readOnlySlots.includes(slot)) {
          const errorMsg = `BLOCKED: workbench_write('${slot}') rejected. This agent is only allowed to READ from '${slot}', not write to it.`
          console.log(`[workbench] ${agentName} blocked: read-only slot ${slot}`)
          return JSON.stringify({ error: errorMsg })
        }
        
        wbSet(slot, content)
        return JSON.stringify({ ok: true, slot, bytes: content.length })
      }
    if (name === 'list_runtimes') {
      // Cache-first: return workbench slot if already populated
      const cached = wbGet('runtimes')
      if (cached) return cached
      // Cache miss: fetch from Piston, store in workbench, return
      try {
        const res = await fetch('https://emkc.org/api/v2/piston/runtimes', { signal: AbortSignal.timeout(8000) })
        if (res.ok) {
          const data = await res.json() as unknown[]
          // ENFORCEMENT: Filter to only the language needed? No, let architect decide.
          const jsonStr = JSON.stringify(data)
          wbSet('runtimes', jsonStr)
          return jsonStr
        }
      } catch {}
      return JSON.stringify({ error: 'Failed to fetch runtimes from Piston' })
    }
    return JSON.stringify({ error: `Unknown workbench operation: ${name}` })
  }
  // RAG search sentinel
  if (url.startsWith('__qdrant__:')) {
    const toolId = url.slice('__qdrant__:'.length)
    const tool   = TOOLS.find(t => t.id === toolId)
    if (!tool) return JSON.stringify({ error: `Qdrant tool not found: ${toolId}` })
    return executeRagSearch(tool, args as { query: string; collection?: string; limit?: number })
  }

  // OpenAI-tools HTTP server
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arguments: args }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) return JSON.stringify({ error: `Tool server ${res.status}: ${await res.text()}` })
    const data = await res.json() as { result?: unknown }
    return JSON.stringify(data.result ?? data)
  } catch (err) {
    return JSON.stringify({ error: String(err) })
  }
}

// Embed query ? search Qdrant ? return formatted hits
async function executeRagSearch(
  tool: ToolConfig,
  args: { query: string; collection?: string; limit?: number },
): Promise<string> {
  const qdrantUrl      = tool.config['url']
  const embeddingUrl   = tool.config['embeddingUrl']
  const collection     = args.collection ?? ''
  const limit          = args.limit ?? 5

  if (!qdrantUrl || !embeddingUrl) {
    return JSON.stringify({ error: `RAG tool '${tool.id}' missing url or embeddingUrl in config` })
  }
  if (!collection) {
    return JSON.stringify({ error: `No collection specified for RAG tool '${tool.id}'. Set a default in the agent's tool assignment or pass collection in the call.` })
  }

  try {
    // 1. Embed the query using the TEI-compatible endpoint
    const embedRes = await fetch(`${embeddingUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: args.query }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!embedRes.ok) return JSON.stringify({ error: `Embedding error: ${embedRes.status}` })
    const embedData = await embedRes.json() as { data: { embedding: number[] }[] }
    const vector = embedData.data[0]?.embedding
    if (!vector) return JSON.stringify({ error: 'Embedding service returned no vector' })

    // 2. Search Qdrant
    const searchRes = await fetch(`${qdrantUrl}/collections/${encodeURIComponent(collection)}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vector, limit, with_payload: true }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!searchRes.ok) return JSON.stringify({ error: `Qdrant error: ${searchRes.status}` })
    const searchData = await searchRes.json() as { result: { id: string | number; score: number; payload: Record<string, unknown> }[] }

    const results = searchData.result.map(r => ({
      score:   Math.round(r.score * 1000) / 1000,
      content: r.payload?.['text'] ?? r.payload?.['content'] ?? JSON.stringify(r.payload),
      source:  r.payload?.['source'] ?? String(r.id),
    }))

    return JSON.stringify({ query: args.query, collection, results })
  } catch (err) {
    return JSON.stringify({ error: String(err) })
  }
}

// -- Tool log ------------------------------------------------------------------

interface ToolLogEntry {
  id:        string
  ts:        number          // unix ms
  agent:     string
  tool:      string
  args:      Record<string, unknown>
  result:    string
  ok:        boolean         // false if result contains an error key
  durationMs: number
}

const toolLog: ToolLogEntry[] = []

function appendToolLog(entry: Omit<ToolLogEntry, 'id'>): void {
  toolLog.unshift({ id: uuidv4(), ...entry })
  // No cap   full history kept in memory for the session
}

// -- Agent execution -----------------------------------------------------------

const MAX_TOOL_ROUNDS  = 10   // prevent infinite loops on misbehaving models

// Pipeline handoff directives -- defined here so runAgent can reference them
// when injecting per-round completion reminders into the message stream
const HANDOFF_DONE     = 'HANDOFF: DONE'
const HANDOFF_ESCALATE = 'HANDOFF: ESCALATE'
const HANDOFF_FOOTER   =
  `\n\n---\nAt the end of your response add exactly one of:\n` +
  `${HANDOFF_DONE}\n` +
  `${HANDOFF_ESCALATE}   <specific defect that blocks the next stage>. Fix needed: <what must change>. May affect: <list any prior stage names whose approvals the fix could invalidate, or "none">`

// Monotonically-increasing request generation. Each new /v1/chat/completions
// request bumps this. runAgent checks it each round and aborts if stale so
// agents from superseded requests don't keep running in the background.
let currentGeneration = 0

async function runAgent(spec: TaskSpec, generation: number): Promise<AgentResult> {
  const agent        = agentMap().get(spec.assignee)
  const systemPrompt = buildFlagPrefix() + (agent?.systemPrompt ?? `You are a ${spec.assignee} specialist.`)
  const llm          = agent?.llm ?? defaultLLM()
  const temperature  = agent?.temperature ?? 0
  const maxTokens    = agent?.maxTokens ?? 4096

  // Pipeline stages include HANDOFF_FOOTER in their task description.
  // For these stages inject the complete_stage tool as a required termination signal.
  const isPipelineStage = spec.description.includes(HANDOFF_DONE)

  try {
    const { defs: externalDefs, urlMap: externalUrlMap } = agent
      ? await fetchAgentTools(agent)
      : { defs: [], urlMap: new Map<string, string>() }

    const toolDefs = isPipelineStage
      ? [...externalDefs, buildCompleteStageTool()]
      : externalDefs
    const urlMap = new Map(externalUrlMap)
    if (isPipelineStage) urlMap.set(COMPLETE_STAGE_FN, COMPLETE_STAGE_URL)

    const messages: AgenticMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: spec.description },
    ]

    let pipelineCompletion: StageCompletion | null = null

    // Hard-cap tool calls for tester/reviewer agents
    const MAX_TESTER_RUNS = 1
    const MAX_REVIEWER_RUNS = 2
    let runCodeCallCount = 0
    // Track last run_code result so we can override a lying DONE from test-engineer
    let lastRunCodeExitCode: number | null = null
    let lastRunCodeStderr:   string        = ''

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (generation !== currentGeneration) {
        console.log(`[abort] ${spec.assignee}:${spec.title} superseded`)
        return { assignee: spec.assignee, title: spec.title, output: '(aborted)', success: false }
      }

      // Always pass toolDefs   we block individual calls below instead
      const response = await callLLMRaw(messages, llm, maxTokens, temperature, toolDefs.length ? toolDefs : undefined)
      const choice   = response.choices[0]
      if (!choice) break

      const { content, tool_calls } = choice.message

      // No tool calls   plain text response
      if (!tool_calls || tool_calls.length === 0) {
        return {
          assignee:   spec.assignee,
          title:      spec.title,
          output:     content ?? '',
          success:    true,
          completion: pipelineCompletion ?? undefined,
          _messages:  messages,
        }
      }

      messages.push({ role: 'assistant', content, tool_calls })

      const toolResults = await Promise.all(
        tool_calls.map(async tc => {
          let parsedArgs: Record<string, unknown> = {}
          try { parsedArgs = JSON.parse(tc.function.arguments || '{}') } catch {}
          const t0 = Date.now()

          // Block run_code when agent exceeds its limit   return error as tool result
          if (tc.function.name === 'run_code') {
            runCodeCallCount++
            const atLimit = (spec.assignee === 'test-engineer' && runCodeCallCount > MAX_TESTER_RUNS)
                         || (spec.assignee === 'adversarial-reviewer' && runCodeCallCount > MAX_REVIEWER_RUNS)
                         || (spec.assignee === 'senior-engineer' && runCodeCallCount > 3)
            if (atLimit) {
              const msg = spec.assignee === 'test-engineer'
                ? 'LIMIT REACHED: You have used your ONE allowed run_code call. Report results now and call complete_stage.'
                : spec.assignee === 'adversarial-reviewer'
                  ? 'LIMIT REACHED: You have used your 2 allowed run_code calls. Report findings now and call complete_stage.'
                  : 'LIMIT REACHED: You have used your 3 allowed run_code calls. Include your best attempt and call complete_stage DONE.'
              return { role: 'tool' as const, tool_call_id: tc.id, content: JSON.stringify({ error: msg }) }
            }
          }

          // ===== UNIVERSAL RUNTIME FIX: Auto-inject language for ALL agents =====
          if (tc.function.name === 'run_code') {
            const storedRuntimeRaw = wbGet('runtimes')
            if (storedRuntimeRaw) {
              let storedRuntime: { language: string; version: string } | null = null
              try {
                storedRuntime = JSON.parse(storedRuntimeRaw) as { language: string; version: string }
              } catch {
                const m = storedRuntimeRaw.match(/^([a-z]+)-(\d+\.\d+(?:\.\d+)?)$/)
                if (m) storedRuntime = { language: m[1]!, version: m[2]! }
              }
              if (storedRuntime) {
                // Inject correct language for ALL agents
                // Strip version — Piston uses default installed version, versioned requests often fail
                parsedArgs['language'] = storedRuntime.language
                delete parsedArgs['version']
                console.log(`[run_code] auto-injected language=${storedRuntime.language} (version stripped) for ${spec.assignee}`)
              }
            }
          }
          // ===== END UNIVERSAL RUNTIME FIX =====

          // Inject implementation from workbench into run_code for agents with injectCodeFromSlot.
          // This forces the test stage to always execute against the authoritative implementation,
          // regardless of what code the agent wrote. Agent should provide only test/main code.
          if (tc.function.name === 'run_code' && agent?.injectCodeFromSlot) {
            const slotCode = wbGet(agent.injectCodeFromSlot)
            if (slotCode) {
              parsedArgs['code'] = slotCode + '\n\n' + (String(parsedArgs['code'] ?? ''))
              console.log(`[run_code] prepended ${agent.injectCodeFromSlot} slot (${slotCode.length}b) for ${spec.assignee}`)
            } else {
              const msg = `ERROR: Cannot run test code because implementation slot '${agent.injectCodeFromSlot}' is empty. The implementation must be written to workbench before testing.`
              return { role: 'tool' as const, tool_call_id: tc.id, content: JSON.stringify({ error: msg, exit_code: 1 }) }
            }
          }

          // complete_stage is the pipeline termination tool   handle it inline
          if (tc.function.name === COMPLETE_STAGE_FN) {
            // Enforce required output slots before accepting complete_stage.
            // If any declared slot is missing, block and tell the agent exactly what to write.
            const requiredSlots = agent?.requiredOutputSlots ?? []
            const missingSlots  = requiredSlots.filter(slot => !wbGet(slot))
            if (missingSlots.length > 0) {
              const msg = `BLOCKED: complete_stage rejected. You must call workbench_write for the following slots before completing: ${missingSlots.join(', ')}. Write them now, then call complete_stage again.`
              console.log(`[complete_stage] ${spec.assignee} blocked -- missing slots: ${missingSlots.join(', ')}`)
              appendToolLog({
                ts: Date.now(), agent: spec.assignee, tool: COMPLETE_STAGE_FN,
                args: parsedArgs, result: JSON.stringify({ blocked: true, missingSlots }), ok: false, durationMs: 0,
              })
              return { role: 'tool' as const, tool_call_id: tc.id, content: JSON.stringify({ error: msg }) }
            }

            let completionStatus: 'DONE' | 'ESCALATE' =
              (parsedArgs['status'] as string === 'ESCALATE') ? 'ESCALATE' : 'DONE'
            let escalationReason = parsedArgs['escalation_reason'] as string | undefined

            // Safety net: if test-engineer claims DONE but last run_code failed, force ESCALATE.
            if (completionStatus === 'DONE'
              && spec.assignee === 'test-engineer'
              && lastRunCodeExitCode !== null
              && lastRunCodeExitCode !== 0) {
              completionStatus = 'ESCALATE'
              escalationReason = `run_code exited with code ${lastRunCodeExitCode}. Stderr: ${lastRunCodeStderr.slice(0, 400)}`
              console.log(`[complete_stage] test-engineer DONE overridden to ESCALATE (exit_code=${lastRunCodeExitCode})`)
            }

            // Fabrication guard: catch test reports written without calling run_code
            if (completionStatus === 'DONE' && spec.assignee === 'test-engineer') {
              if (lastRunCodeExitCode === null) {
                completionStatus = 'ESCALATE'
                escalationReason = 'Test report written without calling run_code. You MUST call run_code first and report actual Piston output. Do not write expected or fabricated values.'
                console.log('[complete_stage] test-engineer DONE overridden to ESCALATE (run_code never called)')
              } else {
                const testReport  = wbGet('test_report') || ''
                const reportLower = testReport.toLowerCase()
                const fakePhrases = ['expected:', 'should return', 'would return', 'if run', 'the test would', 'should be', 'would be']
                if (fakePhrases.some(p => reportLower.includes(p))) {
                  completionStatus = 'ESCALATE'
                  escalationReason = 'Test report contains fabricated expected values instead of actual run_code output. Report only what Piston actually printed.'
                  console.log('[complete_stage] test-engineer DONE overridden to ESCALATE (fabrication phrases detected)')
                }
              }
            }

            pipelineCompletion = {
              status:             completionStatus,
              summary:            String(parsedArgs['summary'] ?? ''),
              escalation_reason:  escalationReason,
            }
            console.log(`[complete_stage] ${spec.assignee}: ${pipelineCompletion.status}   ${pipelineCompletion.summary}`)
            appendToolLog({
              ts: Date.now(), agent: spec.assignee, tool: COMPLETE_STAGE_FN,
              args: parsedArgs, result: JSON.stringify(pipelineCompletion), ok: true, durationMs: 0,
            })
            return { role: 'tool' as const, tool_call_id: tc.id, content: '{"acknowledged":true}' }
          }

          const result    = await executeToolCall(tc.function.name, parsedArgs, urlMap, agent?.name, spec.assignee)
          const durationMs = Date.now() - t0
          // Capture run_code outcome for downstream DONE validation
          if (tc.function.name === 'run_code') {
            try {
              const parsed = JSON.parse(result) as { exit_code?: number; stderr?: string; status?: string }
              lastRunCodeExitCode = typeof parsed.exit_code === 'number' ? parsed.exit_code : (parsed.status === 'ERROR' ? 1 : 0)
              lastRunCodeStderr   = parsed.stderr ?? ''
            } catch { lastRunCodeExitCode = 0 }
          }
          let isError = false
          try { isError = !!JSON.parse(result)?.error } catch {}
          appendToolLog({
            ts: Date.now(), agent: spec.assignee, tool: tc.function.name,
            args: parsedArgs, result, ok: !isError, durationMs,
          })
          console.log(`[tool] ${spec.assignee} called ${tc.function.name} (${durationMs}ms)`)
          return { role: 'tool' as const, tool_call_id: tc.id, content: result }
        }),
      )
      messages.push(...toolResults)

      // If complete_stage was called this round, return immediately  
      // no further tool calls allowed after stage completion
      if (pipelineCompletion) {
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
        let output = lastAssistant?.content ?? ''

        // When the Implementation stage completes with DONE, ensure its code
        // is visible in the output so downstream stages can review/test it.
        // If the response text doesn't contain a code block, extract the code
        // from the run_code tool calls and inject it.
        if ((pipelineCompletion as StageCompletion).status === 'DONE' &&
            (spec.title === 'Implementation' || spec.assignee === 'senior-engineer')) {
          const existingCode = extractCodeBlock(output)
          if (!existingCode) {
            const codeFromTools = extractCodeFromToolCalls(messages)
            if (codeFromTools) {
              output = output + `\n\n## Implementation Code\n\n\`\`\`\n${codeFromTools}\n\`\`\``
            }
          }
        }

        return {
          assignee:   spec.assignee,
          title:      spec.title,
          output,
          success:    true,
          completion: pipelineCompletion,
          _messages:  messages,
        }
      }
      // After round 2, inject a per-round completion reminder
      if (round >= 2) {
        const reminder = isPipelineStage
          ? `[Round ${round + 1}] Call complete_stage now if your work is done. ` +
            `Use status DONE if complete. Use ESCALATE if a specific defect blocks the next stage   ` +
            `include what needs fixing and which prior stages the fix might affect. ` +
            `If one specific issue remains unresolved, make one more focused tool call then call complete_stage.`
          : `[Round ${round + 1}] If your task is complete, write your final response now. ` +
            `If one specific issue remains, make one more focused tool call.`
        messages.push({ role: 'user', content: reminder })
      }
    }

    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
    return {
      assignee:   spec.assignee,
      title:      spec.title,
      output:     lastAssistant?.content ?? '',
      success:    true,
      completion: pipelineCompletion ?? undefined,
      _messages:  messages,
    }

  } catch (err) {
    return {
      assignee: spec.assignee, title: spec.title,
      output:   `Error: ${err instanceof Error ? err.message : String(err)}`,
      success:  false,
      _messages: [],
    }
  }
}

// -- Dependency-aware execution engine -----------------------------------------

interface ExecCallbacks {
  onWaiting:  (spec: TaskSpec, waitingFor: string[]) => void
  onStart:    (spec: TaskSpec) => void
  onComplete: (result: AgentResult) => void
}

async function executeWithDeps(
  specs: TaskSpec[],
  callbacks: ExecCallbacks,
  generation: number,
): Promise<AgentResult[]> {
  const specMap = new Map<string, TaskSpec>(specs.map(s => [s.title, s]))

  // Strip unknown deps and warn -- unknown dep titles are coordinator hallucinations
  for (const spec of specs) {
    const unknown = spec.dependsOn.filter(d => !specMap.has(d))
    if (unknown.length > 0) {
      console.warn(`[deps] "${spec.title}" has unknown dependencies ${JSON.stringify(unknown)} -- dropping them`)
      spec.dependsOn = spec.dependsOn.filter(d => specMap.has(d))
    }
  }

  // Cycle detection via DFS -- throws if a cycle is found
  function detectCycles() {
    const WHITE = 0, GRAY = 1, BLACK = 2
    const color = new Map<string, number>(specs.map(s => [s.title, WHITE]))
    function visit(title: string, stack: string[]) {
      color.set(title, GRAY)
      for (const dep of specMap.get(title)!.dependsOn) {
        if (color.get(dep) === GRAY) {
          throw new Error(`Dependency cycle detected: ${[...stack, title, dep].join(' -> ')}`)
        }
        if (color.get(dep) === WHITE) visit(dep, [...stack, title])
      }
      color.set(title, BLACK)
    }
    for (const spec of specs) {
      if (color.get(spec.title) === WHITE) visit(spec.title, [])
    }
  }
  detectCycles()

  // Memoised promise per task title -- each task awaits its deps then runs
  const resultPromises = new Map<string, Promise<AgentResult>>()
  function getOrCreate(title: string): Promise<AgentResult> {
    if (resultPromises.has(title)) return resultPromises.get(title)!
    const spec = specMap.get(title)!
    const p: Promise<AgentResult> = (async () => {
      // Abort immediately if already superseded before we even start
      if (generation !== currentGeneration) {
        return { assignee: spec.assignee, title: spec.title, output: '(aborted   superseded)', success: false }
      }
      // Signal waiting state before blocking
      if (spec.dependsOn.length > 0) {
        callbacks.onWaiting(spec, spec.dependsOn)
      }
      // Block until all deps resolve (in parallel among themselves)
      const depResults = await Promise.all(spec.dependsOn.map(dep => getOrCreate(dep)))
      // Inject successful dep outputs into this task's description
      const successfulDeps = depResults.filter(r => r.success)
      let enrichedDescription = spec.description
      if (successfulDeps.length > 0) {
        const depContext = successfulDeps
          .map(r => `### ${r.title} (${r.assignee})\n${stripCodeBlocks(r.output)}`)
          .join('\n\n')
        enrichedDescription =
          `${spec.description}\n\n---\n## Context from prior tasks\n\n${depContext}`
      }
      callbacks.onStart(spec)
      const result = await runAgent({ ...spec, description: enrichedDescription }, generation)
      callbacks.onComplete(result)
      return result
    })()
    resultPromises.set(title, p)
    return p
  }

  // Kick off everything -- tasks with no deps start immediately, others wait
  const settled = await Promise.allSettled(specs.map(s => getOrCreate(s.title)))
  return settled
    .filter((r): r is PromiseFulfilledResult<AgentResult> => r.status === 'fulfilled')
    .map(r => r.value)
}

// -- Root task goal injection ---------------------------------------------------
// Tasks with no dependsOn receive no context from prior agents. Inject the full
// goal (which contains all user data) so root agents are not working blind.

function injectGoalIntoRootTasks(specs: TaskSpec[], fullGoal: string): void {
  for (const spec of specs) {
    if (spec.dependsOn.length === 0) {
      spec.description = `## Goal and data\n\n${fullGoal}\n\n## Your task\n\n${spec.description}`
    }
  }
}

// -- Code block extraction -----------------------------------------------------
// Extracts the content of the first code block from a stage output to ensure
// the Reviewer and Tester receive the authoritative implementation code.

function extractCodeBlock(output: string): string | null {
  // Match code blocks with optional language specifier
  const match = output.match(/```[\w]*\n([\s\S]*?)```/)
  if (match) return match[1]!.trim()
  // Try without newline after language tag
  const match2 = output.match(/```[\w]*([\s\S]*?)```/)
  if (match2) return match2[1]!.trim()
  return null
}

function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '[code block omitted]')
}

function extractCodeFromToolCalls(messages: AgenticMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.function?.name === 'run_code') {
          try {
            const args = JSON.parse(tc.function.arguments || '{}')
            if (args.code) return args.code
          } catch {}
        }
      }
    }
  }
  return null
}

// -- Pipeline routing ----------------------------------------------------------
// After each stage the coordinator reviews the output and makes an active
// routing decision. Agents provide information; the coordinator decides action.
//
// AUTO-ESCALATE RULE: When an agent signals ESCALATE via complete_stage, the
// route is determined immediately   no LLM call. The coordinator LLM is
// unreliable at distinguishing valid from invalid ESCALATEs and consistently
// routes NEXT past legitimate findings. The reviewer and tester agents have
// explicit instructions to only ESCALATE for concrete blocking issues.
// Trusting their signal directly is safer than second-guessing with a small
// coordinator model.

interface CoordinatorDecision {
  action:       'NEXT' | 'ESCALATE' | 'SYNTHESIZE' | 'REWIND'
  targetAgent?: string   // set when action === 'ESCALATE'
  rewindTo?:    string   // set when action === 'REWIND'   stage name to return to
  reason:       string
}

function coordinatorRouteSystem(
  goal:            string,
  remainingStages: string[],
  completedStages: string[],
): string {
  const roles = pipelineAgents().map(a =>
    `### ${a.name}${a.order !== undefined ? ` (stage ${a.order})` : ''}\n${a.systemPrompt.trim()}`
  ).join('\n\n')

  const remaining = remainingStages.length > 0
    ? `Remaining pipeline stages: ${remainingStages.join(' ? ')}`
    : `No remaining stages   all pipeline work is complete.`

  const rewindTargets = completedStages.length > 0
    ? `Completed stages available for REWIND: ${completedStages.join(', ')}`
    : ''

  const override = COORDINATOR.routingPrompt?.trim()
  if (override) {
    return applyTemplateVars(override, {
      AGENT_ROSTER:      roles,
      GOAL:              goal,
      REMAINING_STAGES:  remaining,
      COMPLETED_STAGES:  rewindTargets,
    })
  }

  return `You are a pipeline coordinator making a routing decision after reviewing a completed stage.

Goal: ${goal}

Team:
${roles}

${remaining}
${rewindTargets ? rewindTargets + '\n' : ''}
Routing options:
NEXT -- the stage work is acceptable, proceed to the next pipeline stage
ESCALATE -- a blocking defect was found; the fix agent is pre-assigned in the pipeline spec
REWIND <stage-name> -- a fix has changed code that a prior stage already approved; re-run that stage on the updated code
SYNTHESIZE -- all required work is done, skip remaining stages and generate the final answer

ESCALATE routes to the pre-assigned fix agent for this stage. You do not choose the target.
REWIND can only target stages that have already completed (listed above). Use it when a fix could invalidate a prior stage's approval.
Only ESCALATE or REWIND for concrete blocking issues. Do not use them for style or optional improvements.
CRITICAL: If an agent's ESCALATE reason states that the previous stage output is missing, empty, or contains no code or implementation, always route ESCALATE   never NEXT. A missing artifact cannot be fixed by downstream stages and must be sent back to the responsible agent.

Respond with exactly one of these on its own line:
NEXT
ESCALATE -- <one sentence describing the specific blocking defect>
REWIND <stage-name> -- <one sentence explaining why that stage must re-run>
SYNTHESIZE`
}

async function coordinatorRoute(
  goal:            string,
  currentStage:    PipelineStage,
  stageOutput:     string,
  completion:      StageCompletion,
  history:         { name: string; assignee: string; summary: string }[],
  remainingStages: string[],
): Promise<CoordinatorDecision> {
  const t0 = Date.now()
  const historyStr = history.length > 0
    ? history.map(h => `- ${h.name} (${h.assignee}): ${h.summary}`).join('\n')
    : '(no prior stages)'

  const agentSignal = completion.status === 'ESCALATE'
    ? `ESCALATE   ${completion.escalation_reason ?? completion.summary}`
    : `DONE   ${completion.summary}`

  const completedStages = history.map(h => h.name)

  // -- AUTO-ESCALATE: trust the agent's ESCALATE signal directly.
  // The coordinator LLM is unreliable at distinguishing valid from invalid
  // ESCALATEs and consistently routes NEXT past legitimate findings.
  // The reviewer and tester agents have explicit instructions to only
  // ESCALATE for concrete blocking issues   trusting them is safer than
  // asking a small coordinator model to second-guess specialist output.
  //
  // We resolve the fix target from multiple fallback sources to guarantee
  // an ESCALATE always finds a target:
  //   1. currentStage.escalateTo (set by pipeline spec)
  //   2. The order:2 agent (conventionally the implementer/engineer)
  //   3. AGENTS[1] (second agent in the roster)
  //   4. Hardcoded fallback 'senior-engineer'
  if (completion.status === 'ESCALATE') {
    const escalateTarget = currentStage.escalateTo
      ?? (AGENTS.find(a => a.order === 2) ?? AGENTS[1])?.name
      ?? 'senior-engineer'
    const reason = completion.escalation_reason ?? completion.summary ?? 'issue requires fix'
    const durationMs = Date.now() - t0
    appendToolLog({
      ts: Date.now(), agent: 'coordinator', tool: 'route',
      args: {
        stage: currentStage.name,
        assignee: currentStage.assignee,
        agentSignal: completion.status,
        summary: completion.summary.slice(0, 150),
      },
      result: JSON.stringify({
        action: 'ESCALATE',
        targetAgent: escalateTarget,
        reason,
        override: false,
        note: 'auto-escalate: agent signal trusted, LLM routing skipped'
      }),
      ok: true, durationMs,
    })
    return { action: 'ESCALATE', targetAgent: escalateTarget, reason }
  }

  // Only reach LLM routing for DONE signals   these require judgment
  // about NEXT vs REWIND vs SYNTHESIZE
  const raw = await callCoordinatorLLM([
    { role: 'system', content: coordinatorRouteSystem(goal, remainingStages, completedStages) },
    { role: 'user',   content:
        `## Prior stages\n${historyStr}\n\n` +
        `## Completed stage: ${currentStage.name} (${currentStage.assignee})\n\n` +
        `Agent signal: ${agentSignal}\n\n` +
        `Stage output (first 2000 chars):\n${stageOutput.slice(0, 2000)}${stageOutput.length > 2000 ? '\n...' : ''}\n\n` +
        `What is your routing decision?`
    },
  ], 256)
  const durationMs = Date.now() - t0

  const cleaned   = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  const firstLine = cleaned.split('\n')[0]?.trim() ?? ''
  const upper     = firstLine.toUpperCase()

  const logRoute = (decision: CoordinatorDecision) => {
    const override = completion.status === 'ESCALATE' && decision.action === 'NEXT'
    appendToolLog({
      ts: Date.now(), agent: 'coordinator', tool: 'route',
      args: {
        stage:       currentStage.name,
        assignee:    currentStage.assignee,
        agentSignal: completion.status,
        summary:     completion.summary.slice(0, 150),
      },
      result: JSON.stringify({
        action:    decision.action,
        reason:    decision.reason,
        override,
        ...(override ? { note: `agent signalled ${completion.status} but coordinator routed ${decision.action}` } : {}),
        ...(decision.targetAgent ? { targetAgent: decision.targetAgent } : {}),
        ...(decision.rewindTo    ? { rewindTo:    decision.rewindTo    } : {}),
      }),
      ok: true, durationMs,
    })
    return decision
  }

  if (upper.startsWith('SYNTHESIZE')) {
    return logRoute({ action: 'SYNTHESIZE', reason: 'coordinator: work complete' })
  }

  if (upper.startsWith('ESCALATE')) {
    const match  = firstLine.match(/ESCALATE\s*--\s*(.+)/i)
    const reason = match?.[1]?.trim() ?? completion.escalation_reason ?? 'issue requires fix'
    if (currentStage.escalateTo) {
      return logRoute({ action: 'ESCALATE', targetAgent: currentStage.escalateTo, reason })
    }
  }

  if (upper.startsWith('REWIND')) {
    const match     = firstLine.match(/REWIND\s+([^\s\- ]+(?:\s+[^\s\- ]+)*?)\s*(?:--| )\s*(.+)/i)
    const stageName = match?.[1]?.trim()
    const reason    = match?.[2]?.trim() ?? 'prior stage must re-verify updated code'
    if (stageName && completedStages.includes(stageName)) {
      return logRoute({ action: 'REWIND', rewindTo: stageName, reason })
    }
    const partial = completedStages.find(s => s.toLowerCase().includes((stageName ?? '').toLowerCase()))
    if (partial) {
      return logRoute({ action: 'REWIND', rewindTo: partial, reason })
    }
  }

  return logRoute({ action: 'NEXT', reason: 'proceeding to next stage' })
}

// -- Pipeline execution --------------------------------------------------------

function parseHandoff(output: string): { status: 'done' | 'escalate'; reason: string } {
  const upper = output.toUpperCase()
  if (upper.includes('HANDOFF: ESCALATE')) {
    const match = output.match(/HANDOFF:\s*ESCALATE\s*[ -]\s*(.+)/i)
    return { status: 'escalate', reason: match?.[1]?.trim() ?? 'unspecified issue' }
  }
  // Also treat CRITICAL findings as implicit escalation
  if (upper.includes('\n## CRITICAL') || upper.includes('\n**CRITICAL**')) {
    return { status: 'escalate', reason: 'CRITICAL findings detected' }
  }
  return { status: 'done', reason: '' }
}

interface PipelineCallbacks {
  onStageStart:       (stage: PipelineStage, attempt: number) => void
  onStageDone:        (stage: PipelineStage, result: AgentResult, status: 'done' | 'escalate') => void
  onFixStart:         (stage: PipelineStage, fixAgent: string, reason: string) => void
  onFixDone:          (fixAgent: string, result: AgentResult) => void
  onMaxRetries:       (stage: PipelineStage) => void
  onCoordinatorRoute: (decision: CoordinatorDecision) => void
  onRewind:           (fromStage: string, toStage: string, reason: string) => void
}

const MAX_REWINDS_PER_STAGE = 2   // prevent infinite rewind loops

async function executePipeline(
  stages:     PipelineStage[],
  fullGoal:   string,
  generation: number,
  callbacks:  PipelineCallbacks,
): Promise<{ results: AgentResult[]; synthesizeEarly: boolean; wbSnapshot: Record<string, string> }> {
  const pipelineId    = uuidv4()
  const allResults:   AgentResult[]                                     = []
  const history:      { name: string; assignee: string; summary: string }[] = []
  const rewindCounts: Record<string, number>                            = {}
  let previousOutput = ''
  let implementationCode: string | null = null
  let stageIdx       = 0

  return await workbenchIdStorage.run(pipelineId, async () => {
  // Runtimes are now fetched and cached by the software-architect stage as a required deliverable.
  // The architect calls list_runtimes, writes to workbench slot 'runtimes', and complete_stage
  // is blocked until that slot is written. All downstream agents read from the cache.
  while (stageIdx < stages.length) {
    const stage      = stages[stageIdx]!
    const maxRetries = stage.maxRetries ?? 3
    let attempt      = 0
    let lastFix      = ''
    let advanceIdx   = true   // normally advance to stageIdx+1 after inner loop

    while (true) {
      if (generation !== currentGeneration) return { results: allResults, synthesizeEarly: false, wbSnapshot: {} }

      callbacks.onStageStart(stage, attempt)

      const prevSection = previousOutput
        ? `\n\n## Previous Stage Output\n\n${previousOutput.slice(0, 800)}${previousOutput.length > 800 ? '\n[...truncated   full output available to coordinator]' : ''}`
        : ''
      // Declare stage-type flags early -- fixSection needs isTestStage before isReviewOrTest is declared below
      const isReviewOrTestEarly = stage.name === 'Review' || stage.name === 'Testing'
        || stage.assignee === 'adversarial-reviewer' || stage.assignee === 'test-engineer'
      const isTestStageEarly = stage.name === 'Testing' || stage.assignee === 'test-engineer'
      // For test stage: strip code blocks from the fix section -- the implementation is already
      // in implInline and injected via injectCodeFromSlot. Keeping duplicates inflates context.
      const rawFixSection = lastFix
        ? `\n\n## Fix Applied (attempt ${attempt})\n\n${lastFix.slice(0, 1200)}${lastFix.length > 1200 ? '\n[...truncated]' : ''}`
        : ''
      const fixSection = (isTestStageEarly && rawFixSection)
        ? rawFixSection.replace(/```[\s\S]*?```/g, '[code omitted -- see Implementation API above]')
        : rawFixSection

      // Use the early-declared flags (already computed above)
      const isReviewOrTest = isReviewOrTestEarly
      const isTestStage    = isTestStageEarly
      // Reviewer: workbench notice only (reads it correctly via tool call)
      // Test engineer: inline the code directly -- a workbench pointer is insufficient;
      //   the model reads the tool result but then writes its own version in run_code.
      const wbSlots   = wbList()
      const wbImpl    = wbGet('implementation')
      const wbNotice  = wbSlots.length
        ? `\n\n## Workbench\nAvailable slots: ${wbSlots.join(', ')}\n` +
          `IMPORTANT: Call workbench_read('implementation') to fetch the authoritative code. Do NOT use code from elsewhere in this context.\n`
        : ''
      // For test stage: show the API as reference only (so the agent knows function signatures).
      // The server prepends the implementation to run_code via injectCodeFromSlot -- the agent
      // must write ONLY test code (fn main + assertions). Do NOT instruct them to copy the block.
      const implInline = isTestStage && wbImpl
        ? `\n\n## Implementation API (for reference only -- do NOT include in run_code)\n\`\`\`\n${wbImpl}\n\`\`\`\n` +
          `The server pre-loads this implementation automatically. Write only your test harness (fn main with assertions). Do NOT redeclare any structs or functions shown above.\n`
        : ''
      const implSection = isTestStage ? (implInline || wbNotice) : (isReviewOrTest ? wbNotice : '')

      const contextPrevSection = isReviewOrTest ? '' : prevSection

      const taskDesc =
        `## Goal\n\n${fullGoal}${implSection}${contextPrevSection}${fixSection}\n\n## Your Task\n\n${stage.description}` +
        HANDOFF_FOOTER

      const result = await runAgent({
        title: stage.name, description: taskDesc, assignee: stage.assignee, dependsOn: [],
      }, generation)
      // After second retry, strip previousOutput down to code block only to keep context manageable
      if (attempt >= 2) {
        const extracted = extractCodeBlock(previousOutput)
        previousOutput = extracted
          ? `\`\`\`\n${extracted}\n\`\`\``
          : previousOutput.slice(0, 600)
      }

      const completion = result.completion ?? (() => {
        const parsed = parseHandoff(result.output)
        return {
          status:            parsed.status === 'escalate' ? 'ESCALATE' as const : 'DONE' as const,
          summary:           parsed.reason || result.output.slice(0, 120),
          escalation_reason: parsed.status === 'escalate' ? parsed.reason : undefined,
        }
      })()

      callbacks.onStageDone(stage, result, completion.status === 'DONE' ? 'done' : 'escalate')
      allResults.push(result)

      const remainingNames = stages.slice(stageIdx + 1).map(s => s.name)
      const decision = await coordinatorRoute(
        fullGoal, stage, result.output, completion, history, remainingNames,
      )
      callbacks.onCoordinatorRoute(decision)

      // SYNTHESIZE   coordinator says all work is done
      if (decision.action === 'SYNTHESIZE') {
        history.push({ name: stage.name, assignee: stage.assignee, summary: completion.summary })
        const wbSnapshot: Record<string, string> = {}
        const _impl = wbGet('implementation'); if (_impl) wbSnapshot['implementation'] = _impl
        const _rev  = wbGet('review_report');  if (_rev)  wbSnapshot['review_report']  = _rev
        const _tst  = wbGet('test_report');    if (_tst)  wbSnapshot['test_report']    = _tst
        wbClear(pipelineId)
        return { results: allResults, synthesizeEarly: true, wbSnapshot }
      }

      // NEXT   move forward.
      // If this was the Implementation stage, capture the authoritative code
      // so it can be injected into every downstream stage context regardless
      // of how many fix cycles occur.
      if (decision.action === 'NEXT') {
        // Gate: if the Implementation stage routed NEXT but never wrote to workbench,
        // force an escalation back to the engineer rather than letting the reviewer
        // discover the missing slot one stage later.
        const isImplStage = stage.name === 'Implementation' || stage.assignee === 'senior-engineer'
        if (isImplStage && !wbGet('implementation')) {
          console.warn(`[pipeline] Implementation stage NEXT but workbench slot 'implementation' is empty -- forcing escalation`)
          const escalateTarget2 = stage.escalateTo
            ?? (AGENTS.find(a => a.order === 2) ?? AGENTS[1])?.name
            ?? 'senior-engineer'
          if (attempt < maxRetries) {
            const fixResult2 = await runAgent({
              title:       `Fix: ${stage.name}`,
              description: `## Goal\n\n${fullGoal}\n\n## Issue to Fix\n\nYour implementation was accepted but you did not call workbench_write(slot='implementation'). ` +
                           `Write your code to the workbench now.\n\n` +
                           `## Your Task\n\nCall workbench_write with slot='implementation' and your complete code. Then call complete_stage DONE.`,
              assignee:    escalateTarget2,
              dependsOn:   [],
            }, generation)
            callbacks.onFixDone(escalateTarget2, fixResult2)
            allResults.push(fixResult2)
            const recoveredCode = wbGet('implementation')
              ?? extractCodeBlock(fixResult2.output)
              ?? extractCodeFromToolCalls((fixResult2 as { _messages?: AgenticMessage[] })._messages ?? [])
            if (recoveredCode) {
              implementationCode = recoveredCode
              wbSet('implementation', recoveredCode)
            }
          }
        }
        // Auto-publish stage output to named workbench slots.
        // Only write if slot is empty — agents may have already written via workbench_write.
        const slotName = stage.name.toLowerCase().replace(/\s+/g, '_')
        if (result.output && !wbGet(slotName)) wbSet(slotName, result.output)
        // Named slots for key artifacts — same guard
        if (stage.assignee === 'software-architect' && !wbGet('blueprint')) wbSet('blueprint', result.output)
        if (stage.assignee === 'adversarial-reviewer' && !wbGet('review_report')) wbSet('review_report', result.output)
        if (stage.assignee === 'test-engineer' && !wbGet('test_report')) wbSet('test_report', result.output)
        if (stage.name === 'Implementation' || stage.assignee === 'senior-engineer') {
          let extractedCode = extractCodeBlock(result.output)
          if (!extractedCode) {
            // The engineer may have put code only in run_code calls, not the response text.
            // Walk backwards through the agent's messages to find it.
            const toolCode = extractCodeFromToolCalls(
              (result as { _messages?: AgenticMessage[] })._messages ?? []
            )
            if (toolCode) {
              extractedCode = toolCode
              console.log(`[pipeline] Implementation code extracted from run_code tool calls`)
            }
          }
          if (extractedCode) {
            implementationCode = extractedCode
            wbSet('implementation', extractedCode)  // always sync workbench with latest extracted code
            console.log(`[pipeline] Implementation slot updated from stage output (${extractedCode.length} bytes)`)
          } else {
            console.warn(`[pipeline] Implementation stage completed but no code block found in output or tool calls`)
          }
        }
        previousOutput = result.output
        history.push({ name: stage.name, assignee: stage.assignee, summary: completion.summary })
        break
      }

      // REWIND   coordinator wants a prior stage to re-run on the updated code
      if (decision.action === 'REWIND' && decision.rewindTo) {
        const rewindIdx = stages.findIndex(s => s.name === decision.rewindTo)
        const count     = (rewindCounts[decision.rewindTo!] ?? 0) + 1

        if (rewindIdx < 0 || rewindIdx >= stageIdx || count > MAX_REWINDS_PER_STAGE) {
          console.warn(`[pipeline] REWIND to "${decision.rewindTo}" invalid or limit reached   treating as NEXT`)
          previousOutput = result.output
          history.push({ name: stage.name, assignee: stage.assignee, summary: completion.summary })
          break
        }

        rewindCounts[decision.rewindTo!] = count
        callbacks.onRewind(stage.name, decision.rewindTo!, decision.reason)

        // Trim history back to the rewind point so the rewound stage re-runs fresh
        history.splice(rewindIdx)
        // The rewound stage should see the latest fix output as context
        previousOutput = result.output
        stageIdx       = rewindIdx
        advanceIdx     = false
        break
      }

      // ESCALATE   run fix agent then retry this stage
      const escalateTarget = decision.targetAgent ?? stage.escalateTo
      const escalateReason = decision.reason

      if (!escalateTarget || attempt >= maxRetries) {
        if (attempt >= maxRetries) callbacks.onMaxRetries(stage)
        previousOutput = result.output
        history.push({ name: stage.name, assignee: stage.assignee, summary: completion.summary })
        break
      }

      // Write current stage output to workbench before fix runs — only if slot empty
      const escalateSlot = stage.name.toLowerCase().replace(/\s+/g, '_')
      if (result.output && !wbGet(escalateSlot)) wbSet(escalateSlot, result.output)
      if (stage.assignee === 'software-architect' && !wbGet('blueprint')) wbSet('blueprint', result.output)
      if (stage.assignee === 'adversarial-reviewer' && !wbGet('review_report')) wbSet('review_report', result.output)
      if (stage.assignee === 'test-engineer' && !wbGet('test_report')) wbSet('test_report', result.output)
      callbacks.onFixStart(stage, escalateTarget, escalateReason)

      // Fix agent gets current implementation from workbench (always up-to-date)
      const fixWbCode     = wbGet('implementation')
      const fixImplSection = fixWbCode
        ? `## Current Implementation (from workbench -- fix THIS code)\n\n\`\`\`\n${fixWbCode}\n\`\`\`\n\n`
        : implementationCode
          ? `## Implementation Code (fix THIS code)\n\n\`\`\`\n${implementationCode}\n\`\`\`\n\n`
          : ''
      // Inject the relevant stage report so the fix agent knows exactly what to fix
      const fixReportSlot = stage.assignee === 'test-engineer' ? 'test_report' : 'review_report'
      const fixReport     = wbGet(fixReportSlot)
      const fixReportSection = fixReport
        ? `## ${fixReportSlot === 'test_report' ? 'Test' : 'Review'} Report (what failed)\n\n${fixReport.slice(0, 800)}\n\n`
        : ''
      const fixResult = await runAgent({
        title:       `Fix: ${stage.name}`,
        description: `## Goal\n\n${fullGoal}\n\n${fixImplSection}${fixReportSection}## Issue to Fix\n\n${escalateReason}\n\n` +
                     `## Your Task\n\nFix ONLY the issue described above. ` +
                     `After fixing, you MUST: (1) call run_code to verify, (2) call workbench_write with slot='implementation' and your fixed code. ` +
                     `Do not rewrite from scratch. Minimal targeted fix only.`,
        assignee:    escalateTarget,
        dependsOn:   [],
      }, generation)

      callbacks.onFixDone(escalateTarget, fixResult)
      allResults.push(fixResult)
      lastFix = fixResult.output
      // Update both implementationCode and workbench slot so the next review/test
      // attempt always gets the fixed version.
      const fixedCode = extractCodeBlock(fixResult.output)
        ?? extractCodeFromToolCalls((fixResult as { _messages?: AgenticMessage[] })._messages ?? [])
      if (fixedCode) {
        implementationCode = fixedCode
        wbSet('implementation', fixedCode)  // reviewer/tester read this via workbench_read
      }
      attempt++
    }

    if (advanceIdx) stageIdx++
  }

  const wbSnapshot: Record<string, string> = {}
  const _impl2 = wbGet('implementation'); if (_impl2) wbSnapshot['implementation'] = _impl2
  const _rev2  = wbGet('review_report');  if (_rev2)  wbSnapshot['review_report']  = _rev2
  const _tst2  = wbGet('test_report');    if (_tst2)  wbSnapshot['test_report']    = _tst2
  wbClear(pipelineId)
  return { results: allResults, synthesizeEarly: false, wbSnapshot }
  }) // workbenchIdStorage.run
}


// Invisible marker embedded in clarification responses so we can detect them
// in subsequent turns from the full conversation history OpenWebUI sends back.

const CLARIFY_MARKER = '<!-- __CLARIFY__ -->'

function clarificationSystem(): string {
  return COORDINATOR.clarificationPrompt?.trim() || defaultClarificationPrompt()
}

type Phase = 'clarify' | 'execute' | 'execute-with-context'

function detectPhase(messages: ChatMessage[]): Phase {
  const assistantMessages = messages.filter(m => m.role === 'assistant')
  // No prior assistant turn -- first message from this user
  if (assistantMessages.length === 0) return 'clarify'
  // Prior assistant turn contained clarification questions -- user just answered
  if (assistantMessages.at(-1)?.content.includes(CLARIFY_MARKER)) return 'execute-with-context'
  // Continuation of an already-executed conversation
  return 'execute'
}

function buildEnrichedGoal(messages: ChatMessage[]): string {
  const userMessages      = messages.filter(m => m.role === 'user')
  const assistantMessages = messages.filter(m => m.role === 'assistant')
  const originalGoal = userMessages[0]?.content ?? ''
  const clarifyMsg   = assistantMessages.find(m => m.content.includes(CLARIFY_MARKER))
  if (!clarifyMsg) return originalGoal
  // Strip the invisible marker and any surrounding whitespace
  const questions = clarifyMsg.content.replace(CLARIFY_MARKER, '').trim()
  const answers   = userMessages.at(-1)?.content ?? ''
  return `Goal: ${originalGoal}\n\nClarifying questions asked:\n${questions}\n\nUser answers:\n${answers}`
}

async function runClarificationIntake(goal: string): Promise<string | null> {
  const t0  = Date.now()
  const raw = await callCoordinatorLLM([
    { role: 'system', content: clarificationSystem() },
    { role: 'user',   content: goal },
  ], 512)
  const durationMs = Date.now() - t0
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim()

  if (cleaned.startsWith('PROCEED')) {
    appendToolLog({
      ts: Date.now(), agent: 'coordinator', tool: 'clarify',
      args: { goal: goal.slice(0, 500) },
      result: JSON.stringify({ decision: 'PROCEED' }),
      ok: true, durationMs,
    })
    return null
  }
  const questionsStart = cleaned.indexOf('CLARIFY')
  if (questionsStart === -1) {
    appendToolLog({
      ts: Date.now(), agent: 'coordinator', tool: 'clarify',
      args: { goal: goal.slice(0, 500) },
      result: JSON.stringify({ decision: 'PROCEED', note: 'malformed response   treated as PROCEED' }),
      ok: true, durationMs,
    })
    return null
  }
  const questions = cleaned.slice(questionsStart + 'CLARIFY'.length).trim()
  if (!questions) {
    appendToolLog({
      ts: Date.now(), agent: 'coordinator', tool: 'clarify',
      args: { goal: goal.slice(0, 500) },
      result: JSON.stringify({ decision: 'PROCEED', note: 'empty questions   treated as PROCEED' }),
      ok: true, durationMs,
    })
    return null
  }
  appendToolLog({
    ts: Date.now(), agent: 'coordinator', tool: 'clarify',
    args: { goal: goal.slice(0, 500) },
    result: JSON.stringify({ decision: 'CLARIFY', questions: questions.slice(0, 400) }),
    ok: true, durationMs,
  })
  return questions
}

// -- Task decomposition --------------------------------------------------------

// Strip Qwen-style chain-of-thought blocks and extract the inner content of
// any markdown code fence. Returns the cleaned text ready for JSON.parse.
function extractJsonText(llmOutput: string): string {
  const stripped = llmOutput.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  const fenced = stripped.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  return fenced?.[1]?.trim() ?? stripped
}

function parseTaskSpecs(llmOutput: string): TaskSpec[] | null {
  const text = extractJsonText(llmOutput)

  // Locate the outermost JSON array via regex rather than bracket scanning
  const arrayMatch = text.match(/\[[\s\S]*\]/)
  if (!arrayMatch) return null

  try {
    const items: unknown = JSON.parse(arrayMatch[0])
    if (!Array.isArray(items) || items.length === 0) return null

    const specs: TaskSpec[] = []
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue
      const obj = item as Record<string, unknown>

      const title    = String(obj['title'] ?? obj['task'] ?? obj['name'] ?? '').trim()
      const assignee = String(obj['assignee'] ?? obj['agent'] ?? AGENTS[0]!.name).trim()
      if (!title || !assignee) continue

      const rawDeps = obj['dependsOn'] ?? obj['depends_on']
      specs.push({
        title,
        description: String(obj['description'] ?? obj['task'] ?? title),
        assignee,
        dependsOn: Array.isArray(rawDeps)
          ? rawDeps.filter((d): d is string => typeof d === 'string')
          : [],
      })
    }

    if (specs.length === 0) return null

    // All tasks on one agent is a coordinator hallucination signal
    if (specs.length > 1) {
      const assignees = new Set(specs.map(s => s.assignee))
      if (assignees.size === 1) {
        console.warn(`[decompose] All ${specs.length} tasks assigned to "${[...assignees][0]}" -- possible coordinator hallucination, proceeding`)
      }
    }

    return specs
  } catch {
    return null
  }
}

function findClosestAgent(name: string): string {
  const exact = AGENTS.find(a => a.name === name)
  if (exact) return exact.name
  const ci = AGENTS.find(a => a.name.toLowerCase() === name.toLowerCase())
  if (ci) return ci.name
  const sub = AGENTS.find(a => a.name.includes(name) || name.includes(a.name))
  if (sub) return sub.name
  return AGENTS[0]?.name ?? name
}

function parsePipelineSpec(llmOutput: string): PipelineStage[] | null {
  const text = extractJsonText(llmOutput)

  // Locate the outermost JSON object via regex rather than bracket scanning
  const objectMatch = text.match(/\{[\s\S]*\}/)
  if (!objectMatch) return null

  try {
    const parsed: unknown = JSON.parse(objectMatch[0])
    if (typeof parsed !== 'object' || parsed === null) return null

    const obj = parsed as Record<string, unknown>
    if (obj['mode'] !== 'pipeline') return null
    if (!Array.isArray(obj['stages']) || (obj['stages'] as unknown[]).length === 0) return null

    const stages: PipelineStage[] = (obj['stages'] as Record<string, unknown>[]).map(s => ({
      name:        String(s['name']        ?? 'Stage'),
      assignee:    findClosestAgent(String(s['assignee'] ?? AGENTS[0]!.name)),
      description: String(s['description'] ?? ''),
      escalateTo:  s['escalateTo'] ? findClosestAgent(String(s['escalateTo'])) : undefined,
      maxRetries:  typeof s['maxRetries'] === 'number' ? s['maxRetries'] : 3,
    }))

    // The coordinator LLM often omits escalateTo even when the prompt template includes it.
    // Default any missing escalateTo to the implementer (order:2 agent, i.e. senior-engineer).
    // This ensures auto-escalate in coordinatorRoute() always fires for ESCALATE signals.
    const implementer = (AGENTS.find(a => a.order === 2) ?? AGENTS[1])?.name
    if (implementer) {
      for (const stage of stages) {
        if (!stage.escalateTo && stage.assignee !== implementer) {
          stage.escalateTo = implementer
          console.log(`[pipeline] defaulted escalateTo="${implementer}" for stage "${stage.name}"`)          
        }
      }
    }

    return stages
  } catch {
    return null
  }
}

async function decomposeGoal(goal: string): Promise<DecomposeResult> {
  const t0  = Date.now()
  const raw = await callCoordinatorLLM([
    { role: 'system', content: coordinatorSystem() },
    { role: 'user',   content: `Decompose this goal. Use PIPELINE mode for any coding or implementation task.\n\nGoal: ${goal}\n\nRespond ONLY with JSON in a \`\`\`json code fence.` },
  ])
  const durationMs = Date.now() - t0

  // Try pipeline first
  const stages = parsePipelineSpec(raw)
  if (stages && stages.length > 0) {
    const ordered = pipelineAgents()
    stages.forEach((stage, i) => {
      const expected = ordered[i]
      if (expected && stage.assignee !== expected.name) {
        console.warn(`[pipeline] Stage ${i} had assignee "${stage.assignee}", corrected to "${expected.name}" per pipeline order`)
        stage.assignee = expected.name
      }
    })
    appendToolLog({
      ts: Date.now(), agent: 'coordinator', tool: 'decompose',
      args: { goal: goal.slice(0, 500) },
      result: JSON.stringify({
        mode: 'pipeline',
        stages: stages.map(s => ({ name: s.name, assignee: s.assignee })),
      }),
      ok: true, durationMs,
    })
    return { mode: 'pipeline', stages }
  }

  // Fall back to DAG
  const specs = parseTaskSpecs(raw)
  if (specs && specs.length > 0) {
    appendToolLog({
      ts: Date.now(), agent: 'coordinator', tool: 'decompose',
      args: { goal: goal.slice(0, 500) },
      result: JSON.stringify({
        mode: 'dag',
        tasks: specs.map(s => ({ title: s.title, assignee: s.assignee })),
      }),
      ok: true, durationMs,
    })
    return { mode: 'dag', specs }
  }

  // Last resort   one task per agent
  const fallbackSpecs = AGENTS.map(a => ({
    title:       `${a.name}: ${goal.slice(0, 60)}`,
    description: goal,
    assignee:    a.name,
    dependsOn:   [],
  }))
  appendToolLog({
    ts: Date.now(), agent: 'coordinator', tool: 'decompose',
    args: { goal: goal.slice(0, 500) },
    result: JSON.stringify({ mode: 'dag', note: 'fallback   one task per agent', tasks: fallbackSpecs.map(s => s.assignee) }),
    ok: false, durationMs,
  })
  return { mode: 'dag', specs: fallbackSpecs }
}

// The synthesizer LLM generates sections 2-4 only.
// Section 1 (Implementation Code) is injected verbatim from the workbench slot
// after the LLM call to prevent the model from rewriting the code.
const DEFAULT_SYNTHESIS_PROMPT =
  'You are a technical synthesizer. Assemble the final response from specialist outputs.\n\n' +
  'Your response MUST have exactly THREE sections in this order:\n\n' +
  '## Product Description\n' +
  'Write 3-5 sentences describing: (1) what the system does and its key design decisions, ' +
  '(2) time and space complexity from the Design stage, ' +
  '(3) immutability or safety guarantees the implementation provides, ' +
  '(4) any edge cases handled. Be concrete -- name the language features used.\n\n' +
  '## Adversarial Review Report\n' +
  'Summarize the adversarial reviewer findings. If issues were found and fixed, state what they were and confirm the fix. ' +
  'If no issues were found, state that clearly.\n\n' +
  '## Test Report\n' +
  'Summarize the test engineer results: tests run, passed, failed. List any notable edge cases verified. ' +
  'If tests required correction, note what was corrected and why.\n\n' +
  'Rules:\n' +
  '- Do NOT include an Implementation Code section -- that is prepended separately\n' +
  '- Be concise in all three sections -- no padding'

async function synthesize(goal: string, results: AgentResult[], wbSnapshot: Record<string, string> = {}): Promise<string> {
  const t0 = Date.now()
  const sections = results
    .filter(r => r.success)
    .map(r => `### ${r.title} (${r.assignee})\n${stripCodeBlocks(r.output)}`)
    .join('\n\n')
  const systemPrompt = COORDINATOR.synthesisPrompt?.trim() || DEFAULT_SYNTHESIS_PROMPT
  // Truncate verbose stage outputs before synthesis to keep token usage down.
  // The Implementation stage is the only one that needs full preservation.
  // Prefer workbench['implementation'] for the code section -- it always reflects
  // the latest fix, whereas the Implementation stage result may be pre-fix.
  const wbImpl = wbSnapshot['implementation'] ?? wbGet('implementation')
  const truncatedSections = results
    .filter(r => r.success)
    .map(r => {
      const isImplementation = r.title === 'Implementation' || r.assignee === 'senior-engineer'
      const isDesign         = r.title === 'Design'         || r.assignee === 'software-architect'
      if (isImplementation && wbImpl) {
        // Use workbench version -- it has the latest fix applied
        return `### ${r.title} (${r.assignee})\n\`\`\`\n${wbImpl}\n\`\`\``
      }
      const limit = isDesign ? 2400 : 800
      return `### ${r.title} (${r.assignee})\n${r.output.slice(0, limit)}`
    })
    .join('\n\n')

  const synthReview = wbSnapshot['review_report'] ?? wbGet('review_report')
  const synthTest   = wbSnapshot['test_report']   ?? wbGet('test_report')
  const wbSections  = [
    synthReview ? `## Adversarial Review Report (from workbench)\n${synthReview.slice(0, 1200)}` : '',
    synthTest   ? `## Test Report (from workbench)\n${synthTest.slice(0, 800)}`                 : '',
  ].filter(Boolean).join('\n\n')
  const output = await callCoordinatorLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: `## Original Goal\n${goal}\n\n## Specialist Results\n${truncatedSections}\n\n${wbSections}\n\nSynthesize into a final answer with THREE sections: Product Description, Adversarial Review Report, Test Report. Do NOT output an Implementation Code section.` },
  ], 16384)

  // Prepend the verbatim implementation code from workbench as section 1.
  // We do this after the LLM call so the model cannot rewrite or reformat the code.
  const implHeader = wbImpl
    ? `## Implementation Code\n\`\`\`\n${wbImpl}\n\`\`\`\n\n`
    : ''
  const finalOutput = output.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  const assembled   = implHeader + finalOutput
  const durationMs  = Date.now() - t0
  appendToolLog({
    ts: Date.now(), agent: 'coordinator', tool: 'synthesize',
    args: {
      goal:       goal.slice(0, 500),
      agentCount: results.filter(r => r.success).length,
      agents:     [...new Set(results.map(r => r.assignee))],
    },
    result: JSON.stringify({ preview: assembled.slice(0, 300) }),
    ok: true, durationMs,
  })
  return assembled
}

function extractGoal(messages: { role: string; content: string }[]): string | null {
  return messages.filter(m => m.role === 'user').at(-1)?.content ?? null
}

// -- Admin API -----------------------------------------------------------------

// Agents
app.get('/api/agents', (_req, res) => { res.json(AGENTS) })

app.put('/api/agents', (req: Request, res: Response) => {
  if (!Array.isArray(req.body)) { res.status(400).json({ error: 'Expected array' }); return }
  AGENTS = req.body as TeamAgent[]
  saveAgents(AGENTS)
  res.json({ ok: true, count: AGENTS.length })
})

app.post('/api/agents', (req: Request, res: Response) => {
  const agent = req.body as TeamAgent
  if (!agent?.name || !agent?.systemPrompt) { res.status(400).json({ error: 'name and systemPrompt required' }); return }
  if (AGENTS.find(a => a.name === agent.name)) { res.status(409).json({ error: 'Agent name already exists' }); return }
  const newAgent: TeamAgent = { ...agent }
  if (newAgent.temperature === undefined) newAgent.temperature = 0
  if (newAgent.maxTokens === undefined) newAgent.maxTokens = 4096
  if (!newAgent.tools) newAgent.tools = []
  if (!newAgent.toolCollections) newAgent.toolCollections = {}
  if (!newAgent.llm) newAgent.llm = defaultLLM()
  AGENTS.push(newAgent)
  saveAgents(AGENTS)
  res.status(201).json({ ok: true })
})

app.put('/api/agents/:name', (req: Request, res: Response) => {
  const { name } = req.params
  const idx = AGENTS.findIndex(a => a.name === name)
  if (idx === -1) { res.status(404).json({ error: 'Not found' }); return }
  AGENTS[idx] = { ...AGENTS[idx]!, ...req.body as TeamAgent, name }
  saveAgents(AGENTS)
  res.json({ ok: true })
})

app.delete('/api/agents/:name', (req: Request, res: Response) => {
  const { name } = req.params
  const before = AGENTS.length
  AGENTS = AGENTS.filter(a => a.name !== name)
  if (AGENTS.length === before) { res.status(404).json({ error: 'Not found' }); return }
  saveAgents(AGENTS)
  res.json({ ok: true })
})

// Tools
app.get('/api/tools', (_req, res) => { res.json(TOOLS) })

app.put('/api/tools', (req: Request, res: Response) => {
  if (!Array.isArray(req.body)) { res.status(400).json({ error: 'Expected array' }); return }
  TOOLS = req.body as ToolConfig[]
  saveTools(TOOLS)
  res.json({ ok: true, count: TOOLS.length })
})

app.post('/api/tools', (req: Request, res: Response) => {
  const tool = req.body as ToolConfig
  if (!tool?.id || !tool?.name) { res.status(400).json({ error: 'id and name required' }); return }
  if (TOOLS.find(t => t.id === tool.id)) { res.status(409).json({ error: 'Tool id already exists' }); return }
  TOOLS.push(tool)
  saveTools(TOOLS)
  res.status(201).json({ ok: true })
})

app.put('/api/tools/:id', (req: Request, res: Response) => {
  const { id } = req.params
  const idx = TOOLS.findIndex(t => t.id === id)
  if (idx === -1) { res.status(404).json({ error: 'Not found' }); return }
  TOOLS[idx] = { ...TOOLS[idx]!, ...req.body as ToolConfig, id }
  saveTools(TOOLS)
  res.json({ ok: true })
})

app.delete('/api/tools/:id', (req: Request, res: Response) => {
  const { id } = req.params
  const before = TOOLS.length
  TOOLS = TOOLS.filter(t => t.id !== id)
  if (TOOLS.length === before) { res.status(404).json({ error: 'Not found' }); return }
  saveTools(TOOLS)
  res.json({ ok: true })
})

// Coordinator config
app.get('/api/coordinator', (_req, res) => { res.json(COORDINATOR) })

app.put('/api/coordinator', (req: Request, res: Response) => {
  const body = req.body as Partial<CoordinatorConfig>
  if (!body?.llm?.model || !body?.llm?.url) {
    res.status(400).json({ error: 'llm.model and llm.url are required' }); return
  }
  const str = (v: unknown) => typeof v === 'string' ? v : ''
  COORDINATOR = {
    llm:                  { ...defaultLLM(), ...body.llm },
    flags:                Array.isArray(body.flags) ? body.flags.filter(f => typeof f === 'string' && f.trim()) : [],
    decompositionPrompt:  str(body.decompositionPrompt),
    routingPrompt:        str(body.routingPrompt),
    clarificationPrompt:  str(body.clarificationPrompt),
    synthesisPrompt:      str(body.synthesisPrompt),
  }
  saveCoordinator(COORDINATOR)
  res.json({ ok: true })
})

// Returns the built-in default text for each coordinator prompt.
// The UI uses this for Reset-to-default buttons so users always have a reference.
app.get('/api/coordinator/defaults', (_req, res) => {
  res.json({
    decompositionPrompt: defaultDecompositionTemplate(),
    routingPrompt:       defaultRoutingTemplate(),
    clarificationPrompt: defaultClarificationPrompt(),
    synthesisPrompt:     DEFAULT_SYNTHESIS_PROMPT,
  })
})

// Tool execution log
app.get('/api/tool-log', (req: Request, res: Response) => {
  const limit  = parseInt(req.query['limit'] as string || '0') || toolLog.length
  const since  = parseInt(req.query['since'] as string || '0')
  const entries = toolLog.filter(e => e.ts > since).slice(0, limit)
  res.json(entries)
})

app.delete('/api/tool-log', (_req, res) => {
  toolLog.length = 0
  res.json({ ok: true })
})

// Ollama model list proxy
app.get('/api/ollama/models', async (_req, res) => {
  try {
    const base = OLLAMA_BASE_URL.replace('/v1', '')
    const r    = await fetch(`${base}/api/tags`)
    const data = await r.json() as { models?: { name: string }[] }
    res.json(data.models?.map((m: { name: string }) => m.name) ?? [])
  } catch {
    res.json([OLLAMA_MODEL])
  }
})

// Qdrant collections proxy -- fetches from whichever Qdrant URL a given tool has configured
app.get('/api/qdrant/collections', async (req: Request, res: Response) => {
  const toolId  = req.query['toolId'] as string || 'qdrant-rag'
  const tool    = TOOLS.find(t => t.id === toolId && t.type === 'qdrant_rag')
  const baseUrl = tool?.config?.['url'] || 'http://10.20.0.27:6333'
  try {
    const r    = await fetch(`${baseUrl}/collections`)
    const data = await r.json() as { result?: { collections?: { name: string }[] } }
    const names = data.result?.collections?.map((c: { name: string }) => c.name) ?? []
    res.json(names)
  } catch (err) {
    res.status(502).json({ error: `Qdrant unreachable: ${err instanceof Error ? err.message : String(err)}` })
  }
})

// -- WebUI ---------------------------------------------------------------------

app.get('/ui', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(UI_HTML)
})

app.get('/', (_req, res) => { res.redirect('/ui') })

// -- Health --------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', model: MODEL_ID, agents: AGENTS.map(a => a.name) })
})

app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: [{ id: MODEL_ID, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'orchestrail' }],
  })
})

// -- Chat completions ----------------------------------------------------------

app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  const { messages, stream = false } = req.body as {
    messages: { role: string; content: string }[]
    stream?: boolean
  }
  if (!messages?.length) { res.status(400).json({ error: { message: 'No messages', type: 'invalid_request_error' } }); return }
  const goal = extractGoal(messages)
  if (!goal)  { res.status(400).json({ error: { message: 'No user message', type: 'invalid_request_error' } }); return }

  const systemMessage = messages.find(m => m.role === 'system')?.content
  const baseGoal      = systemMessage ? `Context: ${systemMessage}\n\nGoal: ${goal}` : goal
  const completionId  = `chatcmpl-${uuidv4()}`

  // -- Ghost request filter ----------------------------------------------------
  // OpenWebUI sends background metadata requests (title gen, tag gen, follow-up
  // suggestions) through the same /v1/chat/completions endpoint. These all start
  // with "### Task:\n" and should never hit the full multi-agent pipeline.
  // Route them directly to the coordinator LLM for a fast single-shot response.
  if (goal.startsWith('### Task:')) {
    const coordLLM = COORDINATOR.llm ?? defaultLLM()
    const ghostReply = await callLLM(
      [{ role: 'user', content: goal }],
      coordLLM,
      256,
      0,
    )
    const replyText = ghostReply.trim() || 'General'
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      res.write(`data: ${JSON.stringify({
        id: completionId, object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: MODEL_ID,
        choices: [{ index: 0, delta: { content: replyText }, finish_reason: null }],
      })}\n\n`)
      res.write(`data: ${JSON.stringify({
        id: completionId, object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: MODEL_ID,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    } else {
      res.json({
        id: completionId, object: 'chat.completion', model: MODEL_ID,
        created: Math.floor(Date.now() / 1000),
        choices: [{ index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })
    }
    return
  }

  const phase         = detectPhase(messages as ChatMessage[])

  // Bump the global generation counter so any in-flight agents from prior
  // requests will detect they've been superseded and self-abort.
  const generation = ++currentGeneration

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')

    const sendChunk = (content: string) => res.write(`data: ${JSON.stringify({
      id: completionId, object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000), model: MODEL_ID,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`)

    const sendDone = () => {
      const u = usageStorage.getStore() ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      res.write(`data: ${JSON.stringify({
        id: completionId, object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: MODEL_ID,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: u,
      })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }

    await usageStorage.run({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, async () => {
    try {
      // -- Clarification phase ---------------------------------------------------
      if (phase === 'clarify') {
        sendChunk('> **[coordinator]** reviewing goal...\n')
        const questions = await runClarificationIntake(baseGoal)
        if (questions) {
          sendChunk(`> **[coordinator]** a few questions before the team starts:\n\n`)
          sendChunk(`${questions}\n${CLARIFY_MARKER}`)
          sendDone()
          return
        }
        sendChunk('> **[coordinator]** goal is clear, decomposing...\n')
      }

      // -- Resolve final goal context --------------------------------------------
      const fullGoal = phase === 'execute-with-context'
        ? buildEnrichedGoal(messages as ChatMessage[])
        : baseGoal

      sendChunk('> **[coordinator]** decomposing goal...\n')
      const decomposed = await decomposeGoal(fullGoal)

      let completedResults: AgentResult[]
      let synthesizeEarly = false
      let pipelineWbSnapshot: Record<string, string> = {}

      if (decomposed.mode === 'pipeline') {
        sendChunk(`> **[coordinator]** pipeline   ${decomposed.stages.length} stages\n\n`)
        const pipelineResult = await executePipeline(decomposed.stages, fullGoal, generation, {
          onStageStart: (stage, attempt) => {
            const retry = attempt > 0 ? ` (retry ${attempt})` : ''
            sendChunk(`> **[${stage.assignee}]** ${stage.name}${retry}...\n`)
          },
          onStageDone: (stage, result, status) => {
            const icon = status === 'escalate' ? '??' : '?'
            sendChunk(`> **[done]** ${stage.assignee}: ${stage.name} ${icon}\n`)
            sendChunk(`\n<details>\n<summary>${stage.assignee}   ${stage.name}${status === 'escalate' ? ' ??' : ''}</summary>\n\n${result.output}\n\n</details>\n`)
          },
          onFixStart: (stage, fixAgent, reason) => {
            sendChunk(`> **[${fixAgent}]** fixing ${stage.name}: ${reason.slice(0, 80)}...\n`)
          },
          onFixDone: (fixAgent) => {
            sendChunk(`> **[done]** ${fixAgent}: fix applied\n`)
          },
          onMaxRetries: (stage) => {
            sendChunk(`> **[?? max retries]** ${stage.name}   continuing\n`)
          },
          onCoordinatorRoute: (decision) => {
            if (decision.action === 'ESCALATE') {
              sendChunk(`> **[coordinator]** escalating to ${decision.targetAgent}: ${decision.reason}\n`)
            } else if (decision.action === 'SYNTHESIZE') {
              sendChunk(`> **[coordinator]** work complete   synthesizing early\n`)
            }
          },
          onRewind: (fromStage, toStage, reason) => {
            sendChunk(`> **[coordinator]** rewinding to ${toStage}: ${reason}\n`)
          },
        })
        completedResults    = pipelineResult.results
        synthesizeEarly     = pipelineResult.synthesizeEarly
        pipelineWbSnapshot  = pipelineResult.wbSnapshot
      } else {
        injectGoalIntoRootTasks(decomposed.specs, fullGoal)
        sendChunk(`> **[coordinator]** ${decomposed.specs.length} task${decomposed.specs.length !== 1 ? 's' : ''} assigned\n\n`)
        completedResults = await executeWithDeps(decomposed.specs, {
          onWaiting: (spec, waitingFor) => {
            sendChunk(`> **[${spec.assignee}]** waiting for: ${waitingFor.join(', ')}...\n`)
          },
          onStart: (spec) => {
            sendChunk(`> **[${spec.assignee}]** working on: ${spec.title}...\n`)
          },
          onComplete: (result) => {
            sendChunk(`> **[done]** ${result.assignee}: ${result.title}\n`)
            if (result.success && decomposed.specs.length > 1) {
              sendChunk(`\n<details>\n<summary>${result.assignee} -- ${result.title}</summary>\n\n${result.output}\n\n</details>\n`)
            }
          },
        }, generation)
      }

      sendChunk('\n')

      if (completedResults.length === 1) {
        const solo = completedResults[0]
        if (solo) {
          sendChunk(`---\n\n${solo.output}`)
          sendChunk(`\n\n---\n*Agent: ${solo.assignee}*`)
        }
      } else {
        sendChunk('> **[coordinator]** synthesizing...\n\n---\n\n')
        const synthesis = await synthesize(fullGoal, completedResults, pipelineWbSnapshot)
        sendChunk(synthesis)
        const agentList = [...new Set(completedResults.map(r => r.assignee))].join(', ')
        sendChunk(`\n\n---\n*Agents: ${agentList}*`)
      }

      sendDone()
      currentGeneration++ // abort any chains still running after response is sent
    } catch (err) {
      sendChunk(`\n\n**Error:** ${err instanceof Error ? err.message : String(err)}`)
      sendDone()
      currentGeneration++
    }
    }) // usageStorage.run

  } else {
    await usageStorage.run({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, async () => {
    try {
      if (phase === 'clarify') {
        const questions = await runClarificationIntake(baseGoal)
        if (questions) {
          const content = `Before the team starts, a few questions:\n\n${questions}\n${CLARIFY_MARKER}`
          res.json({
            id: completionId, object: 'chat.completion',
            created: Math.floor(Date.now() / 1000), model: MODEL_ID,
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: usageStorage.getStore() ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          })
          return
        }
      }

      const fullGoal = phase === 'execute-with-context'
        ? buildEnrichedGoal(messages as ChatMessage[])
        : baseGoal

      const decomposed = await decomposeGoal(fullGoal)
      let results: AgentResult[]
      let nsWbSnapshot: Record<string, string> = {}

      if (decomposed.mode === 'pipeline') {
        const pr = await executePipeline(decomposed.stages, fullGoal, generation, {
          onStageStart:       (stage, attempt) => { console.log(`[pipeline] ${stage.assignee}: ${stage.name}${attempt > 0 ? ` retry ${attempt}` : ''}`) },
          onStageDone:        (stage, _r, status) => { console.log(`[done] ${stage.assignee}: ${stage.name} ${status}`) },
          onFixStart:         (_s, fixAgent, reason) => { console.log(`[fix] ${fixAgent}: ${reason.slice(0, 60)}`) },
          onFixDone:          (fixAgent) => { console.log(`[fix done] ${fixAgent}`) },
          onMaxRetries:       (stage) => { console.log(`[max retries] ${stage.name}`) },
          onCoordinatorRoute: (decision) => { console.log(`[coordinator] ${decision.action}${decision.targetAgent ? ' ? ' + decision.targetAgent : ''}${decision.rewindTo ? ' ? ' + decision.rewindTo : ''}: ${decision.reason}`) },
          onRewind:           (fromStage, toStage, reason) => { console.log(`[rewind] ${fromStage} ? ${toStage}: ${reason}`) },
        })
        results      = pr.results
        nsWbSnapshot = pr.wbSnapshot
      } else {
        injectGoalIntoRootTasks(decomposed.specs, fullGoal)
        results = await executeWithDeps(decomposed.specs, {
          onWaiting:  (spec, waitingFor) => { console.log(`[deps] ${spec.assignee} waiting for: ${waitingFor.join(', ')}`) },
          onStart:    (spec)             => { console.log(`[start] ${spec.assignee}: ${spec.title}`) },
          onComplete: (result)           => { console.log(`[done]  ${result.assignee}: ${result.title}`) },
        }, generation)
      }

      const agentList  = [...new Set(results.map(r => r.assignee))].join(', ')
      const content    = results.length === 1 && results[0]
        ? results[0].output + `\n\n---\n*Agent: ${results[0].assignee}*`
        : (await synthesize(fullGoal, results, nsWbSnapshot)) + `\n\n---\n*Agents: ${agentList}*`

      res.json({
        id: completionId, object: 'chat.completion',
        created: Math.floor(Date.now() / 1000), model: MODEL_ID,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: usageStorage.getStore() ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })
    } catch (err) {
      res.status(500).json({ error: { message: err instanceof Error ? err.message : String(err), type: 'server_error' } })
    }
    }) // usageStorage.run
  }
})

// -- Start ---------------------------------------------------------------------

app.listen(PORT, () => {
  console.log('Orchestrail -- port ' + PORT)
  console.log('Ollama             -- ' + OLLAMA_BASE_URL)
  console.log('Coordinator        -- ' + COORDINATOR.llm.model + ' @ ' + COORDINATOR.llm.url)
  console.log('Agents             -- ' + AGENTS.map(a => a.name).join(', '))
  console.log('WebUI              -- http://localhost:' + PORT + '/ui')
})