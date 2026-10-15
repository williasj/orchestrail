// -- Tool execution layer ------------------------------------------------------
// Fetches tool definitions, executes tool calls, manages the tool log,
// and provides workbench tool definitions.

import { AsyncLocalStorage } from 'node:async_hooks'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import {
  RAG_MANAGER_CACHE_TTL, WORKBENCH_SENTINEL, cols, CODE_EXEC_URL, SOURCE_ROOT,
} from '../utils/config.js'
import { appendPendingChange } from './persistence.js'
import {
  runSkill, createSkill, skillExecEnabled, type CodeExecFn, type CreateSkillInput,
} from './skillexec.js'
import {
  wbGet, wbSet, wbList, wbIdToConversationId, workbenchIdStorage,
} from './workbench.js'
import { memoryEnabled, qdrantSearch, qdrantUpsert } from './memory.js'
import {
  isObviouslyProse, stripCodeBlockDelimiters, stripThinkBlocks,
  detectDuplicateMain, detectStructRedefinition, ensurePyFutureAnnotations,
} from '../utils/text.js'
import type {
  TeamAgent, ToolConfig, RagManagerEndpoint, RagManagerSpec, ToolLogEntry,
} from '../types/index.js'

// -- Module init ---------------------------------------------------------------

type ToolsDeps = {
  getAgents: () => TeamAgent[]
  getTools:  () => ToolConfig[]
}

let _deps: ToolsDeps | null = null

export function initTools(deps: ToolsDeps): void {
  _deps = deps
}

function agentMap(): Map<string, TeamAgent> {
  return new Map((_deps?.getAgents() ?? []).map(a => [a.name, a]))
}

// -- Tool log ------------------------------------------------------------------

// Per-request context injected by the completions route via AsyncLocalStorage.
// appendToolLog reads it automatically so no call-site changes are needed.
export type { ToolLogRequestContext } from './toolcontext.js'
import { toolLogContextStorage } from './toolcontext.js'
import { buildWikiTools, executeWikiTool, WIKI_SENTINEL, WIKI_TOOL_NAMES } from './wikitools.js'
export { toolLogContextStorage }

// Tool log is now disk-backed per conversation via conversation.ts.
// The legacy in-memory array is removed; getToolLog/clearToolLog are kept
// as thin shims so existing call-sites in admin.ts continue to compile.
import {
  appendToolLogEntry,
  getAllToolLogEntries,
} from './conversation.js'

/** @deprecated Use getAllToolLogEntries from conversation.ts for admin queries. */
export function getToolLog(): ToolLogEntry[] { return getAllToolLogEntries() }
/** @deprecated No-op — tool-log is now per-conversation and only deleted on user request. */
export function clearToolLog(): void { /* intentional no-op */ }

export function appendToolLog(entry: Omit<ToolLogEntry, 'id'>): void {
  const ctx = toolLogContextStorage.getStore()
  const full: ToolLogEntry = {
    id: uuidv4(),
    ...entry,
    userId:         ctx?.userId         ?? entry.userId ?? '',
    conversationId: ctx?.conversationId ?? entry.conversationId ?? '',
  }
  appendToolLogEntry(full)
}

// -- Failure artifact detection ------------------------------------------------
// Used by executeToolCall to skip persisting failed outputs to Qdrant,
// and by synthesize to filter stage results.

export function isFailureArtifact(content: string): boolean {
  const lower = content.toLowerCase()
  return (
    lower.includes('could not be executed') ||
    lower.includes('tool server limitations') ||
    lower.includes('limit reached') ||
    lower.includes('fabricated') ||
    lower.includes('no artifact at slot')
  )
}

// -- Workbench tool definitions ------------------------------------------------
// Injected into every pipeline agent's tool list.

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
      description: 'List the language runtimes available in the execution sandbox (e.g. python, node). Returns the cached runtimes slot if populated; otherwise queries the exec server and caches it. Call this to confirm which runtime strings are valid before writing the runtimes slot.',
      parameters: { type: 'object', properties: {}, required: [] },
    }},
    { type: 'function', function: {
      name: 'workbench_search',
      description: 'Semantic search over workbench artifacts from prior conversation turns. Use to find relevant prior work by topic rather than exact slot name.',
      parameters: { type: 'object', properties: {
        query: { type: 'string', description: 'Natural language search query' },
      }, required: ['query'] },
    }},
  ]
}

// -- RAG Manager fetch ---------------------------------------------------------

const ragManagerCache = new Map<string, { spec: RagManagerSpec; ts: number }>()

export async function fetchRagManagerSpec(baseUrl: string): Promise<RagManagerSpec> {
  const cached = ragManagerCache.get(baseUrl)
  if (cached && Date.now() - cached.ts < RAG_MANAGER_CACHE_TTL) return cached.spec

  const res = await fetch(`${baseUrl}/openapi.json`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`RAG Manager OpenAPI fetch failed: ${res.status}`)
  const openapi = await res.json() as { paths?: Record<string, unknown> }

  const endpoints: RagManagerEndpoint[] = []
  for (const [path, pathObj] of Object.entries(openapi.paths ?? {})) {
    if (!path.startsWith('/api/query_')) continue
    const post = (pathObj as Record<string, unknown>)['post'] as Record<string, unknown> | undefined
    if (!post) continue
    endpoints.push({
      operationId: String(post['operationId'] ?? path.replace('/api/', '')),
      summary:     String(post['summary']     ?? path),
      description: String(post['description'] ?? ''),
      path,
    })
  }

  const spec: RagManagerSpec = { baseUrl, endpoints }
  ragManagerCache.set(baseUrl, { spec, ts: Date.now() })
  return spec
}

// -- Agent tool fetching -------------------------------------------------------
// Returns OpenAI-format tool definitions and a name→URL map for all tools
// enabled and assigned to the given agent.

