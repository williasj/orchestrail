// -- RAG split-storage kernel --------------------------------------------------
// Collection-agnostic engine for the "Qdrant index + filesystem canonical store"
// pattern proven in core/skills.ts. The skill system hard-codes its schema,
// directories, and Qdrant collection; this kernel lifts those out into a
// per-collection CollectionSpec so workbench / failures / users become
// configuration rather than copies of the skill pipeline.
//
// Storage model (split), identical to skills:
//   - Qdrant <spec.collection>: embedding of a description/summary + a file_path
//     pointer + projected metadata. NEVER the canonical record.
//   - Filesystem <spec.dir>/<subdir?>/<id>.<ext>: the canonical record, fetched
//     whole at recall time (atomic, all-or-nothing).
//
// Flow (per collection, all parameterized by the spec):
//   Import:  file -> codec.parse -> hash check -> refine? -> embed -> writeback -> upsert
//   Recall:  query -> embed -> search -> read file (whole) -> spec.format
//   Watch:   fs.watch(dir) debounced -> import
//   Startup: scan dir(s) -> import missing/changed -> orphan cleanup
//
// What this kernel deliberately does NOT do:
//   - chunk anything (no collection in this service is chunked; see investigation)
//   - migrate existing Qdrant points (that is a separate, later, per-collection job)
//   - touch institutional memory (`meta`), which stays atomic-whole in Qdrant

import * as fs   from 'node:fs'
import * as fsp  from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type { CoordinatorConfig } from '../types/index.js'

// -- Module init ---------------------------------------------------------------

type RagKernelDeps = {
  getCoordinator: () => CoordinatorConfig
}

let _deps: RagKernelDeps | null = null

export function initRagKernel(deps: RagKernelDeps): void {
  _deps = deps
}

function memCfg() {
  return _deps?.getCoordinator().memory
}

/** A collection is "live" only if Qdrant + TEI + a vector size are configured. */
export function ragKernelEnabled(): boolean {
  const m = memCfg()
  return !!(m?.qdrantUrl && m?.teiUrl && m?.vectorSize)
}

// -- Canonical record shape ----------------------------------------------------
// Every canonical record is a (meta, body) pair regardless of on-disk format.
// Markdown+frontmatter: meta = frontmatter, body = prose after the closing ---.
// JSON: meta = the object minus the body key, body = the body key (often '').

export interface CanonicalDoc {
  meta: Record<string, unknown>
  body: string
}

export interface CanonicalCodec {
  /** File extension including the dot, e.g. '.md' or '.json'. */
  ext: string
  /** Parse raw file contents; return null if the record is malformed. */
  parse(raw: string): CanonicalDoc | null
  /** Serialize back to the canonical on-disk form. */
  serialize(doc: CanonicalDoc): string
}

// -- CollectionSpec ------------------------------------------------------------
// Everything that differs between skills / workbench / failures / users.
// The kernel functions below are pure with respect to this spec.

export interface CollectionSpec {
  /** Qdrant collection name (e.g. cols.failures). */
  collection: string
  /** Filesystem canonical-store root (container path under /data/orchestrail). */
  dir: string
  /** Optional subdirectories under `dir` to scan/watch. Default: ['']  (flat). */
  subdirs?: string[]
  /** On-disk canonical format. */
  codec: CanonicalCodec

  /** Stable, collision-resistant string key for a record (-> djb2 id + filename). */
  idOf: (meta: Record<string, unknown>) => string
  /** The text that gets embedded for retrieval (a description/summary, NOT the body). */
  embedSource: (meta: Record<string, unknown>, body: string) => string
  /** Project meta onto the Qdrant payload. file_path + content_hash are added by the kernel. */
  payloadOf: (meta: Record<string, unknown>) => Record<string, unknown>

  /** Optional Qdrant filter applied at recall time (e.g. status in {stable,provisional}). */
  recallFilter?: Record<string, unknown>
  /** Minimum cosine score to accept a recall hit. Default: 0.65. */
  similarityThreshold?: number
  /** Format a recalled record for injection into a prompt. */
  format: (doc: CanonicalDoc, score: number) => string

  /** Optional LLM consultation to refine the record before embedding (mutates meta). */
  refine?: (meta: Record<string, unknown>, body: string) => Promise<void>
  /** author_type recorded for files arriving via the watcher. Default: 'human'. */
  watchAuthor?: 'agent' | 'human'

