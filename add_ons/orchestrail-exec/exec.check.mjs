// exec.check.mjs - adversarial isolation tests for the orchestrail-exec sandbox
//
// Exercises pathsafety.safePath / RUNID_RE the way an untrusted agent would try
// to break out of its run dir: ../ traversal, absolute paths, cross-run access,
// and symlink escapes. Follows the check.mjs pattern (standalone, no framework).
//
// Run:  node exec.check.mjs
//
// The file tools are the enforced surface; the bash tool is intentionally NOT
// tested here (it is unconstrained within the container -- see server.mjs header
// and the OS-level per-run isolation follow-on).

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// Point the module at a throwaway workbench BEFORE it is imported (it reads
// WORKBENCH_ROOT at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-check-'))
process.env.WORKBENCH_ROOT = tmp

const { RUNID_RE, runDir, safePath } = await import(
  pathToFileURL(path.join(here, 'pathsafety.mjs')).href
)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}
function throws(fn, label) {
  try { fn(); fail++; console.log('  FAIL  ' + label + '  -> did not throw') }
  catch { console.log('  PASS  ' + label) }
}

// -- Fixture: two runs, one with a secret the other must not reach --------------
const runA = path.join(tmp, 'runA')
const runB = path.join(tmp, 'runB')
fs.mkdirSync(runA, { recursive: true })
fs.mkdirSync(runB, { recursive: true })
fs.writeFileSync(path.join(runB, 'secret.txt'), 'top-secret\n')
fs.writeFileSync(path.join(runA, 'ok.txt'), 'hello\n')

console.log('runId validation (RUNID_RE):')
ok(RUNID_RE.test('runA'), 'plain runId accepted')
ok(RUNID_RE.test('abc-123_456'), 'uuid-like runId accepted')
ok(!RUNID_RE.test('../evil'), 'runId containing ../ rejected')
ok(!RUNID_RE.test('a/b'), 'runId containing a slash rejected')
ok(!RUNID_RE.test(''), 'empty runId rejected')
ok(!RUNID_RE.test('x'.repeat(129)), 'over-long runId rejected')

console.log('\nsafePath - normal access:')
ok(safePath('runA', 'main.py') === path.join(runA, 'main.py'), 'relative path resolves inside the run dir')
ok(safePath('runA', 'ok.txt') === path.join(runA, 'ok.txt'), 'existing file in the run dir is allowed')
ok(safePath('runA', undefined) === runA, 'undefined path resolves to the run dir root')
ok(safePath('runA', '.') === runA, 'dot path resolves to the run dir root')
ok(safePath('runA', 'src/new/file.txt') === path.join(runA, 'src', 'new', 'file.txt'),
   'non-existent nested path is allowed (write_file creates it)')

console.log('\nsafePath - traversal / absolute:')
throws(() => safePath('runA', '../runB/secret.txt'), '../ traversal to sibling run blocked')
throws(() => safePath('runA', '../../etc/passwd'), 'deep ../ traversal blocked')
throws(() => safePath('runA', '/etc/passwd'), 'absolute path blocked')
throws(() => safePath('runA', '/workbench/runB/secret.txt'), 'absolute sibling-run path blocked')

console.log('\nsafePath - cross-run by name:')
throws(() => safePath('runA', '../runB'), 'naming a sibling run dir is blocked')

console.log('\nsafePath - symlink escape:')
// Plant a directory link the way an untrusted agent's `ln -s` would. On Windows
// a real symlink needs elevation, but a *junction* does not -- and realpath
// follows junctions exactly as it follows symlinks, so the test is equivalent.
function makeDirLink(target, linkPath) {
  try { fs.symlinkSync(target, linkPath, 'junction'); return true } catch {}
  try { fs.symlinkSync(target, linkPath); return true } catch {}
  return false
}

if (makeDirLink(runB, path.join(runA, 'evil'))) {   // evil -> runB (sibling run)
  throws(() => safePath('runA', 'evil/secret.txt'), 'reading through a planted link is blocked')
  throws(() => safePath('runA', 'evil'), 'following a planted link to a dir is blocked')
  // `evil/..` is consumed LEXICALLY by path.resolve before any symlink is
  // followed, so it resolves to the run root -- safe, and must NOT be blocked.
  ok(safePath('runA', 'evil/..') === runA, 'link + ../ resolves to the run root (.. is lexical, not a symlink climb)')
} else {
  console.log('  SKIP  escape tests (this OS refused dir-link creation; run on Linux for full coverage)')
}

// A link that stays INSIDE the run dir must still be allowed (no false positive).
const realdir = path.join(runA, 'realdir')
fs.mkdirSync(realdir, { recursive: true })
fs.writeFileSync(path.join(realdir, 'inner.txt'), 'in\n')
if (makeDirLink(realdir, path.join(runA, 'inner'))) {
  ok(safePath('runA', 'inner/inner.txt') === path.join(runA, 'inner', 'inner.txt'),
     'a link that stays inside the run dir is allowed')
} else {
  console.log('  SKIP  inside-link test (this OS refused dir-link creation)')
}

console.log('\nrunDir:')
ok(runDir('runA') === runA, 'runDir maps runId under the workbench root')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
