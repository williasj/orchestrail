// -- Health, UI, and root routes -----------------------------------------------

import type { Router } from 'express'
import type { TeamAgent } from '../types/index.js'

export interface HealthDeps {
  modelId:    string
  uiHtml:     string
  getAgents:  () => TeamAgent[]
}

export function registerHealthRoutes(router: Router, deps: HealthDeps): void {
  const { modelId, uiHtml, getAgents } = deps

  // Pipelines server handshake — OpenWebUI detects a Pipelines connection by
  // calling GET / and expecting { status: true }. UI is still at /ui.
  router.get('/', (_req, res) => { res.json({ status: true }) })

  router.get('/ui', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(uiHtml)
  })

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', model: modelId, agents: getAgents().map(a => a.name) })
  })
}