  /** Logging prefix, e.g. '[failures]'. */
  tag: string
}

// -- Hash ----------------------------------------------------------------------

export function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

// Kernel-owned fields that ragImportFile stamps onto a record during its own
// write-back. They MUST be excluded from the change-hash: otherwise the import's
// write-back mutates the bytes the hash is computed over, so the file never
// matches its stored hash, the skip never fires, and the fs watcher re-imports
// the same record forever (embed + upsert on every loop). Hashing only the
// semantic content (non-kernel meta + body) makes the hash a true change-detector
// that is stable across the kernel's own write-back -> the second pass is skipped.
const KERNEL_META_KEYS = new Set([
  'author_type', 'file_path', 'content_hash', 'last_updated', 'created_at', 'last_verified_at',
])

function stableContentHash(doc: CanonicalDoc): string {
  const stable: Record<string, unknown> = {}
  for (const key of Object.keys(doc.meta).sort()) {
    if (KERNEL_META_KEYS.has(key)) continue
    stable[key] = doc.meta[key]
  }
  return computeHash(JSON.stringify(stable) + '\u0000' + doc.body)
}

/** djb2 -> unsigned 32-bit, matching the stable-id scheme used in skills.ts. */
function djb2Id(key: string): number {
  let h = 5381
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0
  return h
}

// -- TEI embed -----------------------------------------------------------------

async function embed(text: string): Promise<number[] | null> {
  const m = memCfg()
  if (!m?.teiUrl) return null
  // Hard cap well under TEI's 512-token limit; auto_truncate is OFF on this
  // instance, so an over-limit input is an error, not a silent truncation.
  const safe = text.slice(0, 500)
  try {
    const res = await fetch(`${m.teiUrl}/embed`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ inputs: safe }),
      signal:  AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const vectors = await res.json() as number[][]
    return vectors[0] ?? null
  } catch {
    return null
  }
}

// -- Qdrant primitives (self-contained, consistent with skills.ts) -------------

export async function ragEnsureCollection(spec: CollectionSpec): Promise<void> {
  const m = memCfg()
  if (!m?.qdrantUrl || !m?.vectorSize) return
  const res = await fetch(`${m.qdrantUrl}/collections/${spec.collection}`, { method: 'GET' })
  if (res.ok) return
  await fetch(`${m.qdrantUrl}/collections/${spec.collection}`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ vectors: { size: m.vectorSize, distance: 'Cosine' } }),
  })
}

async function qUpsert(
  collection: string,
  id:         number,
  vector:     number[],
  payload:    Record<string, unknown>,
): Promise<void> {
  const m = memCfg()
  if (!m?.qdrantUrl) return
  await fetch(`${m.qdrantUrl}/collections/${collection}/points`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ points: [{ id, vector, payload }] }),
    signal:  AbortSignal.timeout(10_000),
  })
}

async function qSearch(
  collection: string,
  vector:     number[],
  limit:      number,
  filter?:    Record<string, unknown>,
): Promise<Array<{ score: number; payload: Record<string, unknown> }>> {
  const m = memCfg()
  if (!m?.qdrantUrl) return []
  const body: Record<string, unknown> = { vector, limit, with_payload: true }
  if (filter) body['filter'] = filter
  try {
    const res = await fetch(`${m.qdrantUrl}/collections/${collection}/points/search`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    const data = await res.json() as { result: Array<{ score: number; payload: Record<string, unknown> }> }
    return data.result ?? []
  } catch {
    return []
  }
}

async function qSetPayload(
  collection: string,
  id:         number,
  payload:    Record<string, unknown>,
): Promise<void> {
  const m = memCfg()
  if (!m?.qdrantUrl) return
  try {
    await fetch(`${m.qdrantUrl}/collections/${collection}/points/payload`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ payload, points: [id] }),
      signal:  AbortSignal.timeout(5_000),
    })
  } catch { /* non-fatal */ }
}

async function qScroll(
  collection: string,
  limit:      number,
): Promise<Array<{ id: number; payload: Record<string, unknown> }>> {
  const m = memCfg()
  if (!m?.qdrantUrl) return []
  try {
    const res = await fetch(`${m.qdrantUrl}/collections/${collection}/points/scroll`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ limit, with_payload: true }),
      signal:  AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    const data = await res.json() as { result: { points: Array<{ id: number; payload: Record<string, unknown> }> } }
    return data.result?.points ?? []
  } catch {
    return []
  }
}

