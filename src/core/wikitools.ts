// -- AIWiki agent tools -----------------------------------------------------------
// Granted to agents that have a tool of type 'aiwiki' assigned. User, project,
// agent and conversation come from the request context (toolLogContextStorage),
// never from the model. Writes go only to the conversation's bound project.

import { toolLogContextStorage } from './toolcontext.js'
import {
  buildPage, projectPagePath, wikiAppendLog, wikiEnabled, wikiPutPage, wikiReadPage, wikiRequest,
  type WikiScope,
} from './wikiclient.js'

export const WIKI_SENTINEL = '__aiwiki__'

export const WIKI_TOOL_NAMES = [
  'wiki_search', 'wiki_read', 'wiki_projects', 'wiki_write_project_page', 'wiki_append_log', 'wiki_propose',
]

export function buildWikiTools(): unknown[] {
  return [
    { type: 'function', function: {
      name: 'wiki_search',
      description: 'Search the AIWiki: your long-term memory of this project, shared playbooks, lessons from solved problems, and the user\'s preferences. Returns pages with their best matching sections. Search before guessing.',
      parameters: { type: 'object', properties: {
        query:     { type: 'string', description: 'Natural-language question, e.g. "how do we deploy this" or "pip install fails"' },
        namespace: { type: 'string', enum: ['projects', 'playbooks', 'lessons', 'people'], description: 'Optional: limit to one area' },
      }, required: ['query'] },
    }},
    { type: 'function', function: {
      name: 'wiki_read',
      description: 'Read a wiki page by path (from wiki_search results). Pass section (an anchor from the search result) to read just that part.',
      parameters: { type: 'object', properties: {
        path:    { type: 'string', description: 'Page path, e.g. playbooks/code-sandbox.md' },
        section: { type: 'string', description: 'Optional section anchor, e.g. recipes' },
      }, required: ['path'] },
    }},
    { type: 'function', function: {
      name: 'wiki_projects',
      description: 'List the user\'s projects that have wiki memory (only the bound project when the conversation is bound to one).',
      parameters: { type: 'object', properties: {}, required: [] },
    }},
    { type: 'function', function: {
      name: 'wiki_write_project_page',
      description: 'Create or overwrite a page in the bound project\'s memory. Use page "index" for goal/status/where things live/next steps, "decisions" for decisions and why, or any other name for specs and notes. Read the page first and keep what is still true -- this replaces the whole page.',
      parameters: { type: 'object', properties: {
        page:    { type: 'string', description: 'Page name inside the project, e.g. index, decisions, api-design' },
        title:   { type: 'string', description: 'Page title' },
        summary: { type: 'string', description: 'One line describing the page (shown in search results)' },
        body:    { type: 'string', description: 'Markdown body. Use ## headings for sections.' },
      }, required: ['page', 'title', 'summary', 'body'] },
    }},
    { type: 'function', function: {
      name: 'wiki_append_log',
      description: 'Append a dated entry to the bound project\'s work log: what you did, what you found, what is left. Use this at the end of meaningful work.',
      parameters: { type: 'object', properties: {
        heading: { type: 'string', description: 'Short title for the entry' },
        entry:   { type: 'string', description: 'Markdown text of the entry' },
      }, required: ['heading', 'entry'] },
    }},
    { type: 'function', function: {
      name: 'wiki_propose',
      description: 'Propose a change to shared playbooks, lessons, or the user\'s preferences page (a human reviews it). Use for reusable knowledge: a solved problem (lessons/<name>: Symptom, Cause, Fix) or a better procedure. Never include private user details in shared pages.',
      parameters: { type: 'object', properties: {
        path:    { type: 'string', description: 'e.g. lessons/pytest-import-error or playbooks/code-sandbox' },
        action:  { type: 'string', enum: ['create', 'append', 'replace'] },
        title:   { type: 'string', description: 'Page title (create/replace)' },
        summary: { type: 'string', description: 'One-line summary (create/replace)' },
        content: { type: 'string', description: 'Markdown body (create/replace) or a new ## section (append)' },
        evidence: { type: 'string', description: 'What you observed that supports this change' },
      }, required: ['path', 'action', 'content', 'evidence'] },
    }},
  ]
}

function scopeFor(agentName?: string): WikiScope | null {
  const ctx = toolLogContextStorage.getStore()
  if (!ctx?.userId) return null
  return { user: ctx.userId, project: ctx.projectId || null, agent: agentName, conversation: ctx.conversationId }
}

