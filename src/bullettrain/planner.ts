// -- Planning phase -----------------------------------------------------------------
// One LLM call: BRIEF.md in, an ordered task list out. The model is asked for
// JSON, not the tasks.md text grammar directly -- getting free-form markdown
// grammar exactly right every time is a needless reliability risk when a JSON
// schema plus deterministic rendering (store.ts renderTasksMd) gets the same
// result without depending on the model's formatting discipline.
//
// ALPHA CUT: no fission (bt_subtask) after this point -- the task list produced
// here is fixed for the run. Flagged in config.ts as a deferred contract piece.

import { btCallLLM } from './llm.js'
import type { BTRuntime, BTTask } from './types.js'

const PLAN_SYSTEM_PROMPT = `You are the planning stage of an autonomous build agent. You will be given a
project brief. Produce a task list that fully implements the brief, broken into
tasks small enough to verify independently (roughly one file or one coherent
unit of functionality per task).

Rules:
- Every task needs a "verify" field: a single shell command that exits 0 when
  the task is genuinely done and non-zero otherwise. Prefer real checks (running
  a test file, checking a process starts, curling an endpoint) over trivial
  existence checks. Use the literal string "manual" only when no command can
  verify it (e.g. "write documentation").
- Order tasks so that a task's dependencies come before it. List dependency
  task numbers (1-based, referring to this array's order) in "depends".
- Do not pad the list with busywork tasks. Do not skip steps a working
  deliverable actually needs (setup/scaffolding, the core feature, and a way to
  package the result all count).
- Respond with ONLY a JSON array, no prose, no markdown fences. Each element:
  { "title": string, "verify": string, "depends": number[] }`

interface PlanTaskRaw { title: string; verify: string; depends: number[] }

function parsePlanJson(raw: string): PlanTaskRaw[] {
  let text = raw.trim()
  // Strip markdown fences defensively -- models often add them despite instructions.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const parsed = JSON.parse(text) as unknown
  if (!Array.isArray(parsed)) throw new Error('plan response was not a JSON array')
  return parsed.map((raw, i) => {
    const t = raw as Partial<PlanTaskRaw>
    if (typeof t.title !== 'string' || !t.title.trim()) throw new Error(`task ${i + 1} missing title`)
    if (typeof t.verify !== 'string' || !t.verify.trim()) throw new Error(`task ${i + 1} missing verify`)
    return { title: t.title.trim(), verify: t.verify.trim(), depends: Array.isArray(t.depends) ? t.depends : [] }
  })
}

export async function planTasks(brief: string, runtime: BTRuntime, maxTasks: number): Promise<BTTask[]> {
  const res = await btCallLLM(
    [
      { role: 'system', content: PLAN_SYSTEM_PROMPT },
      { role: 'user', content: brief },
    ],
    runtime,
    [],
  )
  const content = res.choices[0]?.message?.content ?? ''
  if (!content.trim()) throw new Error('planner returned empty response')

  const raw = parsePlanJson(content)
  if (raw.length === 0) throw new Error('planner produced zero tasks')
  if (raw.length > maxTasks) throw new Error(`planner produced ${raw.length} tasks, exceeds max_tasks (${maxTasks})`)

  return raw.map((t, i) => {
    const id = String(i + 1).padStart(3, '0')
    const depends = t.depends
      .filter(n => Number.isInteger(n) && n >= 1 && n <= raw.length && n !== i + 1)
      .map(n => String(n).padStart(3, '0'))
    return {
      id, mark: ' ' as const, title: t.title, verify: t.verify,
      depends, attempts: 0, artifacts: [],
    }
  })
}