// -- Directory helpers ---------------------------------------------------------

function subdirsOf(spec: CollectionSpec): string[] {
  return (spec.subdirs && spec.subdirs.length > 0) ? spec.subdirs : ['']
}

async function ensureDirs(spec: CollectionSpec): Promise<void> {
  for (const sub of subdirsOf(spec)) {
    await fsp.mkdir(path.join(spec.dir, sub), { recursive: true })
  }
}

/** Sanitize an id into a safe filename stem (no traversal, bounded length). */
function safeStem(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 120)
}

// -- Import pipeline -----------------------------------------------------------
// read -> parse -> hash skip -> refine? -> stamp pointer/hash -> writeback -> embed -> upsert

export type ImportResult = 'imported' | 'updated' | 'skipped' | 'error'

export async function ragImportFile(
  spec:       CollectionSpec,
  filePath:   string,
  authorType: 'agent' | 'human' = 'human',
): Promise<ImportResult> {
  if (!ragKernelEnabled()) return 'error'

  let raw: string
  try {
    raw = await fsp.readFile(filePath, 'utf-8')
  } catch {
    console.warn(`${spec.tag} cannot read ${filePath}`)
    return 'error'
  }

  const parsed = spec.codec.parse(raw)
  if (!parsed) {
    console.warn(`${spec.tag} malformed record in ${filePath}`)
    return 'error'
  }

  // Hash of the record as it currently sits on disk — used ONLY for the skip check.
  const readHash = stableContentHash(parsed)

  // Skip if an indexed point for this file already carries the same hash.
  const probe = await embed('placeholder')
  if (probe) {
    const existing = await qSearch(spec.collection, probe, 1, {
      must: [{ key: 'file_path', match: { value: filePath } }],
    })
    if (existing[0]?.payload['content_hash'] === readHash) return 'skipped'
  }

  const wasIndexed = String(parsed.meta['content_hash'] ?? '') !== ''
  const now = new Date().toISOString()

  // Optional LLM refinement (mutates meta in place, e.g. description/tags).
  if (spec.refine) {
    try { await spec.refine(parsed.meta, parsed.body) }
    catch { /* refinement is best-effort */ }
  }

  // Stamp the kernel-owned fields onto the canonical record itself, so the file
  // is self-describing (mirrors skills.ts writing frontmatter back to disk).
  parsed.meta['author_type']  = authorType
  parsed.meta['file_path']    = filePath
  parsed.meta['last_updated'] = now
  if (!parsed.meta['created_at']) parsed.meta['created_at'] = now

  // content_hash must be the hash of what will actually be on disk and re-read by
  // the watcher — NOT the as-read or in-memory value. After refinement and number/
  // string coercion in serialize->parse, those can differ. So serialize, re-parse,
  // and hash THAT: the next watcher pass reads the same bytes, computes the same
  // stable hash, and is skipped (no infinite re-import loop). Excluded volatile
  // fields (incl. content_hash itself) keep the hash stable across this write-back.
  parsed.meta['content_hash'] = ''
  const roundTripped = spec.codec.parse(spec.codec.serialize(parsed))
  const hash = roundTripped ? stableContentHash(roundTripped) : readHash
  parsed.meta['content_hash'] = hash

  const updated = spec.codec.serialize(parsed)
  try {
    await fsp.writeFile(filePath, updated, 'utf-8')
  } catch (e) {
    console.warn(`${spec.tag} cannot write back ${filePath}: ${e}`)
  }

  const vector = await embed(spec.embedSource(parsed.meta, parsed.body))
  if (!vector) {
    console.warn(`${spec.tag} embedding failed for ${filePath}`)
    return 'error'
  }

  const payload = {
    ...spec.payloadOf(parsed.meta),
    file_path:    filePath,
    content_hash: hash,
  }
  await qUpsert(spec.collection, djb2Id(spec.idOf(parsed.meta)), vector, payload)

  console.log(`${spec.tag} ${wasIndexed ? 'updated' : 'imported'}: ${spec.idOf(parsed.meta)}`)
  return wasIndexed ? 'updated' : 'imported'
}

/**
 * Write a canonical record from in-memory (meta, body) and index it.
 * Used by agent-generated writes and by API import handlers. Returns the path.
 */
