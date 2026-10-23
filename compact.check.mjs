// Verifies within-stage rolling compaction (see src/utils/compact.ts, wired into
// the runAgent loop in src/core/agent.ts). Follows the check.mjs pattern: a
// standalone assertion script, no test framework, no LLM. Run after a build:
//   npm run build && node compact.check.mjs
//
// It unit-tests compactMessages and asserts the safety invariants the design
// rests on:
//   - below the threshold the input is returned unchanged (same reference);
//   - the leading system + goal messages are preserved verbatim;
//   - the last K messages are preserved verbatim, and the tail is never started
//     on an orphan tool result (it is backed up to an assistant boundary);
//   - a complete_stage tool result (always the most recent round) is kept
//     verbatim in the tail, never folded away;
//   - a workbench_write in the folded middle is summarized (slot name recorded),
//     never silently dropped;
//   - the folded summary is capped at maxChars (oldest lines dropped first);
//   - long tool results are excerpted, not re-sent verbatim;
//   - the function is pure (it never mutates the input array).

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const COMPACT = process.env.COMPACT_MODULE || path.join(here, 'dist', 'utils', 'compact.js')

// Windows absolute paths are not valid ESM import specifiers; use file:// URLs.
const { compactMessages, COMPACT_DEFAULTS } = await import(pathToFileURL(COMPACT).href)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')) }
}

// -- message builders -----------------------------------------------------------
const sys  = (c) => ({ role: 'system', content: c })
const usr  = (c) => ({ role: 'user', content: c })
const asst = (calls, content = null) => ({ role: 'assistant', content, tool_calls: calls })
const tool = (id, content) => ({ role: 'tool', content, tool_call_id: id })
const tc   = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

// A 14-message transcript: system + goal, then 6 tool rounds, the last of which
// is complete_stage (so it sits in the most recent round and stays in the
// verbatim tail). With the default keepLast=6, the first three rounds
// (workbench_write / bash / use_skill) fall in the folded middle.
function makeTranscript() {
  return [
    sys('SYSTEM PROMPT'),
    usr('GOAL: build a thing'),
    asst([tc('c1', 'workbench_write', { slot: 'implementation' })]),
    tool('c1', '{"ok":true,"slot":"implementation","bytes":1234}'),
    asst([tc('c2', 'bash', { command: 'python implementation.py' })]),
    tool('c2', '{"exit_code":0,"stdout":"ok"}'),
    asst([tc('c3', 'use_skill', { name: 'python-run-tests' })]),
    tool('c3', '{"result":{"ran":10,"passed":8,"failed":2}}'),
    asst([tc('c4', 'workbench_write', { slot: 'test_report' })]),
    tool('c4', '{"ok":true,"slot":"test_report","bytes":220}'),
    asst([tc('c5', 'bash', { command: 'ls -la' })]),
    tool('c5', '{"exit_code":0,"stdout":"implementation.py"}'),
    asst([tc('c6', 'complete_stage', { status: 'DONE' })]),
    tool('c6', '{"acknowledged":true}'),
  ]
}

// -- below threshold: unchanged -------------------------------------------------
console.log('below threshold (no-op):')
{
  const short = makeTranscript().slice(0, COMPACT_DEFAULTS.threshold - 1)   // length < threshold
  const out = compactMessages(short)
  ok(out === short, 'returns the same reference when under the threshold', { len: out.length, thr: COMPACT_DEFAULTS.threshold })
}

// -- no assistant turns: unchanged ----------------------------------------------
console.log('\nno assistant turns (nothing to fold):')
{
  const noAsst = [sys('S'), usr('U'), usr('another note')]
  const out = compactMessages(noAsst, { threshold: 1 })
  ok(out === noAsst, 'returns the same reference when there are no assistant turns')
}

// -- basic compaction ------------------------------------------------------------
console.log('\nbasic compaction:')
{
  const input = makeTranscript()
  const out = compactMessages(input)

  ok(out.length < input.length, 'compacted view is shorter than the full transcript', { before: input.length, after: out.length })
  ok(out[0] === input[0], 'system message preserved verbatim (same reference)')
  ok(out[1] === input[1], 'goal (first user) message preserved verbatim (same reference)')

  // Exactly one summary user message sits between the head and the tail.
  ok(out[2].role === 'user', 'a single summary user message follows the head', out[2].role)
  const summary = out[2].content
  ok(summary.includes('workbench_write slot=implementation'), 'summary records the folded workbench_write and its slot', summary)
  ok(summary.includes('bash cmd=python implementation.py'), 'summary records the folded bash call and its command', summary)
  ok(summary.includes('use_skill name=python-run-tests'), 'summary records the folded use_skill call', summary)
  ok(summary.includes('do not repeat it'), 'summary is framed as a context note, not a fresh request', summary)

  // The tail (last keepLast) is preserved verbatim, including complete_stage.
  const tailLen = COMPACT_DEFAULTS.keepLast
  ok(out.length === 3 + tailLen, 'output is head(2) + summary(1) + tail(keepLast)', { out: out.length, expect: 3 + tailLen })
  for (let i = 0; i < tailLen; i++) {
    ok(out[3 + i] === input[input.length - tailLen + i], `tail[${i}] preserved verbatim (same reference)`)
  }
  const csAsst = out[out.length - 2]
  const csTool = out[out.length - 1]
  ok(csAsst.role === 'assistant' && csAsst.tool_calls?.[0]?.function?.name === 'complete_stage', 'complete_stage assistant call is in the verbatim tail')
  ok(csTool.role === 'tool' && csTool.content === '{"acknowledged":true}', 'complete_stage tool result kept verbatim (never folded away)')
  ok(!summary.includes('"acknowledged":true'), 'complete_stage result is NOT duplicated into the summary')
}

