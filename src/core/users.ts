// -- User store ----------------------------------------------------------------
// Manages user accounts, password hashing, session tokens.
// Persists to DATA_DIR/users/registry.json and DATA_DIR/users/sessions.json.
// No external dependencies — uses Node crypto (pbkdf2 + randomBytes).

import * as fs     from 'fs'
import * as path   from 'path'
import * as crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import { DATA_DIR } from '../utils/config.js'
import type { UserRecord, SessionToken, UserRole } from '../types/index.js'

// -- Paths ---------------------------------------------------------------------

const USERS_DIR      = path.join(DATA_DIR, 'users')
const REGISTRY_FILE  = path.join(USERS_DIR, 'registry.json')
const SESSIONS_FILE  = path.join(USERS_DIR, 'sessions.json')

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000  // 30 days

// -- Password hashing (pbkdf2) -------------------------------------------------

const PBKDF2_ITERS  = 100_000
const PBKDF2_KEYLEN = 64
const PBKDF2_DIGEST = 'sha512'

function hashPassword(password: string): string {
  const salt   = crypto.randomBytes(16).toString('hex')
  const derived = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERS, PBKDF2_KEYLEN, PBKDF2_DIGEST)
  return `${salt}:${derived.toString('hex')}`
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const derived = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERS, PBKDF2_KEYLEN, PBKDF2_DIGEST)
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), derived)
}

// -- In-memory state -----------------------------------------------------------

let users:    UserRecord[]  = []
let sessions: SessionToken[] = []

// -- Persistence helpers -------------------------------------------------------

function ensureDir(): void {
  if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true })
}

function loadUsers(): UserRecord[] {
  try {
    if (!fs.existsSync(REGISTRY_FILE)) return []
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')) as UserRecord[]
  } catch { return [] }
}

function saveUsers(): void {
  ensureDir()
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(users, null, 2))
}

function loadSessions(): SessionToken[] {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return []
    const all = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) as SessionToken[]
    // Prune expired on load
    return all.filter(s => new Date(s.expiresAt).getTime() > Date.now())
  } catch { return [] }
}

function saveSessions(): void {
  ensureDir()
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2))
}

// -- Initialization ------------------------------------------------------------

export function initUsers(): void {
  ensureDir()
  users    = loadUsers()
  sessions = loadSessions()

  // Bootstrap admin from env vars on first run
  const adminEmail    = process.env.ADMIN_EMAIL?.trim()
  const adminPassword = process.env.ADMIN_PASSWORD?.trim()

  if (adminEmail && adminPassword) {
    const existing = users.find(u => u.email.toLowerCase() === adminEmail.toLowerCase())
    if (!existing) {
      const now = new Date().toISOString()
      const admin: UserRecord = {
        id:           uuidv4(),
        email:        adminEmail.toLowerCase(),
        displayName:  'Admin',
        passwordHash: hashPassword(adminPassword),
        role:         'admin',
        createdAt:    now,
        lastActive:   now,
      }
      users.push(admin)
      saveUsers()
      console.log('[users] Admin account created for ' + adminEmail)
    } else if (existing.role !== 'admin') {
      // Env var promotes existing user to admin
      existing.role = 'admin'
      saveUsers()
      console.log('[users] ' + adminEmail + ' promoted to admin via env var')
    }
  }

  console.log('[users] ' + users.length + ' user(s) loaded')
}

// -- User CRUD -----------------------------------------------------------------

export function listUsers(): Omit<UserRecord, 'passwordHash'>[] {
  return users.map(({ passwordHash: _ph, ...rest }) => rest)
}

export function getUserByEmail(email: string): UserRecord | undefined {
  return users.find(u => u.email.toLowerCase() === email.toLowerCase())
}

export function getUserById(id: string): UserRecord | undefined {
  return users.find(u => u.id === id)
}

export function createUser(email: string, displayName: string, password: string, role: UserRole = 'user'): UserRecord {
  const existing = getUserByEmail(email)
  if (existing) throw new Error('User already exists: ' + email)
  const now = new Date().toISOString()
  const user: UserRecord = {
    id:           uuidv4(),
    email:        email.toLowerCase(),
    displayName,
    passwordHash: hashPassword(password),
    role,
    createdAt:    now,
    lastActive:   now,
  }
  users.push(user)
  saveUsers()
  return user
}

export function updateUserPassword(userId: string, newPassword: string): void {
  const user = getUserById(userId)
  if (!user) throw new Error('User not found')
  user.passwordHash = hashPassword(newPassword)
  saveUsers()
}

export function updateUserProfile(userId: string, patch: { displayName?: string }): void {
  const user = getUserById(userId)
  if (!user) throw new Error('User not found')
  if (patch.displayName !== undefined) user.displayName = patch.displayName.trim() || user.displayName
  saveUsers()
}

export function setUserRole(userId: string, role: UserRole): void {
  const user = getUserById(userId)
  if (!user) throw new Error('User not found')
  user.role = role
  saveUsers()
}

export function deleteUser(userId: string): void {
  const before = users.length
  users = users.filter(u => u.id !== userId)
  if (users.length === before) throw new Error('User not found')
  // Revoke all sessions for this user
  sessions = sessions.filter(s => s.userId !== userId)
  saveUsers()
  saveSessions()
}

// -- Authentication ------------------------------------------------------------

export function authenticateUser(email: string, password: string): UserRecord | null {
  const user = getUserByEmail(email)
  if (!user) return null
  if (!verifyPassword(password, user.passwordHash)) return null
  user.lastActive = new Date().toISOString()
  saveUsers()
  return user
}

// -- Session tokens ------------------------------------------------------------

export function createSession(user: UserRecord): SessionToken {
  const now     = new Date()
  const expires = new Date(now.getTime() + SESSION_TTL_MS)
  const session: SessionToken = {
    token:     crypto.randomBytes(32).toString('hex'),
    userId:    user.id,
    email:     user.email,
    role:      user.role,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  }
  sessions.push(session)
  // Prune expired
  sessions = sessions.filter(s => new Date(s.expiresAt).getTime() > Date.now())
  saveSessions()
  return session
}

export function validateSession(token: string): SessionToken | null {
  const session = sessions.find(s => s.token === token)
  if (!session) return null
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    sessions = sessions.filter(s => s.token !== token)
    saveSessions()
    return null
  }
  return session
}

export function revokeSession(token: string): void {
  sessions = sessions.filter(s => s.token !== token)
  saveSessions()
}

export function revokeAllSessions(userId: string): void {
  sessions = sessions.filter(s => s.userId !== userId)
  saveSessions()
}