export async function ragWriteRecord(
  spec:       CollectionSpec,
  doc:        CanonicalDoc,
  subdir:     string = '',
  authorType: 'agent' | 'human' = 'agent',
): Promise<{ path: string; result: ImportResult }> {
  await ensureDirs(spec)
  const stem     = safeStem(spec.idOf(doc.meta))
  const filePath = path.join(spec.dir, subdir, `${stem}${spec.codec.ext}`)
  await fsp.writeFile(filePath, spec.codec.serialize(doc), 'utf-8')
  const result = await ragImportFile(spec, filePath, authorType)
  return { path: filePath, result }
}

// -- Recall path ---------------------------------------------------------------

export async function ragRecall(
  spec:  CollectionSpec,
  query: string,
  limit: number = 1,
): Promise<string> {
  if (!ragKernelEnabled()) return ''

  const vector = await embed(query)
  if (!vector) return ''

  const hits = await qSearch(spec.collection, vector, limit, spec.recallFilter)
  if (hits.length === 0) return ''

  const top       = hits[0]!
  const threshold = spec.similarityThreshold ?? 0.65
  if (top.score < threshold) {
    console.log(`${spec.tag} recall: best score ${top.score.toFixed(3)} below threshold ${threshold}`)
    return ''
  }

  const filePath = String(top.payload['file_path'] ?? '')
  if (!filePath) return ''

  let raw: string
  try {
    raw = await fsp.readFile(filePath, 'utf-8')   // whole record, atomic
  } catch {
    console.warn(`${spec.tag} recall: file missing ${filePath} — orphan point`)
    return ''
  }

  const doc = spec.codec.parse(raw)
  if (!doc) return ''

  console.log(`${spec.tag} recalled ${spec.idOf(doc.meta)} (score=${top.score.toFixed(3)})`)
  return spec.format(doc, top.score)
}

// -- Startup scan + orphan cleanup ---------------------------------------------

export async function ragStartupScan(spec: CollectionSpec): Promise<void> {
  if (!ragKernelEnabled()) return
  await ragEnsureCollection(spec)
  await ensureDirs(spec)

  let imported = 0, updated = 0, orphaned = 0

  for (const sub of subdirsOf(spec)) {
    const dir = path.join(spec.dir, sub)
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch { continue }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(spec.codec.ext)) continue
      const author = sub === 'user' ? 'human' : (spec.watchAuthor ?? 'human')
      const result = await ragImportFile(spec, path.join(dir, entry.name), author)
      if (result === 'imported') imported++
      if (result === 'updated')  updated++
    }
  }

  // Orphan cleanup: points whose file_path no longer exists get marked stale.
  for (const point of await qScroll(spec.collection, 200)) {
    const filePath = String(point.payload['file_path'] ?? '')
    if (!filePath) continue
    try {
      await fsp.access(filePath)
    } catch {
      await qSetPayload(spec.collection, point.id, { status: 'orphaned' })
      orphaned++
    }
  }

  console.log(`${spec.tag} startup scan: ${imported} imported, ${updated} updated, ${orphaned} orphaned`)
}

// -- File watcher --------------------------------------------------------------
// Built-in fs.watch with debounce. The investigation notes chokidar is the
// production choice on NFS/ZFS mounts; swapping is a one-function change here.

export async function ragWatch(spec: CollectionSpec): Promise<void> {
  if (!ragKernelEnabled()) return
  await ensureDirs(spec)

  // Watch the 'user' subdir if present, else every configured subdir.
  const subs = subdirsOf(spec).includes('user') ? ['user'] : subdirsOf(spec)

  for (const sub of subs) {
    const watchDir = path.join(spec.dir, sub)
    try {
      const watcher  = fsp.watch(watchDir)
      const debounce = new Map<string, ReturnType<typeof setTimeout>>()
      console.log(`${spec.tag} watching ${watchDir}`)

      for await (const event of watcher) {
        if (!event.filename || !event.filename.endsWith(spec.codec.ext)) continue
        const filename = event.filename
        const existing = debounce.get(filename)
        if (existing) clearTimeout(existing)
        debounce.set(filename, setTimeout(async () => {
          debounce.delete(filename)
          const result = await ragImportFile(
            spec,
            path.join(watchDir, filename),
            spec.watchAuthor ?? 'human',
          )
          if (result !== 'skipped') console.log(`${spec.tag} watcher: ${result} ${filename}`)
        }, 500))
      }
    } catch (e) {
      console.warn(`${spec.tag} watcher failed to start on ${sub}: ${e}`)
    }
  }
}

