// -- Conversation ID resolution and persistence --------------------------------
// Open WebUI sends no chat identifier (confirmed via body + header inspection).
// First turns get a fresh UUID for isolation; follow-up turns reconnect via
// convAliasMap keyed on hash(firstUserMsg + firstAssistantMsg).
//
// Per-conversation directory layout:
//   DATA_DIR/conversations/<userId>/<convId>/meta.json
//   DATA_DIR/conversations/<userId>/<convId>/messages.json
//   DATA_DIR/conversations/<userId>/<convId>/tool-log.json
//
// The alias map is persisted to:
//   DATA_DIR/conversations/alias-map.json
// and hydrated at module load so conversation continuity survives server restarts.
//
// userId is the pipelinesUser.email (lowercased), or '_anonymous' for callers
// that don't send Pipelines context. The toolLogContextStorage provides userId
// and conversationId at the point of registerConvAlias.

import * as fs   from 'fs'
import * as path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { djb2Short } from '../utils/hash.js'
import { DATA_DIR } from '../utils/config.js'
import { toolLogContextStorage } from './toolcontext.js'

const ALIAS_FILE = path.join(DATA_DIR, 'conversations', 'alias-map.json')

const convAliasMap = new Map<string, string>()

// -- Alias map persistence -----------------------------------------------------

function loadAliasMap(): void {
  try {
    if (!fs.existsSync(ALIAS_FILE)) return
    const raw = JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf8')) as Record<string, string>
    for (const [k, v] of Object.entries(raw)) convAliasMap.set(k, v)
    console.log(`[conversation] loaded ${convAliasMap.size} alias(es) from disk`)
  } catch (e) {
    console.warn('[conversation] Failed to load alias map:', e instanceof Error ? e.message : String(e))
  }
}

let _flushTimer: ReturnType<typeof setTimeout> | null = null

function scheduleAliasFlush(): void {
  if (_flushTimer) clearTimeout(_flushTimer)
  _flushTimer = setTimeout(() => {
    _flushTimer = null
    try {
      const dir = path.dirname(ALIAS_FILE)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const out: Record<string, string> = {}
      for (const [k, v] of convAliasMap) out[k] = v
      fs.writeFileSync(ALIAS_FILE, JSON.stringify(out, null, 2))
    } catch (e) {
      console.warn('[conversation] Failed to flush alias map:', e instanceof Error ? e.message : String(e))
    }
  }, 2000)
}

// Hydrate on module load
loadAliasMap()

// -- ID resolution -------------------------------------------------------------

export function resolveConversationId(messages: { role: string; content: string }[]): string {
  const firstUser      = messages.find(m => m.role === 'user')?.content ?? ''
  const firstAssistant = messages.find(m => m.role === 'assistant')?.content ?? ''
  if (firstAssistant) {
    const aliasKey = `${djb2Short(firstUser)}-${djb2Short(firstAssistant)}`
    const cached   = convAliasMap.get(aliasKey)
    if (cached) return cached
    return `conv-${djb2Short(firstUser)}`
  }
  return `conv-${uuidv4().replace(/-/g, '').slice(0, 8)}`
}

export function registerConvAlias(
  messages: { role: string; content: string }[],
  convId: string,
  responseContent: string,
): void {
  const firstUser = messages.find(m => m.role === 'user')?.content ?? ''
  if (!firstUser || !responseContent) return
  const aliasKey = `${djb2Short(firstUser)}-${djb2Short(responseContent)}`
  convAliasMap.set(aliasKey, convId)
  scheduleAliasFlush()

  const ctx    = toolLogContextStorage.getStore()
  const userId = ctx?.userId ? ctx.userId.toLowerCase() : '_anonymous'
  persistConversationMeta(userId, convId, firstUser)
}

// -- Disk helpers --------------------------------------------------------------

export interface ConversationMeta {
  id:          string
  userId:      string
  title:       string
  createdAt:   string
  lastActive:  string
  project?:    string   // AIWiki project slug this conversation is bound to
  mode?:       'direct' // set for Direct Chat conversations; absent = agentic team
}

export interface StoredMessage {
  id:        string
  role:      'user' | 'assistant' | 'system'
  content:   string
  ts:        number   // unix ms
}

function convDir(userId: string, convId: string): string {
  return path.join(DATA_DIR, 'conversations', userId, convId)
}

