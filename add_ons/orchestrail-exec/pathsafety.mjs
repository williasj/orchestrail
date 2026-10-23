// pathsafety.mjs - path confinement for the orchestrail-exec sandbox
//
// Every caller-supplied path is resolved against the run's private directory
// and guaranteed to stay inside it -- lexically AND after symlink resolution.
// This is the blast-radius floor for the file tools (write_file / read_file /
// list_files) in server.mjs. Kept dependency-free (node: builtins only) and
// side-effect-free so it can be unit-tested in isolation.
//
// All source ASCII-only on purpose (on-disk / on-wire program text).

import * as fs from 'node:fs'
import * as path from 'node:path'

const WORKBENCH_ROOT = process.env.WORKBENCH_ROOT || '/workbench'

// runId must be a simple token: uuid, 'default', or similar. No separators that
// could escape the workbench root. Defense-in-depth on top of safePath.
export const RUNID_RE = /^[A-Za-z0-9_.-]{1,128}$/

export function runDir(runId) {
  return path.join(WORKBENCH_ROOT, runId)
}

// Resolve a caller-supplied path against the run dir and guarantee the result
// stays inside it. Returns the absolute path or throws.
//
// Two layers:
//   1. Lexical containment (path.resolve) blocks `../` traversal and absolute
//      paths such as /etc/passwd.
//   2. Symlink-safe containment: the deepest existing ancestor is resolved with
//      fs.realpath and checked against the run dir's real path. This blocks a
//      symlink planted in the run dir (e.g. via bash `ln -s /workbench/other x`)
//      that would otherwise let read_file / write_file / list_files reach
//      another run or the wider filesystem.
export function safePath(runId, userPath) {
  const base = path.resolve(runDir(runId))
  const rel  = (userPath === undefined || userPath === null) ? '.' : String(userPath)
  const abs  = path.resolve(base, rel)

  // 1) Lexical containment.
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error('path traversal blocked: ' + rel)
  }

  // 2) Symlink-safe containment.
  let baseReal
  try {
    baseReal = fs.realpathSync.native(base)
  } catch (e) {
    if (e && e.code === 'ENOENT') return abs   // run dir not created yet; lexical check already passed
    throw e
  }

  let probe = abs
  for (;;) {
    let real
    try {
      real = fs.realpathSync.native(probe)
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        const parent = path.dirname(probe)
        if (parent === probe) return abs        // nothing exists up to the root
        probe = parent
        continue
      }
      throw e
    }
    if (real !== baseReal && !real.startsWith(baseReal + path.sep)) {
      throw new Error('path traversal blocked (symlink escape): ' + rel)
    }
    return abs
  }
}
