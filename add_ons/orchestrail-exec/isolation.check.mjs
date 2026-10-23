// isolation.check.mjs - unit tests for the per-run bash isolation spec
//
// Exercises the PURE leaf (isolation.mjs: ISOLATION_DEFAULTS / shellQuote /
// buildBwrapArgv / buildIsolationSpec) with hand-crafted inputs. No bwrap
// invocation, no OS calls -- so it runs on any platform (including the Windows
// dev box). The LIVE isolation behavior (actual bwrap mounts, cross-run denial,
// out-of-run-dir write denial) is smoke-tested on the Linux deployment (Goldeye),
// not here.
//
// Follows the check.mjs pattern (standalone, no framework).
//
// Run:  node isolation.check.mjs

import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const { ISOLATION_DEFAULTS, shellQuote, buildBwrapArgv, buildIsolationSpec } = await import(
  pathToFileURL(path.join(here, 'isolation.mjs')).href
)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}
// Find the index of a flag and return the value(s) that follow it.
// n = number of value slots after the flag (1 for --tmpfs X, --dev X; 2 for --bind A B, --ro-bind A B).
function flagValue(argv, flag, n = 1) {
  const i = argv.indexOf(flag)
  if (i === -1) return null
  return n === 1 ? argv[i + 1] : argv.slice(i + 1, i + 1 + n)
}

const runDir = '/workbench/runA'
const workbenchRoot = '/workbench'

console.log('ISOLATION_DEFAULTS:')
ok(ISOLATION_DEFAULTS.bwrapBin === 'bwrap', 'default wrapper is bwrap')
ok(ISOLATION_DEFAULTS.bashBin === '/bin/bash', 'default bash bin is /bin/bash')
ok(ISOLATION_DEFAULTS.venvDir === '/opt/venv', 'default venv dir is /opt/venv')
ok(ISOLATION_DEFAULTS.cacheDir === '/cache', 'default cache dir is /cache')
ok(ISOLATION_DEFAULTS.tmpDir === '/tmp', 'default tmp dir is /tmp')
ok(ISOLATION_DEFAULTS.unshare.includes('pid'), 'unshares pid by default')
ok(ISOLATION_DEFAULTS.unshare.includes('uts'), 'unshares uts by default')
ok(ISOLATION_DEFAULTS.unshare.includes('ipc'), 'unshares ipc by default')
ok(!ISOLATION_DEFAULTS.unshare.includes('net'), 'does NOT unshare net by default (keep internet + iptables)')
ok(ISOLATION_DEFAULTS.unshare.includes('user'), 'unshares user by default (needed on Docker; drops container NET_ADMIN inside the sandbox)')

console.log('\nshellQuote:')
ok(shellQuote('/workbench/runA') === "'/workbench/runA'", 'quotes a plain path')
ok(shellQuote('a b') === "'a b'", 'quotes a path with spaces')
ok(shellQuote("it's") === "'it'\\''s'", 'escapes an embedded single quote')
ok(shellQuote("a'b'c") === "'a'\\''b'\\''c'", 'escapes multiple embedded single quotes')

console.log('\nbuildBwrapArgv - basic shape:')
const argv = buildBwrapArgv({ runDir, workbenchRoot, command: 'echo hi' })
ok(Array.isArray(argv), 'returns an array')
ok(argv[0] === '--ro-bind' && argv[1] === '/' && argv[2] === '/', 'whole FS is read-only (ro-bind / /) is the first mount')

console.log('\nbuildBwrapArgv - workbench hiding:')
ok(flagValue(argv, '--tmpfs') === workbenchRoot, 'workbench root is covered by a tmpfs (hides sibling run dirs)')
const tmpfsWbIdx = argv.indexOf(workbenchRoot)
const bindRunIdx = argv.indexOf(runDir)
ok(bindRunIdx !== -1 && argv[bindRunIdx - 1] === '--bind', 'run dir is bound (writable)')
ok(bindRunIdx > tmpfsWbIdx, 'run-dir bind is applied AFTER the workbench tmpfs (re-exposes the run dir)')
ok(flagValue(argv, '--bind', 2) && flagValue(argv, '--bind', 2)[0] === runDir, 'run-dir bind maps runDir -> runDir')

