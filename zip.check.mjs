// Verifies the BulletTrain deliverable-packaging contract
// (see src/bullettrain/zip.ts). Follows the check.mjs pattern: a standalone
// assertion script, no test framework. Run after a build:
//   npm run build && node zip.check.mjs
//
// Item 14 sub-part 4: the deliverable is the WHOLE run workbench, packaged via
// the exec sidecar's GET /deliver endpoint (up to DELIVER_MAX_BYTES) instead of
// base64-to-stdout (which the 1 MiB stdout cap silently truncated). This
// unit-tests the pure, side-effect-free parts of that change:
//   (1) buildPackageCommand -- the bash command zips the workbench into a
//       transient dotfile, excludes .git and the zip itself, checks for `zip`,
//       and no longer base64s to stdout;
//   (2) decidePackaging -- what each I/O outcome (bash exit / /deliver HTTP
//       status) means, including the new clean 413 "too large" failure that
//       replaces the old silent truncation.
// The I/O itself (btBash + btDeliverFile) needs a live exec sidecar and is
// verified by the tsc build + code review, per the repo's check-script policy.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const MODULE = process.env.ZIP_MODULE || path.join(here, 'dist', 'bullettrain', 'zip.js')

const { buildPackageCommand, decidePackaging, BT_DELIVERABLE_ZIP_NAME } =
  await import(pathToFileURL(MODULE).href)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}

// -- buildPackageCommand -----------------------------------------------------------

console.log('buildPackageCommand:')
{
  const cmd = buildPackageCommand()
  ok(cmd.includes('command -v zip'), 'checks that `zip` is installed')
  ok(cmd.includes('exit 3'), 'exits 3 when `zip` is missing (distinct failure mode)')
  ok(cmd.includes('ZIP_MISSING'), 'marks the zip-missing case for the caller')
  ok(cmd.startsWith('set -e;'), 'uses set -e so a failing zip stops the command')
  ok(cmd.includes('zip -rq /tmp/'), 'stages the archive in /tmp (outside the workbench -> never zips into itself)', cmd)
  ok(cmd.includes("zip -rq"), 'invokes zip recursively + quietly')
  ok(cmd.includes("-x '.git/*'"), 'excludes .git from the archive')
  ok(cmd.includes(`cp /tmp/bt-deliverable.zip ./${BT_DELIVERABLE_ZIP_NAME}`), 'copies the staged archive into the workbench root for /deliver', cmd)
  ok(cmd.includes(`rm -f ./${BT_DELIVERABLE_ZIP_NAME}`), 'removes a stale workbench copy before zipping (per-project shared workbench)')
  ok(!cmd.includes('base64'), 'no longer base64s to stdout (the old truncation-prone path)')

  // a per-run temp name avoids /tmp collisions between concurrently-packaging projects
  const withRun = buildPackageCommand(BT_DELIVERABLE_ZIP_NAME, 'bt-myproj')
  ok(withRun.includes('/tmp/bt-deliverable-bt-myproj.zip'), 'per-run temp name threaded through the /tmp staging path', withRun)

  // a custom dotfile name is threaded through the workbench copy target + stale-rm
  const custom = buildPackageCommand('foo.zip')
  ok(custom.includes('cp /tmp/bt-deliverable.zip ./foo.zip') && custom.includes('rm -f ./foo.zip'), 'custom zip name threaded through copy target + stale-rm', custom)
}

// -- decidePackaging: bash failures ------------------------------------------------

console.log('\ndecidePackaging (bash failures):')
{
  const missing = decidePackaging({ bashExit: 3, bashStderr: 'ZIP_MISSING', deliverStatus: null })
  ok(missing.kind === 'error' && /zip.*not installed/i.test(missing.message), 'exit 3 -> zip-not-installed error', JSON.stringify(missing))

  const missingByStderr = decidePackaging({ bashExit: 1, bashStderr: 'ZIP_MISSING', deliverStatus: null })
  ok(missingByStderr.kind === 'error' && /zip.*not installed/i.test(missingByStderr.message), 'ZIP_MISSING on stderr -> zip-not-installed error')

  const failed = decidePackaging({ bashExit: 12, bashStderr: 'boom: disk full', deliverStatus: null })
  ok(failed.kind === 'error' && /zip packaging failed \(exit 12\)/.test(failed.message), 'non-zero exit -> zip-failed error with exit code', JSON.stringify(failed))
  ok(/disk full/.test(failed.message), 'zip-failed error surfaces the stderr')

  // precedence: a bash failure is reported even if /deliver would have succeeded
  const prec = decidePackaging({ bashExit: 1, bashStderr: 'x', deliverStatus: 200, bytes: 10 })
  ok(prec.kind === 'error' && /zip packaging failed/.test(prec.message), 'bash failure takes precedence over a 200 /deliver', JSON.stringify(prec))
}

// -- decidePackaging: /deliver outcomes (bash succeeded) ---------------------------

console.log('\ndecidePackaging (/deliver outcomes):')
{
  const okRes = decidePackaging({ bashExit: 0, bashStderr: '', deliverStatus: 200, bytes: 12345 })
  ok(okRes.kind === 'ok', '200 -> ok', JSON.stringify(okRes))

  const tooLarge = decidePackaging({ bashExit: 0, bashStderr: '', deliverStatus: 413, deliverErrorBody: '{"error":"file too large: 60000000 bytes (max 52428800)"}' })
  ok(tooLarge.kind === 'error' && /too large/i.test(tooLarge.message), '413 -> clean "too large" error (replaces silent truncation)', JSON.stringify(tooLarge))
  ok(/DELIVER_MAX_BYTES/.test(tooLarge.message), '413 error names the DELIVER_MAX_BYTES cap to raise')

  const notFound = decidePackaging({ bashExit: 0, bashStderr: '', deliverStatus: 404, deliverErrorBody: '{"error":"file not found: .bt-deliverable.zip"}' })
  ok(notFound.kind === 'error' && /HTTP 404/.test(notFound.message), '404 -> fetch-failed HTTP 404', JSON.stringify(notFound))

  const serverErr = decidePackaging({ bashExit: 0, bashStderr: '', deliverStatus: 500, deliverErrorBody: 'internal error' })
  ok(serverErr.kind === 'error' && /HTTP 500/.test(serverErr.message) && /internal error/.test(serverErr.message), '500 -> fetch-failed HTTP 500 with body', JSON.stringify(serverErr))

  const noResponse = decidePackaging({ bashExit: 0, bashStderr: '', deliverStatus: null })
  ok(noResponse.kind === 'error' && /no response from exec \/deliver/.test(noResponse.message), 'null status, no error -> "no response" fetch failure', JSON.stringify(noResponse))

  const transport = decidePackaging({ bashExit: 0, bashStderr: '', deliverStatus: null, fetchError: 'fetch failed: ECONNREFUSED' })
  ok(transport.kind === 'error' && /ECONNREFUSED/.test(transport.message), 'transport error -> fetch-failed with the error', JSON.stringify(transport))
}

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
