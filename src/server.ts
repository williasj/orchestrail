import express, { Request, Response } from 'express'
import cors from 'cors'
import { OLLAMA_BASE_URL, OLLAMA_MODEL } from './agents.js'
import { UI_HTML } from './ui.js'
import { PORT, MODEL_ID, PIPELINES_API_KEY, cols, RAG_DIR } from './utils/config.js'
import {
  initMemory, qdrantEnsureCollection,
  rehydrateWorkbench, analyzeAndStoreToolingPatterns,
} from './core/memory.js'
import {
  initSkillExec, startupScanCaps, watchSkillCaps,
} from './core/skillexec.js'
import { initRagKernel } from './core/ragkernel.js'
import { initFailures } from './core/ragspecs.js'
import {
  defaultLLM, loadAgents, loadTools, loadCoordinator,
  saveAgents, saveTools, saveCoordinator,
} from './core/persistence.js'
import {
  initLLM, usageStorage, callLLM, callCoordinatorLLM,
} from './core/llm.js'
import {
  initPrompts,
  defaultDecompositionTemplate, defaultRoutingTemplate,
  defaultClarificationPrompt, DEFAULT_SYNTHESIS_PROMPT,
} from './core/prompts.js'
import {
  initTools, appendToolLog, getToolLog, clearToolLog, fetchRagManagerSpec,
  runCodeViaTool,
} from './core/tools.js'
import { initAgent, runAgent, bumpGeneration, getGeneration } from './core/agent.js'
import { initIntake, runClarificationIntake } from './core/intake.js'
import { initDecompose, decomposeGoal } from './core/decompose.js'
import {
  initSynthesize, synthesize, reflectAndStoreMetaMemory,
} from './core/synthesize.js'
import { resolveConversationId, registerConvAlias } from './core/conversation.js'
import { createCoordinatorRoute } from './core/coordinator.js'
import { registerHealthRoutes }      from './routes/health.js'
import { registerAdminRoutes }       from './routes/admin.js'
import { registerAuthRoutes }        from './routes/auth.js'
import { registerPipelinesRoutes }   from './routes/pipelines.js'
import { registerCompletionsRoutes } from './routes/completions.js'
import { registerBulletTrainRoutes } from './bullettrain/routes.js'
import { recoverStrandedRuns }       from './bullettrain/supervisor.js'
import { registerSkillRoutes }       from './routes/skills.js'
import { registerWikiRoutes }        from './routes/wiki.js'
import { initUsers }                 from './core/users.js'
import type { TeamAgent, ToolConfig, CoordinatorConfig } from './types/index.js'

const app = express()

app.use(cors())
app.use(express.json({ limit: '10mb' }))

// All /v1/* routes require Authorization: Bearer <PIPELINES_API_KEY>.
app.use('/v1', (req: Request, res: Response, next) => {
  const auth  = req.headers['authorization'] ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth
  if (token !== PIPELINES_API_KEY) {
    res.status(401).json({ detail: 'Unauthorized' })
    return
  }
  next()
})

// -- State ---------------------------------------------------------------------

let AGENTS:      TeamAgent[]       = loadAgents()
let TOOLS:       ToolConfig[]      = loadTools()
let COORDINATOR: CoordinatorConfig = loadCoordinator()

initUsers()
initMemory({ getCoordinator: () => COORDINATOR, getToolLog: () => getToolLog() })
initLLM({ getCoordinator: () => COORDINATOR })
initPrompts({ getAgents: () => AGENTS, getCoordinator: () => COORDINATOR })
initTools({ getAgents: () => AGENTS, getTools: () => TOOLS })
initAgent({ getAgents: () => AGENTS })
initIntake({ getCoordinator: () => COORDINATOR })
initDecompose({ getAgents: () => AGENTS, getCoordinator: () => COORDINATOR })
initSynthesize({ getCoordinator: () => COORDINATOR })
initSkillExec({ getCoordinator: () => COORDINATOR })
initRagKernel({ getCoordinator: () => COORDINATOR })

// -- Routes -------------------------------------------------------------------

const coordinatorRoute = createCoordinatorRoute({
  getAgents:        () => AGENTS,
  getRoutingPrompt: () => COORDINATOR.routingPrompt,
  callLLM:          callCoordinatorLLM,
  appendToolLog,
})

// Auth routes — no auth required (login endpoint) + session-gated endpoints
registerAuthRoutes(app)

