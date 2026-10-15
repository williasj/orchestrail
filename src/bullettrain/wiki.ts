// -- BulletTrain <-> AIWiki ----------------------------------------------------------
// BulletTrain runs are bound to their own project automatically: the wiki
// project slug is the BulletTrain slug, owned by the user who created the
// project (older projects without an owner fall back to ADMIN_EMAIL).
//
//   - run start:  ensure projects/<owner>/<slug>/index.md exists, log the start
//   - sessions:   reconstruction prompt includes the project's wiki memory and
//                 relevant shared lessons/playbooks
//   - decisions:  every bt_decision is mirrored to the project's decisions.md
//   - run end:    log the outcome and keep a machine-managed "BulletTrain status"
//                 section on index.md current
// All calls are best-effort; the wiki can never halt a run.

import { readProject, readProjectMd } from './store.js'
import type { BTStatus, BTTask } from './types.js'
import {
  wikiAppendDecision, wikiAppendLog, wikiContextFor, wikiEnabled, wikiEnsureIndex, wikiUpsertSection,
  type WikiScope,
} from '../core/wikiclient.js'

export function btWikiScope(slug: string, runNo?: string): WikiScope | null {
  if (!wikiEnabled()) return null
  const project = readProject(slug)
  const owner = project?.owner || process.env.ADMIN_EMAIL || ''
  if (!owner) return null
  return { user: owner, project: slug, agent: 'bullettrain', conversation: runNo ? `bt-${slug}-${runNo}` : `bt-${slug}` }
}

function firstLines(text: string, n: number, maxChars: number): string {
  return text.split('\n').filter(l => l.trim()).slice(0, n).join('\n').slice(0, maxChars)
}

export async function btWikiRunStart(slug: string, runNo: string, brief: string): Promise<void> {
  const scope = btWikiScope(slug, runNo)
  if (!scope) return
  try {
    const project = readProject(slug)
    const projectMd = readProjectMd(slug)
    await wikiEnsureIndex(scope, project?.title || slug,
      `BulletTrain project ${slug}: ${firstLines(projectMd, 1, 200).replace(/^#+\s*/, '')}`,
      `BulletTrain project created ${project?.created_at?.slice(0, 10) ?? ''}.\n\n## Brief\n${firstLines(projectMd, 12, 1500)}\n`)
    await wikiAppendLog(scope, `Run ${runNo} started`, `BulletTrain run ${runNo} started.\n\n**Brief:**\n${firstLines(brief, 8, 800)}`)
  } catch (e) {
    console.warn(`[bullettrain] wiki run-start sync failed for ${slug}: ${e}`)
  }
}

export async function btWikiRunEnd(slug: string, runNo: string, status: BTStatus, tasks: BTTask[]): Promise<void> {
  const scope = btWikiScope(slug, runNo)
  if (!scope) return
  try {
    const verified = tasks.filter(t => t.mark === 'x').length
    const taskLines = tasks.map(t => `- [${t.mark === ' ' ? ' ' : t.mark}] ${t.id} ${t.title}${t.error ? ` -- ${t.error.slice(0, 160)}` : ''}`).join('\n')
    const outcome = `**State:** ${status.state}${status.halt_reason ? ` (${status.halt_reason})` : ''}\n` +
      `**Message:** ${status.message ?? ''}\n**Verified:** ${verified}/${tasks.length} tasks, ${status.counters.sessions_run} sessions\n\n${taskLines}`
    await wikiAppendLog(scope, `Run ${runNo} ${status.state}`, outcome)
    const project = readProject(slug)
    await wikiUpsertSection(scope, 'index', project?.title || slug, `BulletTrain project ${slug}`,
      'BulletTrain status',
      `Last run ${runNo}: **${status.state}**${status.halt_reason ? ` (${status.halt_reason})` : ''} at ${status.ended_at ?? ''}. ` +
      `${verified}/${tasks.length} tasks verified.${status.state === 'done' ? ' Deliverable packaged.' : ''}\n` +
      `Details are in the project log.`)
  } catch (e) {
    console.warn(`[bullettrain] wiki run-end sync failed for ${slug}: ${e}`)
  }
}

export function btWikiDecision(slug: string, runNo: string, line: string): void {
  const scope = btWikiScope(slug, runNo)
  if (!scope) return
  wikiAppendDecision(scope, line).catch(e => console.warn(`[bullettrain] wiki decision mirror failed: ${e}`))
}

/** Wiki memory + relevant shared knowledge for a session's reconstruction prompt. */
export async function btWikiContext(slug: string, runNo: string, query: string): Promise<string> {
  const scope = btWikiScope(slug, runNo)
  if (!scope) return ''
  try {
    return await wikiContextFor(scope, query, 1200)
  } catch { return '' }
}
