// -- AIWiki client --------------------------------------------------------------
// Shared by agent wiki tools (core/wikitools.ts), the coordinator's context
// injection and write-back (routes/completions.ts), and BulletTrain.
//
// Identity is never chosen by a model: callers pass a WikiScope built from the
// authenticated request / conversation (user, bound project, agent,
// conversation). The wiki service enforces visibility from those headers:
// a user's agents see all of that user's projects when unbound, only the bound
// project when bound, and never another user's pages.
//
// Config (container env): AIWIKI_URL, AIWIKI_TOKEN (service token).
// Every call is best-effort: failures are logged and return null so the wiki
// can never break a pipeline run.

export const AIWIKI_URL   = (process.env.AIWIKI_URL || '').replace(/\/+$/, '')
const AIWIKI_TOKEN        = process.env.AIWIKI_TOKEN || ''
const TIMEOUT_MS          = Number(process.env.AIWIKI_TIMEOUT_MS || 30_000)
export const STUB_MIN_SCORE = Number(process.env.AIWIKI_STUB_MIN_SCORE || 0.55)

export interface WikiScope {
  user:          string                // end user (Orchestrail user email)
  project?:      string | null         // bound project slug, if any
  agent?:        string
  conversation?: string
}

export function wikiEnabled(): boolean {
  return !!(AIWIKI_URL && AIWIKI_TOKEN)
}

