// -- Deliverable download route ------------------------------------------------
// GET /api/deliver/:convToken/:filename
//
// Serves a previously delivered file from the per-conversation deliverable store
// (DATA_DIR/deliverables/<convToken>/<filename>). Auth-gated via requireAuth.
// The convToken is a sanitized conversation ID; the filename is basename-only
// to prevent path traversal.

import type { Request, Response, Router } from 'express'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { requireAuth } from './auth.js'
import { DATA_DIR } from '../utils/config.js'

const DELIVER_MIME: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip':  'application/zip',
  '.pdf':  'application/pdf',
  '.png':  'image/png',
}

const CONV_TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/

export function registerDeliverRoutes(router: Router): void {
  router.get('/api/deliver/:convToken/:filename', requireAuth, (req: Request, res: Response) => {
    const { convToken, filename } = req.params

    if (!CONV_TOKEN_RE.test(convToken)) {
      res.status(400).json({ error: 'invalid convToken' })
      return
    }

    const safeName = path.basename(decodeURIComponent(filename))
    if (!safeName || safeName === '.' || safeName === '..') {
      res.status(400).json({ error: 'invalid filename' })
      return
    }

    const baseDir  = path.join(DATA_DIR, 'deliverables', convToken)
    const filePath = path.join(baseDir, safeName)

    if (!filePath.startsWith(baseDir + path.sep)) {
      res.status(400).json({ error: 'invalid path' })
      return
    }

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'deliverable not found' })
      return
    }

    const ext  = path.extname(safeName).toLowerCase()
    const mime = DELIVER_MIME[ext] ?? 'application/octet-stream'

    res.setHeader('Content-Type', mime)
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`)
    res.sendFile(filePath)
  })
}
