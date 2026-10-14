// orchestrail-exec - sandboxed shell/filesystem tool server
//
// Replaces the Piston run_code wrapper with a stateful, filesystem-aware
// execution surface. Exposes four agent-facing tools, all scoped to
// /workbench/{runId}/ via path validation and a forced `cd`:
//
//   bash(command, [stdin])  -> { stdout, stderr, exit_code }
//   write_file(path, content) -> { ok, path, bytes }
//   read_file(path)         -> { content, bytes }
//   list_files([path])      -> { entries }
//
// Wire protocol (POST /): { name, runId, arguments }
//   - runId is injected by the Orchestrail coordinator from its trusted
//     AsyncLocalStorage workbench id. It is NEVER chosen by the model and is
//     NOT advertised in the GET / schema. A missing/invalid runId is a 400.
//   - reply shape: { result: <tool result> } (mirrors the old dispatch envelope
//     so the coordinator's normalizer keeps working unchanged).
//
// Security posture: this is the blast-radius floor (same role the Piston
// sandbox played). Path traversal outside the run dir is rejected; every bash
// command is forced into the run dir; RFC-1918 egress is dropped by iptables in
// the entrypoint (internet still reachable for pip/npm installs). The container
// is the boundary -- keep it dependency-free (node: builtins only).
//
// All source ASCII-only on purpose (on-disk / on-wire program text).

import http from 'node:http'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

const PORT            = parseInt(process.env.EXEC_PORT || '8766', 10)
const WORKBENCH_ROOT  = process.env.WORKBENCH_ROOT || '/workbench'
const RUN_TIMEOUT_MS  = parseInt(process.env.RUN_TIMEOUT_MS || '60000', 10)
const MAX_OUTPUT_BYTES= parseInt(process.env.MAX_OUTPUT_BYTES || '1048576', 10) // 1 MiB per stream
const MAX_BODY_BYTES  = parseInt(process.env.MAX_BODY_BYTES || '16777216', 10)  // 16 MiB request cap

// runId must be a simple token: uuid, 'default', or similar. No separators that
// could escape the workbench root. This is defense-in-depth on top of safePath.
const RUNID_RE = /^[A-Za-z0-9_.-]{1,128}$/

function log(...a) {
  console.log(new Date().toISOString(), '[exec]', ...a)
}

// -- Path safety ---------------------------------------------------------------

function runDir(runId) {
  return path.join(WORKBENCH_ROOT, runId)
}

// Resolve a caller-supplied path against the run dir and guarantee the result
// stays inside it. Returns the absolute path or throws.
function safePath(runId, userPath) {
  const base = path.resolve(runDir(runId))
  const rel  = (userPath === undefined || userPath === null) ? '.' : String(userPath)
  const abs  = path.resolve(base, rel)
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error('path traversal blocked: ' + rel)
  }
  return abs
}

async function ensureRunDir(runId) {
  await fsp.mkdir(runDir(runId), { recursive: true })
}

// -- Tool implementations ------------------------------------------------------

