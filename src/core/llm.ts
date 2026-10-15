// -- LLM call layer -----------------------------------------------------------
// Raw and convenience wrappers for LLM HTTP calls.
// usageStorage accumulates token counts per-request via AsyncLocalStorage.

import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentLLM, AgenticMessage, ChatMessage, CoordinatorConfig, LLMResponse, UsageTotals } from '../types/index.js'

// -- Module init ---------------------------------------------------------------

type LLMDeps = {
  getCoordinator: () => CoordinatorConfig
}

let _deps: LLMDeps | null = null

export function initLLM(deps: LLMDeps): void {
  _deps = deps
}

// -- Per-request usage accumulator --------------------------------------------
// callLLMRaw is the sole writer; routes/completions.ts reads it via dep injection.

export const usageStorage = new AsyncLocalStorage<UsageTotals>()

// -- Core call -----------------------------------------------------------------

// Raw call — returns full response so callers can inspect tool_calls.
export async function callLLMRaw(
  messages: AgenticMessage[] | ChatMessage[],
  llm: AgentLLM,
  maxTokens: number,
  temperature: number,
  tools?: unknown[],
  requester = 'orchestrail',
  extra?: Record<string, unknown>,
): Promise<LLMResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${llm.apiKey}`,
  }
  if (llm.provider === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01'
  }
  // Names this call in the GPU broker's queue, request history and Sources
  // tab (e.g. orchestrail/senior-engineer). Only sent to local/custom
  // endpoints; plain Ollama and other OpenAI-compatible servers ignore it.
  if (llm.provider !== 'anthropic' && llm.provider !== 'openai') {
    headers['X-Broker-Requester'] = requester.slice(0, 64)
  }
  const body: Record<string, unknown> = { model: llm.model, messages, temperature, max_tokens: maxTokens, ...(extra ?? {}) }
  if (tools && tools.length > 0) body['tools'] = tools
  const res = await fetch(`${llm.url}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`LLM error: ${res.status} ${await res.text()}`)
  const data = await res.json() as LLMResponse
  const store = usageStorage.getStore()
  if (store && data.usage) {
    store.prompt_tokens     += data.usage.prompt_tokens    ?? 0
    store.completion_tokens += data.usage.completion_tokens ?? 0
    store.total_tokens      += data.usage.total_tokens     ?? 0
  } else if (store && !data.usage) {
    console.warn('[llm] no usage field in response — token counts unavailable (model:', llm.model, ')')
  }
  return data
}

// Convenience wrapper — returns only the text content.
export async function callLLM(
  messages: ChatMessage[],
  llm: AgentLLM,
  maxTokens: number,
  temperature: number,
  requester = 'orchestrail',
  extra?: Record<string, unknown>,
): Promise<string> {
  const data = await callLLMRaw(messages, llm, maxTokens, temperature, undefined, requester, extra)
  return data.choices[0]?.message?.content ?? ''
}

// Returns a newline-terminated prefix from active coordinator flags, or ''.
export function buildFlagPrefix(): string {
  const flags = _deps?.getCoordinator().flags
  if (!flags || flags.length === 0) return ''
  return flags.join('\n') + '\n'
}

// Coordinator uses its own persisted LLM config.
// Flags are prepended to every system message so they apply to decomposition,
// clarification, and synthesis without touching the hardcoded prompt text.
//
// Thinking models spend reasoning tokens out of max_tokens. Routing (256),
// intake (1024) and reflection (256) budgets were consumed entirely by
// reasoning, so the answer came back empty and routing silently fell back to
// NEXT on every stage. Short structured calls therefore run with reasoning
// off (reasoning_effort "none", honoured by Ollama's OpenAI endpoint; sent
// only to local/custom providers). Calls that keep thinking use temperature
// 0.6 -- greedy decoding in thinking mode is prone to repetition loops.
export async function callCoordinatorLLM(
  messages: ChatMessage[], maxTokens = 2048, opts: { think?: boolean } = {},
): Promise<string> {
  const coordinator = _deps?.getCoordinator()
  if (!coordinator) throw new Error('LLM module not initialized')
  const prefix = buildFlagPrefix()
  const flagged = prefix
    ? messages.map(m => m.role === 'system' ? { ...m, content: prefix + m.content } : m)
    : messages
  const think = opts.think ?? maxTokens >= 2048
  const local = coordinator.llm.provider !== 'anthropic' && coordinator.llm.provider !== 'openai'
  const extra = !think && local ? { reasoning_effort: 'none' } : undefined
  return callLLM(flagged, coordinator.llm, maxTokens, think ? 0.6 : 0, 'orchestrail/coordinator', extra)
}
