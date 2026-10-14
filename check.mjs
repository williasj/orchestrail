// Defaults target the running container: /data is the bind mount, /app/dist the build.
process.env.BT_DATA_DIR = process.env.BT_DATA_DIR || '/data/bullettrain'
const STORE = process.env.BT_STORE || '/app/dist/bullettrain/store.js'

const store = await import(STORE)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}

const projects = store.listProjects()
console.log('listProjects: ' + projects.length + ' project(s)')
ok(projects.length === 3, 'three projects discovered')

const expect = {
  'bt-fixture-done':    { run: '001', state: 'done',    total: 3, verified: 3, marks: 'xxx' },
  'bt-fixture-halted':  { run: '002', state: 'halted',  total: 6, verified: 1, marks: 'x>!? -' },
  'bt-fixture-running': { run: '001', state: 'running', total: 4, verified: 1, marks: 'x>  ' },
}

for (const p of projects.sort((a, b) => a.slug.localeCompare(b.slug))) {
  const e = expect[p.slug]
  console.log('\n' + p.slug + '  "' + p.title + '"')
  ok(!!e, 'slug is an expected fixture')
  if (!e) continue

  const runNo = p.current_run || p.last_run
  ok(runNo === e.run, 'run number is ' + e.run, 'got ' + runNo)
  ok(store.statusExists(p.slug, runNo), 'status.json exists')

  const st = store.readStatus(p.slug, runNo)
  ok(st.schema === 1, 'schema is 1')
  ok(st.state === e.state, 'state is ' + e.state, 'got ' + st.state)
  ok(st.slug === p.slug && st.run === runNo, 'status slug/run agree with project.json')
  ok(st.counters.tasks_total === e.total, 'counters.tasks_total is ' + e.total, 'got ' + st.counters.tasks_total)
  ok(st.counters.tasks_verified === e.verified, 'counters.tasks_verified is ' + e.verified, 'got ' + st.counters.tasks_verified)

  // runtime must round-trip as a full BTRuntime, or the supervisor would read defaults
  const rt = store.readRuntime(p.slug)
  ok(rt.model === 'qwen3-coder-next:iq3', 'RUNTIME.md model parsed', rt.model)
  ok(rt.exec_timeout_ms === 300000, 'RUNTIME.md exec_timeout_ms parsed', String(rt.exec_timeout_ms))
  ok(typeof rt.num_ctx === 'number' && rt.num_ctx === 65536, 'RUNTIME.md numerics are numbers', String(rt.num_ctx))
  ok(st.runtime && st.runtime.model === rt.model, 'status.runtime matches RUNTIME.md')

  const tasks = store.readTasks(p.slug, runNo)
  ok(tasks.length === e.total, 'parseTasksMd returned ' + e.total + ' tasks', 'got ' + tasks.length)
  ok(tasks.map(t => t.mark).join('') === e.marks, 'task marks are [' + e.marks + ']', '[' + tasks.map(t => t.mark).join('') + ']')
  ok(tasks.every(t => /^\d{3}$/.test(t.id)), 'every task id is 3 digits')
  ok(tasks.every(t => t.verify.length > 0), 'every task has a verify command')

  // counters must agree with the marks, or the header lies about the list below it
  const verifiedMarks = tasks.filter(t => t.mark === 'x').length
  ok(verifiedMarks === st.counters.tasks_verified, 'verified marks match counters', verifiedMarks + ' vs ' + st.counters.tasks_verified)

  // the exact round-trip: re-render what we parsed, compare to what is on disk
  const fsmod = await import('node:fs')
  const onDisk = fsmod.readFileSync(store.runDir(p.slug, runNo) + '/tasks.md', 'utf8')
  ok(store.renderTasksMd(tasks) === onDisk, 'tasks.md round-trips through parse/render byte-for-byte')

  const sessions = store.listSessionRecords(p.slug, runNo)
  ok(sessions.length > 0, 'session records load (' + sessions.length + ')')
  ok(sessions.every(s => typeof s.n === 'number' && s.end_reason), 'session records well-formed')
  const ns = sessions.map(s => s.n)
  ok(ns.join(',') === [...ns].sort((a, b) => a - b).join(','), 'sessions sort ascending', ns.join(','))

  const zip = store.readDeliverableZip(p.slug, runNo)
  if (e.state === 'done') {
    ok(zip !== null && zip.length > 0, 'deliverable.zip present for done run')
    ok(zip && zip[0] === 0x50 && zip[1] === 0x4b, 'deliverable.zip has PK magic bytes')
  } else {
    ok(zip === null, 'no deliverable.zip for non-done run')
  }

  if (e.state === 'halted') {
    ok(st.halt_reason === 'all_blocked', 'halt_reason set', String(st.halt_reason))
    const blocked = tasks.find(t => t.mark === '!')
    ok(!!(blocked && blocked.error), 'blocked task carries an error line')
    ok(!!(blocked && blocked.attempts === 3), 'blocked task shows 3 attempts')
  }
  if (e.state === 'running') {
    ok(p.current_run === runNo, 'current_run set so the UI polls')
  } else {
    ok(p.current_run === null, 'current_run null so Start run is enabled')
  }
}

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
