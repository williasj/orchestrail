// isolation.mjs - per-run bash isolation spec for the orchestrail-exec sandbox
//
// Computes the bubblewrap (bwrap) invocation that confines a run's bash calls to
// its own run dir. The model:
//   - the whole filesystem is mounted READ-ONLY, so any write outside the run
//     dir is a permission error (not just a lexical check);
//   - the workbench root is covered by an empty tmpfs, so SIBLING run dirs are
//     invisible (cross-run access is a permission error, not a path-validation
//     guess);
//   - only this run's dir is re-exposed, writable (the run's private workspace);
//   - the shared tooling (Python venv, dependency caches) and /tmp are writable
//     so pip/npm/go/cargo installs keep working (a read-only cache would break
//     the bash tool's documented install capability);
//   - pid/uts/ipc namespaces are unshared (defense-in-depth); net is NOT
//     unshared (the egress lockdown is iptables in the container netns, and
//     unsharing net would drop the internet and break installs); user is NOT
//     unshared (the server runs as root, so user-namespace mapping is
//     unnecessary complexity).
//
// This is a PURE leaf: it computes the wrapper / argv / mounts / env / cwd with
// no I/O and no OS calls, so it is unit-testable on any platform (see
// isolation.check.mjs). The actual bwrap invocation is thin wiring in
// server.mjs (Linux-only; the live isolation behavior is smoke-tested on the
// Linux deployment, not the Windows dev box).
//
// Kept dependency-free (node: builtins only). All source ASCII-only on purpose
// (on-disk / on-wire program text).

// Default isolation parameters. Overridable per call (see buildBwrapArgv /
// buildIsolationSpec `opts`) so the live mount list can be tuned on the
// deployment without changing the leaf's logic.
export const ISOLATION_DEFAULTS = {
  bwrapBin: 'bwrap',
  bashBin: '/bin/bash',
  venvDir: '/opt/venv',
  cacheDir: '/cache',
  tmpDir: '/tmp',
  devDir: '/dev',
  procDir: '/proc',
  // Namespaces to unshare. Deliberately EXCLUDES:
  //   net  - the egress lockdown is iptables in the container netns; unsharing
  //           net would drop the internet and break pip/npm installs.
  //   user - the server runs as root; adding user-namespace UID mapping is
  //           unnecessary complexity (and can break setuid binaries).
  // 'user' is required on Docker/TrueNAS (pivot_root is refused otherwise) and
  // also means sandboxed commands lose the container's NET_ADMIN, so they cannot
  // flush the iptables egress lockdown. Verified on Goldeye 2026-10-23.
  unshare: ['user', 'pid', 'uts', 'ipc'],
}

// Single-quote a string for safe inclusion in a bash command. Mirrors the
// server's original shellQuote (moved here so the wrapping is testable).
export function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

// Build the full bwrap argv for a run's bash call.
//
// args:
//   runDir        - absolute path to the run's workbench dir (the writable
//                   workspace). Must be under workbenchRoot.
//   workbenchRoot - absolute path to the workbench root (parent of all run
//                   dirs); covered by a tmpfs so sibling run dirs are hidden.
//   command       - the raw bash command to run (wrapped in `cd <runDir> && ( ... )`).
//   opts          - optional overrides for ISOLATION_DEFAULTS.
//
// Returns: string[] - the full bwrap argv, including the command.
export function buildBwrapArgv({ runDir, workbenchRoot, command, opts = {} }) {
  const o = { ...ISOLATION_DEFAULTS, ...opts }
  const wrapped = 'cd ' + shellQuote(runDir) + ' && ( ' + command + ' )'
  const argv = [
    // 1) Whole filesystem read-only: out-of-run-dir writes are a permission error.
    '--ro-bind', '/', '/',
    // 2) Hide the workbench root (and thus every sibling run dir) with an empty
    //    tmpfs. Applied BEFORE the run-dir bind so the run dir re-exposes on top.
    '--tmpfs', workbenchRoot,
    // 3) Re-expose only this run's dir, writable (the run's private workspace).
    //    The source is resolved on the host, so this is the real run dir even
    //    though the sandbox's workbench root is now a tmpfs.
    '--bind', runDir, runDir,
    // 4) Shared tooling stays writable so pip/npm/go/cargo installs work.
    // Shared venv is READ-ONLY: a writable venv lets one run plant code (e.g.
    // sitecustomize.py) that executes in every later run. Per-run installs go to
    // <runDir>/.pylibs via PIP_TARGET + PYTHONPATH (see buildIsolationSpec).
    '--ro-bind', o.venvDir, o.venvDir,
    '--bind', o.cacheDir, o.cacheDir,
    // 5) Per-run writable /tmp (tools write temp files here; not shared across runs).
    '--tmpfs', o.tmpDir,
    // 6) Fresh /dev and /proc (needed by many tools; /proc matches the unshared
    //    pid namespace).
    '--dev', o.devDir,
    '--proc', o.procDir,
  ]
  for (const ns of o.unshare) argv.push('--unshare-' + ns)
  // --die-with-parent: if the server kills bwrap (timeout), the sandbox's init
  // gets SIGKILL and the kernel tears down the whole pid namespace, so no
  // orphaned command keeps running or holds the output pipes open.
  // --new-session: no controlling terminal (blocks TIOCSTI injection).
  // --cap-drop ALL: no capabilities inside the sandbox at all.
  argv.push('--cap-drop', 'ALL', '--die-with-parent', '--new-session')
  argv.push('--chdir', runDir, '--', o.bashBin, '-lc', wrapped)
  return argv
}

// Build the full isolation spec (wrapper, argv, env, cwd) for a run's bash call.
//
// args:
//   runId         - the run's id (a simple token; validated upstream by RUNID_RE).
//   runDir        - absolute path to the run's workbench dir.
//   workbenchRoot - absolute path to the workbench root.
//   command       - the raw bash command to run.
//   env           - the base environment (typically process.env); merged with the
//                   run-specific vars below.
//   opts          - optional overrides for ISOLATION_DEFAULTS.
//
// Returns: { wrapper, argv, env, cwd } - ready for spawn(wrapper, argv, { cwd, env }).
export function buildIsolationSpec({ runId, runDir, workbenchRoot, command, env = {}, opts = {} }) {
  const o = { ...ISOLATION_DEFAULTS, ...opts }
  const argv = buildBwrapArgv({ runDir, workbenchRoot, command, opts })
  const specEnv = {
    ...env,
    HOME: runDir,
    RUN_ID: runId,
    PIP_CACHE_DIR: env.PIP_CACHE_DIR || (o.cacheDir + '/pip'),
    npm_config_cache: env.npm_config_cache || (o.cacheDir + '/npm'),
    PIP_TARGET: runDir + '/.pylibs',
    PYTHONPATH: runDir + '/.pylibs' + (env.PYTHONPATH ? ':' + env.PYTHONPATH : ''),
    PATH: runDir + '/.pylibs/bin:' + (env.PATH || '/usr/local/bin:/usr/bin:/bin'),
  }
  return {
    wrapper: o.bwrapBin,
    argv,
    env: specEnv,
    cwd: runDir,
  }
}