function runBash(runId, command, stdin) {
  return new Promise((resolve) => {
    const dir = runDir(runId)
    // Force every command into the run dir. Errors from a missing dir are
    // pre-empted by ensureRunDir() in the dispatcher.
    const wrapped = 'cd ' + shellQuote(dir) + ' && ( ' + command + ' )'
    const child = spawn('/bin/bash', ['-lc', wrapped], {
      cwd: dir,
      env: {
        ...process.env,
        HOME: dir,
        RUN_ID: runId,
        PIP_CACHE_DIR: process.env.PIP_CACHE_DIR || '/cache/pip',
        npm_config_cache: process.env.npm_config_cache || '/cache/npm',
      },
    })

    let out = Buffer.alloc(0)
    let err = Buffer.alloc(0)
    let outTrunc = false
    let errTrunc = false
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      try { child.kill('SIGKILL') } catch {}
    }, RUN_TIMEOUT_MS)

    child.stdout.on('data', (c) => {
      if (out.length < MAX_OUTPUT_BYTES) out = Buffer.concat([out, c])
      else outTrunc = true
    })
    child.stderr.on('data', (c) => {
      if (err.length < MAX_OUTPUT_BYTES) err = Buffer.concat([err, c])
      else errTrunc = true
    })

    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout: '', stderr: 'spawn error: ' + e.message, exit_code: 127 })
    })

    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let so = out.toString('utf8')
      let se = err.toString('utf8')
      if (outTrunc) so += '\n[output truncated at ' + MAX_OUTPUT_BYTES + ' bytes]'
      if (errTrunc) se += '\n[stderr truncated at ' + MAX_OUTPUT_BYTES + ' bytes]'
      let exit_code
      if (signal) { exit_code = 137; se += (se ? '\n' : '') + 'killed by signal ' + signal + ' (timeout or OOM)' }
      else exit_code = (typeof code === 'number') ? code : 1
      resolve({ stdout: so, stderr: se, exit_code })
    })

    if (stdin && stdin.length) child.stdin.write(stdin)
    child.stdin.end()
  })
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

async function writeFile(runId, p, content) {
  const abs = safePath(runId, p)
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  const data = String(content ?? '')
  await fsp.writeFile(abs, data, 'utf8')
  return { ok: true, path: path.relative(runDir(runId), abs) || path.basename(abs), bytes: Buffer.byteLength(data, 'utf8') }
}

async function readFile(runId, p) {
  const abs = safePath(runId, p)
  const data = await fsp.readFile(abs, 'utf8')
  return { content: data, bytes: Buffer.byteLength(data, 'utf8') }
}

async function listFiles(runId, p) {
  const abs = safePath(runId, p ?? '.')
  const dirents = await fsp.readdir(abs, { withFileTypes: true })
  const entries = dirents.map((d) => ({
    name: d.name,
    type: d.isDirectory() ? 'dir' : (d.isSymbolicLink() ? 'link' : 'file'),
  }))
  return { entries }
}

// -- Runtime discovery (for the coordinator's list_runtimes repoint) -----------
// Reports what the container can actually run, so the architect can populate the
// `runtimes` workbench slot from a real source of truth instead of Piston.

async function detectRuntimes() {
  const probes = [
    { language: 'python', cmd: 'python3', args: ['--version'] },
    { language: 'node',   cmd: 'node',    args: ['--version'] },
    { language: 'bash',   cmd: 'bash',    args: ['--version'] },
    { language: 'go',     cmd: 'go',      args: ['version'] },
    { language: 'rust',   cmd: 'rustc',   args: ['--version'] },
    { language: 'ruby',   cmd: 'ruby',    args: ['--version'] },
  ]
  const out = []
  for (const p of probes) {
    const v = await probeVersion(p.cmd, p.args)
    if (v) out.push({ language: p.language, version: v, aliases: [] })
  }
  return out
}

function probeVersion(cmd, args) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    try {
      const c = spawn(cmd, args)
      let buf = ''
      c.stdout.on('data', (d) => { buf += d.toString('utf8') })
      c.stderr.on('data', (d) => { buf += d.toString('utf8') })
      c.on('error', () => finish(null))
      c.on('close', () => {
        const m = buf.match(/(\d+\.\d+(?:\.\d+)?)/)
        finish(m ? m[1] : (buf.trim().split('\n')[0] || null))
      })
      setTimeout(() => { try { c.kill('SIGKILL') } catch {}; finish(null) }, 4000)
    } catch { finish(null) }
  })
}

// -- Tool schema (agent-facing; runId intentionally absent) --------------------

