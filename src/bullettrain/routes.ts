// -- BulletTrain routes ---------------------------------------------------------
// Session-gated via requireAuth (the existing browser/API auth), NOT under the
// /v1 bearer-key path -- matches the contract's route seam note and the
// existing registerXRoutes(app, deps) pattern used by health/admin/pipelines.

import type { Express, Request, Response } from 'express'
import { requireAuth } from '../routes/auth.js'
import {
  listProjects, projectExists, createProject, readProject, writeProject,
  nextRunNo, createRun, statusExists, readStatus, readTasks, readDeliverableZip,
  readDecisions, readProjectMd, readRuntime, listSessionRecords,
} from './store.js'
import { startSupervisorInBackground } from './supervisor.js'
import { BT_SLUG_RE } from './config.js'

export function registerBulletTrainRoutes(app: Express): void {

  // GET /api/bullettrain/projects
  app.get('/api/bullettrain/projects', requireAuth, (_req: Request, res: Response) => {
    res.json({ projects: listProjects() })
  })

  // POST /api/bullettrain/projects  { slug, title, brief }
  app.post('/api/bullettrain/projects', requireAuth, (req: Request, res: Response) => {
    const { slug, title, brief } = req.body as { slug?: string; title?: string; brief?: string }
    if (!slug || !BT_SLUG_RE.test(slug)) { res.status(400).json({ error: 'slug must match ^[a-z0-9][a-z0-9-]{0,62}$' }); return }
    if (!title || !title.trim()) { res.status(400).json({ error: 'title is required' }); return }
    if (!brief || !brief.trim()) { res.status(400).json({ error: 'brief (MD instruction set content) is required' }); return }
    if (projectExists(slug)) { res.status(409).json({ error: `project '${slug}' already exists` }); return }

    const project = createProject(slug, title.trim(), brief, undefined, req.auth?.email)
    res.status(201).json({ project })
  })

  // GET /api/bullettrain/projects/:slug
  app.get('/api/bullettrain/projects/:slug', requireAuth, (req: Request, res: Response) => {
    const project = readProject(req.params.slug!)
    if (!project) { res.status(404).json({ error: 'not found' }); return }
    res.json({
      project,
      projectMd: readProjectMd(project.slug),
      runtime: readRuntime(project.slug),
      decisions: readDecisions(project.slug),
    })
  })

  // POST /api/bullettrain/projects/:slug/runs  -- start a new run (new project or new stage)
  app.post('/api/bullettrain/projects/:slug/runs', requireAuth, (req: Request, res: Response) => {
    const slug = req.params.slug!
    const project = readProject(slug)
    if (!project) { res.status(404).json({ error: 'not found' }); return }
    if (project.current_run) { res.status(409).json({ error: `run ${project.current_run} already in progress -- routes refuse concurrent runs per project` }); return }

    const { brief } = req.body as { brief?: string }
    const runNo = nextRunNo(project)
    const runtime = readRuntime(slug)
    // A new-stage run gets whatever BRIEF.md the user supplies for this run; if
    // omitted, reuse PROJECT.md content unchanged (a same-brief continuation run).
    const briefContent = brief && brief.trim() ? brief : readProjectMd(slug)
    createRun(slug, runNo, briefContent, runtime)

    project.runs += 1
    project.current_run = runNo
    project.last_run = runNo
    writeProject(project)

    startSupervisorInBackground(slug, runNo)
    res.status(201).json({ runNo })
  })

  // GET /api/bullettrain/projects/:slug/runs/:runNo/status
  app.get('/api/bullettrain/projects/:slug/runs/:runNo/status', requireAuth, (req: Request, res: Response) => {
    const { slug, runNo } = req.params as { slug: string; runNo: string }
    if (!statusExists(slug, runNo)) { res.status(404).json({ error: 'not found' }); return }
    res.json({
      status: readStatus(slug, runNo),
      tasks: readTasks(slug, runNo),
      sessions: listSessionRecords(slug, runNo),
    })
  })

  // GET /api/bullettrain/projects/:slug/runs/:runNo/download
  app.get('/api/bullettrain/projects/:slug/runs/:runNo/download', requireAuth, (req: Request, res: Response) => {
    const { slug, runNo } = req.params as { slug: string; runNo: string }
    const buf = readDeliverableZip(slug, runNo)
    if (!buf) { res.status(404).json({ error: 'no deliverable for this run (not done, or packaging failed -- check status.message)' }); return }
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-${runNo}.zip"`)
    res.send(buf)
  })
}
