// -- Executable skill system (capabilities) ------------------------------------
// A "skill capability" is an EXECUTABLE artifact an agent invokes, not prose it
// reads. This is the line between this module and the prose-memory stores
// (core/skills.ts, core/ragspecs.ts): those recall text INTO the prompt; this
// recalls a skill as INVOCABLE and runs it to produce a deterministic result.
//
// Storage model (split, folder-per-skill):
//   - Qdrant `orchestrail_skill_caps`: description embedding + folder pointer
//   - Filesystem `<skillsDir>/cap/{agent,user,deprecated}/<name>/`:
//       SKILL.md       frontmatter (manifest) + human-readable docs
//       <entrypoint>   the script that runs (e.g. skill.py, skill.js)
//       examples.json  optional [{input, expect}] -> deterministic self-test
//
// Authoring (both paths land in the same self-test -> index -> lifecycle):
//   - human: drop a folder under cap/user/<name>/ (watcher imports it)
//   - agent: call the create_skill tool mid-task
//
// Trust posture (per design decision): agents are trusted. Passing the declared
// self-test is the only bar to `stable`; any agent may invoke any non-deprecated
// skill. The exec container sandbox is the blast-radius floor.
//
// Execution contract (on the wire): the executor (runCodeViaTool) writes the
// program to a file in the run's workbench and runs it via the exec server's
// bash tool. The caller's input is
// JSON on stdin; the skill emits its result as one JSON object inside a
//   ===SKILL_RESULT=== <json> ===END===
// fence on stdout; exit 0 = success. In the default 'entrypoint' mode the author
// only writes a function (skill(input)) and this module supplies the stdin/stdout
// + fence harness; in 'raw' mode the author writes the whole stdin->fence program.

import * as fsp  from 'node:fs/promises'
import * as path from 'node:path'
import { cols } from '../utils/config.js'
import { markdownFrontmatterCodec, computeHash } from './ragkernel.js'
import type { CoordinatorConfig } from '../types/index.js'

// -- Public result types -------------------------------------------------------

export interface SkillRunResult {
  ok:          boolean
  exit_code:   number
  result?:     unknown   // parsed from the ===SKILL_RESULT=== fence, if present
  stdout:      string
  stderr:      string
  duration_ms: number
  error?:      string
}

export interface CreateSkillInput {
  name:             string
  description:      string
  language:         string                    // runtime language string (python, node, ...)
  code:             string                    // entrypoint source
  input_contract?:  string
  output_contract?: string
  input_mode?:      'entrypoint' | 'raw'
  examples?:        Array<{ input: unknown; expect: unknown }>
  tags?:            string[]
}

// Executor injected by the tool layer (tools.runCodeViaTool). Kept as a param
// rather than a static import so this module never imports tools.ts (no cycle).
export type CodeExecFn = (
  language: string,
  code:     string,
  stdin:    string,
) => Promise<{ stdout: string; stderr: string; exit_code: number }>

// -- Module init ---------------------------------------------------------------

type SkillExecDeps = { getCoordinator: () => CoordinatorConfig }
let _deps: SkillExecDeps | null = null
export function initSkillExec(deps: SkillExecDeps): void { _deps = deps }

function getSkillsCfg() { return _deps?.getCoordinator().skills }
function getMemoryCfg() { return _deps?.getCoordinator().memory }

export function skillExecEnabled(): boolean {
  const s = getSkillsCfg()
  const m = getMemoryCfg()
  return !!(s?.skillsDir && m?.qdrantUrl && m?.teiUrl && m?.vectorSize)
}

// Capability skills live under a `cap/` sibling of the prose-skill .md dirs, so
// the existing flat-file skills.ts scanner/watcher (which only reads *.md files
// in agent/ and user/) never sees these folders.
function capsRoot(): string { return path.join(getSkillsCfg()!.skillsDir, 'cap') }
function capSubdir(sub: 'agent' | 'user' | 'deprecated'): string {
  return path.join(capsRoot(), sub)
}

async function ensureCapDirs(): Promise<void> {
  const base = getSkillsCfg()?.skillsDir
  if (!base) return
  for (const sub of ['agent', 'user', 'deprecated']) {
    await fsp.mkdir(path.join(base, 'cap', sub), { recursive: true })
  }
}

// -- Manifest ------------------------------------------------------------------