export async function fetchAgentTools(agent: TeamAgent): Promise<{ defs: unknown[]; urlMap: Map<string, string> }> {
  const tools = _deps?.getTools() ?? []
  const defs: unknown[] = []
  const urlMap = new Map<string, string>()

  const assignedTools = tools.filter(t => t.enabled && agent.tools.includes(t.id))

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
    } else if (tool.type === 'rag_manager') {
      const url = tool.config['url']
      if (!url) continue
      try {
        const spec      = await fetchRagManagerSpec(url)
        const allowRaw  = agent.toolCollections?.[tool.id] ?? ''
        const allowSet  = allowRaw ? new Set(allowRaw.split(',').map(s => s.trim()).filter(Boolean)) : null
        const endpoints = allowSet ? spec.endpoints.filter((e: RagManagerEndpoint) => allowSet.has(e.operationId)) : spec.endpoints
        for (const ep of endpoints) {
          defs.push({
            type: 'function',
            function: {
              name:        ep.operationId,
              description: ep.description || ep.summary,
              parameters: {
                type: 'object',
                properties: {
                  query: { type: 'string',  description: 'Natural language search query' },
                  limit: { type: 'integer', description: 'Number of results to return (default 100)' },
                },
                required: ['query'],
              },
            },
          })
          urlMap.set(ep.operationId, `__rag_manager__:${tool.id}`)
        }
      } catch (err) {
        console.warn(`[tools] Failed to fetch RAG Manager spec from ${tool.id} (${url}): ${err}`)
      }
    } else if (tool.type === 'searxng') {
      const url = tool.config['url']
      if (!url) continue
      const funcName = `web_search_${tool.id.replace(/-/g, '_')}`
      defs.push({
        type: 'function',
        function: {
          name: funcName,
          description: `Search the web using SearXNG (${tool.name}). Returns titles, URLs, and snippets for relevant results.`,
          parameters: {
            type: 'object',
            properties: {
              query:    { type: 'string',  description: 'Search query' },
              limit:    { type: 'number',  description: 'Max results to return (default 5)' },
            },
            required: ['query'],
          },
        },
      })
      urlMap.set(funcName, `__searxng__:${tool.id}`)
    }
  }

  // Always inject workbench tools — available to every pipeline agent
  defs.push(...buildWorkbenchTools())
  urlMap.set('workbench_list',   WORKBENCH_SENTINEL)
  urlMap.set('workbench_read',   WORKBENCH_SENTINEL)
  urlMap.set('workbench_write',  WORKBENCH_SENTINEL)
  urlMap.set('workbench_search', WORKBENCH_SENTINEL)
  urlMap.set('list_runtimes',    WORKBENCH_SENTINEL)

  // Inject executable-skill tools when the subsystem is enabled AND this agent
  // can already execute code. Skills run real code through the same path as the
  // exec tools, so the right to invoke a skill is the same capability as the
  // right to run code: an agent that was not granted the exec tool (e.g. the
  // architect, granted only Web-Search) has no business running python-run-tests.
  // Capability-derived, not role-hardcoded -- the gate is "do you have bash",
  // which is exactly the signal _codeExecUrl resolution already trusts below.
  // Without this, use_skill was exposed to every agent and a design-stage agent
  // could (and did) run tests it was never meant to touch.
  const canExecuteCode = defs.some(
    d => (d as { function?: { name?: string } })?.function?.name === 'bash',
  )
  if (skillExecEnabled() && canExecuteCode) {
    defs.push(...buildSkillTools())
    urlMap.set('use_skill',    SKILL_SENTINEL)
    urlMap.set('create_skill', SKILL_SENTINEL)
  }
  // Inject AIWiki tools when the agent has a tool of type 'aiwiki' assigned
  if (assignedTools.some(t => t.type === 'aiwiki')) {
    defs.push(...buildWikiTools())
    for (const n of WIKI_TOOL_NAMES) urlMap.set(n, WIKI_SENTINEL)
  }

  // Inject self-improvement tools when the agent has the 'self-improve' tool grant
  const hasSelfImprove = assignedTools.some(t => t.type === 'self_improve')
  if (hasSelfImprove) {
    defs.push(...buildSelfImprovementTools())
    urlMap.set('read_source_file', SELF_IMPROVE_SENTINEL)
    urlMap.set('propose_edit',     SELF_IMPROVE_SENTINEL)
  }

  return { defs, urlMap }
}

// -- RAG search / RAG Manager --------------------------------------------------

async function executeRagSearch(
  tool: ToolConfig,
  args: { query: string; collection?: string; limit?: number },
): Promise<string> {
  const qdrantUrl    = tool.config['url']
  const embeddingUrl = tool.config['embeddingUrl']
  const collection   = args.collection ?? ''
  const limit        = args.limit ?? 5

  if (!qdrantUrl || !embeddingUrl) {
    return JSON.stringify({ error: `RAG tool '${tool.id}' missing url or embeddingUrl in config` })
  }
  if (!collection) {
    return JSON.stringify({ error: `No collection specified for RAG tool '${tool.id}'. Set a default in the agent's tool assignment or pass collection in the call.` })
  }

  try {
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

    const searchRes = await fetch(`${qdrantUrl}/collections/${encodeURIComponent(collection)}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vector, limit, with_payload: true }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!searchRes.ok) return JSON.stringify({ error: `Qdrant error: ${searchRes.status}` })
    const searchData = await searchRes.json() as {
      result: { id: string | number; score: number; payload: Record<string, unknown> }[]
    }

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

async function executeRagManagerCall(
  tool:      ToolConfig,
  operation: string,
  args:      { query: string; limit?: number },
): Promise<string> {
  const baseUrl = tool.config['url']
  if (!baseUrl) return JSON.stringify({ error: `RAG Manager tool '${tool.id}' missing url in config` })
  try {
    const body: Record<string, unknown> = { query: args.query }
    if (args.limit !== undefined) body['limit'] = args.limit
    const res = await fetch(`${baseUrl}/api/${operation}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(30_000),
    })
    if (!res.ok) return JSON.stringify({ error: `RAG Manager ${res.status}: ${await res.text()}` })
    return JSON.stringify(await res.json())
  } catch (err) {
    return JSON.stringify({ error: String(err) })
  }
}

// -- Skill capability tools ----------------------------------------------------
// use_skill / create_skill are in-process tools (like complete_stage), routed by
// a sentinel and dispatched to core/skillexec.ts. The actual code execution they
// trigger goes back out through runCodeViaTool -> the same exec server (write_file + bash).

export const SKILL_SENTINEL = '__skillcap__'

// -- Background proposal reviewer ----------------------------------------------
// After a proposal is written, queue a fire-and-forget R1 review job.
// R1 endpoint: a dedicated Ollama host (deepseek-r1:671b, CPU, slow).
// Sequential per-proposal, 10min timeout. Updates reviewerVerdict + reviewerNote.

