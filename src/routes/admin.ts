// -- Admin API routes ----------------------------------------------------------
// CRUD for agents, tools, coordinator config, tool-log, and infra proxies.

import type { Request, Response, Router } from 'express'
import type {
  TeamAgent, ToolConfig, CoordinatorConfig, ToolLogEntry, RagManagerSpec,
} from '../types/index.js'
import {
  listConversations, listAllConversations, conversationBelongsTo, deleteConversation,
  getToolLogEntries, clearToolLogEntries, getAllToolLogEntries,
  getMessages, deleteMessages, deleteToolLog,
} from '../core/conversation.js'
import { requireAuth, requireAdmin } from './auth.js'
import {
  listUsers, getUserById, createUser, updateUserPassword, updateUserProfile, setUserRole, deleteUser,
} from '../core/users.js'
import * as fsSync from 'node:fs'
import * as pathMod from 'node:path'
import {
  loadPendingChanges, updatePendingChange,
  loadAgents, loadCoordinator,
} from '../core/persistence.js'
import { SOURCE_ROOT as srcRoot } from '../utils/config.js'
import { createSkill } from '../core/skillexec.js'
import { runCodeViaTool } from '../core/tools.js'

export interface AdminDeps {
  getAgents:       () => TeamAgent[]
  setAgents:       (a: TeamAgent[]) => void
  saveAgents:      (a: TeamAgent[]) => void
  defaultLLM:      () => TeamAgent['llm']

  getTools:        () => ToolConfig[]
  setTools:        (t: ToolConfig[]) => void
  saveTools:       (t: ToolConfig[]) => void

  getCoordinator:  () => CoordinatorConfig
  setCoordinator:  (c: CoordinatorConfig) => void
  saveCoordinator: (c: CoordinatorConfig) => void
  defaultCoordinatorLLM: () => CoordinatorConfig['llm']

  defaultDecompositionTemplate: () => string
  defaultRoutingTemplate:       () => string
  defaultClarificationPrompt:   () => string
  defaultSynthesisPrompt:       string

  getToolLog:      () => ToolLogEntry[]
  clearToolLog:    () => void

  ollamaBaseUrl:   string
  ollamaModel:     string

  fetchRagManagerSpec: (url: string) => Promise<RagManagerSpec>
}

