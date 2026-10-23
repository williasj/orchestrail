// -- Deliverable packaging -----------------------------------------------------------
// Orchestrail has no filesystem access to /workbench (different container, no
// bind mount between them -- see docker-compose.yml). So packaging happens
// through the exec sidecar in two steps: (1) a `bash` call zips the whole run
// workbench into a transient dotfile at the workbench root, then (2) the zip is
// fetched back as raw bytes over the sidecar's existing `GET /deliver` endpoint
// (the same mechanism the Issue 4 `deliver` tool uses).
//
// Why /deliver and not base64-to-stdout: the exec sidecar caps bash stdout at
// MAX_OUTPUT_BYTES (1 MiB default), and base64 is ~33% larger, so the old
// base64 path silently truncated any deliverable above ~750KB of zip content.
// `GET /deliver` streams the file directly (up to DELIVER_MAX_BYTES, 50 MiB
// default) and fails cleanly (HTTP 413) when the cap is exceeded -- so the user
// gets the WHOLE workbench, or a clear error, never a broken/truncated zip.
//
// REQUIRES: the `zip` package installed in the orchestrail-exec image (it is
// NOT in the current Dockerfile's apt-get list -- Ubuntu ships gzip/tar by
// default but not `zip`). One-line Dockerfile change; this surfaces a clear
// error if it is not present, rather than silently producing an empty zip.
//
// The archive is staged in /tmp (outside the workbench) so it is never zipped
// into itself, then copied to a dotfile (`.bt-deliverable.zip`) at the workbench
// root so the sidecar's path-validated /deliver endpoint can serve it. A stale
// copy from a prior run (the workbench is per-project and shared across runs) is
// removed before zipping; a best-effort rm cleans up the dotfile after the fetch.

import { btBash, btWorkbenchRunId, btDeliverFile, type BTDeliverResult } from './execClient.js'
import type { BTRuntime } from './types.js'

export interface ZipResult {
  ok: boolean
  buffer: Buffer | null
  error?: string
}

// The transient zip's name at the workbench root. A dotfile so it is least
// likely to be picked up by the agent's own tooling. It only exists in the
// workbench between the `cp` and the post-fetch `rm`; the archive is staged in
// /tmp, so the dotfile is never zipped into itself.
export const BT_DELIVERABLE_ZIP_NAME = '.bt-deliverable.zip'

// Pure: build the bash command that zips the whole run workbench. No I/O --
// unit-testable. The archive is written to /tmp (NOT the workbench) so it can
// never be zipped into itself, then copied to the transient dotfile at the
// workbench root for the /deliver fetch. Excludes `.git/*` (VCS internals, not
// part of the deliverable). A stale dotfile from a prior run is removed first
// (the workbench is per-project and shared across runs). `set -e` + the explicit
// zip-presence check (exit 3 / ZIP_MISSING) keep the failure modes distinguishable
// from a plain zip error. A per-run temp name avoids /tmp collisions between
// concurrently-packaging projects (they share the exec container's /tmp).
export function buildPackageCommand(zipName: string = BT_DELIVERABLE_ZIP_NAME, runId: string = ''): string {
  const tmp = runId ? `/tmp/bt-deliverable-${runId}.zip` : '/tmp/bt-deliverable.zip'
  return (
    'set -e; ' +
    'if ! command -v zip >/dev/null 2>&1; then echo "ZIP_MISSING" >&2; exit 3; fi; ' +
    `rm -f ./${zipName} ${tmp}; ` +
    `zip -rq ${tmp} . -x '.git/*' >/dev/null; ` +
    `cp ${tmp} ./${zipName}; ` +
    `rm -f ${tmp}`
  )
}

export type PackDecision =
  | { kind: 'ok' }
  | { kind: 'error'; message: string }