const R1_BASE_URL = 'http://192.168.4.99:11434/v1'
const R1_MODEL    = 'deepseek-r1:671b'
const R1_TIMEOUT_MS = 10 * 60 * 1000  // 10 minutes

async function reviewProposalBackground(proposalId: string): Promise<void> {
  // Small delay to let the appendPendingChange fs write settle
  await new Promise(r => setTimeout(r, 500))

  const { loadPendingChanges: _lpc, updatePendingChange: _upc } = await import('./persistence.js')
  const changes = _lpc()
  const change = changes.find(c => c.id === proposalId)
  if (!change) { console.warn(`[reviewer] proposal ${proposalId} not found`); return }

  // Build context: for src-change, include the full file content
  let fileContext = ''
  if (change.changeType === 'src-change' || !change.changeType) {
    try {
      const abs = resolveSourcePath(change.file)
      const content = fs.readFileSync(abs, 'utf8')
      // Cap to 8000 chars to avoid overwhelming R1 context
      fileContext = content.length > 8000
        ? content.slice(0, 8000) + '\n[...truncated]'
        : content
    } catch { /* file may not be readable, proceed without */ }
  }

  const reviewPrompt =
    `You are a code review agent evaluating a proposed change to the Orchestrail pipeline.\n\n` +
    `CHANGE TYPE: ${change.changeType ?? 'src-change'}\n` +
    `TARGET: ${change.file}\n` +
    `RUBRIC GAPS TARGETED: ${change.rubricGaps?.join(', ') || 'none specified'}\n\n` +
    `RATIONALE FROM AGENT:\n${change.rationale}\n\n` +
    `ORIGINAL TEXT (to be removed):\n\`\`\`\n${change.original}\n\`\`\`\n\n` +
    `REPLACEMENT TEXT (to be inserted):\n\`\`\`\n${change.replacement}\n\`\`\`\n\n` +
    (fileContext ? `FULL FILE CONTENT (for context):\n\`\`\`\n${fileContext}\n\`\`\`\n\n` : '') +
    `Evaluate whether: (1) the change addresses the stated root cause, (2) it cannot introduce regressions, ` +
    `(3) the rationale is evidence-backed, (4) it is minimal and does not touch unrelated code.\n\n` +
    `Respond with VERDICT: APPROVED or VERDICT: FLAGGED followed by a concise note explaining your reasoning.`

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), R1_TIMEOUT_MS)

    let responseText: string
    try {
      const res = await fetch(`${R1_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ollama' },
        body: JSON.stringify({
          model: R1_MODEL,
          max_tokens: 1024,
          temperature: 0,
          messages: [{ role: 'user', content: reviewPrompt }],
        }),
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!res.ok) {
        const errText = await res.text()
        console.warn(`[reviewer] R1 HTTP ${res.status} for ${proposalId}: ${errText.slice(0, 200)}`)
        _upc(proposalId, {
          reviewerVerdict: 'flagged',
          reviewerNote: `Review failed: HTTP ${res.status}`,
          reviewerAt: new Date().toISOString(),
        })
        return
      }
      const data = await res.json() as { choices: Array<{ message: { content: string | null } }> }
      responseText = data.choices?.[0]?.message?.content ?? ''
    } catch (err) {
      clearTimeout(timer)
      const isTimeout = String(err).includes('abort') || String(err).includes('AbortError')
      console.warn(`[reviewer] ${isTimeout ? 'timeout' : 'error'} for proposal ${proposalId}: ${err}`)
      _upc(proposalId, {
        reviewerVerdict: 'flagged',
        reviewerNote: isTimeout ? 'Review timed out (10 min limit)' : `Review error: ${String(err).slice(0, 200)}`,
        reviewerAt: new Date().toISOString(),
      })
      return
    }

    // Strip <think> blocks that R1 emits, then parse verdict
    const cleanedText = responseText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
    const isApproved = /VERDICT:\s*APPROVED/i.test(cleanedText)
    const verdict: import('../types/index.js').ReviewerVerdict = isApproved ? 'approved' : 'flagged'
    // Extract note: everything after the VERDICT line
    const noteMatch = cleanedText.match(/VERDICT:\s*(?:APPROVED|FLAGGED)[^\n]*\n?([\s\S]*)/)
    const note = noteMatch?.[1]?.trim() || cleanedText.slice(0, 400)

    _upc(proposalId, {
      reviewerVerdict: verdict,
      reviewerNote: note.slice(0, 1000),
      reviewerAt: new Date().toISOString(),
    })
    console.log(`[reviewer] proposal ${proposalId}: ${verdict}`)
  } catch (err) {
    console.warn(`[reviewer] unexpected error for ${proposalId}: ${err}`)
  }
}

// -- Self-improvement capability tools ----------------------------------------
// read_source_file / propose_edit are granted only to the self-improvement agent.
// propose_edit validates that `original` actually exists in the target file before
// writing to pending-changes -- no hallucinated patches land on disk.

export const SELF_IMPROVE_SENTINEL = '__selfimprove__'

// Allowlist of file extensions the self-improvement agent may read/propose edits
// for. Prevents it from reading secrets or binary files.
const ALLOWED_EXTENSIONS = new Set(['.ts', '.js', '.json', '.md', '.yaml', '.yml'])

// Resolve and validate a source-relative path. Returns absolute path or throws.
function resolveSourcePath(relPath: string): string {
  // Normalise: strip leading slash/dot-slash and accidental 'src/' prefix.
  // SOURCE_ROOT is already /app/src, so an agent passing 'src/core/foo.ts'
  // would otherwise resolve to /app/src/src/core/foo.ts (double src/).
  const clean = relPath.replace(/^\.?\//, '').replace(/^src\//, '')
  const abs = path.resolve(SOURCE_ROOT, clean)
  // Prevent path traversal outside SOURCE_ROOT
  if (!abs.startsWith(path.resolve(SOURCE_ROOT))) {
    throw new Error(`Path traversal rejected: ${relPath}`)
  }
  const ext = path.extname(abs)
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`File type not allowed for self-improvement: ${ext}`)
  }
  return abs
}

export function buildSelfImprovementTools(): unknown[] {
  return [
    { type: 'function', function: {
      name: 'read_source_file',
      description:
        'Read a source file from the Orchestrail codebase. Use this to understand the ' +
        'current implementation before proposing a change. Path is relative to src/, ' +
        'e.g. "core/prompts.ts" or "core/tools.ts".',
      parameters: { type: 'object', properties: {
        path: { type: 'string', description: 'Relative path from src/ e.g. "core/prompts.ts"' },
      }, required: ['path'] },
    }},
    { type: 'function', function: {
      name: 'propose_edit',
      description:
        'Propose a targeted code change for human review and approval. The `original` ' +
        'string MUST exist verbatim in the file -- it is validated before the proposal ' +
        'is recorded. Write the smallest possible change. Do NOT rewrite whole files. ' +
        'One propose_edit per logical fix. Changes to pipeline.ts, agent.ts, synthesize.ts, ' +
        'or tools.ts are high-risk and require extra scrutiny in your rationale.',
      parameters: { type: 'object', properties: {
        change_type: { type: 'string', enum: ['src-change', 'agent-prompt-change', 'coordinator-prompt-change', 'skill-create'], description: 'Type of change: src-change (TypeScript/config file), agent-prompt-change (agent system prompt in agents.json), coordinator-prompt-change (prompt field in coordinator.json), skill-create (create a new skill).' },
        file:        { type: 'string', description: 'For src-change: relative path from src/ e.g. "core/prompts.ts". For agent-prompt-change: agent name. For coordinator-prompt-change: prompt key (decompositionPrompt/routingPrompt/clarificationPrompt/synthesisPrompt). For skill-create: ignored.' },
        original:    { type: 'string', description: 'For src-change/agent-prompt-change/coordinator-prompt-change: exact verbatim text to replace (must exist). For skill-create: skill name (kebab-case).' },
        replacement: { type: 'string', description: 'For src-change/agent-prompt-change/coordinator-prompt-change: new text to substitute. For skill-create: full skill spec as JSON string.' },
        rationale:   { type: 'string', description: 'Why this change improves quality. Reference specific rubric gaps, fabrication patterns, or observed failures.' },
        rubric_gaps: { type: 'array', items: { type: 'string' }, description: 'Rubric item IDs this targets e.g. ["#7", "#10"]' },
      }, required: ['change_type', 'file', 'original', 'replacement', 'rationale'] },
    }},
  ]
}

function buildSkillTools(): unknown[] {
  return [
    { type: 'function', function: {
      name: 'use_skill',
      description:
        'Run a registered executable skill and get its deterministic result. Use this ' +
        'instead of re-deriving a procedure by hand when an Available skill fits (e.g. a ' +
        'validator or checker). Returns { ok, exit_code, result, stdout, stderr }.',
      parameters: { type: 'object', properties: {
        name:  { type: 'string', description: 'Skill name exactly as listed under Available skills.' },
        input: { description: 'Input value passed to the skill as JSON (object, array, string, etc.).' },
      }, required: ['name'] },
    }},
    { type: 'function', function: {
      name: 'create_skill',
      description:
        'Register a reusable executable skill so future runs can invoke it via use_skill. ' +
        'Provide working code plus examples; if the examples pass, the skill is promoted to ' +
        'stable automatically. Prefer this for checks/validators you would otherwise rewrite.',
      parameters: { type: 'object', properties: {
        name:            { type: 'string', description: 'kebab-case skill name.' },
        description:     { type: 'string', description: 'What it does and WHEN to use it (this is the discovery surface).' },
        language:        { type: 'string', description: 'Runtime language string, e.g. "python", "node".' },
        code:            { type: 'string', description: 'Entrypoint source. In entrypoint mode define skill(input) and return the result.' },
        input_mode:      { type: 'string', enum: ['entrypoint', 'raw'], description: 'entrypoint (default): define skill(input). raw: read stdin and print the ===SKILL_RESULT=== fence yourself.' },
        input_contract:  { type: 'string', description: 'One line: what input the skill expects.' },
        output_contract: { type: 'string', description: 'One line: what result it returns.' },
        examples:        { type: 'array', description: 'Array of { input, expect } used as the deterministic self-test gate to stable.', items: { type: 'object' } },
        tags:            { type: 'array', items: { type: 'string' } },
      }, required: ['name', 'description', 'language', 'code'] },
    }},
  ]
}

// Resolve the URL of the registered exec tool server (its defs GET URL is also
// its POST target). Cached. CODE_EXEC_URL overrides discovery when set. Discovery
// now keys on the `bash` tool -- the orchestrail-exec server advertises bash /
// write_file / read_file / list_files instead of the old Piston run_code.
let _codeExecUrl: string | null = null
async function resolveCodeExecUrl(): Promise<string | null> {
  if (CODE_EXEC_URL) return CODE_EXEC_URL
  if (_codeExecUrl) return _codeExecUrl
  const tools = (_deps?.getTools() ?? []).filter(t => t.enabled && t.type === 'openai_tools')
  for (const tool of tools) {
    const url = tool.config['url']
    if (!url) continue
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) continue
      const defs = await res.json() as Array<{ function?: { name?: string } }>
      if (defs.some(d => d.function?.name === 'bash')) { _codeExecUrl = url; return url }
    } catch { /* try next */ }
  }
  return null
}

// Names handled by the orchestrail-exec server. The same four tools are exposed
// to agents (granted via the openai_tools registration) AND used internally by
// runCodeViaTool to run skills. executeToolCall intercepts these to inject the
// trusted runId and wrap the { name, runId, arguments } envelope -- the model
// never supplies a runId and these never fall through to the generic HTTP path.
const EXEC_TOOLS = new Set(['bash', 'write_file', 'read_file', 'list_files'])

// Map a language string to the file extension and the bash command that runs a
// file of that language. The exec server is a dumb sandboxed shell -- this is
// where the language->command knowledge lives (the inverse of the old Piston
// filename map). `$F` is substituted with the temp filename. Unknown languages
// throw so a misconfigured skill fails loudly instead of silently mis-running.
function execLangSpec(language: string): { ext: string; run: (f: string) => string } {
  const l = language.toLowerCase()
  if (l.startsWith('python') || l === 'py')
    return { ext: 'py', run: f => `python3 ${f}` }
  if (l.startsWith('node') || l.startsWith('javascript') || l === 'js')
    return { ext: 'js', run: f => `node ${f}` }
  if (l.startsWith('typescript') || l === 'ts')
    return { ext: 'ts', run: f => `npx --yes tsx ${f}` }
  if (l === 'bash' || l === 'sh')
    return { ext: 'sh', run: f => `bash ${f}` }
  if (l === 'ruby' || l === 'rb')
    return { ext: 'rb', run: f => `ruby ${f}` }
  if (l === 'go')
    return { ext: 'go', run: f => `go run ${f}` }
  throw new Error(`unsupported exec language "${language}" (no run mapping)`)
}

// POST a single tool call to the exec server with the trusted runId envelope.
// Returns the parsed `result` payload (or throws on transport/HTTP failure).
async function execToolPost(url: string, name: string, runId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, runId, arguments: args }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300)
    throw new Error(`exec ${name} HTTP ${res.status}: ${body}`)
  }
  const data = await res.json() as Record<string, unknown>
  return (data['result'] ?? data) as Record<string, unknown>
}

// The CodeExecFn handed to skillexec. Skills now run through the SAME path agents
// use: write the program to a temp file in the run's workbench, then `bash` it,
// piping the caller's input JSON to stdin. There is no run_code primitive on the
// exec server -- the four stateful tools are the whole surface. The runId scoping
// the exec server requires comes from the workbench AsyncLocalStorage already in
// scope here (pipeline run id, or 'default' on the streaming completions path).
export const runCodeViaTool: CodeExecFn = async (language, code, stdin) => {
  const url = await resolveCodeExecUrl()
  if (!url) throw new Error('no exec endpoint registered (set CODE_EXEC_URL or enable an orchestrail-exec tool)')
  const runId = workbenchIdStorage.getStore() ?? 'default'
  const spec  = execLangSpec(language)
  // PEP 563 shim: a python runtime older than 3.10 raises on PEP 604 unions
  // (`dict | None`) evaluated at def time. Forcing string annotations is safe and
  // a no-op on 3.10+. Applied only to the code that actually runs -- never to
  // stored slots or the deliverable.
  const execCode = language === 'python' ? ensurePyFutureAnnotations(code) : code

  const fname = `__skill_${uuidv4()}.${spec.ext}`
  // 1) lay the program down in the run's private workbench dir
  await execToolPost(url, 'write_file', runId, { path: fname, content: execCode })
  // 2) run it, capture the program's exit code, then clean up the temp file
  //    (rc preserved so a failing skill still reports its real exit code)
  const command = `${spec.run(fname)}; rc=$?; rm -f ${fname}; exit $rc`
  const r = await execToolPost(url, 'bash', runId, { command, stdin })

  const stdout = String(r['stdout'] ?? '')
  const stderr = String(r['stderr'] ?? '')
  const exit_code = typeof r['exit_code'] === 'number' ? (r['exit_code'] as number) : 1
  return { stdout, stderr, exit_code }
}

// In the single-namespace python-run-tests harness, the implementation is exec'd
// into the same namespace as test_code, so importing it by module name is never
// required. Strip test_code import lines that pull ONLY implementation-defined
// symbols (or the literal `implementation` module); the in-namespace definitions
// resolve instead. This makes the skill path robust to whatever module name the
// agent guessed (fibonacci / main / implementation). Lines importing any non-impl
// symbol (stdlib, third-party) are preserved untouched.
function stripRedundantImplImports(code: string, testCode: string): string {
  const symbols = new Set<string>()
  for (const m of code.matchAll(/^[ \t]*(?:def|class)[ \t]+(\w+)/gm)) symbols.add(m[1]!)
  if (symbols.size === 0) return testCode
  return testCode.split('\n').map(line => {
    const fromImp = line.match(/^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+(.+?)[ \t]*$/)
    if (fromImp) {
      if (fromImp[1] === 'implementation') return ''
      const names = fromImp[2]!.split(',')
        .map(s => s.trim().split(/\s+as\s+/)[0]!.trim())
        .filter(Boolean)
      if (names.length > 0 && names.every(n => symbols.has(n))) return ''
    }
    if (/^[ \t]*import[ \t]+implementation\b/.test(line)) return ''
    return line
  }).join('\n')
}

// Pick the extension for implementation.<ext> from the declared runtimes slot,
// defaulting to py. Keeps the materialized filename aligned with the runtime the
// architect declared so `from implementation import ...` matches the language.
function implementationExt(): string {
  try {
    const raw = wbGet('runtimes')
    if (raw) {
      let lang = ''
      try {
        const parsed = JSON.parse(raw) as unknown
        if (Array.isArray(parsed) && (parsed[0] as { language?: string })?.language) {
          lang = String((parsed[0] as { language: string }).language)
        } else if ((parsed as { language?: string })?.language) {
          lang = String((parsed as { language: string }).language)
        }
      } catch {
        const m = raw.match(/([A-Za-z]+)/)
        if (m) lang = m[1]!
      }
      if (lang) return execLangSpec(lang).ext
    }
  } catch { /* unknown language -> default below */ }
  return 'py'
}

// Mirror the implementation slot to a file in the current run's exec dir. Awaited
// by workbench_write; failures are swallowed (a run without an exec endpoint, or
// a transient exec error, must not block the slot write itself).
async function materializeImplementation(content: string): Promise<void> {
  try {
    const url = await resolveCodeExecUrl()
    if (!url) return
    const runId = workbenchIdStorage.getStore() ?? 'default'
    const ext = implementationExt()
    await execToolPost(url, 'write_file', runId, { path: `implementation.${ext}`, content })
    console.log(`[workbench] materialized implementation.${ext} in run ${runId} (${content.length}b)`)
  } catch (err) {
    console.log(`[workbench] implementation materialization skipped: ${String(err)}`)
  }
}

// -- Tool call execution -------------------------------------------------------

export async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  urlMap: Map<string, string>,
  agentName?: string,
  specAssignee?: string,
): Promise<string> {
  const tools = _deps?.getTools() ?? []
  const url = urlMap.get(name)
  if (!url) return JSON.stringify({ error: `No tool registered for function: ${name}` })

  // AIWiki sentinel
  if (url === WIKI_SENTINEL) return executeWikiTool(name, args, agentName)

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
      const slot = String(args['slot'] ?? '')
      let content = String(args['content'] ?? '')

      if (!slot) return JSON.stringify({ error: 'slot is required' })

      content = stripCodeBlockDelimiters(content)
      content = stripThinkBlocks(content)

      if (slot === 'runtimes') {
        content = content.trim().toLowerCase()
        const validPattern = /^(python|rust|java|node|javascript|typescript|go|csharp|php|ruby|swift|kotlin)(-\d+\.\d+(\.\d+)?)?$/
        if (!validPattern.test(content)) {
          return JSON.stringify({
            error: `Invalid runtime '${content}'. Must be a language name or versioned string like 'python-3.9.4', 'rust-1.70.0', 'java-15.0.2'. Call list_runtimes and copy the exact language string plus version.`,
          })
        }
        wbSet(slot, content)
        return JSON.stringify({ ok: true, slot, bytes: content.length })
      }

      const deliverableSlots = ['implementation', 'blueprint']
      const isDeliverableSlot = deliverableSlots.includes(slot)

      if (isDeliverableSlot && isObviouslyProse(content)) {
        const hint = slot === 'blueprint'
          ? 'design specification — pseudocode, YAML structure, data models, or technical notes'
          : 'the actual deliverable — source code, configuration file, YAML, JSON, script, etc.'
        const errorMsg = `BLOCKED: workbench_write('${slot}') rejected. Content appears to be a natural language explanation rather than a deliverable artifact. Write the ${hint}, not a description of what you plan to produce.`
        console.log(`[workbench] ${agentName || specAssignee} blocked: prose detected in slot ${slot}`)
        return JSON.stringify({ error: errorMsg })
      }

      if (specAssignee === 'test-engineer' && isDeliverableSlot) {
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

      const agent = agentName ? agentMap().get(agentName) : null
      const readOnlySlots = agent?.readOnlySlots ?? []
      const isReviewerWritingImpl =
        (agentName === 'adversarial-reviewer' || specAssignee === 'adversarial-reviewer') &&
        slot === 'implementation'
      if (readOnlySlots.includes(slot) || isReviewerWritingImpl) {
        const errorMsg = `BLOCKED: workbench_write('${slot}') rejected. This agent is only allowed to READ from '${slot}', not write to it.`
        console.log(`[workbench] ${agentName ?? specAssignee} blocked: read-only slot ${slot}`)
        return JSON.stringify({ error: errorMsg })
      }

      if (slot === 'implementation') {
        const isTestHarness =
          /\bimport\s+implementation\b/.test(content) ||
          /\bassert\s+hasattr\s*\(\s*implementation\b/.test(content) ||
          /\bassert\s+implementation\./.test(content) ||
          /^import sys\b[\s\S]*?\bimport implementation\b/m.test(content)
        if (isTestHarness) {
          const errorMsg =
            `BLOCKED: workbench_write('implementation') rejected. Content appears to be a test harness ` +
            `(it imports or asserts against the implementation module). ` +
            `Write ONLY source code to the implementation slot -- test code belongs in your bash test run or a use_skill python-run-tests call.`
          console.log(`[workbench] ${agentName ?? specAssignee} blocked: test harness detected in implementation slot`)
          return JSON.stringify({ error: errorMsg })
        }
      }

      wbSet(slot, content)
      // Materialize the implementation slot as a real file in the run's exec dir
      // so agents (and the skill harness, which execs in that dir) can resolve
      // `from implementation import <name>` -- their dominant instinct -- instead
      // of guessing filenames (main.py / fibonacci.py) or inventing paths
      // (/testbed, /home/user). This is the filesystem analogue of the old slot
      // injection: the orchestrator mirrors the canonical verified slot to a
      // canonical filename, it authors nothing. Best-effort; awaited so the file
      // exists before we return ok, but a missing exec endpoint is non-fatal.
      if (slot === 'implementation') {
        await materializeImplementation(content)
      }
      if (memoryEnabled() && !isFailureArtifact(content)) {
        const convId = wbIdToConversationId.get(workbenchIdStorage.getStore() ?? 'default')
        if (convId) {
          qdrantUpsert(cols.conversation, `${convId}:${slot}`, content, {
            conversationId: convId, slot, ts: Date.now(),
          }).catch(() => {})
        }
      }
      return JSON.stringify({ ok: true, slot, bytes: content.length })
    }
    if (name === 'workbench_search') {
      if (!memoryEnabled()) return JSON.stringify({ error: 'Extended memory is not enabled.' })
      const query  = String(args['query'] ?? '')
      const convId = wbIdToConversationId.get(workbenchIdStorage.getStore() ?? 'default')
      const filter = convId
        ? { must: [{ key: 'conversationId', match: { value: convId } }] }
        : undefined
      const hits   = await qdrantSearch(cols.conversation, query, 5, filter)
      const results = hits.map(h => ({
        slot:    h.payload['slot'],
        content: h.payload['text'],
        score:   h.score,
      }))
      return JSON.stringify(results)
    }
    if (name === 'list_runtimes') {
      const cached = wbGet('runtimes')
      if (cached) return cached
      try {
        const execUrl = await resolveCodeExecUrl()
        if (execUrl) {
          // exec server exposes GET /runtimes alongside the POST / dispatch
          const runtimesUrl = execUrl.replace(/\/+$/, '') + '/runtimes'
          const res = await fetch(runtimesUrl, { signal: AbortSignal.timeout(8000) })
          if (res.ok) {
            const data = await res.json() as { result?: unknown }
            const runtimes = data.result ?? data
            const jsonStr = JSON.stringify(runtimes)
            wbSet('runtimes', jsonStr)
            return jsonStr
          }
        }
      } catch {}
      return JSON.stringify({ error: 'Failed to fetch runtimes from the exec server' })
    }
    return JSON.stringify({ error: `Unknown workbench operation: ${name}` })
  }

  // Skill capability sentinel
  if (url === SKILL_SENTINEL) {
    if (name === 'use_skill') {
      let skillName   = String(args['name'] ?? '')
      let skillInput  = args['input']
      // Envelope auto-repair: the model sometimes nests everything under `input`
      // and omits the top-level `name` (-> "name is required", a wasted round-trip
      // and a spurious failure record). When the input carries a python-run-tests
      // shape (code + test_code), default the name instead of rejecting.
      const inObj = (skillInput && typeof skillInput === 'object')
        ? skillInput as Record<string, unknown> : undefined
      // Envelope auto-repair: a `test_code` argument is unique to python-run-tests,
      // so its presence is enough to recover an omitted name (the model often nests
      // everything under `input` and drops the top-level `name`). Widened from
      // requiring code+test_code to test_code alone, since `code` is now optional --
      // see the slot-default below.
      if (!skillName && inObj && 'test_code' in inObj) {
        skillName = 'python-run-tests'
        console.log('[use_skill] recovered missing name -> python-run-tests (test_code shape)')
      }
      if (!skillName) return JSON.stringify({ error: 'name is required' })
      if (skillName === 'python-run-tests' && inObj) {
        let nextInput: Record<string, unknown> = inObj
        // Affordance, not agency: the code under test is unambiguously the
        // `implementation` slot the orchestrator already owns. The test-engineer's
        // real work is authoring `test_code`; making it also echo back the
        // implementation in the same call is the most complex part of the one tool
        // call it most often fails. When `code` is omitted or blank, default it from
        // the slot. If the agent DID pass code, respect it verbatim (do not clobber).
        const hasUsableCode = typeof nextInput['code'] === 'string'
          && (nextInput['code'] as string).trim().length > 0
        if (!hasUsableCode) {
          const slotImpl = wbGet('implementation')
          if (slotImpl && slotImpl.trim()) {
            nextInput = { ...nextInput, code: slotImpl }
            console.log('[use_skill] python-run-tests: defaulted `code` from implementation slot ' +
              `(${slotImpl.length}b); agent supplied test_code only`)
          }
        }
        // Apply the PEP 563 shim to whatever code we are about to run so the harness
        // compiles `dict | None` annotations on a sub-3.10 runtime.
        if (typeof nextInput['code'] === 'string') {
          nextInput = { ...nextInput, code: ensurePyFutureAnnotations(nextInput['code'] as string) }
        }
        // Backstop for the single-namespace harness: the implementation is exec'd
        // into the SAME namespace as test_code, so importing it by module name is
        // never necessary and is the main fragility -- agents guess `from fibonacci
        // import ...` / `from main import ...` / `from implementation import ...`
        // and hit ImportError when the guessed module/name does not line up. Strip
        // import lines that pull ONLY implementation-defined symbols (or the literal
        // `implementation` module); the in-namespace definitions then resolve.
        // Non-impl imports (stdlib, third-party) are untouched.
        if (typeof nextInput['code'] === 'string' && typeof nextInput['test_code'] === 'string') {
          const stripped = stripRedundantImplImports(nextInput['code'] as string, nextInput['test_code'] as string)
          if (stripped !== nextInput['test_code']) {
            nextInput = { ...nextInput, test_code: stripped }
            console.log('[use_skill] python-run-tests: stripped redundant impl-symbol imports from test_code')
          }
        }
        skillInput = nextInput
      }
      const result = await runSkill(skillName, skillInput, runCodeViaTool)
      return JSON.stringify(result)
    }
    if (name === 'create_skill') {
      const input: CreateSkillInput = {
        name:            String(args['name'] ?? ''),
        description:     String(args['description'] ?? ''),
        language:        String(args['language'] ?? ''),
        code:            String(args['code'] ?? ''),
        input_mode:      args['input_mode'] === 'raw' ? 'raw' : 'entrypoint',
        input_contract:  args['input_contract']  !== undefined ? String(args['input_contract'])  : undefined,
        output_contract: args['output_contract'] !== undefined ? String(args['output_contract']) : undefined,
        examples:        Array.isArray(args['examples']) ? args['examples'] as CreateSkillInput['examples'] : undefined,
        tags:            Array.isArray(args['tags']) ? (args['tags'] as string[]) : undefined,
      }
      // Author is the agent that called the tool (trusted authoring path).
      const result = await createSkill(input, runCodeViaTool, 'agent')
      return JSON.stringify(result)
    }
    return JSON.stringify({ error: `Unknown skill operation: ${name}` })
  }

  // Self-improvement sentinel
  if (url === SELF_IMPROVE_SENTINEL) {
    if (name === 'read_source_file') {
      const relPath = String(args['path'] ?? '')
      if (!relPath) return JSON.stringify({ error: 'path is required' })
      try {
        const abs = resolveSourcePath(relPath)
        const content = fs.readFileSync(abs, 'utf8')
        return JSON.stringify({ path: relPath, content, bytes: content.length })
      } catch (err) {
        return JSON.stringify({ error: String(err) })
      }
    }
    if (name === 'propose_edit') {
      const changeType  = String(args['change_type'] ?? 'src-change') as import('../types/index.js').ChangeType
      const relFile     = String(args['file']        ?? '')
      const original    = String(args['original']    ?? '')
      const replacement = String(args['replacement'] ?? '')
      const rationale   = String(args['rationale']   ?? '')
      const rubricGaps  = Array.isArray(args['rubric_gaps'])
        ? (args['rubric_gaps'] as string[]) : []

      const validChangeTypes = new Set(['src-change', 'agent-prompt-change', 'coordinator-prompt-change', 'skill-create'])
      if (!validChangeTypes.has(changeType)) {
        return JSON.stringify({ error: `Invalid change_type: ${changeType}. Must be one of: src-change, agent-prompt-change, coordinator-prompt-change, skill-create` })
      }
      if (!original)    return JSON.stringify({ error: 'original is required' })
      if (!replacement) return JSON.stringify({ error: 'replacement is required' })
      if (!rationale)   return JSON.stringify({ error: 'rationale is required' })

      // Dedup guard: skip if an identical pending proposal already exists
      const { loadPendingChanges: _lpcd } = await import('./persistence.js')
      const existingChanges = _lpcd()
      const dupe = existingChanges.find(c =>
        c.status === 'pending' &&
        (changeType === 'skill-create'
          ? c.changeType === 'skill-create' && c.original === original
          : c.file === relFile && c.original === original),
      )
      if (dupe) {
        return JSON.stringify({ ok: true, deduplicated: true, existingId: dupe.id, message: 'An identical pending proposal already exists -- skipped.' })
      }

      // Per-type validation
      if (changeType === 'src-change') {
        if (!relFile) return JSON.stringify({ error: 'file is required for src-change' })
        let fileContent: string
        try {
          const abs = resolveSourcePath(relFile)
          fileContent = fs.readFileSync(abs, 'utf8')
        } catch (err) {
          return JSON.stringify({ error: `Cannot read file: ${String(err)}` })
        }
        if (!fileContent.includes(original)) {
          return JSON.stringify({
            error: 'VALIDATION FAILED: original text not found verbatim in file. ' +
                   'Read the file first with read_source_file and copy the exact text to replace.',
          })
        }
      } else if (changeType === 'agent-prompt-change') {
        // validate agent exists
        const agents = _deps?.getAgents() ?? []
        if (!agents.find(a => a.name === relFile)) {
          return JSON.stringify({ error: `Agent not found: ${relFile}. Use exact agent name as it appears in the agent list.` })
        }
        const agent = agents.find(a => a.name === relFile)!
        if (!agent.systemPrompt.includes(original)) {
          return JSON.stringify({ error: 'VALIDATION FAILED: original text not found verbatim in agent system prompt. Read the current prompt first.' })
        }
      } else if (changeType === 'coordinator-prompt-change') {
        const validKeys = new Set(['decompositionPrompt', 'routingPrompt', 'clarificationPrompt', 'synthesisPrompt'])
        if (!validKeys.has(relFile)) {
          return JSON.stringify({ error: `Invalid coordinator prompt key: ${relFile}. Valid keys: decompositionPrompt, routingPrompt, clarificationPrompt, synthesisPrompt` })
        }
        const { loadCoordinator: _lc } = await import('./persistence.js')
        const coord = _lc()
        const currentVal = (coord as unknown as Record<string, unknown>)[relFile]
        if (typeof currentVal === 'string' && !currentVal.includes(original)) {
          return JSON.stringify({ error: 'VALIDATION FAILED: original text not found verbatim in coordinator prompt field.' })
        }
      } else if (changeType === 'skill-create') {
        // For skill-create: original = skill name, replacement = skill spec JSON
        // Validate it's valid JSON
        try {
          JSON.parse(replacement)
        } catch {
          return JSON.stringify({ error: 'For skill-create, replacement must be valid JSON representing the skill spec.' })
        }
      }

      const ctx = toolLogContextStorage.getStore()
      const change: import('../types/index.js').PendingChange = {
        id:          uuidv4(),
        timestamp:   new Date().toISOString(),
        triggeredBy: ctx?.conversationId ?? 'unknown',
        agent:       agentName ?? 'unknown',
        file:        relFile,
        original,
        replacement,
        rationale,
        rubricGaps,
        status:      'pending',
        changeType,
      }
      appendPendingChange(change)
      console.log(`[propose_edit] recorded ${changeType} change ${change.id} for ${relFile} by ${agentName}`)

      // Fire-and-forget background R1 review
      reviewProposalBackground(change.id).catch((e) => {
        console.warn(`[propose_edit] reviewer background job failed for ${change.id}: ${e}`)
      })

      return JSON.stringify({
        ok:      true,
        id:      change.id,
        file:    relFile,
        changeType,
        status:  'pending',
        message: 'Change recorded. A human must approve it in the admin UI before it is applied.',
      })
    }
    return JSON.stringify({ error: `Unknown self-improvement operation: ${name}` })
  }

  // RAG search sentinel
  if (url.startsWith('__qdrant__:')) {
    const toolId = url.slice('__qdrant__:'.length)
    const tool   = tools.find(t => t.id === toolId)
    if (!tool) return JSON.stringify({ error: `Qdrant tool not found: ${toolId}` })
    return executeRagSearch(tool, args as { query: string; collection?: string; limit?: number })
  }

  // SearXNG web search sentinel
  if (url.startsWith('__searxng__:')) {
    const toolId = url.slice('__searxng__:'.length)
    const tool   = tools.find(t => t.id === toolId)
    if (!tool) return JSON.stringify({ error: `SearXNG tool not found: ${toolId}` })
    const baseUrl = tool.config['url']?.replace(/\/$/, '')
    if (!baseUrl) return JSON.stringify({ error: 'SearXNG tool has no URL configured' })
    const query = String((args as { query?: string }).query ?? '')
    const limit = Number((args as { limit?: number }).limit ?? 5)
    if (!query) return JSON.stringify({ error: 'query is required' })
    try {
      const searchUrl = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json`
      const res = await fetch(searchUrl, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return JSON.stringify({ error: `SearXNG returned ${res.status}` })
      const data = await res.json() as { results?: { title?: string; url?: string; content?: string }[] }
      const results = (data.results ?? []).slice(0, limit).map(r => ({
        title:   r.title   ?? '',
        url:     r.url     ?? '',
        snippet: r.content ?? '',
      }))
      return JSON.stringify({ results })
    } catch (err) {
      return JSON.stringify({ error: `SearXNG request failed: ${String(err)}` })
    }
  }

  // RAG Manager sentinel
  if (url.startsWith('__rag_manager__:')) {
    const toolId = url.slice('__rag_manager__:'.length)
    const tool   = tools.find(t => t.id === toolId)
    if (!tool) return JSON.stringify({ error: `RAG Manager tool not found: ${toolId}` })
    return executeRagManagerCall(tool, name, args as { query: string; limit?: number })
  }

  // Exec tools (bash / write_file / read_file / list_files): the orchestrail-exec
  // server expects a { name, runId, arguments } envelope and scopes every call to
  // /workbench/{runId}/. The runId is the trusted pipeline run id from the
  // workbench AsyncLocalStorage -- it is injected here, NEVER taken from the model
  // (the GET / schema does not even advertise it). Routing through one place keeps
  // direct agent calls and skill invocations (runCodeViaTool) on one envelope and
  // one normalized reply, and is what agent.ts parses for its outcome gate.
  if (EXEC_TOOLS.has(name)) {
    const execUrl = await resolveCodeExecUrl()
    if (!execUrl) return JSON.stringify({ error: 'no exec endpoint registered (set CODE_EXEC_URL or enable an orchestrail-exec tool)', exit_code: 1 })
    const runId = workbenchIdStorage.getStore() ?? 'default'
    try {
      const r = await execToolPost(execUrl, name, runId, args)
      return JSON.stringify(r)
    } catch (err) {
      return JSON.stringify({ error: String(err), exit_code: 1 })
    }
  }

  // Generic HTTP tool
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(args),
      signal:  AbortSignal.timeout(30_000),
    })
    if (!res.ok) return JSON.stringify({ error: `Tool HTTP ${res.status}: ${await res.text()}` })
    return JSON.stringify(await res.json())
  } catch (err) {
    return JSON.stringify({ error: String(err) })
  }
}