export function registerAdminRoutes(router: Router, deps: AdminDeps): void {
  const {
    getAgents, setAgents, saveAgents, defaultLLM,
    getTools, setTools, saveTools,
    getCoordinator, setCoordinator, saveCoordinator, defaultCoordinatorLLM,
    defaultDecompositionTemplate, defaultRoutingTemplate,
    defaultClarificationPrompt, defaultSynthesisPrompt,
    getToolLog, clearToolLog,
    ollamaBaseUrl, ollamaModel,
    fetchRagManagerSpec,
  } = deps

  // -- Agents ------------------------------------------------------------------

  router.get('/api/agents', requireAuth, (_req, res) => { res.json(getAgents()) })

  router.put('/api/agents', requireAuth, requireAdmin, (req: Request, res: Response) => {
    if (!Array.isArray(req.body)) { res.status(400).json({ error: 'Expected array' }); return }
    const agents = req.body as TeamAgent[]
    setAgents(agents)
    saveAgents(agents)
    res.json({ ok: true, count: agents.length })
  })

  router.post('/api/agents', requireAuth, requireAdmin, (req: Request, res: Response) => {
    const agent = req.body as TeamAgent
    if (!agent?.name || !agent?.systemPrompt) { res.status(400).json({ error: 'name and systemPrompt required' }); return }
    const agents = getAgents()
    if (agents.find(a => a.name === agent.name)) { res.status(409).json({ error: 'Agent name already exists' }); return }
    const newAgent: TeamAgent = { ...agent }
    if (newAgent.temperature  === undefined) newAgent.temperature  = 0
    if (newAgent.maxTokens    === undefined) newAgent.maxTokens    = 4096
    if (!newAgent.tools)          newAgent.tools          = []
    if (!newAgent.toolCollections) newAgent.toolCollections = {}
    if (!newAgent.llm)            newAgent.llm             = defaultLLM()
    const updated = [...agents, newAgent]
    setAgents(updated)
    saveAgents(updated)
    res.status(201).json({ ok: true })
  })

  router.put('/api/agents/:name', requireAuth, requireAdmin, (req: Request, res: Response) => {
    const { name } = req.params
    const agents = getAgents()
    const idx    = agents.findIndex(a => a.name === name)
    if (idx === -1) { res.status(404).json({ error: 'Not found' }); return }
    agents[idx] = { ...agents[idx]!, ...req.body as TeamAgent, name }
    setAgents(agents)
    saveAgents(agents)
    res.json({ ok: true })
  })

  router.delete('/api/agents/:name', requireAuth, requireAdmin, (req: Request, res: Response) => {
    const { name } = req.params
    const before   = getAgents().length
    const updated  = getAgents().filter(a => a.name !== name)
    if (updated.length === before) { res.status(404).json({ error: 'Not found' }); return }
    setAgents(updated)
    saveAgents(updated)
    res.json({ ok: true })
  })

  // -- Tools -------------------------------------------------------------------

  router.get('/api/tools', requireAuth, (_req, res) => { res.json(getTools()) })

  router.put('/api/tools', requireAuth, requireAdmin, (req: Request, res: Response) => {
    if (!Array.isArray(req.body)) { res.status(400).json({ error: 'Expected array' }); return }
    const tools = req.body as ToolConfig[]
    setTools(tools)
    saveTools(tools)
    res.json({ ok: true, count: tools.length })
  })

  router.post('/api/tools', requireAuth, requireAdmin, (req: Request, res: Response) => {
    const tool  = req.body as ToolConfig
    if (!tool?.id || !tool?.name) { res.status(400).json({ error: 'id and name required' }); return }
    const tools = getTools()
    if (tools.find(t => t.id === tool.id)) { res.status(409).json({ error: 'Tool id already exists' }); return }
    const updated = [...tools, tool]
    setTools(updated)
    saveTools(updated)
    res.status(201).json({ ok: true })
  })

  router.put('/api/tools/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
    const { id } = req.params
    const tools  = getTools()
    const idx    = tools.findIndex(t => t.id === id)
    if (idx === -1) { res.status(404).json({ error: 'Not found' }); return }
    tools[idx] = { ...tools[idx]!, ...req.body as ToolConfig, id }
    setTools(tools)
    saveTools(tools)
    res.json({ ok: true })
  })

  router.delete('/api/tools/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
    const { id }  = req.params
    const before  = getTools().length
    const updated = getTools().filter(t => t.id !== id)
    if (updated.length === before) { res.status(404).json({ error: 'Not found' }); return }
    setTools(updated)
    saveTools(updated)
    res.json({ ok: true })
  })

  // -- Coordinator config ------------------------------------------------------

  router.get('/api/coordinator', requireAuth, (_req, res) => { res.json(getCoordinator()) })

  router.put('/api/coordinator', requireAuth, requireAdmin, (req: Request, res: Response) => {
    const body = req.body as Partial<CoordinatorConfig>
    if (!body?.llm?.model || !body?.llm?.url) {
      res.status(400).json({ error: 'llm.model and llm.url are required' }); return
    }
    const str = (v: unknown) => typeof v === 'string' ? v : ''
    const current = getCoordinator()
    const updated: CoordinatorConfig = {
      llm:                 { ...defaultCoordinatorLLM(), ...body.llm },
      flags:               Array.isArray(body.flags)
        ? body.flags.filter((f): f is string => typeof f === 'string' && !!f.trim())
        : [],
      decompositionPrompt: str(body.decompositionPrompt),
      routingPrompt:       str(body.routingPrompt),
      clarificationPrompt: str(body.clarificationPrompt),
      synthesisPrompt:     str(body.synthesisPrompt),
    }
    // Preserve fields managed outside the UI form — memory, skills, and any
    // future additions — so a coordinator save never silently nukes them.
    const mem = body.memory ?? current.memory
    if (mem) updated.memory = mem
    if (current.skills) updated.skills = current.skills
    setCoordinator(updated)
    saveCoordinator(updated)
    res.json({ ok: true })
  })

  // Returns the built-in default text for each coordinator prompt.
  // The UI uses this for Reset-to-default buttons.
  router.get('/api/coordinator/defaults', requireAuth, (_req, res) => {
    res.json({
      decompositionPrompt: defaultDecompositionTemplate(),
      routingPrompt:       defaultRoutingTemplate(),
      clarificationPrompt: defaultClarificationPrompt(),
      synthesisPrompt:     defaultSynthesisPrompt,
    })
  })

  // -- Tool execution log ------------------------------------------------------

  // GET /api/tool-log
  // Regular users: returns only entries tagged with their email.
  // Admins: returns all entries; optional ?userId= filter narrows to one user.
  // Optional ?conversationId= filter narrows to one conversation.
  router.get('/api/tool-log', requireAuth, (req: Request, res: Response) => {
    const limit      = parseInt(req.query['limit'] as string || '0') || 0
    const since      = parseInt(req.query['since']  as string || '0')
    const filterConv = req.query['conversationId'] as string | undefined

    let entries: ToolLogEntry[]
    if (req.auth?.role === 'admin') {
      const filterUser = req.query['userId'] as string | undefined
      entries = getAllToolLogEntries({ since, filterUser, filterConv, limit: limit || undefined })
    } else {
      const myEmail = req.auth?.email ?? ''
      entries = getAllToolLogEntries({ since, filterUser: myEmail, filterConv, limit: limit || undefined })
    }

    res.json(entries)
  })

  // Global tool-log clear is intentionally removed -- tool-log is now per-conversation
  // and only deleted when a user deletes the conversation.

  // -- Conversations -----------------------------------------------------------

  // GET /api/conversations
  // Regular users: their own conversations only.
  // Admins: all conversations; optional ?userId= filter.
  router.get('/api/conversations', requireAuth, (req: Request, res: Response) => {
    if (req.auth?.role === 'admin') {
      const filterUser = req.query['userId'] as string | undefined
      const all = listAllConversations()
      res.json(filterUser ? all.filter(c => c.userId === filterUser) : all)
    } else {
      res.json(listConversations(req.auth!.email))
    }
  })

  // GET /api/conversations/:convId/tool-log
  // Returns tool-log entries for a specific conversation.
  // Regular users: only if the conversation belongs to them.
  // Admins: any conversation.
  // GET /api/conversations/:convId/messages
  // Returns stored message history for a conversation.
  router.get('/api/conversations/:convId/messages', requireAuth, (req: Request, res: Response) => {
    const { convId } = req.params
    if (!convId) { res.status(400).json({ error: 'Missing convId' }); return }

    if (req.auth?.role !== 'admin') {
      const myEmail = req.auth?.email ?? ''
      if (!conversationBelongsTo(myEmail, convId)) {
        res.status(403).json({ error: 'Conversation not found' }); return
      }
      res.json(getMessages(myEmail, convId))
    } else {
      // Admin: find owner first
      const all  = listAllConversations()
      const meta = all.find(c => c.id === convId)
      if (!meta) { res.status(404).json({ error: 'Conversation not found' }); return }
      res.json(getMessages(meta.userId, convId))
    }
  })

  router.get('/api/conversations/:convId/tool-log', requireAuth, (req: Request, res: Response) => {
    const { convId } = req.params
    if (!convId) { res.status(400).json({ error: 'Missing convId' }); return }

    if (req.auth?.role !== 'admin') {
      const myEmail = req.auth?.email ?? ''
      if (!conversationBelongsTo(myEmail, convId)) {
        res.status(403).json({ error: 'Conversation not found' }); return
      }
      const since = parseInt(req.query['since'] as string || '0')
      const entries = getToolLogEntries(myEmail, convId)
      res.json(since ? entries.filter(e => e.ts > since) : entries)
    } else {
      const all  = listAllConversations()
      const meta = all.find(c => c.id === convId)
      if (!meta) { res.status(404).json({ error: 'Conversation not found' }); return }
      const since = parseInt(req.query['since'] as string || '0')
      const entries = getToolLogEntries(meta.userId, convId)
      res.json(since ? entries.filter(e => e.ts > since) : entries)
    }
  })

  // DELETE /api/conversations/:convId/tool-log
  // Clears tool-log for one conversation on user request. Does NOT delete messages.
  router.delete('/api/conversations/:convId/tool-log', requireAuth, (req: Request, res: Response) => {
    const { convId } = req.params
    if (!convId) { res.status(400).json({ error: 'Missing convId' }); return }

    if (req.auth?.role !== 'admin') {
      const myEmail = req.auth?.email ?? ''
      if (!conversationBelongsTo(myEmail, convId)) {
        res.status(403).json({ error: 'Conversation not found' }); return
      }
      clearToolLogEntries(myEmail, convId)
    } else {
      const all  = listAllConversations()
      const meta = all.find(c => c.id === convId)
      if (!meta) { res.status(404).json({ error: 'Conversation not found' }); return }
      clearToolLogEntries(meta.userId, convId)
    }
    res.json({ ok: true })
  })

  // DELETE /api/conversations/:convId
  // Permanently removes a conversation's persisted metadata.
  // Regular users: only their own. Admins: any.
  router.delete('/api/conversations/:convId', requireAuth, (req: Request, res: Response) => {
    const { convId } = req.params
    if (!convId) { res.status(400).json({ error: 'Missing convId' }); return }

    if (req.auth?.role !== 'admin') {
      const myEmail = req.auth?.email ?? ''
      if (!conversationBelongsTo(myEmail, convId)) {
        res.status(403).json({ error: 'Conversation not found' }); return
      }
      deleteConversation(myEmail, convId)
    } else {
      // Admin: find which user owns it by scanning all conversations
      const all = listAllConversations()
      const meta = all.find(c => c.id === convId)
      if (!meta) { res.status(404).json({ error: 'Conversation not found' }); return }
      deleteConversation(meta.userId, convId)
    }

    res.json({ ok: true })
  })

  // -- Infra proxies -----------------------------------------------------------

  // Ollama model list proxy
  router.get('/api/ollama/models', requireAuth, async (_req, res) => {
    try {
      const base = ollamaBaseUrl.replace('/v1', '')
      const r    = await fetch(`${base}/api/tags`)
      const data = await r.json() as { models?: { name: string }[] }
      res.json(data.models?.map((m: { name: string }) => m.name) ?? [])
    } catch {
      res.json([ollamaModel])
    }
  })

  // Qdrant collections proxy
  router.get('/api/qdrant/collections', requireAuth, async (req: Request, res: Response) => {
    const toolId  = req.query['toolId'] as string || 'qdrant-rag'
    const tool    = getTools().find(t => t.id === toolId && t.type === 'qdrant_rag')
    const baseUrl = tool?.config?.['url'] || 'http://localhost:6333'
    try {
      const r    = await fetch(`${baseUrl}/collections`)
      const data = await r.json() as { result?: { collections?: { name: string }[] } }
      const names = data.result?.collections?.map((c: { name: string }) => c.name) ?? []
      res.json(names)
    } catch (err) {
      res.status(502).json({ error: `Qdrant unreachable: ${err instanceof Error ? err.message : String(err)}` })
    }
  })

  // RAG Manager endpoints proxy
  router.get('/api/rag-manager/endpoints', requireAuth, async (req: Request, res: Response) => {
    const toolId = String(req.query['toolId'] ?? '')
    const tool   = getTools().find(t => t.id === toolId && t.type === 'rag_manager')
    if (!tool) { res.status(404).json({ error: 'RAG Manager tool not found' }); return }
    const url = tool.config['url']
    if (!url) { res.status(400).json({ error: 'Tool has no URL configured' }); return }
    try {
      const spec = await fetchRagManagerSpec(url)
      res.json(spec.endpoints.map(e => ({ operationId: e.operationId, summary: e.summary })))
    } catch (err) {
      res.status(502).json({ error: `RAG Manager unreachable: ${err instanceof Error ? err.message : String(err)}` })
    }
  })

  // -- Skills ------------------------------------------------------------------
  // The legacy prose-skill system (core/skills.ts) was retired in favor of the
  // executable skill-cap system (core/skillexec.ts). Its admin endpoints and the
  // /api/skills routes were removed with it; executable caps are managed via the
  // use_skill / create_skill tools and (where exposed) their own admin surface.

  // -- Pending changes (self-improvement) --------------------------------------

  router.get('/api/pending-changes', requireAuth, requireAdmin, (_req: Request, res: Response) => {
    res.json(loadPendingChanges())
  })

  // Approve: apply the patch to the source file on disk
  // Approve: apply the patch based on changeType
  router.post('/api/pending-changes/:id/approve', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const id = req.params['id']
    const changes = loadPendingChanges()
    const change = changes.find(c => c.id === id)
    if (!change) { res.status(404).json({ error: 'Change not found' }); return }
    if (change.status !== 'pending') { res.status(409).json({ error: `Change is already ${change.status}` }); return }

    const changeType = change.changeType ?? 'src-change'

    try {
      if (changeType === 'src-change' || !changeType) {
        const clean = change.file.replace(/^\.?\//, '')
        const abs = pathMod.resolve(srcRoot, clean)
        if (!abs.startsWith(pathMod.resolve(srcRoot))) {
          res.status(400).json({ error: 'Path traversal rejected' }); return
        }

        let fileContent: string
        try {
          fileContent = fsSync.readFileSync(abs, 'utf8')
        } catch (err) {
          res.status(500).json({ error: `Cannot read file: ${String(err)}` }); return
        }

        if (!fileContent.includes(change.original)) {
          updatePendingChange(id, {
            status: 'rejected',
            reviewedAt: new Date().toISOString(),
            reviewNote: 'AUTO-REJECTED: original text no longer exists in file (file was modified since proposal)',
          })
          res.status(409).json({ error: 'Original text no longer exists in file. Change auto-rejected.' }); return
        }

        const patched = fileContent.replace(change.original, change.replacement)
        try {
          fsSync.writeFileSync(abs, patched, 'utf8')
        } catch (err) {
          res.status(500).json({ error: `Cannot write file: ${String(err)}` }); return
        }

        updatePendingChange(id, {
          status: 'approved',
          reviewedAt: new Date().toISOString(),
          reviewNote: (req.body as { note?: string }).note,
        })
        console.log(`[pending-changes] approved src-change ${id} -> patched ${change.file}`)
        res.json({ ok: true, id, file: change.file, message: 'Patch applied. Rebuild the container to activate.' })

      } else if (changeType === 'agent-prompt-change') {
        const agents = loadAgents()
        const agentIdx = agents.findIndex(a => a.name === change.file)
        if (agentIdx === -1) {
          res.status(404).json({ error: `Agent not found: ${change.file}` }); return
        }
        const agent = agents[agentIdx]!
        if (!agent.systemPrompt.includes(change.original)) {
          updatePendingChange(id, {
            status: 'rejected',
            reviewedAt: new Date().toISOString(),
            reviewNote: 'AUTO-REJECTED: original text no longer exists in agent system prompt',
          })
          res.status(409).json({ error: 'Original text no longer exists in agent prompt. Change auto-rejected.' }); return
        }
        agents[agentIdx] = { ...agent, systemPrompt: agent.systemPrompt.replace(change.original, change.replacement) }
        saveAgents(agents)
        updatePendingChange(id, {
          status: 'approved',
          reviewedAt: new Date().toISOString(),
          reviewNote: (req.body as { note?: string }).note,
        })
        console.log(`[pending-changes] approved agent-prompt-change ${id} -> patched agent ${change.file}`)
        res.json({ ok: true, id, file: change.file, message: 'Agent system prompt patched. Hot-reloadable -- no rebuild needed.' })

      } else if (changeType === 'coordinator-prompt-change') {
        const validKeys = new Set(['decompositionPrompt', 'routingPrompt', 'clarificationPrompt', 'synthesisPrompt'])
        if (!validKeys.has(change.file)) {
          res.status(400).json({ error: `Invalid coordinator prompt key: ${change.file}` }); return
        }
        const coord = loadCoordinator()
        const currentVal = (coord as unknown as Record<string, unknown>)[change.file]
        if (typeof currentVal === 'string' && !currentVal.includes(change.original)) {
          updatePendingChange(id, {
            status: 'rejected',
            reviewedAt: new Date().toISOString(),
            reviewNote: 'AUTO-REJECTED: original text no longer exists in coordinator prompt',
          })
          res.status(409).json({ error: 'Original text no longer exists in coordinator prompt. Change auto-rejected.' }); return
        }
        const currentStr = typeof currentVal === 'string' ? currentVal : ''
        ;(coord as unknown as Record<string, unknown>)[change.file] = currentStr.replace(change.original, change.replacement)
        saveCoordinator(coord)
        updatePendingChange(id, {
          status: 'approved',
          reviewedAt: new Date().toISOString(),
          reviewNote: (req.body as { note?: string }).note,
        })
        console.log(`[pending-changes] approved coordinator-prompt-change ${id} -> patched ${change.file}`)
        res.json({ ok: true, id, file: change.file, message: 'Coordinator prompt patched. Hot-reloadable -- no rebuild needed.' })

      } else if (changeType === 'skill-create') {
        let spec: Record<string, unknown>
        try {
          spec = JSON.parse(change.replacement) as Record<string, unknown>
        } catch {
          res.status(400).json({ error: 'skill spec JSON is invalid' }); return
        }
        const skillInput = {
          name:            change.original,
          description:     String(spec['description'] ?? ''),
          language:        String(spec['language'] ?? 'python'),
          code:            String(spec['code'] ?? ''),
          input_mode:      spec['input_mode'] === 'raw' ? 'raw' as const : 'entrypoint' as const,
          input_contract:  spec['input_contract'] !== undefined ? String(spec['input_contract']) : undefined,
          output_contract: spec['output_contract'] !== undefined ? String(spec['output_contract']) : undefined,
          examples:        Array.isArray(spec['examples']) ? spec['examples'] as { input: unknown; expect: unknown }[] : undefined,
          tags:            Array.isArray(spec['tags']) ? (spec['tags'] as string[]) : undefined,
        }
        const result = await createSkill(skillInput, runCodeViaTool, 'human')
        updatePendingChange(id, {
          status: 'approved',
          reviewedAt: new Date().toISOString(),
          reviewNote: (req.body as { note?: string }).note ?? `Skill created: ${JSON.stringify(result).slice(0, 200)}`,
        })
        console.log(`[pending-changes] approved skill-create ${id} -> skill ${change.original}`)
        res.json({ ok: true, id, file: change.file, skillResult: result, message: 'Skill created. Hot-reloadable -- no rebuild needed.' })

      } else {
        res.status(400).json({ error: `Unknown changeType: ${changeType}` })
      }
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // Reject: mark as rejected, no file changes
  router.post('/api/pending-changes/:id/reject', requireAuth, requireAdmin, (req: Request, res: Response) => {
    const id = req.params['id']
    const updated = updatePendingChange(id, {
      status: 'rejected',
      reviewedAt: new Date().toISOString(),
      reviewNote: (req.body as { note?: string }).note,
    })
    if (!updated) { res.status(404).json({ error: 'Change not found' }); return }
    res.json({ ok: true, id, status: 'rejected' })
  })

  // Download pending changes as JSON (for verification handoff)
  router.get('/api/pending-changes/export', requireAuth, requireAdmin, (_req: Request, res: Response) => {
    const changes = loadPendingChanges()
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    res.setHeader('Content-Disposition', `attachment; filename="pending-changes-${ts}.json"`)
    res.setHeader('Content-Type', 'application/json')
    res.send(JSON.stringify(changes, null, 2))
  })

  // -- User management (admin) -------------------------------------------------

  // GET /api/users -- list all registered users (no password hashes)
  router.get('/api/users', requireAuth, requireAdmin, (_req: Request, res: Response) => {
    res.json(listUsers())
  })

  // POST /api/users -- create a new user
  router.post('/api/users', requireAuth, requireAdmin, (req: Request, res: Response) => {
    const { email, displayName, password, role } = req.body as {
      email?: string; displayName?: string; password?: string; role?: string
    }
    if (!email || !password) {
      res.status(400).json({ error: 'email and password are required' }); return
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' }); return
    }
    if (role && role !== 'admin' && role !== 'user') {
      res.status(400).json({ error: 'role must be admin or user' }); return
    }
    try {
      const user = createUser(
        email.trim().toLowerCase(),
        (displayName ?? '').trim() || email.trim(),
        password,
        (role as 'admin' | 'user') ?? 'user',
      )
      const { passwordHash: _ph, ...safe } = user
      res.status(201).json(safe)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      res.status(409).json({ error: msg })
    }
  })


  // PUT /api/users/me/password -- any authenticated user can change their own password
  router.put('/api/users/me/password', requireAuth, (req: Request, res: Response) => {
    const { password } = req.body as { password?: string }
    if (!password || password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' }); return
    }
    const userId = req.auth?.userId
    if (!userId) { res.status(401).json({ error: 'Not authenticated' }); return }
    updateUserPassword(userId, password)
    res.json({ ok: true })
  })
  // PUT /api/users/:id -- update role and/or displayName (admin); password via separate route
  router.put('/api/users/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
    const { id } = req.params
    const { role, displayName } = req.body as { role?: string; displayName?: string }
    const user = getUserById(id)
    if (!user) { res.status(404).json({ error: 'User not found' }); return }
    // Prevent admin from demoting themselves
    if (role && role !== user.role && user.id === req.auth?.userId) {
      res.status(400).json({ error: 'Cannot change your own role' }); return
    }
    if (role && role !== 'admin' && role !== 'user') {
      res.status(400).json({ error: 'role must be admin or user' }); return
    }
    if (role && role !== user.role) setUserRole(id, role as 'admin' | 'user')
    if (displayName !== undefined) updateUserProfile(id, { displayName })
    const updatedUser = getUserById(id)!
    const { passwordHash: _ph, ...safe } = updatedUser
    res.json(safe)
  })

  // PUT /api/users/:id/password -- reset a user's password (admin)
  router.put('/api/users/:id/password', requireAuth, requireAdmin, (req: Request, res: Response) => {
    const { id } = req.params
    const { password } = req.body as { password?: string }
    if (!password || password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' }); return
    }
    if (!getUserById(id)) { res.status(404).json({ error: 'User not found' }); return }
    updateUserPassword(id, password)
    res.json({ ok: true })
  })

  // DELETE /api/users/:id -- remove a user (admin cannot delete themselves)
  router.delete('/api/users/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
    const { id } = req.params
    if (id === req.auth?.userId) {
      res.status(400).json({ error: 'Cannot delete your own account' }); return
    }
    try {
      deleteUser(id)
      res.json({ ok: true })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      res.status(404).json({ error: msg })
    }
  })
}