// -- Codecs --------------------------------------------------------------------

/**
 * Markdown + YAML-ish frontmatter codec. The parser is the generalized form of
 * core/skills.ts parseSkillFile: string scalars, flow sequences (tags: [a, b]),
 * block sequences, folded scalars (key: >), ints and floats. Keys are arbitrary
 * (no fixed schema) so failures, skills, and any future MD collection share it.
 */
export const markdownFrontmatterCodec: CanonicalCodec = {
  ext: '.md',

  parse(content: string): CanonicalDoc | null {
    if (!content.startsWith('---')) return null
    const end = content.indexOf('\n---', 3)
    if (end === -1) return null

    const yamlStr = content.slice(3, end).trimStart()
    const body    = content.slice(end + 4).trimStart()
    const meta: Record<string, unknown> = {}

    const lines = yamlStr.split('\n')
    let i = 0
    while (i < lines.length) {
      const line = lines[i]!
      if (!line.trim() || line.trim().startsWith('#')) { i++; continue }

      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) { i++; continue }

      const key  = line.slice(0, colonIdx).trim()
      const rest = line.slice(colonIdx + 1)

      // Flow sequence: key: [a, b, c]
      const flow = rest.match(/^\s*\[([^\]]*)\]\s*$/)
      if (flow) {
        meta[key] = (flow[1] ?? '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
        i++; continue
      }

      const trimmedRest = rest.trim()
      if (trimmedRest === '') {
        // Block sequence (next lines start with '-') or empty scalar.
        if (lines[i + 1]?.match(/^\s*-\s/)) {
          const items: string[] = []
          i++
          while (i < lines.length && lines[i]!.match(/^\s*-\s/)) {
            items.push(lines[i]!.replace(/^\s*-\s*/, '').trim().replace(/^['"]|['"]$/g, ''))
            i++
          }
          meta[key] = items
          continue
        }
        meta[key] = ''
        i++; continue
      }

      // Folded scalar: key: >  (collect indented continuation lines)
      if (trimmedRest === '>') {
        const parts: string[] = []
        i++
        while (i < lines.length && (lines[i]!.startsWith('  ') || lines[i]!.trim() === '')) {
          parts.push(lines[i]!.trim())
          i++
        }
        meta[key] = parts.filter(Boolean).join(' ')
        continue
      }

      // Scalar (number-coerced when it parses cleanly).
      let val: string | number = trimmedRest.replace(/^['"]|['"]$/g, '')
      const num = Number(val)
      if (!isNaN(num) && val !== '') val = num
      meta[key] = val
      i++
    }

    return { meta, body }
  },

  serialize(doc: CanonicalDoc): string {
    const lines: string[] = ['---']
    for (const [key, value] of Object.entries(doc.meta)) {
      if (Array.isArray(value)) {
        lines.push(`${key}: [${value.join(', ')}]`)
      } else if (typeof value === 'string' && (value.length > 80 || value.includes('\n'))) {
        lines.push(`${key}: >`)
        lines.push(`  ${value.replace(/\n/g, ' ')}`)
      } else {
        lines.push(`${key}: ${String(value)}`)
      }
    }
    lines.push('---')
    return lines.join('\n') + '\n\n' + doc.body
  },
}

/**
 * JSON codec for structured-record collections (the case the investigation
 * flagged: "workbench data may be structured JSON"). The body, if any, lives
 * under the reserved `_body` key so the (meta, body) contract is preserved.
 */
export const jsonCodec: CanonicalCodec = {
  ext: '.json',

  parse(content: string): CanonicalDoc | null {
    try {
      const obj = JSON.parse(content) as Record<string, unknown>
      const body = typeof obj['_body'] === 'string' ? obj['_body'] : ''
      const meta = { ...obj }
      delete meta['_body']
      return { meta, body }
    } catch {
      return null
    }
  },

  serialize(doc: CanonicalDoc): string {
    const out: Record<string, unknown> = { ...doc.meta }
    if (doc.body) out['_body'] = doc.body
    return JSON.stringify(out, null, 2) + '\n'
  },
}
