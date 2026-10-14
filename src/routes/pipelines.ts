// -- Pipelines management API + Models routes ----------------------------------
// Implements the OpenWebUI Pipelines protocol so Orchestrail appears as a
// managed pipeline in Admin > Pipelines, with live valve editing.

import type { Request, Response, Router } from 'express'
import type { TeamAgent, CoordinatorConfig } from '../types/index.js'

export interface PipelinesDeps {
  modelId:         string
  getCoordinator:  () => CoordinatorConfig
  setCoordinator:  (c: CoordinatorConfig) => void
  saveCoordinator: (c: CoordinatorConfig) => void
  getAgents:       () => TeamAgent[]
  setAgents:       (a: TeamAgent[]) => void
  saveAgents:      (a: TeamAgent[]) => void
}

// Fixed pipeline metadata — Orchestrail presents as a single built-in pipeline.
const PIPELINE_META = {
  module: 'orchestrail',
  name:   'Orchestrail',
  type:   'pipe' as const,
  meta:   { name: 'Orchestrail', description: 'Multi-agent orchestration pipeline with DAG and sequential modes.' },
}

const VALVE_SPEC = {
  type: 'object',
  properties: {
    ollama_base_url:    { type: 'string', title: 'Ollama / LLM Base URL',      description: 'OpenAI-compatible base URL for the coordinator and default agent LLM (e.g. http://host.docker.internal:11434/v1).' },
    coordinator_model:  { type: 'string', title: 'Coordinator Model',           description: 'Model used for decomposition, routing, and synthesis.' },
    api_key:            { type: 'string', title: 'LLM API Key',                 description: 'Bearer key for the LLM endpoint ("ollama" for local Ollama).' },
    memory_qdrant_url:  { type: 'string', title: 'Memory — Qdrant URL',         description: 'Qdrant base URL for agent memory. Leave blank to disable memory.' },
    memory_tei_url:     { type: 'string', title: 'Memory — Embedding URL',      description: 'TEI-compatible embedding endpoint URL for memory indexing.' },
  },
  required: [],
}

export function registerPipelinesRoutes(router: Router, deps: PipelinesDeps): void {
  const {
    modelId, getCoordinator, setCoordinator, saveCoordinator,
    getAgents, setAgents, saveAgents,
  } = deps

  const pipelineMeta = { id: modelId, ...PIPELINE_META }

  const getValves = () => {
    const c = getCoordinator()
    return {
      ollama_base_url:    c.llm.url,
      coordinator_model:  c.llm.model,
      api_key:            c.llm.apiKey,
      memory_qdrant_url:  c.memory?.qdrantUrl  ?? '',
      memory_tei_url:     c.memory?.teiUrl     ?? '',
    }
  }

  // -- Pipeline list / valves --------------------------------------------------

  router.get(['/v1/pipelines', '/pipelines'], (_req, res) => {
    res.json({ data: [{ ...pipelineMeta, valves: getValves() }] })
  })

  router.get(['/v1/pipelines/:id/valves', '/pipelines/:id/valves'], (req: Request, res: Response) => {
    if (req.params['id'] !== modelId) { res.status(404).json({ detail: 'Pipeline not found' }); return }
    res.json(getValves())
  })

  router.get(['/v1/pipelines/:id/valves/spec', '/pipelines/:id/valves/spec'], (req: Request, res: Response) => {
    if (req.params['id'] !== modelId) { res.status(404).json({ detail: 'Pipeline not found' }); return }
    res.json(VALVE_SPEC)
  })

  router.post(['/v1/pipelines/:id/valves/update', '/pipelines/:id/valves/update'], (req: Request, res: Response) => {
    if (req.params['id'] !== modelId) { res.status(404).json({ detail: 'Pipeline not found' }); return }
    const {
      ollama_base_url, coordinator_model, api_key,
      memory_qdrant_url, memory_tei_url,
    } = req.body as Record<string, string>

    const c      = getCoordinator()
    const prevUrl   = c.llm.url
    const prevModel = c.llm.model

    if (ollama_base_url   !== undefined) c.llm.url    = ollama_base_url
    if (coordinator_model !== undefined) c.llm.model  = coordinator_model
    if (api_key           !== undefined) c.llm.apiKey = api_key

    // Propagate LLM changes to agents still using the old coordinator URL/model.
    if (ollama_base_url !== undefined || coordinator_model !== undefined || api_key !== undefined) {
      const updated = getAgents().map(a =>
        (a.llm.url === prevUrl && a.llm.model === prevModel)
          ? { ...a, llm: { ...a.llm, ...c.llm } }
          : a
      )
      setAgents(updated)
      saveAgents(updated)
    }

    if (memory_qdrant_url !== undefined || memory_tei_url !== undefined) {
      c.memory = {
        ...c.memory,
        ...(memory_qdrant_url !== undefined ? { qdrantUrl: memory_qdrant_url } : {}),
        ...(memory_tei_url    !== undefined ? { teiUrl:    memory_tei_url    } : {}),
      } as typeof c.memory
    }

    setCoordinator(c)
    saveCoordinator(c)
    res.json(getValves())
  })

  // Dynamic install/delete — not supported; return a clear error.
  router.post('/v1/add', (_req, res) => {
    res.status(400).json({ detail: 'Orchestrail does not support dynamic pipeline installation. Configure agents via the /ui admin panel.' })
  })

  router.delete('/v1/delete/:id', (_req, res) => {
    res.status(400).json({ detail: 'The built-in Orchestrail pipeline cannot be deleted.' })
  })

  // -- Models ------------------------------------------------------------------

  const modelsResponse = () => ({
    object: 'list',
    data: [{
      id: modelId, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'orchestrail',
      // Tell OpenWebUI this model supports usage reporting so it sets stream_options.include_usage=true
      capabilities: { usage: true },
    }],
  })

  router.get('/v1/models', (_req, res) => { res.json(modelsResponse()) })
  // Open// OpenWebUI hits /models (no /v1 prefix) when registered as a Pipelines connection
  router.get('/models',    (_req, res) => { res.json(modelsResponse()) })
}