function ensureConvDir(userId: string, convId: string): string {
  const dir = convDir(userId, convId)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// -- Meta persistence ----------------------------------------------------------

function persistConversationMeta(userId: string, convId: string, firstUserMessage: string): void {
  try {
    const dir      = ensureConvDir(userId, convId)
    const metaFile = path.join(dir, 'meta.json')

    let meta: ConversationMeta
    if (fs.existsSync(metaFile)) {
      meta            = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as ConversationMeta
      meta.lastActive = new Date().toISOString()
    } else {
      const title = firstUserMessage.slice(0, 80).replace(/\s+/g, ' ').trim()
      const now   = new Date().toISOString()
      meta = { id: convId, userId, title, createdAt: now, lastActive: now }
    }
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2))
  } catch (e) {
    console.warn('[conversation] Failed to persist meta for', convId, e instanceof Error ? e.message : String(e))
  }
}

// -- Message persistence -------------------------------------------------------

function messagesFile(userId: string, convId: string): string {
  return path.join(convDir(userId, convId), 'messages.json')
}

export function appendMessage(userId: string, convId: string, role: StoredMessage['role'], content: string): void {
  try {
    ensureConvDir(userId, convId)
    const file    = messagesFile(userId, convId)
    const existing: StoredMessage[] = fs.existsSync(file)
      ? (JSON.parse(fs.readFileSync(file, 'utf8')) as StoredMessage[])
      : []
    existing.push({ id: uuidv4(), role, content, ts: Date.now() })
    fs.writeFileSync(file, JSON.stringify(existing, null, 2))
  } catch (e) {
    console.warn('[conversation] Failed to append message for', convId, e instanceof Error ? e.message : String(e))
  }
}

export function getMessages(userId: string, convId: string): StoredMessage[] {
  try {
    const file = messagesFile(userId, convId)
    if (!fs.existsSync(file)) return []
    return JSON.parse(fs.readFileSync(file, 'utf8')) as StoredMessage[]
  } catch (e) {
    console.warn('[conversation] Failed to read messages for', convId, e instanceof Error ? e.message : String(e))
    return []
  }
}

