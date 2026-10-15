// -- Direct Chat ------------------------------------------------------------------
// One-off conversations straight with a model, with Orchestrail's tools attached
// (sandbox shell, web search, AIWiki, RAG, skills) but none of the team machinery:
// no decomposition, stages, workbench slots or verification gates.
//
//   GET  /api/direct/options   models, tools and defaults for the UI
//   POST /api/direct/chat      SSE  { message, conversationId?, model?, tools?: string[], project? }
//
// Conversations live in the normal conversation store with meta.mode = 'direct',
// so history, tool logs and AIWiki project binding work the same way. Each
// conversation gets its own persistent sandbox directory (run id direct-<conv>),
// so files written in one message are still there in the next.

import type { Request, Response, Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { requireAuth } from './auth.js'
import { callLLMRaw, usageStorage } from '../core/llm.js'
import { fetchAgentTools, executeToolCall, toolLogContextStorage } from '../core/tools.js'
import { workbenchIdStorage } from '../core/workbench.js'
import {
  appendMessage, getMessages, touchConversation, getConversationProject, setConversationProject,
  setConversationMode,
} from '../core/conversation.js'
import { wikiContextFor, wikiSlug, type WikiScope } from '../core/wikiclient.js'
import type { AgenticMessage, CoordinatorConfig, TeamAgent, ToolConfig } from '../types/index.js'

const MAX_ROUNDS     = Number(process.env.DIRECT_MAX_TOOL_ROUNDS || 30)
const MAX_TOKENS     = Number(process.env.DIRECT_MAX_TOKENS || 16384)
const HISTORY_CHARS  = 60_000          // older turns are dropped beyond this
// Pipeline plumbing that means nothing outside the team pipeline
const HIDDEN_TOOLS   = new Set(['workbench_list', 'workbench_read', 'workbench_write', 'workbench_search', 'list_runtimes'])
const EXCLUDED_TYPES = new Set(['self_improve'])

export interface DirectDeps {
  getCoordinator: () => CoordinatorConfig
  getTools:       () => ToolConfig[]
}

function systemPrompt(toolNames: string[]): string {
  const has = (n: string) => toolNames.includes(n)
  const lines = [
    'You are a capable assistant running inside Orchestrail, talking directly with the user.',
    'Answer conversationally and directly. Use tools when they genuinely help -- to run or check code, inspect files, ' +
    'look something up, or recall project knowledge -- not for things you can answer outright.',
  ]
  if (has('bash')) lines.push(
    'You have a persistent Ubuntu 24.04 sandbox for this conversation (bash, write_file, read_file, list_files). Files and ' +
    'installed packages persist between messages. Python (venv, pip works), Node 20, Go, Rust, Java, C/C++, LibreOffice, ' +
    'pandoc, ImageMagick, ffmpeg and common CLI tools are installed. The public internet is reachable; the local network is not. ' +
    'When you claim code works, run it first.')
  if (toolNames.some(n => n.startsWith('web_search'))) lines.push('You can search the web; cite the URLs you relied on.')
  if (has('wiki_search')) lines.push(
    'AIWiki holds curated playbooks, lessons and project memory: search it before answering questions about the user\'s ' +
    'systems or projects, and record durable findings in the bound project with wiki_append_log or wiki_write_project_page.')
  if (has('use_skill')) lines.push('Registered skills can be run with use_skill.')
  lines.push('Format answers in Markdown. Be concise.')
  return lines.join('\n\n')
}

/** Rebuild model-facing history from stored messages: drop tool status lines, cap total size. */
function historyFor(userId: string, convId: string): AgenticMessage[] {
  const msgs = getMessages(userId, convId)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.role === 'assistant'
        ? m.content.split('\n').filter(l => !l.startsWith('> **[')).join('\n').replace(/<details>[\s\S]*?<\/details>/g, '').trim()
        : m.content,
    }))
  const out: AgenticMessage[] = []
  let used = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    used += msgs[i]!.content.length
    if (used > HISTORY_CHARS && out.length > 0) break
    out.unshift(msgs[i]!)
  }
  return out
}

const preview = (v: unknown, n = 140) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  const one = String(s ?? '').replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n) + '...' : one
}