export interface SkillManifest {
  name:             string
  version:          string
  status:           'provisional' | 'stable' | 'deprecated'
  description:      string
  language:         string
  entrypoint:       string
  input_mode:       'entrypoint' | 'raw'
  input_contract:   string
  output_contract:  string
  tags:             string[]
  author:           string
  author_type:      'agent' | 'human'
  confidence:       number
  invocation_count: number
  success_count:    number
  self_test_passed: boolean
  created_at:       string
  last_updated:     string
  content_hash:     string
}

function manifestFromMeta(meta: Record<string, unknown>): SkillManifest {
  const mode = String(meta['input_mode'] ?? 'entrypoint')
  return {
    name:             String(meta['name']             ?? ''),
    version:          String(meta['version']          ?? '1.0.0'),
    status:           (meta['status'] as SkillManifest['status']) ?? 'provisional',
    description:      String(meta['description']      ?? ''),
    language:         String(meta['language']         ?? '').toLowerCase(),
    entrypoint:       String(meta['entrypoint']       ?? ''),
    input_mode:       mode === 'raw' ? 'raw' : 'entrypoint',
    input_contract:   String(meta['input_contract']  ?? ''),
    output_contract:  String(meta['output_contract'] ?? ''),
    tags:             Array.isArray(meta['tags']) ? (meta['tags'] as string[]) : [],
    author:           String(meta['author']           ?? ''),
    author_type:      (meta['author_type'] as SkillManifest['author_type']) ?? 'human',
    confidence:       Number(meta['confidence']        ?? 0),
    invocation_count: Number(meta['invocation_count']  ?? 0),
    success_count:    Number(meta['success_count']     ?? 0),
    // Parser leaves booleans as strings -> coerce explicitly.
    self_test_passed: String(meta['self_test_passed'] ?? 'false') === 'true',
    created_at:       String(meta['created_at']       ?? ''),
    last_updated:     String(meta['last_updated']      ?? ''),
    content_hash:     String(meta['content_hash']      ?? ''),
  }
}

function metaFromManifest(m: SkillManifest): Record<string, unknown> {
  return {
    name:             m.name,
    version:          m.version,
    status:           m.status,
    description:      m.description,
    language:         m.language,
    entrypoint:       m.entrypoint,
    input_mode:       m.input_mode,
    input_contract:   m.input_contract,
    output_contract:  m.output_contract,
    tags:             m.tags,
    author:           m.author,
    author_type:      m.author_type,
    confidence:       m.confidence,
    invocation_count: m.invocation_count,
    success_count:    m.success_count,
    self_test_passed: m.self_test_passed,
    created_at:       m.created_at,
    last_updated:     m.last_updated,
    content_hash:     m.content_hash,
  }
}

// Hash over SEMANTIC content only (manifest essentials + body + entrypoint
// source), excluding volatile/runtime fields, so the import write-back is
// skip-stable and the watcher does not re-import in a loop -- same discipline as
// the RAG kernel and skills.ts.
function stableManifestHash(m: SkillManifest, body: string, source: string): string {
  const semantic = {
    name: m.name, version: m.version, description: m.description,
    language: m.language, entrypoint: m.entrypoint, input_mode: m.input_mode,
    input_contract: m.input_contract, output_contract: m.output_contract,
    tags: [...m.tags], author: m.author,
  }
  return computeHash(JSON.stringify(semantic) + '\u0000' + body + '\u0000' + source)
}

function manifestPath(folder: string): string { return path.join(folder, 'SKILL.md') }

async function readManifest(folder: string): Promise<{ manifest: SkillManifest; body: string } | null> {
  let raw: string
  try { raw = await fsp.readFile(manifestPath(folder), 'utf-8') } catch { return null }
  const doc = markdownFrontmatterCodec.parse(raw)
  if (!doc) return null
  const manifest = manifestFromMeta(doc.meta)
  if (!manifest.name || !manifest.entrypoint) return null
  return { manifest, body: doc.body }
}

async function writeManifest(folder: string, m: SkillManifest, body: string): Promise<void> {
  const content = markdownFrontmatterCodec.serialize({ meta: metaFromManifest(m), body })
  await fsp.writeFile(manifestPath(folder), content, 'utf-8')
}

// -- TEI + Qdrant (description -> embedding -> folder pointer) ------------------

