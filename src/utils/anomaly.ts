// -- Anomaly register: synthesis history fidelity --------------------------------
// Pure, dependency-free helpers for catching the case where the synthesis
// narrative misreports the run's HISTORY (frontier issue A4, P2): e.g. claiming
// "no test corrections needed" after a test was actually rewritten, or narrating
// a "found -> fixed -> confirmed" arc on a run that never reworked.
//
// The run record (AgentResult[]) is the ground truth: every stage attempt,
// every ESCALATE, every "Fix:" helper agent, and every verification outcome is
// recorded by the orchestrator, not by the model. The synthesis is model-authored
// prose and can drift from that record. This module derives the factual record
// (describeRunFacts), checks the narrative's history claims against it
// (detectSynthesisAnomalies), and renders a machine-authored register
// (renderAnomalyRegister) that surfaces any contradiction.
//
// Conservative by design: each anomaly requires BOTH a factual condition in the
// run record AND an unambiguous claim in the prose. When in doubt, no anomaly.
// The register is advisory (a note appended to the synthesis output), never a
// hard gate -- it flags the contradiction for the reader, it does not block the
// run or re-run the model.
//
// Kept in a leaf module (types only) so the contract logic can be unit-tested
// standalone (anomaly.check.mjs) with no LLM.

import type { AgentResult } from '../types/index.js'

/** A "Fix: ..." helper agent is the orchestrator's response to an escalation; its presence is rework evidence. */
export const FIX_AGENT_TITLE_RE = /^Fix:/i

/** The factual state of one pipeline stage, derived from the run record. */
export interface StageFact {
  name:             string
  assignee:         string
  /** Number of own attempts recorded for this stage (re-runs after escalation / self-contract / rewind). */
  attempts:         number
  /** The terminal (last own-attempt) completion status. */
  terminalStatus:   'DONE' | 'ESCALATE'
  /** True when any own attempt ended ESCALATE. */
  escalatedAtLeastOnce: boolean
}

/** The factual record of a run, derived from its AgentResult[] (the ground truth). */
export interface RunFacts {
  stages:                  StageFact[]
  /** All attempts (stage attempts and fix agents alike) that ended ESCALATE. */
  totalEscalations:        number
  /** "Fix: ..." helper agents that ran (the orchestrator's escalation responses). */
  fixAgentCount:           number
  /** ESCALATEs synthesized because the agent failed its OWN contract (self-contract). */
  selfContractEscalations: number
  /** A terminal stage whose required verification never passed (deterministic ground truth). */
  verificationFailed:      boolean
  /** The test stage's terminal status is ESCALATE (a clean passing run was not reached). */
  testStageEscalated:      boolean
  /** Any rework happened: an escalation, a fix agent, or a stage with more than one attempt. */
  hadRework:               boolean
}

/** One contradiction between the synthesis narrative and the run record. */
export interface SynthesisAnomaly {
  /** Greppable code, e.g. `no_correction_claimed`. */
  code:     string
  /** The synthesis claim (the matched text, verbatim). */
  claim:    string
  /** What the run record shows that contradicts the claim. */
  evidence: string
}

/**
 * Derive the factual record from a run's results. Pure -- never mutates the
 * input, never throws. "Fix:" helper agents are rework evidence, not stages,
 * so they are counted separately and excluded from the per-stage facts. The
 * terminal state of a stage is its LAST own-attempt (a stage that escalated on
 * attempt 1 and closed DONE on retry is terminal-DONE). A result with no
 * completion is counted as an attempt with terminal status DONE (no escalation
 * was recorded for it).
 */
export function describeRunFacts(results: AgentResult[]): RunFacts {
  const byStage       = new Map<string, StageFact>()
  const terminalByStage = new Map<string, AgentResult>()
  let totalEscalations        = 0
  let fixAgentCount           = 0
  let selfContractEscalations = 0

  for (const r of results) {
    const escalated = r.completion?.status === 'ESCALATE'
    if (escalated) totalEscalations++
    if (escalated && r.completion?.selfContract) selfContractEscalations++

    if (FIX_AGENT_TITLE_RE.test(r.title ?? '')) {
      fixAgentCount++
      continue
    }

    const key = r.title || r.assignee || ''
    const st  = escalated ? 'ESCALATE' : 'DONE'
    const fact = byStage.get(key)
    if (!fact) {
      byStage.set(key, {
        name:               r.title,
        assignee:           r.assignee,
        attempts:           1,
        terminalStatus:     st,
        escalatedAtLeastOnce: escalated,
      })
    } else {
      fact.attempts++
      fact.terminalStatus = st
      fact.escalatedAtLeastOnce = fact.escalatedAtLeastOnce || escalated
    }
    terminalByStage.set(key, r)
  }

  const stages = [...byStage.values()]
  const terminals = [...terminalByStage.values()]
  const verificationFailed = terminals.some(
    r => r.verification?.required === true && r.verification.passed === false,
  )
  const testStageEscalated = terminals.some(
    r => (r.assignee === 'test-engineer' || r.title === 'Testing') && r.completion?.status === 'ESCALATE',
  )
  const hadRework = totalEscalations > 0 || fixAgentCount > 0 || stages.some(s => s.attempts > 1)

  return {
    stages,
    totalEscalations,
    fixAgentCount,
    selfContractEscalations,
    verificationFailed,
    testStageEscalated,
    hadRework,
  }
}

