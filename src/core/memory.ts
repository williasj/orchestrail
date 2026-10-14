// -- Memory (Qdrant + TEI) ----------------------------------------------------
// Handles vector memory: collection management, upsert, search,
// workbench rehydration, and tool-call failure learning (-> failures library).

import { cols } from '../utils/config.js'
import { wbGet, wbSet } from './workbench.js'
import { recordFailure } from './ragspecs.js'
import type { CoordinatorConfig, ToolLogEntry } from '../types/index.js'

// Coarse error classifier for the file-backed failures library. Maps a raw error
// message to one of the failures spec's error_class buckets. Best-effort only.
function classifyToolError(msg: string): string {
  const m = msg.toLowerCase()
  if (/\b(401|403)\b|unauthor|forbidden|permission|credential|api[ _-]?key|token/.test(m)) return 'auth'
  if (/timeout|timed out|etimedout|deadline exceeded/.test(m))                              return 'timeout'
  if (/\b(429)\b|rate limit|too many requests|throttl/.test(m))                             return 'rate_limit'
  if (/\b(404)\b|not found|no such|enoent|does not exist|missing/.test(m))                  return 'not_found'
  if (/econnrefused|econnreset|unreachable|network|socket hang up|dns/.test(m))             return 'network'
  if (/invalid|malformed|must be|expected|parse|schema|required|bad request|\b400\b/.test(m)) return 'malformed_input'
  return 'other'
}

// -- Module init ---------------------------------------------------------------

type MemoryDeps = {
  getCoordinator: () => CoordinatorConfig
  getToolLog:     () => ToolLogEntry[]
}

let _deps: MemoryDeps | null = null

export function initMemory(deps: MemoryDeps): void {
  _deps = deps
}

function getMemoryCfg() {
  return _deps?.getCoordinator().memory
}

// -- Core helpers --------------------------------------------------------------

export function memoryEnabled(): boolean {
  const m = getMemoryCfg()
  return !!(m?.qdrantUrl && m?.teiUrl && m?.vectorSize)
}

