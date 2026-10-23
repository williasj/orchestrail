// Verifies the cheap-mode contract (see src/utils/cheapmode.ts, a pure leaf
// following the terminal.ts / budget.ts pattern). Follows the check.mjs pattern:
// a standalone assertion script, no test framework. Run after a build:
//   npm run build && node cheapmode.check.mjs
//
// It unit-tests the pure logic behind item 17 / B3 (user-selectable cheap mode):
// which single agent performs the whole job, what reasoning effort is requested,
// and that the single-stage pipeline is well-formed (one stage, the cheap-mode
// agent, a bounded retry budget, and a task description that names the goal).
// All pure (no I/O, no LLM) so they can be asserted deterministically.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const MODULE = process.env.CHEAPMODE_MODULE || path.join(here, 'dist', 'utils', 'cheapmode.js')

const {
  CHEAP_MODE_AGENT, CHEAP_MODE_REASONING_EFFORT, cheapModeStage,
} = await import(pathToFileURL(MODULE).href)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}

// -- constants ------------------------------------------------------------------

console.log('constants:')
{
  ok(CHEAP_MODE_AGENT === 'senior-engineer', 'cheap mode is a single senior-engineer run', CHEAP_MODE_AGENT)
  ok(CHEAP_MODE_REASONING_EFFORT === 'low', 'cheap mode requests a lower reasoning effort', CHEAP_MODE_REASONING_EFFORT)
}

// -- cheapModeStage -------------------------------------------------------------

console.log('\ncheapModeStage:')
{
  const goal = 'Write a Python function that sums a list of integers.'
  const stage = cheapModeStage(goal)

  ok(stage.name === 'Implementation', 'stage name is the senior-engineer canonical stageName', stage.name)
  ok(stage.assignee === CHEAP_MODE_AGENT, 'stage is assigned to the cheap-mode agent', stage.assignee)
  ok(stage.maxRetries === 2, 'bounded self-correction budget (2), not the default 3', String(stage.maxRetries))
  ok(typeof stage.description === 'string' && stage.description.length > 0, 'task description is non-empty')
  ok(stage.description.includes('implementation'), 'task names the implementation workbench slot', stage.description)
  ok(!('escalateTo' in stage) || stage.escalateTo === undefined, 'no escalation target (single stage, nothing to route to)')

  // The pipeline derives the workbench slot name from stage.name -> 'implementation'.
  const slotName = stage.name.toLowerCase().replace(/\s+/g, '_')
  ok(slotName === 'implementation', 'stage name maps to the implementation slot', slotName)

  // A different goal yields an independent stage (no shared mutable state).
  const other = cheapModeStage('Something entirely different.')
  ok(other !== stage, 'each call returns a fresh stage object')
  ok(other.assignee === CHEAP_MODE_AGENT, 'independent stage still uses the cheap-mode agent')
}

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
