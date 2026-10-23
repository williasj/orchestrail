// -- Clarification / intake phase ----------------------------------------------
// Classifies incoming goals as DIRECT, PROCEED, or CLARIFY before decomposition.

import { callCoordinatorLLM } from './llm.js'
import { appendToolLog } from './tools.js'
import { defaultClarificationPrompt, defaultDirectAnswerPrompt, clarificationRefinePrompt } from './prompts.js'
import {
  classifyIntakeHeuristic,
  detectConsequentialAmbiguity,
  buildClarificationQuestions,
  validateClarificationQuestions,
  extractJsonArray,
  type ClarificationQuestion,
} from '../utils/intake.js'
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
  | { decision: 'CLARIFY'; questions: ClarificationQuestion[] }

// -- Clarification helpers (Issue 10) ------------------------------------------

// Best-effort LLM refine of the code scaffold: tighten phrasing and add
// domain-specific options. Returns null on any parse/validation failure so the
// caller falls back to the scaffold. Never throws.
async function refineClarificationQuestions(goal: string, scaffold: ClarificationQuestion[]): Promise<ClarificationQuestion[] | null> {
  try {
    const raw = await callCoordinatorLLM([
      { role: 'system', content: clarificationRefinePrompt() },
      { role: 'user',   content: JSON.stringify({ goal, scaffold }) },
    ], 1024)
    const cleaned = raw.replace(/[\s\S]*?<\/think>/g, '').trim()
    const parsed = JSON.parse(extractJsonArray(cleaned))
    return validateClarificationQuestions(parsed)
  } catch {
    return null
  }
}

// The free-form classifier (fallback path) returns CLARIFY questions as plain
// text. Wrap that text as a single open "other" question so the structured
// shape is uniform downstream; the raw text is preserved verbatim.
function parseFreeFormClarify(questions: string): ClarificationQuestion[] {
  const text = questions.trim()
  if (!text) return []
  return [{
    dimension: 'other',
    header: 'Clarification',
    question: text,
    options: [],
  }]
}

export async function runClarificationIntake(goal: string): Promise<ClarificationResult> {
  const t0 = Date.now()

  // Heuristic pre-classifier (pure, no LLM). Routes the obvious cases with no
  // model round-trip: a specific work request -> PROCEED (straight to the
  // pipeline, skipping the classifier call); a trivial question -> DIRECT
  // (single direct answer, never the pipeline). Anything it cannot confidently
  // call falls through to the LLM classifier below (unchanged behavior).
  const h = classifyIntakeHeuristic(goal)

  if (h.route === 'PROCEED') {
    appendToolLog({
      ts: Date.now(), agent: 'coordinator', tool: 'clarify',
      args: { goal: goal.slice(0, 500) },
      result: JSON.stringify({ decision: 'PROCEED', note: 'heuristic fast-path: ' + h.reason }),
      ok: true, durationMs: Date.now() - t0,
    })
    return { decision: 'PROCEED' }
  }

  if (h.route === 'DIRECT') {
    const answerRaw = await callCoordinatorLLM([
      { role: 'system', content: defaultDirectAnswerPrompt() },
      { role: 'user',   content: goal },
    ], 1024)
    const answer = answerRaw.replace(/[\s\S]*?<\/think>/g, '').trim()
    appendToolLog({
      ts: Date.now(), agent: 'coordinator', tool: 'clarify',
      args: { goal: goal.slice(0, 500) },
      result: JSON.stringify({ decision: 'DIRECT', note: 'heuristic fast-path: ' + h.reason, preview: answer.slice(0, 100) }),
      ok: true, durationMs: Date.now() - t0,
    })
    return { decision: 'DIRECT', answer: answer || goal }
  }

  // Consequential-ambiguity gate (pure, Issue 10): a build request that leaves a
  // consequential dimension unspecified gets a bounded set of multiple-choice
  // questions (each with a write-in escape) instead of a single open-ended
  // question. The scaffold is code-built; the LLM only refines phrasing / adds
  // domain options (best-effort), and the scaffold is the fallback when the
  // refine is malformed. A fully-specified goal (no unspecified consequential
  // dimension) skips this and falls through to the LLM classifier below.
  const det = detectConsequentialAmbiguity(goal)
  if (det.isConsequential) {
    const scaffold = buildClarificationQuestions(det.dimensions)
    const refined = (await refineClarificationQuestions(goal, scaffold)) ?? scaffold
    appendToolLog({
      ts: Date.now(), agent: 'coordinator', tool: 'clarify',
      args: { goal: goal.slice(0, 500) },
      result: JSON.stringify({ decision: 'CLARIFY', note: 'consequential ambiguity: ' + det.reason, questions: refined.length, refined: refined !== scaffold }),
      ok: true, durationMs: Date.now() - t0,
    })
    return { decision: 'CLARIFY', questions: refined }
  }

  // AMBIGUOUS -> the LLM classifier decides (DIRECT / PROCEED / CLARIFY).
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
  return { decision: 'CLARIFY', questions: parseFreeFormClarify(questions) }
}
