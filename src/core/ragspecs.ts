// -- RAG collection specs ------------------------------------------------------
// Concrete CollectionSpec instances that bind the collection-agnostic kernel
// (core/ragkernel.ts) to a specific Qdrant collection + canonical-file format.
//
// This file currently defines the FAILURES collection only (tool-call lessons
// library). Workbench and users get their own specs here when they are wired,
// reusing the same kernel — that is the point of the split.
//
// Failures is the single store for tool-call lessons: the run analyzer in
// core/memory.ts records auto-learned failures here, and humans/agents can author
// records too (distinguished by author_type / tags, not a separate collection).
// The legacy payload-only `orchestrail_tooling` collection has been removed.

import * as path from 'node:path'
import { cols, RAG_DIR } from '../utils/config.js'
import {
  type CollectionSpec,
  type CanonicalDoc,
  markdownFrontmatterCodec,
  ragRecall, ragWriteRecord, ragStartupScan, ragWatch, ragEnsureCollection,
  ragKernelEnabled,
} from './ragkernel.js'

const FAILURES_DIR = path.join(RAG_DIR, 'failures')

// -- Failure record spec -------------------------------------------------------

export const failuresSpec: CollectionSpec = {
  collection: cols.failures,
  dir:        FAILURES_DIR,
  // Flat layout per the investigation's mount table (rag/failures). The watcher
  // watches this root; records written by recordFailure() also land here.
  subdirs:    [''],
  codec:      markdownFrontmatterCodec,
  tag:        '[failures]',

  // Stable id: a given (tool, error_class, day) collapses to one record so the
  // same failure re-observed in a day updates rather than duplicates.
  idOf: (m) =>
    `${String(m['tool'] ?? 'unknown')}__${String(m['error_class'] ?? 'unknown')}__` +
    `${String(m['occurred_at'] ?? '').slice(0, 10)}`,

  // Only the natural-language description is embedded (NOT the body) — the
  // description is the discoverability surface, the body is the canonical detail.
  embedSource: (m) => String(m['description'] ?? ''),

  payloadOf: (m) => ({
    tool:            String(m['tool'] ?? ''),
    error_class:     String(m['error_class'] ?? ''),
    description:     String(m['description'] ?? ''),
    tags:            Array.isArray(m['tags']) ? m['tags'] : [],
    // Parser leaves booleans as strings (matches skills.ts) — coerce explicitly.
    resolved:        String(m['resolved'] ?? 'false') === 'true',
    verified:        String(m['verified'] ?? 'false') === 'true',
    resolution_type: String(m['resolution_type'] ?? 'unresolved'),
    confidence:      Number(m['confidence'] ?? 0),
    occurred_at:     String(m['occurred_at'] ?? ''),
    status:          'active',
  }),

  // Slightly looser than skills: a "similar failure" warning is useful even at
  // moderate similarity, and the consequence of a false positive is just a hint.
  similarityThreshold: 0.6,

  // Recall hygiene: only surface records that carry an actionable signal -- a
  // resolution (confidence 0.5/0.9) or a documented prevention (0.3). Bare
  // unresolved occurrence records (confidence 0) are still WRITTEN to disk (for
  // analytics and future promotion if they later get resolved) but are filtered
  // OUT of recall, so they never get pushed into an agent prompt as a "known
  // failure" with nothing to act on. Server-side Qdrant filter; missing-field
  // (legacy, pre-field) points are excluded until they re-import and re-stamp.
  recallFilter: { must: [{ key: 'confidence', range: { gt: 0 } }] },

  format: (doc, score) => {
    const m         = doc.meta
    const resolved  = String(m['resolved'] ?? 'false') === 'true'
    const verified  = String(m['verified'] ?? 'false') === 'true'
    const state     = !resolved ? 'UNRESOLVED'
                    : verified  ? 'resolved (verified)'
                    : 'resolved (unverified)'
    return (
      `\n\n## Known failure: \`${m['tool']}\` (${m['error_class']})\n` +
      `*(match ${score.toFixed(2)}, confidence ${Number(m['confidence'] ?? 0).toFixed(2)}, ${state})*\n\n` +
      doc.body.trim()
    )
  },

  watchAuthor: 'human',
}

// -- Record / recall helpers ---------------------------------------------------