export interface PackageSignals {
  bashExit: number            // exit code of the zip bash command
  bashStderr: string          // stderr of the zip bash command
  deliverStatus: number | null  // HTTP status of GET /deliver (null if the fetch threw / was skipped)
  deliverErrorBody?: string     // response body when /deliver is non-2xx
  fetchError?: string           // transport-level error when the fetch threw
  bytes?: number                // size of the fetched buffer (when 200)
}

// Pure: interpret the packaging I/O signals into a decision. This is the
// contract -- what each outcome means -- kept side-effect-free so it can be
// unit-tested in isolation (zip.check.mjs). The I/O (bash + /deliver fetch)
// lives in packageDeliverableZip and is verified by the build + review.
// Precedence: bash failure is reported before any /deliver outcome, so a failed
// zip is never masked by a coincidental /deliver response.
export function decidePackaging(s: PackageSignals): PackDecision {
  // (1) the zip binary is missing from the exec image
  if (s.bashExit === 3 || /ZIP_MISSING/.test(s.bashStderr)) {
    return { kind: 'error', message: "'zip' is not installed in the orchestrail-exec image -- add it to the Dockerfile apt-get line and rebuild" }
  }
  // (2) the zip command itself failed
  if (s.bashExit !== 0) {
    return { kind: 'error', message: `zip packaging failed (exit ${s.bashExit}): ${s.bashStderr.slice(0, 500)}` }
  }
  // (3) the /deliver fetch was never reached (no endpoint / transport error)
  if (s.deliverStatus === null) {
    return { kind: 'error', message: `deliver fetch failed: ${s.fetchError ?? 'no response from exec /deliver'}` }
  }
  // (4) the file exceeds the sidecar's DELIVER_MAX_BYTES cap -- a clean,
  //     actionable failure instead of the old silent truncation
  if (s.deliverStatus === 413) {
    return { kind: 'error', message: 'deliverable too large to package (exceeds the exec DELIVER_MAX_BYTES cap, default 50 MiB) -- raise DELIVER_MAX_BYTES on orchestrail-exec, or trim the workbench' }
  }
  // (5) any other /deliver rejection (404 not found, 400 bad path, 500, ...)
  if (s.deliverStatus !== 200) {
    const detail = (s.deliverErrorBody ?? '').trim()
    return { kind: 'error', message: `deliver fetch failed: HTTP ${s.deliverStatus}${detail ? ' ' + detail.slice(0, 200) : ''}` }
  }
  // (6) success
  return { kind: 'ok' }
}

export async function packageDeliverableZip(slug: string, runtime: BTRuntime): Promise<ZipResult> {
  const runId = btWorkbenchRunId(slug)

  const r = await btBash(runId, buildPackageCommand(BT_DELIVERABLE_ZIP_NAME, runId), undefined, runtime.exec_timeout_ms)
  const exit_code = typeof r.exit_code === 'number' ? r.exit_code : 1
  const stderr = String(r.stderr ?? '')

  // Only fetch the zip if the zip command succeeded; otherwise report the bash
  // failure directly (decidePackaging checks bash before deliver, so passing
  // deliverStatus: null here yields the same bash-failure decision).
  let d: BTDeliverResult = { status: null, buffer: null }
  if (exit_code === 0) {
    d = await btDeliverFile(runId, BT_DELIVERABLE_ZIP_NAME, runtime.exec_timeout_ms)
  }

  const decision = decidePackaging({
    bashExit: exit_code,
    bashStderr: stderr,
    deliverStatus: d.status,
    deliverErrorBody: d.errorBody,
    fetchError: d.error,
    bytes: d.buffer ? d.buffer.length : undefined,
  })
  if (decision.kind === 'error') return { ok: false, buffer: null, error: decision.message }

  // Best-effort cleanup of the transient zip (the workbench is per-project and
  // shared across runs). Non-fatal: the -x exclusion keeps it out of any future
  // archive even if this rm fails.
  try { await btBash(runId, `rm -f ./${BT_DELIVERABLE_ZIP_NAME}`, undefined, runtime.exec_timeout_ms) } catch { /* best-effort */ }

  return { ok: true, buffer: d.buffer }
}
