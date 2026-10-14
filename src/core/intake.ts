// -- Clarification / intake phase ----------------------------------------------
// Classifies incoming goals as DIRECT, PROCEED, or CLARIFY before decomposition.

import { callCoordinatorLLM } from './llm.js'
import { appendToolLog } from './tools.js'
import { defaultClarificationPrompt } from './prompts.js'
import type { CoordinatorConfig } from '../types/index.js'

// -- Module init ---------------------------------------------------------------

type IntakeDeps = {
  getCoordinator: () => CoordinatorConfig
}

let _deps: IntakeDeps | null = null

export function initIntake(deps: IntakeDeps): void {
  _deps = deps
}

// -- Clarification system prompt -----------------------------------------------

function clarificationSystem(): string {
  return _deps?.getCoordinator().clarificationPrompt?.trim() || defaultClarificationPrompt()
}

// -- Intake classifier ---------------------------------------------------------

export type ClarificationResult =
  | { decision: 'PROCEED' }
  | { decision: 'DIRECT';  answer: string }
  | { decision: 'CLARIFY'; questions: string }

export async function runClarificationIntake(goal: string): Promise<ClarificationResult> {
  const t0  = Date.now()
  const raw = await callCoordinatorLLM([
    { role: 'system', content: clarificationSystem() },
    { role: 'user',   content: goal },
  ], 1024)
  const durationMs = Date.now() - t0
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim()

  // DIRECT: <answer> — trivial questions answered immediately, no pipeline needed
  if (cleaned.startsWith('DIRECT:')) {
    const answer = cleaned.slice('DIRECT:'.length).trim()
    appendToolLog({
      ts: Date.now(), agent: 'coordinator', tool: 'clarify',
      args: { goal: goal.slice(0, 500) },
      result: JSON.stringify({ decision: 'DIRECT', preview: answer.slice(0, 100) }),
      ok: true, durationMs,
    })
    return { decision: 'DIRECT', answer: answer || goal }
  }

  if (cleaned.startsWith('PROCEED')) {
    appendToolLog({
      ts: Date.now(), agent: 'coordinator', tool: 'clarify',
      args: { goal: goal.slice(0, 500) },
      result: JSON.stringify({ decision: 'PROCEED' }),
      ok: true, durationMs,
    })
    return { decision: 'PROCEED' }
  }

  const questionsStart = cleaned.indexOf('CLARIFY')
  if (questionsStart === -1) {
    appendToolLog({
      ts: Date.now(), agent: 'coordinator', tool: 'clarify',
      args: { goal: goal.slice(0, 500) },
      result: JSON.stringify({ decision: 'PROCEED', note: 'malformed response — treated as PROCEED' }),
      ok: true, durationMs,
    })
    return { decision: 'PROCEED' }
  }
  const questions = cleaned.slice(questionsStart + 'CLARIFY'.length).trim()
  if (!questions) {
    appendToolLog({
      ts: Date.now(), agent: 'coordinator', tool: 'clarify',
      args: { goal: goal.slice(0, 500) },
      result: JSON.stringify({ decision: 'PROCEED', note: 'empty questions — treated as PROCEED' }),
      ok: true, durationMs,
    })
    return { decision: 'PROCEED' }
  }
  appendToolLog({
    ts: Date.now(), agent: 'coordinator', tool: 'clarify',
    args: { goal: goal.slice(0, 500) },
    result: JSON.stringify({ decision: 'CLARIFY', questions: questions.slice(0, 400) }),
    ok: true, durationMs,
  })
  return { decision: 'CLARIFY', questions }
}
