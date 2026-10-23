// -- BulletTrain brief clarification ----------------------------------------------
// Reuses the consequential-ambiguity clarification pattern from utils/intake.ts
// (the same multi-choice, CLARIFY_MAX_QUESTIONS = 5 shape the Agentic Team intake
// uses) so a BulletTrain project brief that leaves a consequential dimension
// unspecified (interface, language, platform, scope, constraints) can be
// clarified before a run. Advisory: the run is never blocked on it (see the
// route wiring) -- the UI shows a question link, and answering folds the
// selections into the brief.
//
// Pure leaf (types + logic only) so it is unit-testable standalone
// (clarify.check.mjs), following the runtime.ts / store.ts leaf pattern.

import {
  detectConsequentialAmbiguity,
  buildClarificationQuestions,
  type ClarificationQuestion,
} from '../utils/intake.js'

export interface BTClarification {
  isConsequential: boolean
  reason: string
  questions: ClarificationQuestion[]
}

/**
 * Detect consequential ambiguity in a project brief and build the multi-choice
 * questions that resolve it (capped at CLARIFY_MAX_QUESTIONS = 5). A brief that
 * already specifies the consequential dimensions returns isConsequential: false
 * with an empty question list (nothing to ask).
 */
export function clarifyBrief(brief: string): BTClarification {
  const det = detectConsequentialAmbiguity(brief)
  if (!det.isConsequential) return { isConsequential: false, reason: det.reason, questions: [] }
  return { isConsequential: true, reason: det.reason, questions: buildClarificationQuestions(det.dimensions) }
}

/**
 * Fold the user's multi-choice selections back into the brief. answersByIndex
 * maps a question's 0-based index (as a string) to the selected option id; a
 * value that matches no option id is treated as a free-text write-in and passed
 * through verbatim. For a multiple-select question the value is a
 * comma-separated list of option ids. Returns the brief unchanged when nothing
 * was selected.
 *
 * Mirrors foldClarificationAnswers' output shape ("...\n\nClarified: H = V; ...")
 * and reuses each option's `fold ?? label`, so the folded line reads the same
 * whether it came from the chat free-text path or the UI selection path.
 */
export function foldSelections(
  brief: string,
  questions: ClarificationQuestion[],
  answersByIndex: Record<string, string>,
): string {
  if (!questions.length) return brief
  const clauses: string[] = []
  questions.forEach((q, i) => {
    const raw = (answersByIndex[String(i)] ?? '').trim()
    if (!raw) return
    if (q.multiple) {
      const resolved = raw.split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(p => {
          const opt = q.options.find(o => o.id.toLowerCase() === p.toLowerCase())
          return opt ? (opt.fold ?? opt.label) : p
        })
      if (resolved.length) clauses.push(q.header + ' = ' + resolved.join(', '))
    } else {
      const opt = q.options.find(o => o.id.toLowerCase() === raw.toLowerCase())
      clauses.push(q.header + ' = ' + (opt ? (opt.fold ?? opt.label) : raw))
    }
  })
  if (!clauses.length) return brief
  return brief + '\n\nClarified: ' + clauses.join('; ')
}
