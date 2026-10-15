// -- AIWiki routes (UI + API) ---------------------------------------------------
//   GET  /api/wiki/status                      is the wiki configured / reachable
//   GET  /api/wiki/projects                    the signed-in user's projects
//   PUT  /api/conversations/:convId/project    bind / unbind { project: string | null }
// The project binding is the user's choice; agents never set their own scope.

import type { Request, Response, Router } from 'express'
import { requireAuth } from './auth.js'
import { getConversationProject, setConversationProject, listAllConversations } from '../core/conversation.js'
import { AIWIKI_URL, wikiEnabled, wikiRequest, wikiSlug } from '../core/wikiclient.js'

export function registerWikiRoutes(router: Router): void {
  router.get('/api/wiki/status', requireAuth, async (req: Request, res: Response) => {
    if (!wikiEnabled()) { res.json({ enabled: false }); return }
    const r = await wikiRequest('GET', '/api/projects', { user: req.auth!.email })
    res.json({ enabled: true, url: AIWIKI_URL, reachable: r.ok, error: r.ok ? undefined : r.error })
  })

  router.get('/api/wiki/projects', requireAuth, async (req: Request, res: Response) => {
    if (!wikiEnabled()) { res.json([]); return }
    const r = await wikiRequest<unknown[]>('GET', '/api/projects', { user: req.auth!.email })
    if (!r.ok) { res.status(502).json({ error: r.error }); return }
    res.json(r.data ?? [])
  })

  router.put('/api/conversations/:convId/project', requireAuth, (req: Request, res: Response) => {
    const convId = String(req.params['convId'] ?? '')
    const raw = (req.body as { project?: string | null })?.project
    const project = raw ? wikiSlug(String(raw)) : null
    if (raw && !project) { res.status(400).json({ error: 'invalid project name' }); return }
    // owner = the signed-in user; admins may bind any conversation
    let owner = req.auth!.email
    if (req.auth?.role === 'admin') {
      const meta = listAllConversations().find(c => c.id === convId)
      if (meta) owner = meta.userId
    }
    if (!setConversationProject(owner, convId, project)) { res.status(404).json({ error: 'conversation not found' }); return }
    res.json({ ok: true, conversationId: convId, project: getConversationProject(owner, convId) })
  })
}