registerHealthRoutes(app, {
  modelId:   MODEL_ID,
  uiHtml:    UI_HTML,
  getAgents: () => AGENTS,
})

registerAdminRoutes(app, {
  getAgents:    () => AGENTS,
  setAgents:    (a) => { AGENTS = a },
  saveAgents,
  defaultLLM,

  getTools:     () => TOOLS,
  setTools:     (t) => { TOOLS = t },
  saveTools,

  getCoordinator:        () => COORDINATOR,
  setCoordinator:        (c) => { COORDINATOR = c },
  saveCoordinator,
  defaultCoordinatorLLM: defaultLLM,

  defaultDecompositionTemplate,
  defaultRoutingTemplate,
  defaultClarificationPrompt,
  defaultSynthesisPrompt: DEFAULT_SYNTHESIS_PROMPT,

  getToolLog,
  clearToolLog,

  ollamaBaseUrl:       OLLAMA_BASE_URL,
  ollamaModel:         OLLAMA_MODEL,
  fetchRagManagerSpec,
})

registerPipelinesRoutes(app, {
  modelId:        MODEL_ID,
  getCoordinator: () => COORDINATOR,
  setCoordinator: (c) => { COORDINATOR = c },
  saveCoordinator,
  getAgents:      () => AGENTS,
  setAgents:      (a) => { AGENTS = a },
  saveAgents,
})

registerCompletionsRoutes(app, {
  usageStorage,
  bumpGeneration,
  getGeneration,
  callLLM,
  getCoordinator:  () => COORDINATOR,
  runClarificationIntake,
  decomposeGoal,
  synthesize,
  runAgent,
  coordinatorRoute,
  rehydrateWorkbench,
  reflectAndStoreMetaMemory,
  analyzeAndStoreToolingPatterns,
  resolveConversationId,
  registerConvAlias,
})

// BulletTrain: single-agent autonomous project runner. Own routes/storage/config
// under src/bullettrain/ -- shares this container, the auth session above, the
// UI shell, and the orchestrail-exec sidecar. Does not touch AGENTS/TOOLS/
// COORDINATOR and reads no core/ pipeline state.
registerBulletTrainRoutes(app)
recoverStrandedRuns()
registerSkillRoutes(app, { exec: runCodeViaTool })
registerWikiRoutes(app)

// -- Start ---------------------------------------------------------------------

app.listen(PORT, async () => {
  console.log('Orchestrail -- port ' + PORT)
  console.log('Ollama             -- ' + OLLAMA_BASE_URL)
  console.log('Coordinator        -- ' + COORDINATOR.llm.model + ' @ ' + COORDINATOR.llm.url)
  console.log('Agents             -- ' + AGENTS.map(a => a.name).join(', '))
  console.log('WebUI              -- http://localhost:' + PORT + '/ui')
  console.log('Pipelines URL      -- http://localhost:' + PORT + '  (key: ' + PIPELINES_API_KEY + ')')

  for (const a of AGENTS) {
    if (a.readOnlySlots === undefined) {
      console.warn(`[config] Agent '${a.name}' has no readOnlySlots field -- agents.json may be stale.`)
    }
  }

  const m = COORDINATOR.memory
  if (m?.qdrantUrl && m?.teiUrl && m?.vectorSize) {
    console.log('Memory (Qdrant)    -- ' + m.qdrantUrl)
    console.log('Memory (TEI)       -- ' + m.teiUrl)
    console.log('Memory (cols)      -- ' + Object.values(cols).join(', '))
    try {
      await Promise.all(Object.values(cols).map(c => qdrantEnsureCollection(m.qdrantUrl, c, m.vectorSize)))
    } catch (e) {
      console.warn('[memory] Failed to ensure collections:', e instanceof Error ? e.message : String(e))
    }

    // RAG split-storage collections (file-backed). Failures first; workbench/users later.
    console.log('RAG dir            -- ' + RAG_DIR)
    await initFailures()
  }

  const s = COORDINATOR.skills
  if (s?.skillsDir) {
    console.log('Skills dir         -- ' + s.skillsDir)
    // Executable skills (capabilities): scan cap/ folders + watch cap/user.
    // The executor is runCodeViaTool (writes the program then runs it via the exec server's bash tool).
    await startupScanCaps(runCodeViaTool)
    watchSkillCaps(runCodeViaTool).catch(e => console.warn('[skillcap] watcher error:', e))
  }
})