export interface FailureInput {
  tool:             string
  error_class:      string   // 'auth' | 'timeout' | 'malformed_input' | ...
  description:      string   // 1-2 sentence natural-language summary (embedded)
  failure_context:  string   // what the agent was trying to do, inputs provided
  error_output:     string   // the actual error returned
  root_cause?:      string
  resolution?:      string
  prevention?:      string   // maps to skill Pitfalls; promotion candidate if verified
  resolution_type?: 'workaround' | 'fix' | 'escalated' | 'unresolved'
  resolved?:        boolean
  verified?:        boolean   // resolution actually RE-TESTED, not "worked once"
  tags?:            string[]
  occurred_at?:     string    // ISO8601; defaults to now
}

/**
 * Confidence discipline (investigation §3.4): confidence is EARNED. A verified
 * (re-tested) resolution earns the most; an unverified "worked once" earns some;
 * an unresolved failure that nonetheless documents an actionable prevention earns
 * a floor (it is still a usable lesson). A bare unresolved failure with no
 * prevention earns ZERO -- it is occurrence data, not a lesson, and the recall
 * filter (confidence > 0) keeps it out of agent prompts. This is what stops a
 * record like `run_code__not_found` (no fix, no prevention) from being pushed at
 * every agent as a "known failure" it can do nothing about.
 */
function hasActionablePrevention(input: FailureInput): boolean {
  const p = (input.prevention ?? '').trim()
  return p.length > 0 && !/^no prevention/i.test(p)
}

function failureConfidence(input: FailureInput): number {
  if (input.resolved) return input.verified ? 0.9 : 0.5
  return hasActionablePrevention(input) ? 0.3 : 0
}

function buildFailureDoc(input: FailureInput): CanonicalDoc {
  const now = new Date().toISOString()
  const meta: Record<string, unknown> = {
    tool:            input.tool,
    error_class:     input.error_class,
    description:     input.description,
    tags:            input.tags ?? [],
    occurred_at:     input.occurred_at ?? now,
    resolved:        input.resolved ?? false,
    verified:        input.verified ?? false,
    resolution_type: input.resolution_type ?? (input.resolved ? 'fix' : 'unresolved'),
    confidence:      failureConfidence(input),
  }
  const body = [
    '## Failure Context',
    input.failure_context.trim(),
    '',
    '## Error Output',
    input.error_output.trim(),
    '',
    '## Root Cause',
    (input.root_cause ?? 'Unknown.').trim(),
    '',
    '## Resolution',
    (input.resolution ?? 'Unresolved.').trim(),
    '',
    '## Prevention',
    (input.prevention ?? 'No prevention strategy documented yet.').trim(),
  ].join('\n')
  return { meta, body }
}

/** Persist a failure as a canonical Markdown record and index it. */
export async function recordFailure(input: FailureInput): Promise<string | null> {
  if (!ragKernelEnabled()) return null
  const { path: filePath, result } = await ragWriteRecord(
    failuresSpec, buildFailureDoc(input), '', 'agent',
  )
  return result === 'error' ? null : filePath
}

/** Recall the most relevant known failure for a prospective tool call / task. */
export async function recallFailures(query: string, limit = 1): Promise<string> {
  return ragRecall(failuresSpec, query, limit)
}

// -- Startup wiring ------------------------------------------------------------

/** Ensure collection, import any on-disk records, and start the watcher. */
export async function initFailures(): Promise<void> {
  if (!ragKernelEnabled()) return
  await ragEnsureCollection(failuresSpec)
  await ragStartupScan(failuresSpec)
  // Background watcher — drop a .md into the failures dir and it self-indexes.
  ragWatch(failuresSpec).catch(e => console.warn('[failures] watcher error:', e))
}

// -- Canonical failure-record template (investigation §7 step 7) ---------------
// Parallel to the human skill template. Hand-authored failures use this shape;
// recordFailure() emits the same structure programmatically.

export const FAILURE_RECORD_TEMPLATE = `---
tool: <tool-name-that-failed>
error_class: <auth | timeout | malformed_input | not_found | rate_limit | ...>
description: >
  One to two sentence natural-language summary of the failure. THIS is what gets
  embedded and searched, so write it the way an agent would describe the problem.
tags: [tag1, tag2]
occurred_at: 2026-01-01T00:00:00Z
resolved: false
verified: false
resolution_type: unresolved
confidence: 0.0
---

## Failure Context
What the agent was trying to do, and what inputs it provided.

## Error Output
The actual error returned by the tool or runtime.

## Root Cause
What caused the failure, if known.

## Resolution
What was done to resolve it, or why it remains unresolved.

## Prevention
How to avoid this failure on future invocations. (Maps to a skill Pitfall;
becomes a promotion candidate ONLY if the resolution is verified and this
section names a checkable detection signal, not just a prose warning.)
`
