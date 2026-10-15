// -- AIWiki write-back loop: runs that hit trouble propose lessons ---------------
// After a run that needed an escalation, rewind, fix or failed verification (or a
// BulletTrain run that halted or needed retries), the coordinator model reads what
// went wrong next to the closest existing lessons and drafts at most two general,
// reusable lessons. They are submitted as wiki PROPOSALS: nothing lands in the
// shared lessons/ namespace until a person accepts it in the AIWiki review queue.
// Best-effort and fire-and-forget; AIWIKI_LESSONS=0 turns it off.

import { callCoordinatorLLM } from './llm.js'
import { extractJsonText, stripCodeBlocks } from '../utils/text.js'
import { buildPage, wikiEnabled, wikiRequest, type WikiScope } from './wikiclient.js'
import type { AgentResult } from '../types/index.js'

const ENABLED       = process.env.AIWIKI_LESSONS !== '0'
const MAX_LESSONS   = 2
const PATH_RE       = /^lessons\/[a-z0-9][a-z0-9-]{2,60}$/

export interface RunIncidents {
  goal:      string
  outcome:   string          // short prose: how the run ended
  incidents: string[]        // one line or short paragraph per thing that went wrong
  source:    string          // conversation id or bt-<slug>-<run>
}

interface SearchHit { path: string; title: string; summary: string; score: number }
interface Drafted { action?: string; path?: string; title?: string; summary?: string; tags?: unknown; body?: string }

const clip = (s: string, n: number) => {
  const t = stripCodeBlocks(String(s ?? '')).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '...' : t
}

/** Incidents worth learning from in a chat run's stage results. Empty = clean run. */
export function incidentsFromResults(results: AgentResult[], rewindCount: number): string[] {
  const out: string[] = []
  for (const r of results) {
    const st = r.completion?.status
    if (st === 'ESCALATE')
      out.push(`${r.assignee} escalated during "${r.title}": ${clip(r.completion?.escalation_reason || r.completion?.summary || r.output, 500)}`)
    if (/^fix\b/i.test(r.title))
      out.push(`${r.assignee} ran a fix ("${r.title}"): ${clip(r.output, 300)}`)
    if (r.verification?.required && !r.verification.passed)
      out.push(`verification failed in "${r.title}": ${clip(r.verification.detail, 300)}`)
    if (!r.success)
      out.push(`${r.assignee} did not complete "${r.title}": ${clip(r.output, 300)}`)
  }
  if (rewindCount > 0 && !out.some(x => x.includes('rewind'))) out.push(`the pipeline rewound ${rewindCount} time(s)`)
  return out.slice(0, 12)
}

export async function proposeLessons(scope: WikiScope, run: RunIncidents): Promise<string[]> {
  if (!ENABLED || !wikiEnabled() || !scope.user || !run.incidents.length) return []
  const lscope: WikiScope = { ...scope, agent: 'orchestrail/lessons', conversation: run.source }

  // closest existing lessons, so the model can extend one instead of duplicating it
  const q = clip(run.incidents.join(' '), 600)
  const hits = await wikiRequest<SearchHit[]>('GET', `/api/search?namespace=lessons&limit=5&q=${encodeURIComponent(q)}`, lscope)
  const existing = (hits.ok && Array.isArray(hits.data) ? hits.data : []).filter(h => h.score >= 0.45)

  const prompt =
    'You maintain a wiki of LESSONS for a team of AI agents (architect, engineer, test engineer, reviewer) ' +
    'that write and run code in a sandbox. A run just hit trouble. Decide whether it teaches something ' +
    'GENERAL that would help future runs on different tasks.\n\n' +
    `## Goal (for context only)\n${clip(run.goal, 500)}\n\n` +
    `## How it ended\n${clip(run.outcome, 400)}\n\n` +
    `## What went wrong\n${run.incidents.map(i => '- ' + i).join('\n')}\n\n` +
    `## Existing lessons that may already cover it\n${existing.length ? existing.map(h => `- ${h.path} -- ${h.title}: ${h.summary}`).join('\n') : '(none close)'}\n\n` +
    '## Rules\n' +
    '- Only a pattern that will recur: a tool or environment pitfall, a pipeline/workbench mistake, a testing trap. ' +
    'A one-off model slip or a task-specific bug is NOT a lesson; return an empty list for those.\n' +
    '- If an existing lesson covers it, use action "append" with that exact path and add only what is new.\n' +
    `- At most ${MAX_LESSONS} lessons. Usually zero or one.\n` +
    '- Never include user names, emails, project names, file paths from the task, secrets, or code longer than 3 lines.\n' +
    '- body is markdown with "## Symptom", "## Cause" and "## Guidance" sections (for append: one "## " section with the new observation).\n' +
    '- path is lessons/<lowercase-hyphenated-slug>. summary is one line under 200 characters.\n\n' +
    'Respond with ONLY JSON: {"lessons": [{"action": "create"|"append", "path": "...", "title": "...", ' +
    '"summary": "...", "tags": ["..."], "body": "..."}]}'

  let drafted: Drafted[] = []
  try {
    const raw = await callCoordinatorLLM([{ role: 'user', content: prompt }], 4096)
    const parsed = JSON.parse(extractJsonText(raw)) as { lessons?: Drafted[] }
    drafted = Array.isArray(parsed.lessons) ? parsed.lessons.slice(0, MAX_LESSONS) : []
  } catch (e) {
    console.warn(`[wikilearn] lesson drafting failed for ${run.source}: ${e}`)
    return []
  }

  const submitted: string[] = []
  const today = new Date().toISOString().slice(0, 10)
  for (const d of drafted) {
    const path = String(d.path ?? '').replace(/\.md$/, '').trim()
    const body = String(d.body ?? '').trim()
    if (!PATH_RE.test(path) || body.length < 40) continue
    const evidence = { conversationId: run.source, incidents: run.incidents.slice(0, 6) }
    let action = d.action === 'append' ? 'append' : 'create'
    const tags = Array.isArray(d.tags) ? d.tags.map(String).filter(t => /^[a-z0-9-]{2,30}$/.test(t)).slice(0, 6) : []
    const full = buildPage(String(d.title ?? path.split('/')[1]).slice(0, 120), String(d.summary ?? '').slice(0, 200) || 'Lesson drafted from a run',
                           body, { tags, status: 'draft', confidence: 0.5, sources: [run.source] })
    const append = body.startsWith('## ') ? body : `## Seen again ${today}\n\n${body}`
    let r = await wikiRequest('POST', '/api/proposals', lscope, { path, action, content: action === 'create' ? full : append, evidence })
    if (!r.ok && r.status === 409 && action === 'create') {        // exists: add to it instead
      action = 'append'
      r = await wikiRequest('POST', '/api/proposals', lscope, { path, action, content: `## Seen again ${today}\n\n${body}`, evidence })
    } else if (!r.ok && r.status === 404 && action === 'append') { // gone: create it
      action = 'create'
      r = await wikiRequest('POST', '/api/proposals', lscope, { path, action, content: full, evidence })
    }
    if (r.ok) submitted.push(`${action} ${path}`)
    else console.warn(`[wikilearn] proposal for ${path} rejected: ${r.error}`)
  }
  if (submitted.length) console.log(`[wikilearn] ${run.source}: proposed ${submitted.join(', ')}`)
  return submitted
}