const err = (msg: string) => JSON.stringify({ error: msg })
// status 0 = no HTTP response (timeout / network): the write may still have landed
const writeErr = (r: { status: number; error?: string }, fallback: string) =>
  (r.error || fallback) + (r.status === 0 ? ' -- the wiki may still have saved it; wiki_read the page before retrying' : '')
const enc = (p: string) => p.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')

export async function executeWikiTool(name: string, args: Record<string, unknown>, agentName?: string): Promise<string> {
  if (!wikiEnabled()) return err('AIWiki is not configured on this server')
  const scope = scopeFor(agentName)
  if (!scope) return err('AIWiki needs a signed-in user; this request has no user context')
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '').trim()

  if (name === 'wiki_search') {
    if (!s('query')) return err('query is required')
    const ns = s('namespace')
    const r = await wikiRequest<Array<Record<string, unknown>>>('GET',
      `/api/search?q=${encodeURIComponent(s('query'))}&limit=6${ns ? `&namespace=${encodeURIComponent(ns)}` : ''}`, scope)
    if (!r.ok) return err(r.error || 'search failed')
    const hits = (r.data || []).map(h => ({
      path: h['path'], title: h['title'], summary: h['summary'], score: h['score'],
      sections: ((h['sections'] as Array<Record<string, unknown>>) || []).map(x => ({ anchor: x['anchor'], heading: x['heading'], preview: x['preview'] })),
    }))
    return JSON.stringify({ results: hits, note: hits.length ? 'Read a section with wiki_read(path, section) before relying on it.' : 'No relevant pages.' })
  }

  if (name === 'wiki_read') {
    if (!s('path')) return err('path is required')
    const sec = s('section')
    const r = await wikiRequest<Record<string, unknown>>('GET',
      `/api/pages/${enc(s('path'))}${sec ? `?section=${encodeURIComponent(sec)}` : ''}`, scope)
    if (!r.ok) return err(r.status === 404 ? `not found or not visible: ${s('path')}${sec ? '#' + sec : ''}` : (r.error || 'read failed'))
    const d = r.data || {}
    if (sec) return JSON.stringify({ path: d['path'], title: d['title'], section: d['section'], text: d['text'] })
    return JSON.stringify({ path: d['path'], title: d['title'], summary: d['summary'], body: d['body'],
      sections: ((d['sections'] as Array<Record<string, unknown>>) || []).map(x => x['anchor']) })
  }

  if (name === 'wiki_projects') {
    const r = await wikiRequest<unknown[]>('GET', '/api/projects', scope)
    if (!r.ok) return err(r.error || 'failed')
    return JSON.stringify({ bound_project: scope.project || null, projects: r.data })
  }

  if (name === 'wiki_write_project_page') {
    if (!scope.project) return err('this conversation is not bound to a project, so there is no project memory to write. Ask the user to pick or create a project in the chat project selector.')
    const path = projectPagePath(scope, s('page'))
    if (!path) return err('page is required (e.g. index, decisions, notes)')
    if (!s('title') || !s('summary') || !s('body')) return err('title, summary and body are required')
    const r = await wikiPutPage(scope, path, buildPage(s('title'), s('summary'), s('body')), `Update ${s('page')}`)
    if (!r.ok) return err(writeErr(r, 'write failed'))
    return JSON.stringify({ ok: true, path: path + '.md' })
  }

  if (name === 'wiki_append_log') {
    if (!scope.project) return err('this conversation is not bound to a project; there is no project log to append to.')
    if (!s('entry')) return err('entry is required')
    const r = await wikiAppendLog(scope, s('heading') || 'update', s('entry'))
    if (!r || !r.ok) return err(r ? writeErr(r, 'append failed') : 'append failed')
    return JSON.stringify({ ok: true })
  }

  if (name === 'wiki_propose') {
    const action = s('action')
    const path = s('path').replace(/\.md$/i, '')
    if (!path || !['create', 'append', 'replace'].includes(action)) return err('path and action (create|append|replace) are required')
    if (path.startsWith('projects/')) return err('project pages are written directly with wiki_write_project_page, not proposed')
    let content = s('content')
    if (action !== 'append') {
      if (!s('title') || !s('summary')) return err('title and summary are required for create/replace')
      content = buildPage(s('title'), s('summary'), content)
    }
    const r = await wikiRequest<Record<string, unknown>>('POST', '/api/proposals', scope, {
      path, action, content,
      evidence: { conversationId: scope.conversation, agent: agentName, note: s('evidence') },
    })
    if (!r.ok) return err(r.error || 'proposal failed')
    return JSON.stringify({ ok: true, id: r.data?.['id'], status: 'pending review' })
  }

  // keep the reader helper referenced for future tools
  void wikiReadPage
  return err(`unknown wiki tool: ${name}`)
}