export async function qdrantEnsureCollection(
  qdrantUrl: string,
  name: string,
  vectorSize: number,
): Promise<void> {
  const res = await fetch(`${qdrantUrl}/collections/${name}`, { method: 'GET' })
  if (res.ok) return
  await fetch(`${qdrantUrl}/collections/${name}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vectors: { size: vectorSize, distance: 'Cosine' } }),
  })
}

export async function qdrantUpsert(
  collection: string,
  pointId: string,
  text: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const m = getMemoryCfg()
  if (!m?.qdrantUrl || !m?.teiUrl || !m?.vectorSize) return
  const embedRes = await fetch(`${m.teiUrl}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: text.slice(0, 2048) }),
  })
  if (!embedRes.ok) return
  const vectors = await embedRes.json() as number[][]
  const vector  = vectors[0]
  if (!vector) return
  // Derive a numeric ID from the string pointId via djb2
  let h = 5381
  for (let i = 0; i < pointId.length; i++) h = ((h << 5) + h + pointId.charCodeAt(i)) >>> 0
  await fetch(`${m.qdrantUrl}/collections/${collection}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points: [{ id: h, vector, payload: { ...payload, text } }] }),
  })
}

export async function qdrantSearch(
  collection: string,
  query: string,
  limit: number,
  filter?: Record<string, unknown>,
): Promise<Array<{ payload: Record<string, unknown>; score: number }>> {
  const m = getMemoryCfg()
  if (!m?.qdrantUrl || !m?.teiUrl) return []
  const embedRes = await fetch(`${m.teiUrl}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: query.slice(0, 2048) }),
  })
  if (!embedRes.ok) return []
  const vectors = await embedRes.json() as number[][]
  const vector  = vectors[0]
  if (!vector) return []
  const body: Record<string, unknown> = { vector, limit, with_payload: true }
  if (filter) body['filter'] = filter
  const searchRes = await fetch(`${m.qdrantUrl}/collections/${collection}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!searchRes.ok) return []
  const data = await searchRes.json() as {
    result: Array<{ payload: Record<string, unknown>; score: number }>
  }
  return data.result ?? []
}

// -- Workbench rehydration -----------------------------------------------------

export async function rehydrateWorkbench(conversationId: string, goal: string): Promise<void> {
  if (!memoryEnabled() || !conversationId) return
  const hits = await qdrantSearch(cols.conversation, goal, 10, {
    must: [{ key: 'conversationId', match: { value: conversationId } }],
  })
  let restored = 0
  for (const hit of hits) {
    const slot    = hit.payload['slot'] as string | undefined
    const content = hit.payload['text'] as string | undefined
    if (slot && content && wbGet(slot) === null) {
      wbSet(slot, content)
      restored++
    }
  }
  console.log(`[memory] rehydrated ${restored} workbench slot(s) for conversation ${conversationId}`)
}

// -- Tooling pattern learning --------------------------------------------------

// analyzeAndStoreToolingPatterns scans the current run's tool log for tool-call
// failure patterns (and any in-run recovery) and records each to the file-backed
// failures library, so future agent runs can recall and avoid repeating them.
export async function analyzeAndStoreToolingPatterns(runStartTs: number): Promise<void> {
  if (!memoryEnabled()) return
  const toolLog = _deps?.getToolLog() ?? []
  // toolLog is newest-first; filter to this run's entries then reverse to chronological
  const chronological = toolLog.filter(e => e.ts >= runStartTs).reverse()
  if (chronological.length === 0) return

  type PatternRecord = {
    tool:         string
    errorPattern: string
    badArgKeys:   Set<string>
    agentRoles:   Set<string>
    recoveryHint: string | null
    recovered:    boolean   // true only if a later successful call of the same tool was found in-run
  }
  const failureMap = new Map<string, PatternRecord>()

  for (let i = 0; i < chronological.length; i++) {
    const entry = chronological[i]!
    if (entry.ok) continue

    // Normalize the error message out of the JSON wrapper
    let errorMsg = entry.result
    try {
      const parsed = JSON.parse(entry.result) as Record<string, unknown>
      if (typeof parsed['error'] === 'string') errorMsg = parsed['error']
    } catch { /* use raw string */ }
    const errorSig = errorMsg.slice(0, 200)
    const key = `${entry.tool}::${errorSig}`

    if (!failureMap.has(key)) {
      failureMap.set(key, {
        tool:         entry.tool,
        errorPattern: errorSig,
        badArgKeys:   new Set<string>(),
        agentRoles:   new Set<string>(),
        recoveryHint: null,
        recovered:    false,
      })
    }
    const rec = failureMap.get(key)!
    Object.keys(entry.args).forEach(k => rec.badArgKeys.add(k))
    rec.agentRoles.add(entry.agent)

    // Find the nearest later successful call of the same tool by the same agent
    if (rec.recoveryHint === null) {
      const failedKeys = Object.keys(entry.args)
      const successEntry = chronological.slice(i + 1).find(e => {
        if (e.tool !== entry.tool || !e.ok || e.agent !== entry.agent) return false
        const a = e.args as Record<string, unknown>
        // Exclude orchestrator-internal successes. These run via privileged paths
        // (slot injection for the implementation under test), so their ARGS are
        // not a recovery the agent can reproduce -- mining them is what minted the
        // bogus "call python-run-tests with code:'' " lesson, which NameErrors as
        // a real agent invocation. An orchestratorVerified flag, or a use_skill
        // call with no `input`, marks exactly those non-reproducible successes.
        if (a['orchestratorVerified'] === true) return false
        if (entry.tool === 'use_skill' && (a['input'] === undefined || a['input'] === null)) return false
        // Require the success to share the failed call's argument shape, so a
        // structurally different call is not mistaken for the fix.
        if (failedKeys.length > 0 && !failedKeys.some(k => k in a)) return false
        return true
      })
      if (successEntry) {
        // Summarise the successful args, redacting large code/content blobs
        const safeArgs = Object.fromEntries(
          Object.entries(successEntry.args).map(([k, v]) => {
            if (k === 'code' || k === 'content') return [k, '<redacted>']
            if (typeof v === 'string' && v.length > 120) return [k, v.slice(0, 120) + '...']
            return [k, v]
          }),
        )
        rec.recoveryHint = `Correct args: ${JSON.stringify(safeArgs)}`
        rec.recovered    = true
      } else {
        // The error message itself often contains the fix (e.g. "Must be a versioned string like...")
        rec.recoveryHint = errorSig
      }
    }
  }

  if (failureMap.size === 0) return

  // Each analyzed pattern is recorded to the file-backed failures library — the
  // single split-storage store. Qdrant holds the embedding + a file_path pointer;
  // the canonical lesson lives in a .md on disk. No-op when the RAG kernel is
  // disabled (recordFailure guards internally). Confidence discipline: an in-run
  // recovery "worked once" => resolved but NOT verified (never re-tested). Strings
  // here become on-disk .md content -> keep ASCII.
  let failuresWritten = 0
  for (const rec of failureMap.values()) {
    const agentRoles = [...rec.agentRoles]
    const badArgKeys = [...rec.badArgKeys].join(', ')
    const roleLabel  = agentRoles.join(', ') || 'an agent'
    try {
      const filePath = await recordFailure({
        tool:            rec.tool,
        error_class:     classifyToolError(rec.errorPattern),
        description:     `The ${rec.tool} tool failed for ${roleLabel}: ${rec.errorPattern.slice(0, 140)}`,
        failure_context: `Agent role(s) ${roleLabel} invoked \`${rec.tool}\` with argument keys: ${badArgKeys || 'none'}.`,
        error_output:    rec.errorPattern,
        resolution:      rec.recovered ? (rec.recoveryHint ?? undefined) : undefined,
        prevention:      rec.recovered
          ? `A later agent invocation in the same run used these args and succeeded -- UNVERIFIED single-run signal, confirm before relying on it: ${rec.recoveryHint}`
          : undefined,
        resolution_type: rec.recovered ? 'fix' : 'unresolved',
        resolved:        rec.recovered,
        verified:        false,
        tags:            ['auto', 'tooling', rec.tool],
      })
      if (filePath) failuresWritten++
    } catch (e) {
      console.warn(`[failures] auto-record failed for ${rec.tool}:`, e)
    }
  }

  if (failuresWritten > 0) {
    console.log(`[failures] auto-recorded ${failuresWritten} failure record(s) from this run`)
  }
}
