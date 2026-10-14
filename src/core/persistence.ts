// -- Persistence ---------------------------------------------------------------
// Load/save for agents, tools, and coordinator config.
// Also exports mutable AGENTS, TOOLS, COORDINATOR state and defaultLLM.

import * as fs from 'fs'
import { DEFAULT_AGENTS, OLLAMA_BASE_URL, OLLAMA_MODEL } from '../agents.js'
import {
  DATA_DIR, AGENTS_FILE, TOOLS_FILE, COORDINATOR_FILE, SKILLS_DIR,
} from '../utils/config.js'
import type { AgentLLM, TeamAgent, ToolConfig, CoordinatorConfig } from '../types/index.js'

// -- Default LLM ---------------------------------------------------------------

export function defaultLLM(): AgentLLM {
  return {
    provider: 'local',
    url: OLLAMA_BASE_URL,
    apiKey: 'ollama',
    model: OLLAMA_MODEL,
  }
}

// -- Default tools -------------------------------------------------------------

const DEFAULT_TOOLS: ToolConfig[] = [
  {
    id: 'qdrant-rag',
    name: 'Qdrant RAG',
    type: 'qdrant_rag',
    enabled: false,
    config: {
      url: 'http://localhost:6333',
      embeddingUrl: 'http://localhost:8764',
    },
  },
]

// -- I/O helpers ---------------------------------------------------------------

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch {}
}

export function loadAgents(): TeamAgent[] {
  ensureDataDir()
  try {
    const raw = fs.readFileSync(AGENTS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as TeamAgent[]
  } catch {}
  // First boot -- build from hardcoded defaults and persist immediately
  const agents: TeamAgent[] = DEFAULT_AGENTS.map(a => ({
    name: a.name,
    systemPrompt: a.systemPrompt || '',
    llm: defaultLLM(),
    temperature: 0,
    maxTokens: 4096,
    tools: [],
    toolCollections: {},
    peers: [],
  }))
  try { fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2), 'utf8') } catch {}
  return agents
}

export function loadTools(): ToolConfig[] {
  ensureDataDir()
  try {
    const raw = fs.readFileSync(TOOLS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as ToolConfig[]
  } catch {}
  try { fs.writeFileSync(TOOLS_FILE, JSON.stringify(DEFAULT_TOOLS, null, 2), 'utf8') } catch {}
  return DEFAULT_TOOLS
}

export function saveAgents(agents: TeamAgent[]) {
  ensureDataDir()
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2), 'utf8')
}

export function saveTools(tools: ToolConfig[]) {
  ensureDataDir()
  fs.writeFileSync(TOOLS_FILE, JSON.stringify(tools, null, 2), 'utf8')
}

export function loadCoordinator(): CoordinatorConfig {
  ensureDataDir()
  try {
    const raw = fs.readFileSync(COORDINATOR_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed?.llm) {
      // Migrate: back-fill skills block if absent
      let dirty = false
      if (!parsed.skills) {
        parsed.skills = { skillsDir: SKILLS_DIR }
        dirty = true
      }
      if (dirty) {
        try { fs.writeFileSync(COORDINATOR_FILE, JSON.stringify(parsed, null, 2), 'utf8') } catch {}
      }
      return parsed as CoordinatorConfig
    }
  } catch {}
  const cfg: CoordinatorConfig = {
    llm: defaultLLM(), flags: [],
    decompositionPrompt: '', routingPrompt: '', clarificationPrompt: '', synthesisPrompt: '',
    skills: { skillsDir: SKILLS_DIR },
  }
  if (process.env.QDRANT_URL && process.env.TEI_URL) {
    cfg.memory = {
      qdrantUrl:  process.env.QDRANT_URL,
      teiUrl:     process.env.TEI_URL,
      vectorSize: parseInt(process.env.TEI_VECTOR_SIZE ?? '768', 10),
    }
  }
  try { fs.writeFileSync(COORDINATOR_FILE, JSON.stringify(cfg, null, 2), 'utf8') } catch {}
  return cfg
}

export function saveCoordinator(cfg: CoordinatorConfig) {
  ensureDataDir()
  fs.writeFileSync(COORDINATOR_FILE, JSON.stringify(cfg, null, 2), 'utf8')
}

// -- Pending changes -----------------------------------------------------------

import type { PendingChange } from '../types/index.js'
import { PENDING_CHANGES_FILE } from '../utils/config.js'

export function loadPendingChanges(): PendingChange[] {
  ensureDataDir()
  try {
    const raw = fs.readFileSync(PENDING_CHANGES_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as PendingChange[]
  } catch {}
  return []
}

export function savePendingChanges(changes: PendingChange[]): void {
  ensureDataDir()
  fs.writeFileSync(PENDING_CHANGES_FILE, JSON.stringify(changes, null, 2), 'utf8')
}

export function appendPendingChange(change: PendingChange): void {
  const changes = loadPendingChanges()
  changes.push(change)
  savePendingChanges(changes)
}

export function updatePendingChange(id: string, patch: Partial<PendingChange>): PendingChange | null {
  const changes = loadPendingChanges()
  const idx = changes.findIndex(c => c.id === id)
  if (idx === -1) return null
  changes[idx] = { ...changes[idx]!, ...patch }
  savePendingChanges(changes)
  return changes[idx]!
}