console.log('\nbuildBwrapArgv - shared tooling writable:')
ok(flagValue(argv, '--bind', 2) !== null, 'has bind mounts')
ok(argv.includes('/opt/venv') && argv[argv.indexOf('/opt/venv') - 1] === '--ro-bind', 'shared venv is READ-ONLY (no cross-run code planting)')
ok(argv.includes('--die-with-parent'), '--die-with-parent: killing bwrap tears down the sandbox (timeout safety)')
ok(argv.includes('--new-session'), '--new-session: no controlling terminal')
ok(argv.indexOf('--die-with-parent') < argv.indexOf('--'), 'die-with-parent comes before the command separator')
ok(argv.includes('/cache') && argv[argv.indexOf('/cache') - 1] === '--bind', 'cache is bound writable (install caching works)')

console.log('\nbuildBwrapArgv - tmp / dev / proc:')
ok(flagValue(argv, '--tmpfs') === workbenchRoot || argv.slice(argv.indexOf('/tmp') - 1, argv.indexOf('/tmp') + 1).join(' ') === '--tmpfs /tmp', '/tmp is a per-run tmpfs')
ok(argv[argv.indexOf('/tmp') - 1] === '--tmpfs', '/tmp is mounted with --tmpfs (writable, per-run)')
ok(argv[argv.indexOf('/dev') - 1] === '--dev', 'fresh /dev is mounted')
ok(argv[argv.indexOf('/proc') - 1] === '--proc', 'fresh /proc is mounted')

console.log('\nbuildBwrapArgv - namespaces:')
ok(argv.includes('--unshare-pid'), 'unshares pid')
ok(argv.includes('--unshare-uts'), 'unshares uts')
ok(argv.includes('--unshare-ipc'), 'unshares ipc')
ok(!argv.includes('--unshare-net'), 'does NOT unshare net (internet + iptables egress lockdown preserved)')
ok(argv.includes('--unshare-user'), 'unshares user')
ok(argv[argv.indexOf('--cap-drop') + 1] === 'ALL', 'drops all capabilities inside the sandbox')

console.log('\nbuildBwrapArgv - command wiring:')
const chdirIdx = argv.indexOf('--chdir')
ok(chdirIdx !== -1 && argv[chdirIdx + 1] === runDir, 'chdir to the run dir')
const sepIdx = argv.indexOf('--')
ok(sepIdx !== -1, 'has a -- separator before the command')
ok(sepIdx > chdirIdx, 'the -- separator comes after the mounts/chdir')
ok(argv[sepIdx + 1] === '/bin/bash', 'runs /bin/bash')
ok(argv[sepIdx + 2] === '-lc', 'with -lc (login shell)')
ok(argv[sepIdx + 3] === 'cd ' + shellQuote(runDir) + ' && ( echo hi )', 'wraps the command in `cd <runDir> && ( ... )`')
ok(argv[argv.length - 1] === 'cd ' + shellQuote(runDir) + ' && ( echo hi )', 'the wrapped command is the last argv element')

console.log('\nbuildBwrapArgv - empty command:')
const argvEmpty = buildBwrapArgv({ runDir, workbenchRoot, command: '' })
ok(argvEmpty[argvEmpty.length - 1] === 'cd ' + shellQuote(runDir) + ' && (  )', 'empty command still wraps (empty subshell)')

console.log('\nbuildBwrapArgv - runDir with special chars:')
const tricky = "/workbench/run'A b"
const argvTricky = buildBwrapArgv({ runDir: tricky, workbenchRoot, command: 'echo hi' })
ok(argvTricky[argvTricky.indexOf('--chdir') + 1] === tricky, 'chdir uses the raw runDir')
ok(argvTricky[argvTricky.length - 1].includes(shellQuote(tricky)), 'the wrapped command shell-quotes the tricky runDir')

