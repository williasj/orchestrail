// -- BulletTrain LLM call layer --------------------------------------------------
// Own copy of the OpenAI-compatible chat-completions call, matching the shape
// core/llm.ts already uses against the same Ollama endpoint. Duplicated rather
// than imported per the contract's audit finding: BT's tool-calling loop, retry
// policy, and token accounting are its own (40-80 round sessions vs a pipeline
// stage's MAX_TOOL_ROUNDS=10), so coupling to core/llm.ts would mean threading
// BT-specific behavior through a module built for something else.
//
// RETRY POLICY -- why this exists:
// A thrown error here ends the SESSION and halts the whole RUN as
// 'llm_unreachable' (session.ts catches btCallLLM and returns that haltReason).
// There is no higher retry layer, so a single transient blip was enough to kill
// a twelve-hour build. Transient conditions are ordinary when the endpoint is a
// GPU broker rather than raw Ollama:
//
//   503 + Retry-After  the broker's FIFO hold window expired while another
//                      backend held the GPU slot. Retryable, and the broker
//                      tells us how long to wait.
//   503 parked         the target backend is parked because another backend
//                      holds the slot. Also retryable.
//   502                upstream error between broker and Ollama.
//   timeout            a cold model load after a slot swap, or a long
//                      generation.
//
// A 4xx that is NOT 429 is a configuration or request error -- a wrong model
// name, a malformed body. Retrying those burns wall clock and fails with the
// same message, so they fail fast.

import type { AgenticMessage, LLMResponse } from '../types/index.js'
import type { BTRuntime } from './types.js'

// Must exceed the worst case the broker can impose: its hold window (default
// 60s, BROKER_HOLD_TIMEOUT_SECONDS) plus its own upstream ceiling
// (COMPUTE_TIMEOUT = 300s in proxy.py). Below that sum our abort fires first
// and we lose the broker's own error message, which is the one that says what
// actually went wrong.
const LLM_TIMEOUT_MS = Number(process.env.BT_LLM_TIMEOUT_MS || 420_000)

// Attempts BEYOND the first. 3 retries against a 60s broker hold window covers
// a multi-minute ComfyUI job without the run noticing.
const LLM_MAX_RETRIES = Number(process.env.BT_LLM_MAX_RETRIES || 3)

// Asks the broker to queue us this long before answering 503, instead of its
// default. Consumed by the proxy and stripped before forwarding upstream, so it
// is inert against a raw Ollama endpoint. The broker clamps it to
// MAX_HOLD_TIMEOUT_SECONDS (600).
const LLM_BROKER_HOLD_SECONDS = Number(process.env.BT_LLM_BROKER_HOLD_SECONDS || 90)

const BACKOFF_BASE_MS = 2_000
const BACKOFF_MAX_MS = 60_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Retry-After is seconds or an HTTP date. Returns ms, or null if absent. */
function parseRetryAfter(res: Response): number | null {
  const raw = res.headers.get('retry-after')
  if (!raw) return null
  const secs = Number(raw)
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, BACKOFF_MAX_MS)
  const when = Date.parse(raw)
  if (!Number.isNaN(when)) return Math.min(Math.max(0, when - Date.now()), BACKOFF_MAX_MS)
  return null
}

function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), BACKOFF_MAX_MS)
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504
}

export async function btCallLLM(
  messages: AgenticMessage[],
  runtime: BTRuntime,
  tools: unknown[],
  requester = 'bullettrain',
): Promise<LLMResponse> {
  const maxTokens = Math.max(1024, Math.floor(runtime.num_ctx * 0.25))
  const body: Record<string, unknown> = {
    model: runtime.model,
    messages,
    temperature: runtime.temperature,
    max_tokens: maxTokens,
  }
  if (tools.length > 0) body['tools'] = tools

  const url = `${runtime.endpoint.replace(/\/$/, '')}/chat/completions`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.OPENAI_API_KEY || 'ollama'}`,
    // Identifies us in the broker's queue and lease display. Ignored elsewhere.
    'X-Broker-Requester': requester.slice(0, 64),
    'X-Broker-Hold-Seconds': String(LLM_BROKER_HOLD_SECONDS),
  }
  const payload = JSON.stringify(body)

  let lastError = ''

  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    if (attempt > 0) console.error(`[bullettrain] LLM retry ${attempt}/${LLM_MAX_RETRIES}: ${lastError}`)

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      })
    } catch (e) {
      // Network refusal, DNS failure, or our own abort -- all transient enough
      // to retry: a parked backend refuses connections while being restored and
      // comes back on its own.
      lastError = e instanceof Error ? e.message : String(e)
      if (attempt === LLM_MAX_RETRIES) {
        throw new Error(`BulletTrain LLM unreachable after ${attempt + 1} attempts: ${lastError}`)
      }
      await sleep(backoffMs(attempt))
      continue
    }

    if (res.ok) return await res.json() as LLMResponse

    const text = await res.text().catch(() => '')
    const detail = `${res.status} ${text.slice(0, 500)}`

    if (!isRetryableStatus(res.status)) {
      // Fail fast: a wrong model name or malformed body will not improve.
      throw new Error(`BulletTrain LLM error: ${detail}`)
    }

    lastError = detail
    if (attempt === LLM_MAX_RETRIES) {
      throw new Error(`BulletTrain LLM error after ${attempt + 1} attempts: ${detail}`)
    }
    // The broker knows better than our curve how long the slot is held.
    const wait = parseRetryAfter(res) ?? backoffMs(attempt)
    await sleep(wait)
  }

  // Unreachable: every loop exit above returns or throws.
  throw new Error(`BulletTrain LLM error: exhausted retries: ${lastError}`)
}

/** Character-count fallback estimator for when a response lacks a usage field
 *  (llm.ts:57 notes this happens against some backends). ~4 chars/token is a
 *  standard rough estimate -- good enough for a checkpoint trigger, not for
 *  billing. Without this the soft_checkpoint_pct trigger silently never fires
 *  against a backend that omits usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