async function embedText(text: string): Promise<number[] | null> {
  const m = getMemoryCfg()
  if (!m?.teiUrl) return null
  const safe = text.slice(0, 500)
  try {
    const res = await fetch(`${m.teiUrl}/embed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: safe }), signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const vectors = await res.json() as number[][]
    return vectors[0] ?? null
  } catch { return null }
}

function skillId(name: string): number {
  let h = 5381
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0
  return h
}

export async function ensureCapsCollection(): Promise<void> {
  const m = getMemoryCfg()
  if (!m?.qdrantUrl || !m?.vectorSize) return
  const res = await fetch(`${m.qdrantUrl}/collections/${cols.skillCaps}`, { method: 'GET' })
  if (res.ok) return
  await fetch(`${m.qdrantUrl}/collections/${cols.skillCaps}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vectors: { size: m.vectorSize, distance: 'Cosine' } }),
  })
}

async function capUpsert(folder: string, m: SkillManifest, vector: number[]): Promise<void> {
  const mem = getMemoryCfg()
  if (!mem?.qdrantUrl) return
  await fetch(`${mem.qdrantUrl}/collections/${cols.skillCaps}/points`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points: [{
      id: skillId(m.name),
      vector,
      payload: {
        name: m.name, folder, content_hash: m.content_hash,
        language: m.language, entrypoint: m.entrypoint, input_mode: m.input_mode,
        status: m.status, confidence: m.confidence, author_type: m.author_type,
        description: m.description, input_contract: m.input_contract,
        output_contract: m.output_contract,
        invocation_count: m.invocation_count, success_count: m.success_count,
        self_test_passed: m.self_test_passed, tags: m.tags,
      },
    }] }),
    signal: AbortSignal.timeout(10_000),
  })
}