console.log('\nbuildBwrapArgv - custom opts:')
const argv2 = buildBwrapArgv({ runDir, workbenchRoot, command: 'ls', opts: { venvDir: '/my/venv', cacheDir: '/my/cache', unshare: ['pid'] } })
ok(argv2.includes('/my/venv'), 'custom venv dir is used')
ok(argv2.includes('/my/cache'), 'custom cache dir is used')
ok(!argv2.includes('/opt/venv'), 'default venv dir is NOT used when overridden')
ok(argv2.includes('--unshare-pid'), 'custom unshare includes pid')
ok(!argv2.includes('--unshare-uts'), 'custom unshare does NOT include uts')
ok(!argv2.includes('--unshare-ipc'), 'custom unshare does NOT include ipc')

console.log('\nbuildIsolationSpec - basic:')
const spec = buildIsolationSpec({ runId: 'runA', runDir, workbenchRoot, command: 'echo hi', env: { FOO: 'bar' } })
ok(spec.wrapper === 'bwrap', 'wrapper is bwrap')
ok(Array.isArray(spec.argv) && spec.argv.length > 0, 'argv is a non-empty array')
ok(spec.cwd === runDir, 'cwd is the run dir')
ok(spec.env.HOME === runDir, 'env.HOME is the run dir')
ok(spec.env.RUN_ID === 'runA', 'env.RUN_ID is the runId')
ok(spec.env.FOO === 'bar', 'env inherits the passed base env')
ok(spec.env.PIP_CACHE_DIR === '/cache/pip', 'env.PIP_CACHE_DIR defaults to <cache>/pip')
ok(spec.env.npm_config_cache === '/cache/npm', 'env.npm_config_cache defaults to <cache>/npm')

console.log('\nbuildIsolationSpec - env overrides preserved:')
const spec2 = buildIsolationSpec({ runId: 'runB', runDir: '/workbench/runB', workbenchRoot, command: 'echo hi', env: { PIP_CACHE_DIR: '/custom/pip', npm_config_cache: '/custom/npm' } })
ok(spec2.env.PIP_CACHE_DIR === '/custom/pip', 'env.PIP_CACHE_DIR is preserved when set')
ok(spec2.env.npm_config_cache === '/custom/npm', 'env.npm_config_cache is preserved when set')
ok(spec2.env.HOME === '/workbench/runB', 'env.HOME is the (different) run dir')
ok(spec2.env.RUN_ID === 'runB', 'env.RUN_ID is the (different) runId')

console.log('\nbuildIsolationSpec - custom opts thread through:')
const spec3 = buildIsolationSpec({ runId: 'runC', runDir: '/workbench/runC', workbenchRoot, command: 'echo hi', opts: { bwrapBin: '/usr/bin/bwrap', unshare: [] } })
ok(spec3.wrapper === '/usr/bin/bwrap', 'custom wrapper is used')
ok(!spec3.argv.includes('--unshare-pid'), 'empty unshare list -> no unshare flags')


// -- Per-run pip installs (Claude review fixes) ----------------------------------
{
  const sp = buildIsolationSpec({ runId: 'r1', runDir: '/workbench/r1', workbenchRoot: '/workbench', command: 'true', env: { PATH: '/opt/venv/bin:/usr/bin', PYTHONPATH: '/x' } })
  ok(sp.env.PIP_TARGET === '/workbench/r1/.pylibs', 'pip installs go to the run dir (PIP_TARGET)')
  ok(sp.env.PYTHONPATH === '/workbench/r1/.pylibs:/x', 'run-local libs are first on PYTHONPATH, existing kept')
  ok(sp.env.PATH.startsWith('/workbench/r1/.pylibs/bin:') && sp.env.PATH.includes('/opt/venv/bin'), 'run-local bin first on PATH, venv kept')
}

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