const TOOL_DEFINITIONS = [
  { type: 'function', function: {
    name: 'bash',
    description:
      'Run a bash command in this run\'s private working directory. State persists ' +
      'across calls within the run: files you write stay, packages you pip/npm ' +
      'install stay (cached). Use this to install dependencies, run code you wrote ' +
      'with write_file, and inspect output. Returns { stdout, stderr, exit_code }.',
    parameters: { type: 'object', properties: {
      command: { type: 'string', description: 'The bash command to execute.' },
      stdin:   { type: 'string', description: 'Optional text piped to the command\'s stdin.' },
    }, required: ['command'] },
  }},
  { type: 'function', function: {
    name: 'write_file',
    description:
      'Write a UTF-8 text file into this run\'s working directory (parent dirs are ' +
      'created). Use this to lay down source files, then run them with bash. ' +
      'Returns { ok, path, bytes }.',
    parameters: { type: 'object', properties: {
      path:    { type: 'string', description: 'Relative path within the run dir, e.g. "main.py" or "src/lib.rs".' },
      content: { type: 'string', description: 'Full file contents.' },
    }, required: ['path', 'content'] },
  }},
  { type: 'function', function: {
    name: 'read_file',
    description: 'Read a UTF-8 text file from this run\'s working directory. Returns { content, bytes }.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Relative path within the run dir.' },
    }, required: ['path'] },
  }},
  { type: 'function', function: {
    name: 'list_files',
    description: 'List files and directories in this run\'s working directory (or a subpath). Returns { entries }.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Optional relative subpath; defaults to the run dir root.' },
    }, required: [] },
  }},
]

// -- HTTP plumbing -------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY_BYTES) { reject(new Error('request body too large')); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function dispatch(name, runId, args) {
  if (!RUNID_RE.test(runId)) {
    const e = new Error('invalid or missing runId'); e.status = 400; throw e
  }
  await ensureRunDir(runId)
  switch (name) {
    case 'bash':
      return runBash(runId, String(args.command ?? ''), args.stdin !== undefined ? String(args.stdin) : '')
    case 'write_file':
      if (args.path === undefined)    { const e = new Error('write_file requires path');    e.status = 400; throw e }
      if (args.content === undefined) { const e = new Error('write_file requires content'); e.status = 400; throw e }
      return writeFile(runId, args.path, args.content)
    case 'read_file':
      if (args.path === undefined) { const e = new Error('read_file requires path'); e.status = 400; throw e }
      return readFile(runId, args.path)
    case 'list_files':
      return listFiles(runId, args.path)
    default: {
      const e = new Error('unknown tool: ' + JSON.stringify(name)); e.status = 404; throw e
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return sendJson(res, 200, { status: 'ok' })
    if (req.method === 'GET' && req.url === '/')        return sendJson(res, 200, TOOL_DEFINITIONS)
    if (req.method === 'GET' && req.url === '/runtimes') {
      const runtimes = await detectRuntimes()
      return sendJson(res, 200, { result: runtimes })
    }
    if (req.method === 'POST' && (req.url === '/' || req.url === '')) {
      let payload
      try { payload = JSON.parse(await readBody(req) || '{}') }
      catch { return sendJson(res, 400, { error: 'invalid JSON body' }) }
      const name  = payload.name
      const runId = payload.runId
      const args  = (payload.arguments && typeof payload.arguments === 'object')
        ? payload.arguments
        : (payload.parameters && typeof payload.parameters === 'object' ? payload.parameters : {})
      try {
        const result = await dispatch(name, runId, args)
        return sendJson(res, 200, { result })
      } catch (err) {
        const status = err.status || 500
        log('dispatch error', name, runId, '->', err.message)
        return sendJson(res, status, { error: err.message })
      }
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    sendJson(res, 500, { error: String(err && err.message ? err.message : err) })
  }
})

fs.mkdirSync(WORKBENCH_ROOT, { recursive: true })
server.listen(PORT, '0.0.0.0', () => {
  log('orchestrail-exec listening on :' + PORT + ' (workbench root ' + WORKBENCH_ROOT + ')')
})
