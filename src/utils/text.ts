// -- Text and code manipulation utilities -------------------------------------
// Pure functions with no side effects. Safe to import from any module.

import type { AgenticMessage } from '../types/index.js'

// -- Prose detection -----------------------------------------------------------

/**
 * Returns true when content is clearly natural-language prose with no
 * technical structure. Used to block agents from writing "I will create a
 * function that..." instead of an actual deliverable.
 *
 * Deliberately permissive: YAML, JSON, configs, scripts, and any structured
 * content all pass. Only plain English paragraphs are blocked.
 */
export function isObviouslyProse(content: string): boolean {
  if (!content || content.length < 20) return false

  // Any of these patterns indicate structured / technical content — allow immediately
  const technicalPatterns = [
    /^\s*[\w][\w\s_-]*\s*:/m,          // YAML / config key: value  (e.g.  job_name: snmp)
    /^\s*-\s+\S/m,                      // YAML list items           (e.g.  - targets:)
    /[{}]/m,                            // JSON / code braces
    /^\s*(import|from|use|require|#include|package)\s/m,   // code imports
    /^\s*(def|fn|func|function|class|struct|interface|impl|trait)\s/m, // definitions
    /^\s*(const|let|var|pub|private|protected|static|async)\s/m,       // code keywords
    /^\s*(if|else|for|while|return|switch|match)\s*[({]/m, // control flow
    /^\s*\/\//m,                        // line comments
    /^\s*\/\*/m,                        // block comments
    /^\s*#\s*\w/m,                      // YAML comments or C preprocessor
    /=>/m,                              // arrow functions / fat arrows
    /\$\{/m,                            // template literals
    /^\s{2,}\S/m,                       // indented structured content
    /`[\s\S]*`/m,                       // backtick code spans
    /\[\s*[\w'"]/m,                     // array literals [value or ["value"]
  ]

  for (const pattern of technicalPatterns) {
    if (pattern.test(content)) return false   // structured → not prose
  }

  // Now check for English prose signals
  const lines = content.trim().split('\n').filter(l => l.trim().length > 0)
  if (lines.length === 0) return false

  const proseSignals = [
    /^(I |I'll |I will |I'm |I've |Here |Here's |This |The |In |To |For |With |We |Let |Our |Below|Above|Note)/i,
    /\.\s+[A-Z]/,   // "sentence. Next sentence"
  ]
  let proseScore = 0
  for (const p of proseSignals) {
    if (p.test(content)) proseScore++
  }

  // Long flowing lines with no structural characters are also a prose signal
  const longEnglishLines = lines.filter(l => {
    const t = l.trim()
    return t.length > 50 && /[a-z] [a-z]/i.test(t) && !/[:{}\[\]()=<>|]/.test(t)
  })
  if (longEnglishLines.length > lines.length * 0.5) proseScore++

  return proseScore >= 2
}

// -- Code block manipulation ---------------------------------------------------

/**
 * Removes markdown code block fences if present, returning the inner content.
 */
export function stripCodeBlockDelimiters(content: string): string {
  const fenceMatch = content.match(/```[\w]*\n([\s\S]*?)```/)
  if (fenceMatch) return fenceMatch[1]!.trim()
  return content.trim()
}

/**
 * Strips <think>...</think> blocks produced by reasoning models (DeepSeek-R1,
 * QwQ, etc.). Applied to agent outputs, workbench content, and tool argument
 * strings so internal monologue never leaks into downstream context.
 */
export function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

/**
 * Detects duplicate `fn main()` definitions in Rust code. Used to prevent
 * the code execution tool from receiving broken multi-entry-point programs.
 */
export function detectDuplicateMain(code: string): boolean {
  const mainMatches = code.match(/fn\s+main\s*\(/g)
  return (mainMatches?.length ?? 0) > 1
}

/**
 * Returns true if `code` redefines any struct/class/interface/type already
 * present in `existingCode`. Used to catch accidental redefinitions when
 * agents append code to a workbench slot.
 */
export function detectStructRedefinition(code: string, existingCode?: string): boolean {
  if (!existingCode) return false
  const structPattern = /(?:pub\s+)?(?:struct|class|interface|type)\s+(\w+)/g
  const existingStructs = new Set<string>()
  let match
  while ((match = structPattern.exec(existingCode)) !== null) {
    existingStructs.add(match[1])
  }
  while ((match = structPattern.exec(code)) !== null) {
    if (existingStructs.has(match[1])) return true
  }
  return false
}

/**
 * Extracts the content of the first markdown code block. Returns null if
 * no code block is found.
 */
export function extractCodeBlock(output: string): string | null {
  const match = output.match(/```[\w]*\n([\s\S]*?)```/)
  if (match) return match[1]!.trim()
  // Try without newline after language tag
  const match2 = output.match(/```[\w]*([\s\S]*?)```/)
  if (match2) return match2[1]!.trim()
  return null
}

/**
 * Replaces all markdown code blocks with a placeholder. Used to keep context
 * windows lean when full code isn't needed downstream.
 */
export function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '[code block omitted]')
}

/**
 * Scans backwards through agentic messages for the implementation source an
 * agent laid down via the exec tools. In the agentic bash model code is written
 * with `write_file` (path + content), so this returns the `content` of the most
 * recent non-test, non-temp write_file call -- falling back to the most recent
 * write_file content if every file looks like a test. Returns null if none found.
 * This is a third-tier fallback: the canonical path is workbench_write to the
 * 'implementation' slot, with a fenced code block in the stage output as the next.
 */
export function extractCodeFromToolCalls(messages: AgenticMessage[]): string | null {
  let firstAnyWrite: string | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.function?.name === 'write_file') {
          try {
            const args = JSON.parse(tc.function.arguments || '{}')
            const content = typeof args.content === 'string' ? args.content : ''
            if (!content) continue
            const p = String(args.path ?? '').toLowerCase()
            const looksTest = /(^|[\/_.-])test/.test(p) || p.startsWith('__skill_')
            if (!looksTest) return content          // prefer the implementation file
            if (firstAnyWrite === null) firstAnyWrite = content
          } catch {}
        }
      }
    }
  }
  return firstAnyWrite
}

// -- JSON extraction -----------------------------------------------------------

/**
 * Strips chain-of-thought blocks and extracts the inner content of any
 * markdown code fence. Returns cleaned text ready for JSON.parse.
 */
export function extractJsonText(llmOutput: string): string {
  const stripped = llmOutput.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  const fenced = stripped.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  return fenced?.[1]?.trim() ?? stripped
}

// -- Python annotation compatibility ------------------------------------------

/**
 * Prepends `from __future__ import annotations` to Python source when absent, so
 * PEP 604 union annotations (`dict | None`) evaluate as strings (PEP 563) and do
 * not raise `TypeError: unsupported operand type(s) for |` on a runtime older
 * than 3.10. Applied ONLY at execution time (exec bash run / use_skill code) --
 * never to stored slots or the user-facing deliverable. A no-op on 3.10+ and
 * idempotent: if the future import is already present, the source is returned
 * unchanged.
 */
export function ensurePyFutureAnnotations(code: string): string {
  if (!code) return code
  if (/^\s*from\s+__future__\s+import\s+[^\n]*\bannotations\b/m.test(code)) return code
  return 'from __future__ import annotations\n' + code
}
