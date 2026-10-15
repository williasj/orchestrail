// -- Skills admin API ---------------------------------------------------------
// View, edit, add, test, deprecate and restore executable skill capabilities
// (core/skillexec.ts). Reads need auth; writes need admin. Every write goes
// through the same self-test -> embed -> index path as the folder watcher.
//
//   GET    /api/skills                    list manifests (all locations)
//   GET    /api/skills/:name              manifest + SKILL.md + source + examples
//   POST   /api/skills                    create (CreateSkillInput, author human)
//   PUT    /api/skills/:name              edit { skillMd?, source?, examples? }
//   POST   /api/skills/:name/run          run with { input } -> SkillRunResult
//   POST   /api/skills/:name/deprecate
//   POST   /api/skills/:name/restore
//   POST   /api/skills/rescan             re-import every folder from disk

import type { Request, Response, Router } from 'express'
import { requireAuth, requireAdmin } from './auth.js'
import {
  createSkill, deprecateSkill, editSkillFiles, getSkillDetail, listSkillCaps,
  locateSkill, rescanSkills, restoreSkill, runSkill, skillExecEnabled,
  type CodeExecFn, type CreateSkillInput,
} from '../core/skillexec.js'

const NAME_RE = /^[a-z0-9_-]{1,80}$/

export function registerSkillRoutes(router: Router, deps: { exec: CodeExecFn }): void {
  const { exec } = deps

  const guard = (res: Response): boolean => {
    if (skillExecEnabled()) return true
    res.status(503).json({ error: 'skill execution is not enabled (coordinator.skills / memory config)' })
    return false
  }
  const nameOf = (req: Request, res: Response): string | null => {
    const n = String(req.params['name'] ?? '')
    if (!NAME_RE.test(n)) { res.status(400).json({ error: 'invalid skill name' }); return null }
    return n
  }

  router.get('/api/skills', requireAuth, async (_req: Request, res: Response) => {
    if (!guard(res)) return
    const manifests = await listSkillCaps()
    const out = []
    for (const m of manifests) {
      const loc = await locateSkill(m.name)
      out.push({ ...m, location: loc?.location ?? null })
    }
    res.json(out)
  })

  router.post('/api/skills/rescan', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    if (!guard(res)) return
    await rescanSkills(exec)
    res.json({ ok: true, skills: (await listSkillCaps()).length })
  })

  router.get('/api/skills/:name', requireAuth, async (req: Request, res: Response) => {
    if (!guard(res)) return
    const name = nameOf(req, res); if (!name) return
    const d = await getSkillDetail(name)
    if (!d) { res.status(404).json({ error: 'not found' }); return }
    res.json(d)
  })

  router.post('/api/skills', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    if (!guard(res)) return
    const input = req.body as CreateSkillInput
    if (input?.name && await locateSkill(input.name)) {
      res.status(409).json({ error: `skill "${input.name}" already exists -- use PUT /api/skills/${input.name}` }); return
    }
    const r = await createSkill(input, exec, 'human')
    res.status(r.status === 'error' ? 400 : 201).json(r)
  })

  router.put('/api/skills/:name', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    if (!guard(res)) return
    const name = nameOf(req, res); if (!name) return
    const { skillMd, source, examples } = req.body as { skillMd?: string; source?: string; examples?: Array<{ input: unknown; expect: unknown }> }
    if (skillMd === undefined && source === undefined && examples === undefined) {
      res.status(400).json({ error: 'nothing to change: send skillMd, source and/or examples' }); return
    }
    const r = await editSkillFiles(name, { skillMd, source, examples }, exec)
    res.status(r.status === 'error' ? (r.error?.startsWith('No skill') ? 404 : 400) : 200).json(r)
  })

  router.post('/api/skills/:name/run', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    if (!guard(res)) return
    const name = nameOf(req, res); if (!name) return
    const { input } = req.body as { input?: unknown }
    res.json(await runSkill(name, input ?? null, exec))
  })

  router.post('/api/skills/:name/deprecate', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    if (!guard(res)) return
    const name = nameOf(req, res); if (!name) return
    const r = await deprecateSkill(name)
    res.status(r.ok ? 200 : 404).json(r)
  })

  router.post('/api/skills/:name/restore', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    if (!guard(res)) return
    const name = nameOf(req, res); if (!name) return
    const r = await restoreSkill(name, exec)
    res.status(r.status === 'error' ? 400 : 200).json(r)
  })
}
