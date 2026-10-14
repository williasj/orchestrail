// -- Deliverable packaging -----------------------------------------------------------
// Orchestrail has no filesystem access to /workbench (different container, no
// bind mount between them -- see docker-compose.yml). So packaging happens
// through the exec sidecar's existing `bash` tool: zip the workspace, base64
// the result to stdout (bash's stdout is a UTF-8 text field on the wire, so
// binary has to go out as text), decode it back into a Buffer here.
//
// REQUIRES: the `zip` package installed in the orchestrail-exec image (it is
// NOT in the current Dockerfile's apt-get list -- Ubuntu ships `gzip`/`tar` by
// default but not `zip`). One-line Dockerfile change, documented in the
// handoff notes; this file assumes it is present and surfaces a clear error if
// it is not, rather than silently producing an empty zip.
//
// KNOWN ALPHA LIMIT: the exec sidecar caps bash stdout at MAX_OUTPUT_BYTES
// (1 MiB default, server.mjs). Base64 is ~33% larger than binary, so this
// caps deliverables at roughly 750KB of actual zip content before the exec
// server silently truncates the output. Fine for a small alpha project; raise
// MAX_OUTPUT_BYTES via the orchestrail-exec service env for anything bigger --
// no code change needed, it is already a configurable env var.

import { btBash, btWorkbenchRunId } from './execClient.js'
import type { BTRuntime } from './types.js'

export interface ZipResult {
  ok: boolean
  buffer: Buffer | null
  error?: string
  truncated?: boolean
}

export async function packageDeliverableZip(slug: string, runtime: BTRuntime): Promise<ZipResult> {
  const runId = btWorkbenchRunId(slug)
  const cmd =
    'set -e; ' +
    'if ! command -v zip >/dev/null 2>&1; then echo "ZIP_MISSING" >&2; exit 3; fi; ' +
    'rm -f /tmp/bt-deliverable.zip; ' +
    "zip -rq /tmp/bt-deliverable.zip . -x '.git/*' >/dev/null; " +
    'base64 -w0 /tmp/bt-deliverable.zip; ' +
    'rm -f /tmp/bt-deliverable.zip'

  const r = await btBash(runId, cmd, undefined, runtime.exec_timeout_ms)
  const exit_code = typeof r.exit_code === 'number' ? r.exit_code : 1

  if (exit_code === 3 || /ZIP_MISSING/.test(String(r.stderr ?? ''))) {
    return { ok: false, buffer: null, error: "'zip' is not installed in the orchestrail-exec image -- add it to the Dockerfile apt-get line and rebuild" }
  }
  if (exit_code !== 0) {
    return { ok: false, buffer: null, error: `zip packaging failed (exit ${exit_code}): ${String(r.stderr ?? '').slice(0, 500)}` }
  }

  const b64 = String(r.stdout ?? '').trim()
  if (!b64) return { ok: false, buffer: null, error: 'zip packaging produced no output' }

  const stdoutBytes = Buffer.byteLength(b64, 'utf8')
  const truncated = stdoutBytes >= 1_048_000 // just under the 1 MiB exec stdout cap -- likely truncated

  try {
    const buffer = Buffer.from(b64, 'base64')
    return { ok: true, buffer, truncated }
  } catch (err) {
    return { ok: false, buffer: null, error: `base64 decode failed: ${String(err)}` }
  }
}
