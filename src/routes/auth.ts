// -- Auth routes and middleware ------------------------------------------------
// POST /api/auth/login    — email + password → session token (HttpOnly cookie + JSON)
// POST /api/auth/logout   — revoke session
// GET  /api/auth/me       — return current user info
// GET  /api/users         — admin: list all users
// POST /api/users         — admin: create user
// DELETE /api/users/:id   — admin: delete user
// PUT /api/users/:id/role — admin: set role

import type { Request, Response, Router, NextFunction } from 'express'
import type { AuthContext } from '../types/index.js'
import {
  authenticateUser, createSession, revokeSession, validateSession,
} from '../core/users.js'

// Augment Express Request with auth context
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext
    }
  }
}

// -- Session token extraction --------------------------------------------------
// Accepts token from:
//  1. Authorization: Bearer <token>  (API / fetch calls)
//  2. Cookie: orchestrail_session=<token>  (browser UI)

function extractToken(req: Request): string | null {
  const auth = req.headers['authorization'] ?? ''
  if (auth.startsWith('Bearer ')) {
    const t = auth.slice(7).trim()
    if (t) return t
  }
  const cookies = parseCookies(req.headers['cookie'] ?? '')
  return cookies['orchestrail_session'] ?? null
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim())
  }
  return out
}

// -- Middleware ----------------------------------------------------------------

/** Require a valid session. Attaches req.auth. Returns 401 otherwise. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req)
  if (!token) { res.status(401).json({ error: 'Not authenticated' }); return }
  const session = validateSession(token)
  if (!session) { res.status(401).json({ error: 'Session expired or invalid' }); return }
  req.auth = { userId: session.userId, email: session.email, role: session.role }
  next()
}

/** Require admin role. Must be composed after requireAuth. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.auth?.role !== 'admin') { res.status(403).json({ error: 'Admin only' }); return }
  next()
}

// -- Route registration -------------------------------------------------------

export function registerAuthRoutes(router: Router): void {

  // POST /api/auth/login
  router.post('/api/auth/login', (req: Request, res: Response) => {
    const { email, password } = req.body as { email?: string; password?: string }
    if (!email || !password) { res.status(400).json({ error: 'email and password required' }); return }

    const user = authenticateUser(email.trim(), password)
    if (!user) { res.status(401).json({ error: 'Invalid email or password' }); return }

    const session = createSession(user)

    // Set HttpOnly cookie for browser UI (30-day, SameSite=Lax)
    res.setHeader('Set-Cookie', [
      `orchestrail_session=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`,
    ])

    res.json({
      token:       session.token,
      email:       user.email,
      displayName: user.displayName,
      role:        user.role,
      expiresAt:   session.expiresAt,
    })
  })

  // POST /api/auth/logout
  router.post('/api/auth/logout', (req: Request, res: Response) => {
    const token = extractToken(req)
    if (token) revokeSession(token)
    res.setHeader('Set-Cookie', ['orchestrail_session=; Path=/; HttpOnly; Max-Age=0'])
    res.json({ ok: true })
  })

  // GET /api/auth/me
  router.get('/api/auth/me', requireAuth, (req: Request, res: Response) => {
    res.json(req.auth)
  })

  // User management routes moved to admin.ts
}