export function deleteMessages(userId: string, convId: string): void {
  try {
    const file = messagesFile(userId, convId)
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch (e) {
    console.warn('[conversation] Failed to delete messages for', convId, e instanceof Error ? e.message : String(e))
  }
}

// -- Tool-log persistence ------------------------------------------------------

import type { ToolLogEntry } from '../types/index.js'

function toolLogFile(userId: string, convId: string): string {
  return path.join(convDir(userId, convId), 'tool-log.json')
}

export function appendToolLogEntry(entry: ToolLogEntry): void {
  if (!entry.userId || !entry.conversationId) return
  try {
    const userId = entry.userId.toLowerCase()
    const convId = entry.conversationId
    ensureConvDir(userId, convId)
    const file    = toolLogFile(userId, convId)
    const existing: ToolLogEntry[] = fs.existsSync(file)
      ? (JSON.parse(fs.readFileSync(file, 'utf8')) as ToolLogEntry[])
      : []
    // prepend to match original in-memory behaviour (newest first)
    existing.unshift(entry)
    fs.writeFileSync(file, JSON.stringify(existing, null, 2))
  } catch (e) {
    console.warn('[conversation] Failed to append tool-log entry for', entry.conversationId, e instanceof Error ? e.message : String(e))
  }
}

/** Return tool-log entries for a specific conversation. */
export function getToolLogEntries(userId: string, convId: string): ToolLogEntry[] {
  try {
    const file = toolLogFile(userId.toLowerCase(), convId)
    if (!fs.existsSync(file)) return []
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ToolLogEntry[]
  } catch (e) {
    console.warn('[conversation] Failed to read tool-log for', convId, e instanceof Error ? e.message : String(e))
    return []
  }
}

/** Clear tool-log for a specific conversation (user-initiated only). */
export function clearToolLogEntries(userId: string, convId: string): void {
  try {
    const file = toolLogFile(userId.toLowerCase(), convId)
    if (fs.existsSync(file)) fs.writeFileSync(file, '[]')
  } catch (e) {
    console.warn('[conversation] Failed to clear tool-log for', convId, e instanceof Error ? e.message : String(e))
  }
}

/** Delete tool-log file entirely (called as part of conversation delete). */
export function deleteToolLog(userId: string, convId: string): void {
  try {
    const file = toolLogFile(userId.toLowerCase(), convId)
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch (e) {
    console.warn('[conversation] Failed to delete tool-log for', convId, e instanceof Error ? e.message : String(e))
  }
}

/**
 * Scan all conversations across all users and return a flat list of tool-log
 * entries. Used by the legacy /api/tool-log global endpoint (admin only).
 */
export function getAllToolLogEntries(opts?: {
  since?:          number
  filterUser?:     string
  filterConv?:     string
  limit?:          number
}): ToolLogEntry[] {
  const since      = opts?.since      ?? 0
  const filterUser = opts?.filterUser
  const filterConv = opts?.filterConv
  const base       = path.join(DATA_DIR, 'conversations')
  if (!fs.existsSync(base)) return []

  const results: ToolLogEntry[] = []

  for (const userDir of fs.readdirSync(base, { withFileTypes: true })) {
    if (!userDir.isDirectory()) continue
    if (userDir.name === 'alias-map.json') continue
    if (filterUser && userDir.name !== filterUser.toLowerCase()) continue

    const userPath = path.join(base, userDir.name)
    for (const convDir_ of fs.readdirSync(userPath, { withFileTypes: true })) {
      if (!convDir_.isDirectory()) continue
      if (filterConv && convDir_.name !== filterConv) continue

      const file = path.join(userPath, convDir_.name, 'tool-log.json')
      if (!fs.existsSync(file)) continue
      try {
        const entries = JSON.parse(fs.readFileSync(file, 'utf8')) as ToolLogEntry[]
        for (const e of entries) {
          if (e.ts > since) results.push(e)
        }
      } catch { /* skip corrupt file */ }
    }
  }

  // newest first
  results.sort((a, b) => b.ts - a.ts)
  return opts?.limit ? results.slice(0, opts.limit) : results
}

// -- Query helpers (used by API routes) ----------------------------------------

export function listConversations(userId: string): ConversationMeta[] {
  const base = path.join(DATA_DIR, 'conversations', userId)
  if (!fs.existsSync(base)) return []
  return fs.readdirSync(base, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .flatMap(d => {
      const metaFile = path.join(base, d.name, 'meta.json')
      if (!fs.existsSync(metaFile)) return []
      try {
        return [JSON.parse(fs.readFileSync(metaFile, 'utf8')) as ConversationMeta]
      } catch { return [] }
    })
    .sort((a, b) => b.lastActive.localeCompare(a.lastActive))
}

export function listAllConversations(): ConversationMeta[] {
  const base = path.join(DATA_DIR, 'conversations')
  if (!fs.existsSync(base)) return []
  return fs.readdirSync(base, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'alias-map.json')
    .flatMap(userDir => listConversations(userDir.name))
    .sort((a, b) => b.lastActive.localeCompare(a.lastActive))
}

export function conversationBelongsTo(userId: string, convId: string): boolean {
  return fs.existsSync(path.join(DATA_DIR, 'conversations', userId, convId, 'meta.json'))
}

export function touchConversation(userId: string, convId: string, firstUserMessage: string): void {
  persistConversationMeta(userId.toLowerCase() || '_anonymous', convId, firstUserMessage)
}

export function deleteConversation(userId: string, convId: string): boolean {
  const dir = convDir(userId, convId)
  if (!fs.existsSync(dir)) return false
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  } catch (e) {
    console.warn('[conversation] Failed to delete', convId, e instanceof Error ? e.message : String(e))
    return false
  }
}


// -- Project binding (AIWiki) ------------------------------------------------
// Set by the user (chat project picker / API), never by a model. The bound
// project scopes what the conversation's agents can see and write in the wiki.

function metaPath(userId: string, convId: string): string {
  return path.join(convDir(userId.toLowerCase() || '_anonymous', convId), 'meta.json')
}

export function getConversationProject(userId: string, convId: string): string | null {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(userId, convId), 'utf8')) as ConversationMeta
    return meta.project || null
  } catch { return null }
}

export function setConversationMode(userId: string, convId: string, mode: 'direct' | null): boolean {
  const file = metaPath(userId, convId)
  try {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as ConversationMeta
    if (mode) meta.mode = mode
    else delete meta.mode
    fs.writeFileSync(file, JSON.stringify(meta, null, 2))
    return true
  } catch { return false }
}

export function setConversationProject(userId: string, convId: string, project: string | null): boolean {
  const file = metaPath(userId, convId)
  try {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as ConversationMeta
    if (project) meta.project = project
    else delete meta.project
    fs.writeFileSync(file, JSON.stringify(meta, null, 2))
    return true
  } catch { return false }
}
