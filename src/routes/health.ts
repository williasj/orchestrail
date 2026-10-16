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

  // GET / does double duty:
  //  - Browsers (Accept prefers text/html) are sent to the web UI.
  //  - Everything else gets the Pipelines handshake: OpenWebUI detects a
  //    Pipelines connection by calling GET / and expecting { status: true }.
  // 302, not 301, so browsers never cache the redirect.
  router.get('/', (req, res) => {
    if (req.accepts(['json', 'html']) === 'html') {
      res.redirect(302, '/ui')
      return
    }
    res.json({ status: true })
  })

  router.get('/ui', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(uiHtml)
  })

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', model: modelId, agents: getAgents().map(a => a.name) })
  })
}