/** Same rule as the wiki service: lowercase, non-alphanumerics collapsed to '-'. */
export function wikiSlug(s: string): string {
  return (s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
}

export interface WikiResponse<T = unknown> { ok: boolean; status: number; data: T | null; error?: string }

export async function wikiRequest<T = unknown>(
  method: string, path: string, scope: WikiScope, body?: unknown, raw = false,
): Promise<WikiResponse<T>> {
  if (!wikiEnabled()) return { ok: false, status: 0, data: null, error: 'AIWiki is not configured (AIWIKI_URL / AIWIKI_TOKEN)' }
  if (!scope.user) return { ok: false, status: 0, data: null, error: 'no user context for AIWiki' }
  const headers: Record<string, string> = {
    'Authorization':  `Bearer ${AIWIKI_TOKEN}`,
    'X-Wiki-User':    scope.user,
    'Content-Type':   'application/json',
  }
  if (scope.project)      headers['X-Wiki-Project']      = scope.project
  if (scope.agent)        headers['X-Wiki-Agent']        = scope.agent.slice(0, 64)
  if (scope.conversation) headers['X-Wiki-Conversation'] = scope.conversation.slice(0, 64)
  try {
    const res = await fetch(`${AIWIKI_URL}${path}`, {
      method, headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await res.text()
    let data: unknown = text
    if (!raw) { try { data = text ? JSON.parse(text) : null } catch { /* keep text */ } }
    if (!res.ok) {
      const err = (data && typeof data === 'object' && ((data as Record<string, unknown>)['error'] || (data as Record<string, unknown>)['detail'])) || text
      return { ok: false, status: res.status, data: null, error: String(err).slice(0, 400) }
    }
    return { ok: true, status: res.status, data: data as T }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[aiwiki] ${method} ${path} failed: ${msg}`)
    return { ok: false, status: 0, data: null, error: msg }
  }
}

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/')

export function projectPagePath(scope: WikiScope, page: string): string | null {
  if (!scope.project) return null
  const clean = page.trim().replace(/\.md$/i, '').replace(/^\/+|\/+$/g, '')
    .split('/').map(wikiSlug).filter(Boolean).join('/')
  if (!clean) return null
  return `projects/${wikiSlug(scope.user)}/${scope.project}/${clean}`
}

function frontmatter(meta: Record<string, unknown>): string {
  const lines = Object.entries(meta).map(([k, v]) =>
    `${k}: ${Array.isArray(v) ? '[' + v.map(x => JSON.stringify(String(x))).join(', ') + ']' : JSON.stringify(String(v))}`)
  return `---\n${lines.join('\n')}\n---\n\n`
}

export function buildPage(title: string, summary: string, body: string, extra: Record<string, unknown> = {}): string {
  return frontmatter({ title, summary: summary.replace(/\s+/g, ' ').slice(0, 280), ...extra }) + body.trim() + '\n'
}

interface PageView { path: string; title: string; summary: string; body: string; meta: Record<string, unknown>; sections: Array<{ heading: string; anchor: string }> }

export async function wikiReadPage(scope: WikiScope, path: string): Promise<PageView | null> {
  const r = await wikiRequest<PageView>('GET', `/api/pages/${enc(path)}`, scope)
  return r.ok ? r.data : null
}

export async function wikiPutPage(scope: WikiScope, path: string, content: string, message: string): Promise<WikiResponse> {
  return wikiRequest('PUT', `/api/pages/${enc(path)}`, scope, { content, message })
}

/** Replace the body of one '## heading' section (or append it) and save. */
export async function wikiUpsertSection(
  scope: WikiScope, page: string, title: string, summary: string, heading: string, content: string,
): Promise<WikiResponse | null> {
  const path = projectPagePath(scope, page)
  if (!path) return null
  const cur = await wikiReadPage(scope, path)
  const block = `## ${heading}\n${content.trim()}\n`
  let body: string
  let meta: Record<string, unknown> = { title, summary }
  if (cur) {
    meta = { ...cur.meta }
    const re = new RegExp(`(^|\\n)## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n[\\s\\S]*?(?=\\n## |$)`)
    body = re.test(cur.body) ? cur.body.replace(re, (m, lead) => `${lead}${block.trimEnd()}`) : `${cur.body.trimEnd()}\n\n${block}`
  } else {
    body = block
  }
  const fm = { ...meta }
  delete fm['created']; delete fm['updated']
  return wikiPutPage(scope, path, frontmatter(fm) + body.trim() + '\n', `Update ${heading} on ${page}`)
}

/** Append a dated entry to the bound project's log.md (created on first use). */
export async function wikiAppendLog(scope: WikiScope, heading: string, entry: string): Promise<WikiResponse | null> {
  const path = projectPagePath(scope, 'log')
  if (!path) return null
  const cur = await wikiReadPage(scope, path)
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const block = `## ${stamp} -- ${heading.replace(/\n/g, ' ').slice(0, 120)}\n${entry.trim()}\n`
  const content = cur
    ? frontmatter(Object.fromEntries(Object.entries(cur.meta).filter(([k]) => k !== 'created' && k !== 'updated'))) +
      `${cur.body.trimEnd()}\n\n${block}`
    : buildPage(`${scope.project} log`, `Dated work log for project ${scope.project}, newest last.`, block, { tags: ['log'] })
  return wikiPutPage(scope, path, content, `Log: ${heading.slice(0, 60)}`)
}

/** Append one decision line to the bound project's decisions.md. */
export async function wikiAppendDecision(scope: WikiScope, line: string): Promise<WikiResponse | null> {
  const path = projectPagePath(scope, 'decisions')
  if (!path) return null
  const cur = await wikiReadPage(scope, path)
  const item = `- ${new Date().toISOString().slice(0, 10)}: ${line.replace(/\n/g, ' ').trim()}`
  const content = cur
    ? frontmatter(Object.fromEntries(Object.entries(cur.meta).filter(([k]) => k !== 'created' && k !== 'updated'))) +
      `${cur.body.trimEnd()}\n${item}\n`
    : buildPage(`${scope.project} decisions`, `Decisions for project ${scope.project} and why.`, `## Decisions\n${item}\n`, { tags: ['decisions'] })
  return wikiPutPage(scope, path, content, 'Decision recorded')
}

/** Create the bound project's index.md if it does not exist yet. */
export async function wikiEnsureIndex(scope: WikiScope, title: string, summary: string, body: string): Promise<void> {
  const path = projectPagePath(scope, 'index')
  if (!path) return
  if (await wikiReadPage(scope, path)) return
  await wikiPutPage(scope, path, buildPage(title, summary, body, { tags: ['project'] }), 'Create project index')
}

/**
 * Context block for a goal: the bound project's index (if any) plus stubs of
 * relevant pages above STUB_MIN_SCORE. Returns '' when nothing useful.
 */
export async function wikiContextFor(scope: WikiScope, query: string, maxIndexChars = 1500): Promise<string> {
  if (!wikiEnabled() || !scope.user) return ''
  const parts: string[] = []
  if (scope.project) {
    const idx = await wikiReadPage(scope, projectPagePath(scope, 'index')!)
    if (idx) {
      const body = idx.body.length > maxIndexChars ? idx.body.slice(0, maxIndexChars) + '\n...(truncated; wiki_read the page for the rest)' : idx.body
      parts.push(`Bound project: ${scope.project}. Its memory (projects/.../${scope.project}/index.md):\n${body}`)
    } else {
      parts.push(`Bound project: ${scope.project}. It has no memory yet -- create index.md with wiki_write_project_page as you learn what it is.`)
    }
  }
  const q = encodeURIComponent(query.slice(0, 500))
  const stubs = await wikiRequest<string>('GET', `/api/stubs?q=${q}&limit=6&min_score=${STUB_MIN_SCORE}`, scope, undefined, true)
  if (stubs.ok && typeof stubs.data === 'string' && stubs.data.trim()) parts.push(stubs.data.trim())
  if (!parts.length) return ''
  return `## AIWiki context\n${parts.join('\n\n')}`
}