// -- maxChars cap ----------------------------------------------------------------
console.log('\nmaxChars cap (oldest lines dropped first):')
{
  // 20 tool rounds -> a long middle. Force a small cap.
  const msgs = [sys('S'), usr('GOAL')]
  for (let r = 0; r < 20; r++) {
    const id = 'c' + r
    msgs.push(asst([tc(id, 'bash', { command: `step ${r} of the long build process` })]))
    msgs.push(tool(id, `{"exit_code":0,"stdout":"output from step ${r} padded out to be reasonably long"}`))
  }
  const maxChars = 600
  const out = compactMessages(msgs, { maxChars })
  const summary = out[2].content
  ok(summary.length <= maxChars + 60, 'summary stays within the cap (allowing for the omission marker)', { len: summary.length, cap: maxChars })
  ok(summary.includes('older round line(s) omitted'), 'omission marker present when lines were dropped', summary)
  // The most recent FOLDED round (step 16) survives; the oldest is dropped.
  ok(summary.includes('step 16'), 'most recent folded round survives the cap', summary)
  ok(!summary.includes('step 0 '), 'oldest folded round is dropped to fit the cap', summary)
  // The most recent round (step 19) is in the verbatim tail, not the summary.
  ok(out.slice(3).some(m => (m.content || '').includes('step 19')), 'most recent round is verbatim in the tail')
}

// -- long tool results are excerpted, not re-sent verbatim -----------------------
console.log('\nexcerpting (long results truncated):')
{
  const long = 'X'.repeat(500)
  const msgs = [
    sys('S'), usr('GOAL'),
    asst([tc('a', 'read_file', { path: 'big.txt' })]),
    tool('a', long),
    ...Array.from({ length: 10 }, (_, i) => i % 2 === 0
      ? asst([tc('x' + i, 'bash', { command: `c${i}` })])
      : tool('x' + (i - 1), `r${i}`)),
  ]
  const out = compactMessages(msgs)
  const summary = out[2].content
  ok(summary.includes('…'), 'long tool result is excerpted with an ellipsis', summary)
  ok(!summary.includes(long), 'the full verbatim long result is NOT re-sent in the summary')
}

// -- workbench_write in the middle is summarized, not dropped --------------------
console.log('\nworkbench_write safety (summarized, not dropped):')
{
  const msgs = [
    sys('S'), usr('GOAL'),
    asst([tc('w', 'workbench_write', { slot: 'blueprint' })]),
    tool('w', '{"ok":true,"slot":"blueprint"}'),
    ...Array.from({ length: 10 }, (_, i) => i % 2 === 0
      ? asst([tc('z' + i, 'bash', { command: `c${i}` })])
      : tool('z' + (i - 1), `r${i}`)),
  ]
  const out = compactMessages(msgs)
  const summary = out[2].content
  ok(summary.includes('workbench_write slot=blueprint'), 'the folded workbench_write is recorded with its slot name', summary)
}

// -- purity: the input is never mutated ------------------------------------------
console.log('\npurity (input not mutated):')
{
  const input = makeTranscript()
  const snapshot = JSON.stringify(input)
  const lenBefore = input.length
  compactMessages(input)
  ok(input.length === lenBefore, 'input length unchanged after compaction')
  ok(JSON.stringify(input) === snapshot, 'input contents unchanged after compaction (deep-equal)')
}

// -- tail is never started on an orphan tool result ------------------------------
console.log('\ntail boundary (no orphaned tool result):')
{
  // Force the naive tail start to land on a tool message.
  const msgs = [sys('S'), usr('GOAL')]
  for (let r = 0; r < 8; r++) {
    const id = 't' + r
    msgs.push(asst([tc(id, 'bash', { command: `c${r}` })]))
    msgs.push(tool(id, `r${r}`))
  }
  // length = 2 + 16 = 18. keepLast=5 -> naive tailStart = 13 (a tool).
  const out = compactMessages(msgs, { keepLast: 5 })
  const firstTail = out[3]
  ok(firstTail.role !== 'tool', 'the tail does not start on an orphan tool result', firstTail.role)
  ok(firstTail.role === 'assistant', 'the tail is backed up to an assistant boundary', firstTail.role)
  // Every tool result in the tail still has its assistant parent earlier in the view.
  let orphan = false
  for (let i = 3; i < out.length; i++) {
    if (out[i].role === 'tool' && out[i - 1].role !== 'assistant' && out[i - 1].role !== 'tool') orphan = true
  }
  ok(!orphan, 'no tool result is orphaned from its assistant parent in the compacted view')
}

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