async function capUpdateStats(name: string, invocation: number, success: number): Promise<void> {
  const mem = getMemoryCfg()
  if (!mem?.qdrantUrl) return
  try {
    await fetch(`${mem.qdrantUrl}/collections/${cols.skillCaps}/points/payload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: { invocation_count: invocation, success_count: success },
        points: [skillId(name)],
      }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch { /* non-fatal */ }
}

async function capSetPayload(name: string, payload: Record<string, unknown>): Promise<void> {
  const mem = getMemoryCfg()
  if (!mem?.qdrantUrl) return
  try {
    await fetch(`${mem.qdrantUrl}/collections/${cols.skillCaps}/points/payload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, points: [skillId(name)] }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch { /* non-fatal */ }
}

// -- Harness (entrypoint mode) -------------------------------------------------
// The author writes only `skill(input)`. We append a per-language harness that
// reads stdin JSON (falling back to an embedded literal if the runner did not
// forward stdin), calls skill(input), and prints the result fence. Keep all
// harness strings ASCII-only -- they become on-disk / on-wire program text.

const RESULT_OPEN  = '===SKILL_RESULT==='
const RESULT_CLOSE = '===END==='

function jsLiteral(s: string): string {
  return JSON.stringify(s)   // safe JS/JSON string literal (also valid Python via json)
}

function pythonHarness(inputJson: string): string {
  return [
    '',
    'if __name__ == "__main__":',
    '    import sys, json',
    '    _raw = sys.stdin.read()',
    '    if not _raw.strip():',
    '        _raw = ' + jsLiteral(inputJson),
    '    try:',
    '        _input = json.loads(_raw) if _raw.strip() else None',
    '    except Exception:',
    '        _input = _raw',
    '    _result = skill(_input)',
    '    print("' + RESULT_OPEN + '")',
    '    print(json.dumps(_result, default=str))',
    '    print("' + RESULT_CLOSE + '")',
  ].join('\n')
}

function nodeHarness(inputJson: string): string {
  return [
    '',
    '(async () => {',
    '  const _chunks = [];',
    '  for await (const c of process.stdin) _chunks.push(c);',
    '  let _raw = Buffer.concat(_chunks).toString("utf8");',
    '  if (!_raw.trim()) _raw = ' + jsLiteral(inputJson) + ';',
    '  let _input;',
    '  try { _input = _raw.trim() ? JSON.parse(_raw) : null; } catch (e) { _input = _raw; }',
    '  const _result = await skill(_input);',
    '  console.log(' + jsLiteral(RESULT_OPEN) + ');',
    '  console.log(JSON.stringify(_result));',
    '  console.log(' + jsLiteral(RESULT_CLOSE) + ');',
    '})();',
  ].join('\n')
}

function langFamily(language: string): 'python' | 'node' | 'other' {
  const l = language.toLowerCase()
  if (l.startsWith('python') || l === 'py') return 'python'
  if (l.startsWith('node') || l.startsWith('javascript') || l === 'js' || l.startsWith('typescript') || l === 'ts') return 'node'
  return 'other'
}

// Compose the final program sent to the executor.
function buildProgram(manifest: SkillManifest, source: string, inputJson: string): string | null {
  if (manifest.input_mode === 'raw') return source   // author owns the full I/O contract
  const fam = langFamily(manifest.language)
  if (fam === 'python') return source + '\n' + pythonHarness(inputJson)
  if (fam === 'node')   return source + '\n' + nodeHarness(inputJson)
  // entrypoint mode unsupported for this language -> caller must use raw mode
  return null
}

function parseResultFence(stdout: string): unknown | undefined {
  const open = stdout.indexOf(RESULT_OPEN)
  if (open === -1) return undefined
  const after = stdout.slice(open + RESULT_OPEN.length)
  const close = after.indexOf(RESULT_CLOSE)
  const inner = (close === -1 ? after : after.slice(0, close)).trim()
  if (!inner) return undefined
  try { return JSON.parse(inner) } catch { return inner }
}

// -- Locate a skill folder by name --------------------------------------------

async function findSkillFolder(name: string, includeDeprecated = false): Promise<string | null> {
  const subs: Array<'agent' | 'user' | 'deprecated'> =
    includeDeprecated ? ['user', 'agent', 'deprecated'] : ['user', 'agent']
  for (const sub of subs) {
    const folder = path.join(capSubdir(sub), name)
    try { await fsp.access(manifestPath(folder)); return folder } catch { /* next */ }
  }
  return null
}

// -- Run a skill ---------------------------------------------------------------

const PROMOTE_MIN_RUNS = 5
const PROMOTE_MIN_RATE = 0.80
const DECAY_MIN_RUNS   = 10
const DECAY_MAX_RATE   = 0.50

export async function runSkill(
  name:  string,
  input: unknown,
  exec:  CodeExecFn,
): Promise<SkillRunResult> {
  const empty = (error: string): SkillRunResult =>
    ({ ok: false, exit_code: 1, stdout: '', stderr: '', duration_ms: 0, error })

  if (!skillExecEnabled()) return empty('skill execution is not enabled')

  const folder = await findSkillFolder(name)
  if (!folder) return empty(`No skill named "${name}". It may not exist or may be deprecated.`)

  const read = await readManifest(folder)
  if (!read) return empty(`Skill "${name}" has an invalid SKILL.md manifest.`)
  const { manifest } = read

  let source: string
  try { source = await fsp.readFile(path.join(folder, manifest.entrypoint), 'utf-8') }
  catch { return empty(`Skill "${name}" entrypoint "${manifest.entrypoint}" is missing.`) }

  const inputJson = JSON.stringify(input ?? null)
  const program   = buildProgram(manifest, source, inputJson)
  if (program === null) {
    return empty(`Skill "${name}" uses entrypoint mode for unsupported language ` +
      `"${manifest.language}". Re-author it in raw mode (read stdin, print the result fence).`)
  }

  const t0 = Date.now()
  let out: { stdout: string; stderr: string; exit_code: number }
  try { out = await exec(manifest.language, program, inputJson) }
  catch (e) { return empty(`Executor error: ${e instanceof Error ? e.message : String(e)}`) }
  const duration_ms = Date.now() - t0

  const ok     = out.exit_code === 0
  const result = parseResultFence(out.stdout)

  // Record a real invocation (this is the point of executable skills: stats mean
  // actual executions, not prompt-recalls). Fire-and-forget on the lifecycle.
  recordInvocation(folder, name, ok).catch(() => {})

  return {
    ok, exit_code: out.exit_code, result,
    stdout: out.stdout, stderr: out.stderr, duration_ms,
    ...(ok ? {} : { error: out.stderr.slice(0, 400) || `exit ${out.exit_code}` }),
  }
}

async function recordInvocation(folder: string, name: string, passed: boolean): Promise<void> {
  const read = await readManifest(folder)
  if (!read) return
  const { manifest: m, body } = read
  m.invocation_count++
  if (passed) m.success_count++
  m.last_updated = new Date().toISOString()
  const rate = m.invocation_count > 0 ? m.success_count / m.invocation_count : 0

  let moved = false
  if (m.invocation_count >= DECAY_MIN_RUNS && rate < DECAY_MAX_RATE && m.status !== 'deprecated') {
    m.status = 'deprecated'
    console.log(`[skillcap] deprecated by decay: ${name} (rate ${(rate * 100).toFixed(0)}%)`)
    await deprecateFolder(folder, name)
    moved = true
  } else if (m.status === 'provisional' && m.self_test_passed
    && m.invocation_count >= PROMOTE_MIN_RUNS && rate >= PROMOTE_MIN_RATE) {
    m.status = 'stable'
    console.log(`[skillcap] promoted to stable: ${name}`)
  }

  if (!moved) await writeManifest(folder, m, body)
  await capUpdateStats(name, m.invocation_count, m.success_count)
  if (m.status === 'deprecated') await capSetPayload(name, { status: 'deprecated' })
  else if (m.status === 'stable') await capSetPayload(name, { status: 'stable' })
}

async function deprecateFolder(folder: string, name: string): Promise<void> {
  const dest = path.join(capSubdir('deprecated'), name)
  try {
    await fsp.mkdir(capSubdir('deprecated'), { recursive: true })
    await fsp.rename(folder, dest)
  } catch (e) { console.warn(`[skillcap] deprecate move failed for ${name}: ${e}`) }
}

// -- Self-test -----------------------------------------------------------------

interface SelfTest { ran: boolean; passed: number; total: number; failures: string[] }

async function readExamples(folder: string): Promise<Array<{ input: unknown; expect: unknown }>> {
  try {
    const raw = await fsp.readFile(path.join(folder, 'examples.json'), 'utf-8')
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function selfTest(folder: string, manifest: SkillManifest, exec: CodeExecFn): Promise<SelfTest> {
  const examples = await readExamples(folder)
  if (examples.length === 0) return { ran: false, passed: 0, total: 0, failures: [] }

  let source: string
  try { source = await fsp.readFile(path.join(folder, manifest.entrypoint), 'utf-8') }
  catch { return { ran: false, passed: 0, total: examples.length, failures: ['entrypoint missing'] } }

  let passed = 0
  const failures: string[] = []
  for (let i = 0; i < examples.length; i++) {
    const ex        = examples[i]!
    const inputJson = JSON.stringify(ex.input ?? null)
    const program   = buildProgram(manifest, source, inputJson)
    if (program === null) { failures.push(`example ${i}: language unsupported in entrypoint mode`); continue }
    try {
      const out = await exec(manifest.language, program, inputJson)
      if (out.exit_code !== 0) { failures.push(`example ${i}: exit ${out.exit_code}: ${out.stderr.slice(0, 120)}`); continue }
      const got = parseResultFence(out.stdout)
      if (deepEqual(got, ex.expect)) passed++
      else failures.push(`example ${i}: expected ${JSON.stringify(ex.expect)} got ${JSON.stringify(got)}`)
    } catch (e) {
      failures.push(`example ${i}: executor error ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { ran: true, passed, total: examples.length, failures }
}

// -- Create a skill (agent create_skill tool, or programmatic) -----------------

const SUPPORTED_RAW_FALLBACK = true   // any runtime language allowed in raw mode

function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 80)
}

function entrypointFor(language: string, mode: 'entrypoint' | 'raw'): string {
  const fam = langFamily(language)
  if (fam === 'python') return 'skill.py'
  if (fam === 'node')   return 'skill.js'
  // raw mode for other languages: name the file generically
  return mode === 'raw' ? 'skill.txt' : 'skill.txt'
}

export interface CreateSkillResult {
  status:    'created' | 'updated' | 'error'
  skill?:    string
  promoted?: 'stable' | 'provisional'
  self_test?: SelfTest
  error?:    string
}

export async function createSkill(
  input:      CreateSkillInput,
  exec:       CodeExecFn,
  authorType: 'agent' | 'human' = 'agent',
): Promise<CreateSkillResult> {
  if (!skillExecEnabled()) return { status: 'error', error: 'skill execution is not enabled' }

  const name = sanitizeName(input.name)
  if (!name) return { status: 'error', error: 'invalid skill name' }
  if (!input.code?.trim())        return { status: 'error', error: 'code is required' }
  if (!input.description?.trim()) return { status: 'error', error: 'description is required' }
  if (!input.language?.trim())    return { status: 'error', error: 'language is required' }

  const mode = input.input_mode ?? 'entrypoint'
  const fam  = langFamily(input.language)
  if (mode === 'entrypoint' && fam === 'other' && !SUPPORTED_RAW_FALLBACK) {
    return { status: 'error', error: `entrypoint mode unsupported for ${input.language}; use raw mode` }
  }
  const effectiveMode: 'entrypoint' | 'raw' =
    (mode === 'entrypoint' && fam === 'other') ? 'raw' : mode

  const sub: 'agent' | 'user' = authorType === 'agent' ? 'agent' : 'user'
  const folder = path.join(capSubdir(sub), name)
  const existing = await findSkillFolder(name, true)
  const isUpdate = existing !== null
  const targetFolder = existing ?? folder

  const entrypoint = entrypointFor(input.language, effectiveMode)
  const now = new Date().toISOString()

  const manifest: SkillManifest = {
    name,
    version:          '1.0.0',
    status:           'provisional',
    description:      input.description.trim().slice(0, 500),
    language:         input.language.toLowerCase(),
    entrypoint,
    input_mode:       effectiveMode,
    input_contract:   (input.input_contract  ?? '').slice(0, 300),
    output_contract:  (input.output_contract ?? '').slice(0, 300),
    tags:             input.tags ?? [],
    author:           authorType === 'agent' ? 'orchestrail-agent' : 'human',
    author_type:      authorType,
    confidence:       0,
    invocation_count: 0,
    success_count:    0,
    self_test_passed: false,
    created_at:       now,
    last_updated:     now,
    content_hash:     '',
  }

  // Body = human-readable docs. The interface contract is duplicated here for the
  // reader; the embedded discovery surface is `description`.
  const body = [
    `# ${name}`,
    '',
    input.description.trim(),
    '',
    '## Input',
    manifest.input_contract || '(JSON value on stdin)',
    '',
    '## Output',
    manifest.output_contract || '(JSON value in the SKILL_RESULT fence)',
    '',
    `## Mode`,
    effectiveMode === 'entrypoint'
      ? `entrypoint -- defines \`skill(input)\`; the runtime supplies the stdin/result harness.`
      : `raw -- the script reads stdin and prints the ${RESULT_OPEN}/${RESULT_CLOSE} fence itself.`,
  ].join('\n')

  try {
    await fsp.mkdir(targetFolder, { recursive: true })
    await fsp.writeFile(path.join(targetFolder, entrypoint), input.code, 'utf-8')
    if (input.examples && input.examples.length > 0) {
      await fsp.writeFile(path.join(targetFolder, 'examples.json'),
        JSON.stringify(input.examples, null, 2), 'utf-8')
    }
  } catch (e) {
    return { status: 'error', error: `cannot write skill files: ${e instanceof Error ? e.message : String(e)}` }
  }

  // Deterministic self-test gates promotion to stable (the only bar -- agents are
  // trusted). No examples -> stays provisional (callable, but not auto-stable).
  const st = await selfTest(targetFolder, manifest, exec)
  if (st.ran && st.total > 0 && st.passed === st.total) {
    manifest.self_test_passed = true
    manifest.status     = 'stable'
    manifest.confidence = 0.9
  }

  // Stamp a skip-stable content hash (mirror skills.ts: serialize -> reparse ->
  // hash the final on-disk semantic content so the watcher does not re-import).
  manifest.content_hash = stableManifestHash(manifest, body, input.code)
  await writeManifest(targetFolder, manifest, body)

  const vector = await embedText(manifest.description)
  if (!vector) return { status: 'error', error: 'embedding failed' }
  await capUpsert(targetFolder, manifest, vector)

  console.log(`[skillcap] ${isUpdate ? 'updated' : 'created'}: ${name} ` +
    `(${manifest.language}, ${manifest.status}, self_test ${st.ran ? `${st.passed}/${st.total}` : 'none'})`)

  return {
    status:    isUpdate ? 'updated' : 'created',
    skill:     name,
    promoted:  manifest.status === 'stable' ? 'stable' : 'provisional',
    self_test: st,
  }
}

// -- Import from disk (watcher / startup) --------------------------------------
// A human-authored folder already contains SKILL.md + entrypoint. Import = run
// self-test, (re)embed, upsert. Skip-stable via content_hash.

export async function importSkillFolder(folder: string, exec: CodeExecFn): Promise<'imported' | 'updated' | 'skipped' | 'error'> {
  if (!skillExecEnabled()) return 'error'
  const read = await readManifest(folder)
  if (!read) { console.warn(`[skillcap] invalid manifest in ${folder}`); return 'error' }
  const { manifest: m, body } = read

  let source: string
  try { source = await fsp.readFile(path.join(folder, m.entrypoint), 'utf-8') }
  catch { console.warn(`[skillcap] entrypoint missing in ${folder}`); return 'error' }

  const readHash = stableManifestHash(m, body, source)

  // Skip if already indexed unchanged.
  const mem = getMemoryCfg()!
  try {
    const res = await fetch(`${mem.qdrantUrl}/collections/${cols.skillCaps}/points/scroll`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 1, with_payload: true,
        filter: { must: [{ key: 'name', match: { value: m.name } }] } }),
      signal: AbortSignal.timeout(5_000),
    })
    if (res.ok) {
      const data = await res.json() as { result: { points: Array<{ payload: Record<string, unknown> }> } }
      const existing = data.result?.points?.[0]
      if (existing && existing.payload['content_hash'] === readHash) return 'skipped'
    }
  } catch { /* proceed */ }

  const isNew = m.content_hash === ''
  const now = new Date().toISOString()
  const st = await selfTest(folder, m, exec)
  if (st.ran && st.total > 0 && st.passed === st.total) {
    m.self_test_passed = true
    if (m.status === 'provisional') { m.status = 'stable'; m.confidence = Math.max(m.confidence, 0.9) }
  } else if (st.ran) {
    m.self_test_passed = false
  }
  m.last_updated = now
  if (!m.created_at) m.created_at = now

  m.content_hash = stableManifestHash(m, body, source)
  await writeManifest(folder, m, body)

  const vector = await embedText(m.description)
  if (!vector) { console.warn(`[skillcap] embed failed for ${m.name}`); return 'error' }
  await capUpsert(folder, m, vector)
  console.log(`[skillcap] ${isNew ? 'imported' : 'updated'}: ${m.name} (self_test ${st.ran ? `${st.passed}/${st.total}` : 'none'})`)
  return isNew ? 'imported' : 'updated'
}

// -- Recall (surface skills as INVOCABLE, not as prose) ------------------------

// Advertise-gate, not an invoke-gate: this only controls whether a skill is
// LISTED in the agent's prompt. The agent still decides whether to call it via
// use_skill, so a marginal false-positive is cheap (an unused line in a list)
// while a false-negative is total (the skill is invisible and the agent
// re-derives the procedure by hand / thrashes on run_code). That asymmetry is
// why this floor is permissive and live-tunable: set SKILLCAP_RECALL_THRESHOLD
// to retune on prod without a rebuild. Default stays 0.6 to match prior behavior.
const RECALL_THRESHOLD = (() => {
  const raw = Number(process.env.SKILLCAP_RECALL_THRESHOLD)
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.6
})()

async function capSearch(vector: number[], limit: number): Promise<Array<{
  name: string; description: string; input_contract: string; output_contract: string
  language: string; status: string; confidence: number; score: number
}>> {
  const mem = getMemoryCfg()
  if (!mem?.qdrantUrl) return []
  const statusFilter = { should: [
    { key: 'status', match: { value: 'stable' } },
    { key: 'status', match: { value: 'provisional' } },
  ] }
  try {
    const res = await fetch(`${mem.qdrantUrl}/collections/${cols.skillCaps}/points/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vector, limit, with_payload: true, filter: { must: [statusFilter] } }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    const data = await res.json() as { result: Array<{ score: number; payload: Record<string, unknown> }> }
    return data.result.map(r => ({
      name:            String(r.payload['name'] ?? ''),
      description:     String(r.payload['description'] ?? ''),
      input_contract:  String(r.payload['input_contract'] ?? ''),
      output_contract: String(r.payload['output_contract'] ?? ''),
      language:        String(r.payload['language'] ?? ''),
      status:          String(r.payload['status'] ?? ''),
      confidence:      Number(r.payload['confidence'] ?? 0),
      score:           r.score,
    }))
  } catch { return [] }
}

// Returns a prompt block ADVERTISING invocable skills (with how to call them),
// not the skill bodies. The agent then calls use_skill to actually run one.
export async function recallSkillCaps(query: string, limit = 3): Promise<string> {
  if (!skillExecEnabled()) return ''
  const vector = await embedText(query)
  if (!vector) {
    console.log(`[skillcap] recall: embed failed for "${query.slice(0, 60)}"`)
    return ''
  }
  // Score every named candidate first so a miss can report WHY (mirrors the
  // failures path, which logs "best score X below threshold"). The previous
  // version filtered + early-returned silently, which is exactly why a recall
  // that ran but scored under the gate left no trace in the logs.
  const candidates = (await capSearch(vector, limit)).filter(h => h.name)
  if (candidates.length === 0) {
    console.log(`[skillcap] recall: 0 candidates for "${query.slice(0, 60)}"`)
    return ''
  }
  const hits = candidates.filter(h => h.score >= RECALL_THRESHOLD)
  if (hits.length === 0) {
    const best = candidates[0]!
    console.log(`[skillcap] recall: best "${best.name}" score=${best.score.toFixed(3)} below threshold ${RECALL_THRESHOLD} for "${query.slice(0, 60)}"`)
    return ''
  }

  const lines = hits.map(h => {
    const io = h.input_contract || h.output_contract
      ? ` (input: ${h.input_contract || '?'} -> ${h.output_contract || '?'})`
      : ''
    const prov = h.status === 'provisional' ? ' [provisional]' : ''
    return `- \`${h.name}\`${prov}: ${h.description}${io}`
  }).join('\n')

  console.log(`[skillcap] recall: ${hits.length} invocable skill(s) (top "${hits[0]!.name}" ${hits[0]!.score.toFixed(3)}) for "${query.slice(0, 60)}"`)
  return (
    `\n\n## Available skills (executable)\n` +
    `You can run any of these by calling the use_skill tool with { name, input }. ` +
    `They execute real code and return a deterministic result -- prefer them over ` +
    `re-deriving a procedure by hand. If none fits and you build a reusable check, ` +
    `register it with create_skill so later runs can reuse it.\n` +
    lines
  )
}

// -- Listing (admin/UI) --------------------------------------------------------

export async function listSkillCaps(): Promise<SkillManifest[]> {
  if (!skillExecEnabled()) return []
  const out: SkillManifest[] = []
  for (const sub of ['agent', 'user', 'deprecated'] as const) {
    const dir = capSubdir(sub)
    let names: string[]
    try { names = await fsp.readdir(dir) } catch { continue }
    for (const n of names) {
      // Detect a skill by the presence of SKILL.md rather than the dirent type
      // flag: some filesystems (ZFS-backed bind mounts) return DT_UNKNOWN, which
      // makes Dirent.isDirectory() report false for real directories.
      const folder = path.join(dir, n)
      try { await fsp.access(manifestPath(folder)) } catch { continue }
      const read = await readManifest(folder)
      if (read) out.push(read.manifest)
    }
  }
  return out
}

// -- Startup scan + watcher ----------------------------------------------------

export async function startupScanCaps(exec: CodeExecFn): Promise<void> {
  if (!skillExecEnabled()) return
  await ensureCapDirs()
  await ensureCapsCollection()
  let imported = 0, updated = 0
  for (const sub of ['agent', 'user'] as const) {
    const dir = capSubdir(sub)
    let names: string[]
    try { names = await fsp.readdir(dir) } catch { continue }
    for (const n of names) {
      // Skill = a subdir containing SKILL.md. Checking the manifest directly is
      // robust against DT_UNKNOWN (ZFS-backed mounts report dirs as non-dirs via
      // Dirent.isDirectory()) and naturally skips stray files.
      const folder = path.join(dir, n)
      try { await fsp.access(manifestPath(folder)) } catch { continue }
      const r = await importSkillFolder(folder, exec)
      if (r === 'imported') imported++
      if (r === 'updated')  updated++
    }
  }
  console.log(`[skillcap] startup scan: ${imported} imported, ${updated} updated`)
}

// Watch cap/user for folder changes. fs.watch is recursive (Node 18+); we
// debounce and re-import the top-level skill folder for any event beneath it.
export async function watchSkillCaps(exec: CodeExecFn): Promise<void> {
  if (!skillExecEnabled()) return
  await ensureCapDirs()
  const watchDir = capSubdir('user')
  try {
    const watcher = fsp.watch(watchDir, { recursive: true })
    console.log(`[skillcap] watching ${watchDir} for user skill folders`)
    const debounce = new Map<string, ReturnType<typeof setTimeout>>()
    for await (const event of watcher) {
      if (!event.filename) continue
      // First path segment under cap/user is the skill folder name.
      const top = event.filename.split(path.sep)[0]
      if (!top) continue
      const existing = debounce.get(top)
      if (existing) clearTimeout(existing)
      debounce.set(top, setTimeout(async () => {
        debounce.delete(top)
        const folder = path.join(watchDir, top)
        try { await fsp.access(manifestPath(folder)) } catch { return }  // not a skill folder yet
        const r = await importSkillFolder(folder, exec)
        if (r !== 'skipped') console.log(`[skillcap] watcher: ${r} ${top}`)
      }, 600))
    }
  } catch (e) {
    console.warn(`[skillcap] watcher failed to start: ${e}`)
  }
}