// -- History-claim patterns -------------------------------------------------------
// Each rule fires only when (a) a factual condition holds in the run record AND
// (b) the prose makes the corresponding unambiguous claim. Patterns are kept
// narrow on purpose: a missed contradiction is cheaper than a false alarm.

interface ClaimRule {
  code:      string
  /** The factual condition that must hold for the claim to be a contradiction. */
  when:      (f: RunFacts) => boolean
  patterns:  RegExp[]
  evidence:  (f: RunFacts) => string
}

const NO_CORRECTION_PATTERNS = [
  /no (?:test )?(?:fixes?|corrections?|changes?|revisions?)(?: were| was)? (?:needed|required)/i,
  /required no (?:test )?(?:fixes?|corrections?|changes?|revisions?)/i,
  /did not require (?:any )?(?:fixes?|corrections?|changes?|revisions?)/i,
  /without (?:any )?(?:fixes?|corrections?|changes?|revisions?)/i,
  /no rework\b/i,
  // "in/on a single pass|attempt" -- the run-referencing form. The bare "single
  // pass" is deliberately NOT matched: it often describes an algorithm ("a
  // single pass over the input"), not the run.
  /(?:in|on) (?:a|one) single (?:pass|attempt)/i,
  /first attempt (?:passed|succeeded|worked)/i,
]

const CLEAN_PASS_PATTERNS = [
  /all tests (?:passed|pass)\b/i,
  /tests? all passed/i,
  /passed (?:all|every) tests?/i,
  /clean pass\b/i,
  /no (?:test )?failures\b/i,
  /zero (?:test )?failures\b/i,
  /100 ?% (?:pass|passed)/i,
]

const REWORK_CLAIM_PATTERNS = [
  /after (?:multiple|several) (?:attempts?|iterations?|fixes?|corrections?|revisions?|rounds?)/i,
  /the team (?:iterated|retried)/i,
  /went through (?:multiple|several) (?:rounds?|iterations?|attempts?)/i,
  /multiple (?:fix|correction|revision) (?:rounds?|cycles?|iterations?)/i,
]

const CLAIM_RULES: ClaimRule[] = [
  {
    code:     'no_correction_claimed',
    when:     f => f.hadRework,
    patterns: NO_CORRECTION_PATTERNS,
    evidence: f => {
      const parts = [
        f.totalEscalations > 0 ? `${f.totalEscalations} escalation(s)` : '',
        f.fixAgentCount > 0    ? `${f.fixAgentCount} fix agent(s)`     : '',
        f.stages.filter(s => s.attempts > 1).length > 0
          ? `${f.stages.filter(s => s.attempts > 1).length} re-run stage(s)` : '',
      ].filter(Boolean)
      return `the run record shows rework: ${parts.join(', ')}`
    },
  },
  {
    code:     'clean_pass_claimed',
    when:     f => f.testStageEscalated || f.verificationFailed,
    patterns: CLEAN_PASS_PATTERNS,
    evidence: f => f.testStageEscalated
      ? 'the test stage ended ESCALATE -- a clean passing run was not reached'
      : 'a required verification never passed',
  },
  {
    code:     'rework_claimed',
    when:     f => !f.hadRework,
    patterns: REWORK_CLAIM_PATTERNS,
    evidence: () => 'the run record shows no rework: no escalations, no fix agents, and every stage ran exactly once',
  },
]

/**
 * Check the synthesis narrative's history claims against the run record.
 * Returns one anomaly per rule that fires (the first matched pattern is the
 * claim). Pure -- never throws, never mutates. Empty/whitespace synthesis
 * yields no anomalies.
 */
export function detectSynthesisAnomalies(facts: RunFacts, synthesis: string): SynthesisAnomaly[] {
  const text = (synthesis ?? '').trim()
  if (!text) return []

  const anomalies: SynthesisAnomaly[] = []
  for (const rule of CLAIM_RULES) {
    if (!rule.when(facts)) continue
    for (const pattern of rule.patterns) {
      const m = text.match(pattern)
      if (m) {
        anomalies.push({ code: rule.code, claim: m[0].trim(), evidence: rule.evidence(facts) })
        break
      }
    }
  }
  return anomalies
}

/**
 * Render the machine-authored anomaly register. Returns '' when there are no
 * anomalies. The register is advisory: it names the contradiction and defers
 * to the run record as authoritative; it does not alter or block the synthesis.
 */
export function renderAnomalyRegister(anomalies: SynthesisAnomaly[]): string {
  if (anomalies.length === 0) return ''
  const lines = anomalies
    .map(a => `> - **${a.code}**: the synthesis claims "${a.claim}" but ${a.evidence}.`)
    .join('\n')
  return (
    '\n\n> [!NOTE]\n'
    + '> **ANOMALY REGISTER -- the narrative above contradicts the run record.** '
    + 'The run record is authoritative; treat the flagged claim(s) as unreliable:\n'
    + lines
  )
}
