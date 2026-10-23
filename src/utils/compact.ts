// -- Within-stage rolling compaction --------------------------------------------
// Pure, dependency-free helper that bounds the context re-sent to the LLM on
// every tool round inside a single agent stage.
//
// The agentic loop (core/agent.ts) re-sends the ENTIRE `messages` array on each
// LLM call. With up to MAX_TOOL_ROUNDS rounds and up to ~8000 chars of tool
// output per round, a single stage can blow past the model's context window --
// the B2 evidence ("tokens dominated by context re-sent each tool round; 16k cap
// hit 10x in one vLLM run"). The wall is WITHIN a stage, not between stages
// (inter-stage hand-offs already rebuild from a truncated prior-stage output).
//
// compactMessages folds the OLDER tool rounds into a short summary block while
// keeping the leading system/goal messages and the most recent K messages
// verbatim, so the re-sent context stays bounded. It is a pure, read-only
// transformation: it returns a NEW array and never mutates the input. The caller
// (agent.ts) keeps the full transcript intact for the returned _messages and for
// extractCodeFromToolCalls, and passes only the compacted view to the LLM.
//
// Safety invariants (asserted by compact.check.mjs):
//   - The leading non-assistant messages (system + the goal, plus any prior
//     summary) are preserved verbatim.
//   - The last `keepLast` messages are preserved verbatim, and the tail is backed
//     up to an assistant boundary so a tool result is never orphaned from its
//     assistant parent.
//   - A complete_stage tool result always lands in the most recent round, hence
//     always in the verbatim tail -- it is never folded away.
//   - A workbench_write in the folded middle is summarized (its slot name is
//     recorded), never silently dropped; the workbench store itself is untouched.
//   - The folded summary is capped at `maxChars` (oldest lines dropped first).
//
// Kept in a leaf module (types only) so it is unit-testable standalone
// (compact.check.mjs), following the secrets.ts / terminal.ts / intake.ts pattern.

import type { AgenticMessage, ToolCall } from '../types/index.js'

export interface CompactOptions {
  keepLast?:  number  // trailing messages kept verbatim (default 6)
  maxChars?:  number  // cap on the folded summary block, in chars (default 4000)
  threshold?: number  // only compact when messages.length >= threshold (default 12)
}

export const COMPACT_DEFAULTS: Required<CompactOptions> = {
  keepLast:  6,
  maxChars:  4000,
  threshold: 12,
}

const SUMMARY_HEADER =
  '[Context: earlier tool rounds compacted to save context. This is a summary of what already happened -- do not repeat it. The most recent rounds follow verbatim.]'

function firstAssistantIndex(messages: AgenticMessage[]): number {
  for (let i = 0; i < messages.length; i++) if (messages[i]!.role === 'assistant') return i
  return -1
}

// A short, greppable label for a tool call: the name plus the one argument that
// identifies what it did (slot / path / command / skill name / status).
function toolCallLabel(tc: ToolCall): string {
  let arg = ''
  try {
    const a = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
    switch (tc.function.name) {
      case 'workbench_write':
      case 'workbench_read': arg = ` slot=${a['slot']}`; break
      case 'bash':           arg = ` cmd=${String(a['command'] ?? '').replace(/\s+/g, ' ').slice(0, 60)}`; break
      case 'read_file':
      case 'write_file':
      case 'list_files':    arg = ` path=${a['path']}`; break
      case 'use_skill':     arg = ` name=${a['name']}`; break
      case 'complete_stage': arg = ` status=${a['status']}`; break
      default:              arg = ` ${JSON.stringify(a).slice(0, 80)}`
    }
  } catch { arg = '' }
  return `${tc.function.name}${arg}`
}

function excerpt(s: string | null, n: number): string {
  if (!s) return ''
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

// Fold a run of middle messages into summary lines. Each assistant tool call is
// paired with its result(s) by tool_call_id so the summary reads as
// "action -> outcome" rather than two disconnected lines.
function summarizeMiddle(middle: AgenticMessage[]): string[] {
  const lines: string[] = []
  for (let i = 0; i < middle.length; i++) {
    const m = middle[i]!
    if (m.role === 'assistant') {
      if (m.content && m.content.trim()) lines.push(`assistant: ${excerpt(m.content, 120)}`)
      if (m.tool_calls) {
        // Gather the tool results that immediately follow, until the next
        // assistant/user message, keyed by tool_call_id.
        const results = new Map<string, string>()
        for (let j = i + 1; j < middle.length && middle[j]!.role === 'tool'; j++) {
          const t = middle[j]!
          if (t.tool_call_id) results.set(t.tool_call_id, t.content ?? '')
        }
        for (const tc of m.tool_calls) {
          const res = results.get(tc.id)
          lines.push(`${toolCallLabel(tc)} -> ${res ? excerpt(res, 120) : '(no result)'}`)
        }
      }
    } else if (m.role === 'user') {
      // A per-round reminder or other injected note.
      lines.push(`(note) ${excerpt(m.content, 80)}`)
    }
    // A stray tool message not attached to an assistant above is skipped.
  }
  return lines
}

/**
 * Returns a bounded view of `messages` for an LLM call. Messages before the
 * first assistant turn (system + goal) and the last `keepLast` messages are kept
 * verbatim; everything in between is folded into a single summary `user` message
 * capped at `maxChars`. Below `threshold`, the input is returned unchanged (same
 * reference). Never mutates the input.
 */
export function compactMessages(messages: AgenticMessage[], opts: CompactOptions = {}): AgenticMessage[] {
  const keepLast  = opts.keepLast  ?? COMPACT_DEFAULTS.keepLast
  const maxChars  = opts.maxChars  ?? COMPACT_DEFAULTS.maxChars
  const threshold = opts.threshold ?? COMPACT_DEFAULTS.threshold

  if (messages.length < threshold) return messages

  const headEnd = firstAssistantIndex(messages)
  if (headEnd <= 0) return messages   // no assistant turns to fold

  // Tail: last keepLast messages, backed up so it never starts on an orphan tool
  // (a tool result must stay with its assistant parent).
  let tailStart = messages.length - keepLast
  if (tailStart < headEnd) tailStart = headEnd
  while (tailStart > headEnd && messages[tailStart]!.role === 'tool') tailStart--

  if (tailStart >= messages.length) return messages   // nothing in the middle

  const middle = messages.slice(headEnd, tailStart)
  if (middle.length === 0) return messages

  let lines = summarizeMiddle(middle)
  // Cap the summary: drop the OLDEST lines first so the most recent folded rounds
  // survive, then flag that older rounds were omitted.
  const marker = (n: number) => `[…${n} older round line(s) omitted…]`
  let omitted = 0
  for (;;) {
    const rendered = SUMMARY_HEADER + '\n' + (omitted > 0 ? marker(omitted) + '\n' : '') + lines.join('\n')
    if (rendered.length <= maxChars || lines.length <= 1) break
    lines = lines.slice(1)
    omitted++
  }
  const summary = SUMMARY_HEADER + '\n' + (omitted > 0 ? marker(omitted) + '\n' : '') + lines.join('\n')

  return [
    ...messages.slice(0, headEnd),   // system + goal (+ any prior summary) verbatim
    { role: 'user', content: summary },
    ...messages.slice(tailStart),    // most recent rounds verbatim
  ]
}