export function registerDirectRoutes(router: Router, deps: DirectDeps): void {
  const toolChoices = () => deps.getTools().filter(t => t.enabled && !EXCLUDED_TYPES.has(t.type))
  const defaultTools = () => {
    const ids = toolChoices().map(t => t.id)
    // one exec endpoint is enough; prefer the sidecar when both are configured
    return ids.includes('orchestrail-exec') ? ids.filter(id => id !== 'code-execution-tools') : ids
  }

  router.get('/api/direct/options', requireAuth, (_req: Request, res: Response) => {
    const c = deps.getCoordinator()
    res.json({
      defaultModel: c.llm.model,
      tools: toolChoices().map(t => ({ id: t.id, name: t.name, type: t.type })),
      defaultTools: defaultTools(),
    })
  })

  router.post('/api/direct/chat', requireAuth, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { message?: string; conversationId?: string; model?: string; tools?: unknown; project?: string | null }
    const message = String(body.message ?? '').trim()
    if (!message) { res.status(400).json({ error: 'message is required' }); return }
    const userId = req.auth!.email
    const convId = (body.conversationId && /^[\w-]{4,64}$/.test(body.conversationId)) ? body.conversationId
      : `direct-${uuidv4().replace(/-/g, '').slice(0, 8)}`

    const history = historyFor(userId, convId)
    touchConversation(userId, convId, message)
    setConversationMode(userId, convId, 'direct')
    appendMessage(userId, convId, 'user', message)
    if (Object.prototype.hasOwnProperty.call(body, 'project')) {
      setConversationProject(userId, convId, body.project ? wikiSlug(String(body.project)) || null : null)
    }
    const projectId = getConversationProject(userId, convId) || undefined

    const allowed = new Set(toolChoices().map(t => t.id))
    const toolIds = (Array.isArray(body.tools) ? body.tools.map(String) : defaultTools()).filter(id => allowed.has(id))
    const coord   = deps.getCoordinator()
    const llm     = { ...coord.llm, model: (body.model && /^[\w.:\/-]{1,120}$/.test(body.model)) ? body.model : coord.llm.model }
    const pseudo  = { name: 'direct-chat', tools: toolIds, toolCollections: {}, llm, temperature: 0.6, maxTokens: MAX_TOKENS } as unknown as TeamAgent

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    let closed = false
    req.on('close', () => { closed = true })
    const send = (ev: Record<string, unknown>) => { if (!closed) res.write(`data: ${JSON.stringify(ev)}\n\n`) }
    send({ type: 'init', conversationId: convId, model: llm.model, tools: toolIds, project: projectId ?? null })

    let transcript = ''          // what the UI shows and what gets stored
    const chunk = (s: string) => { transcript += s; send({ type: 'chunk', content: s }) }

    try {
      await toolLogContextStorage.run({ userId, conversationId: convId, projectId }, () =>
        workbenchIdStorage.run(`direct-${convId}`, () =>
          usageStorage.run({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, async () => {
            const { defs, urlMap } = await fetchAgentTools(pseudo)
            const toolDefs = defs.filter(d => !HIDDEN_TOOLS.has(String((d as { function?: { name?: string } }).function?.name)))
            const names = toolDefs.map(d => String((d as { function?: { name?: string } }).function?.name))

            let sys = systemPrompt(names)
            if (names.includes('wiki_search')) {
              const scope: WikiScope = { user: userId, project: projectId ?? null, agent: 'direct-chat', conversation: convId }
              const ctx = await wikiContextFor(scope, message).catch(() => '')
              if (ctx) sys += '\n\n' + ctx
            }
            const messages: AgenticMessage[] = [{ role: 'system', content: sys }, ...history, { role: 'user', content: message }]

            for (let round = 0; round < MAX_ROUNDS && !closed; round++) {
              let resp
              try {
                resp = await callLLMRaw(messages, llm, MAX_TOKENS, 0.6, toolDefs.length ? toolDefs : undefined, 'orchestrail/direct-chat')
              } catch (e) {
                if (!/LLM error: 5\d\d/.test(String(e))) throw e
                resp = await callLLMRaw(messages, llm, MAX_TOKENS, 0.7, toolDefs.length ? toolDefs : undefined, 'orchestrail/direct-chat')
              }
              const msg = resp.choices[0]?.message
              if (!msg) break
              const calls = msg.tool_calls ?? []
              const text  = (msg.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
              if (!calls.length) {
                chunk((transcript ? '\n\n' : '') + (text || '_(no reply)_'))
                break
              }
              if (text) chunk((transcript ? '\n\n' : '') + text + '\n')
              messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls })
              for (const tc of calls) {
                let args: Record<string, unknown> = {}
                try { args = JSON.parse(tc.function.arguments || '{}') } catch { /* keep {} */ }
                const label = preview(args['command'] ?? args['query'] ?? args['path'] ?? args['name'] ?? args, 120)
                chunk(`\n> **[tool]** ${tc.function.name}: ${label.replace(/\*/g, '')}\n`)
                const t0 = Date.now()
                let result: string
                try {
                  result = urlMap.has(tc.function.name)
                    ? await executeToolCall(tc.function.name, args, urlMap, 'direct-chat', 'direct-chat')
                    : JSON.stringify({ error: `unknown tool ${tc.function.name}` })
                } catch (e) { result = JSON.stringify({ error: String(e) }) }
                const ok = !/^\s*\{\s*"error"/.test(result)
                chunk(`> **[${ok ? 'done' : 'tool error'}]** ${tc.function.name} (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`)
                messages.push({ role: 'tool', tool_call_id: tc.id, content: result.length > 24_000 ? result.slice(0, 24_000) + '\n...[truncated]' : result })
              }
              if (round === MAX_ROUNDS - 1) chunk(`\n\n_Stopped after ${MAX_ROUNDS} tool rounds._`)
            }
            send({ type: 'done', usage: usageStorage.getStore() })
          })))
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      chunk(`\n\n**Error:** ${m}`)
      send({ type: 'error', content: m })
    } finally {
      if (transcript.trim()) appendMessage(userId, convId, 'assistant', transcript.trim())
      if (!closed) res.end()
    }
  })
}
