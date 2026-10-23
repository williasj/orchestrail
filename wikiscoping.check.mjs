// Verifies the AIWiki scoping-rule contract (E2) in the shipped WebUI: the
// "unbound sees everything but writes nothing" rule must be explicit in the UI
// so users understand the scoping. Follows the check.mjs pattern: a standalone
// assertion script, no test framework. Run after a build:
//   npm run build && node wikiscoping.check.mjs
//
// The scoping rule lives in two pure leaf functions in src/web/assets/app.js:
//   wikiScopeRule(project)     -> { bound, badge, rule, invariant }
//   renderWikiScopeLine(project) -> an HTML line (badge + rule + invariant)
// The rule: bound to project P -> agents read AND write only P's memory;
// unbound -> agents read all of the user's projects but write to none; and no
// agent ever sees another user's pages. app.js is a plain browser script (not a
// TS module), so it is loaded in a minimal Node sandbox and the functions under
// test are exercised directly -- testing the exact bytes that are served.

import path from 'node:path'
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const APP_JS = process.env.WIKISCOPING_APPJS || path.join(here, 'dist', 'web', 'assets', 'app.js')

if (!fs.existsSync(APP_JS)) {
  console.error('  FAIL  app.js not found at ' + APP_JS + ' -- run `npm run build` first')
  process.exit(1)
}

const src = fs.readFileSync(APP_JS, 'utf8')

// Minimal browser-ish sandbox so the plain-script app.js can load in Node. The
// only top-level side effects are localStorage.getItem (auth state) and
// window.onload = fn; both are stubbed. All DOM calls live inside functions we
// never invoke. JS built-ins (String/Object/Array/...) are provided by the
// fresh vm context.
const sandbox = {
  console,
  localStorage: {
    _s: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null },
    setItem(k, v) { this._s[k] = String(v) },
    removeItem(k) { delete this._s[k] },
  },
  window: {},
  document: {
    getElementById() { return null },
    querySelector() { return null },
    querySelectorAll() { return [] },
    createElement() { return { style: {}, addEventListener() {}, appendChild() {} } },
    addEventListener() {},
  },
  fetch() { return Promise.reject(new Error('no fetch in check')) },
}
vm.createContext(sandbox)

let loaded
try {
  vm.runInContext(src + '\n;globalThis.__orc = { wikiScopeRule, renderWikiScopeLine, esc };', sandbox)
  loaded = sandbox.__orc
} catch (e) {
  console.error('  FAIL  could not load app.js in sandbox: ' + (e && e.message))
  process.exit(1)
}

const { wikiScopeRule, renderWikiScopeLine, esc } = loaded
if (typeof wikiScopeRule !== 'function' || typeof renderWikiScopeLine !== 'function') {
  console.error('  FAIL  wikiScopeRule / renderWikiScopeLine not found in app.js')
  process.exit(1)
}

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}

const INVARIANT = 'Agents never see another user\'s pages.'

// -- Unbound: sees everything, writes nothing ---------------------------------

console.log('unbound (no project bound):')
{
  const r = wikiScopeRule(null)
  ok(r.bound === false, 'bound is false for null', JSON.stringify(r))
  ok(r.badge === 'Unbound', 'badge is "Unbound"', r.badge)
  ok(/read all/.test(r.rule), 'rule says agents can read all projects', r.rule)
  ok(/write to none/.test(r.rule), 'rule says agents write to none', r.rule)
  ok(r.invariant === INVARIANT, 'invariant (per-user boundary) present', r.invariant)

  // empty string is treated as unbound too (falsy)
  const rEmpty = wikiScopeRule('')
  ok(rEmpty.bound === false, 'empty-string project is unbound', JSON.stringify(rEmpty))
  ok(rEmpty.badge === 'Unbound', 'empty-string badge is "Unbound"', rEmpty.badge)
}

// -- Bound: read AND write only that project ----------------------------------

console.log('bound to a project:')
{
  const r = wikiScopeRule('myproj')
  ok(r.bound === true, 'bound is true for a project', JSON.stringify(r))
  ok(r.badge === 'Bound: myproj', 'badge names the bound project', r.badge)
  ok(/read and write only/.test(r.rule), 'rule says agents read AND write only that project', r.rule)
  ok(r.rule.includes('myproj'), 'rule names the bound project', r.rule)
  ok(/hidden/.test(r.rule), 'rule says other projects are hidden', r.rule)
  ok(r.invariant === INVARIANT, 'invariant present', r.invariant)

  // a slug with dashes
  const rDash = wikiScopeRule('my-proj-2')
  ok(rDash.bound === true, 'dashed slug is bound', JSON.stringify(rDash))
  ok(rDash.badge === 'Bound: my-proj-2', 'badge names the dashed slug', rDash.badge)
  ok(rDash.rule.includes('my-proj-2'), 'rule names the dashed slug', rDash.rule)
}

// -- Rendered HTML: structure -------------------------------------------------

console.log('rendered HTML line (structure):')
{
  const out = renderWikiScopeLine('myproj')
  ok(out.includes('wiki-scope-bound'), 'bound badge uses the bound class', out)
  ok(!out.includes('wiki-scope-unbound'), 'no unbound class when bound', out)
  ok(out.includes('Bound: myproj'), 'bound badge text present', out)
  ok(out.includes('read and write only'), 'bound rule text present', out)
  ok(out.includes(INVARIANT), 'invariant rendered', out)
  ok((out.match(/<span /g) || []).length === 3, 'exactly three spans (badge, rule, invariant)', out)
  ok(/class="wiki-scope-rule"/.test(out), 'rule span has its class', out)
  ok(/class="wiki-scope-inv"/.test(out), 'invariant span has its class', out)

  const outU = renderWikiScopeLine(null)
  ok(outU.includes('wiki-scope-unbound'), 'unbound badge uses the unbound class', outU)
  ok(!outU.includes('wiki-scope-bound'), 'no bound class when unbound', outU)
  ok(outU.includes('Unbound'), 'unbound badge text present', outU)
  ok(outU.includes(INVARIANT), 'invariant rendered when unbound', outU)
}

// -- HTML escaping (no injection via a hostile project name) ------------------

console.log('HTML escaping (hostile project name):')
{
  const hostile = '<script>alert(1)</script>'
  const out = renderWikiScopeLine(hostile)
  ok(out.includes(esc(hostile)), 'project name is escaped in the badge', out)
  ok(!out.includes('<script>alert'), 'no live <script> injected', out)
  ok(out.includes(INVARIANT), 'invariant still present', out)

  const r = wikiScopeRule(hostile)
  ok(r.bound === true, 'hostile name still counts as bound (it is a value, not markup)', JSON.stringify(r))
  ok(r.badge === 'Bound: ' + hostile, 'badge carries the raw value for data use', r.badge)
}

// -- Invariant is always shown regardless of binding --------------------------

console.log('invariant is binding-independent:')
{
  ok(renderWikiScopeLine(null).includes(INVARIANT), 'invariant shown when unbound')
  ok(renderWikiScopeLine('a').includes(INVARIANT), 'invariant shown when bound to "a"')
  ok(wikiScopeRule('b').invariant === INVARIANT, 'invariant stable for bound "b"')
  ok(wikiScopeRule(null).invariant === INVARIANT, 'invariant stable for unbound')
}

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
