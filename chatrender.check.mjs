// Verifies the per-stage detail-block rendering contract in the shipped WebUI
// (renderChatContent in src/web/assets/app.js). Follows the check.mjs pattern: a
// standalone assertion script, no test framework. Run after a build:
//   npm run build && node chatrender.check.mjs
//
// It unit-tests the pure rendering logic behind item 18 (D3 / I3: "per-stage
// detail blocks sometimes render empty in chat"). The bug: each <details> block
// is flattened into a single-line placeholder, but the stage body is multi-line,
// so the placeholder was split across lines by the line loop and the body
// rendered empty (with the content leaking out as plain text and a literal
// __END__ marker). The assertions confirm a multi-line body now renders
// populated, with newlines preserved, no sentinel leakage, and no HTML
// injection. app.js is a plain browser script (not a TS module), so it is
// loaded in a minimal Node sandbox and the function under test is exercised
// directly -- testing the exact bytes that are served.

import path from 'node:path'
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const APP_JS = process.env.CHATRENDER_APPJS || path.join(here, 'dist', 'web', 'assets', 'app.js')

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
  vm.runInContext(src + '\n;globalThis.__orc = { renderChatContent, esc, inlineFormat };', sandbox)
  loaded = sandbox.__orc
} catch (e) {
  console.error('  FAIL  could not load app.js in sandbox: ' + (e && e.message))
  process.exit(1)
}

const { renderChatContent, esc, inlineFormat } = loaded
if (typeof renderChatContent !== 'function') {
  console.error('  FAIL  renderChatContent not found in app.js')
  process.exit(1)
}

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}

function noSentinelLeak(s) {
  return !s.includes('__DET__') && !s.includes('__SEP__') &&
         !s.includes('__END__') && !s.includes('__NL__')
}

// -- Core bug: multi-line body must render populated --------------------------

console.log('multi-line detail body (the item 18 bug):')
{
  const input = 'Intro text\n' +
    '<details>\n' +
    '<summary>architect — Design</summary>\n' +
    '\n' +
    'Line A\n' +
    'Line B\n' +
    'Line C\n' +
    '</details>\n' +
    'Outro text'
  const out = renderChatContent(input, false)

  ok(out.includes('<div class="detail-body">Line A\nLine B\nLine C</div>'),
    'multi-line body renders populated with newlines preserved', out)
  ok(out.includes('<summary>architect — Design</summary>'),
    'summary preserved', out)
  ok(out.includes('<span>Intro text</span>'), 'text before the block preserved', out)
  ok(out.includes('<span>Outro text</span>'), 'text after the block preserved', out)
  ok(noSentinelLeak(out), 'no sentinel markers leak into output', out)
  ok((out.match(/<details>/g) || []).length === 1, 'exactly one <details> open tag', out)
  ok((out.match(/<\/details>/g) || []).length === 1, 'exactly one </details> close tag', out)
}

// -- Realistic backend format (completions.ts chunk shape) --------------------

console.log('realistic backend chunk format:')
{
  // Matches completions.ts: \n<details>\n<summary>X — Y</summary>\n\n<output>\n\n</details>\n
  const output = 'function add(a,b){\n  return a+b;\n}'
  const input = '\n<details>\n<summary>senior-engineer — Implement</summary>\n\n' + output + '\n\n</details>\n'
  const out = renderChatContent(input, false)

  ok(out.includes('<div class="detail-body">function add(a,b){\n  return a+b;\n}</div>'),
    'code-style multi-line body preserved verbatim (pre-wrap)', out)
  ok(out.includes('<summary>senior-engineer — Implement</summary>'),
    'assignee — stage summary preserved', out)
  ok(noSentinelLeak(out), 'no sentinel markers leak', out)
}

// -- Regression: single-line body still works ---------------------------------

console.log('single-line detail body (regression):')
{
  const input = '<details>\n<summary>test-engineer — Run</summary>\n\nall 23 tests passed\n</details>'
  const out = renderChatContent(input, false)
  ok(out.includes('<div class="detail-body">all 23 tests passed</div>'),
    'single-line body populated', out)
  ok(out.includes('<summary>test-engineer — Run</summary>'), 'summary populated', out)
  ok(noSentinelLeak(out), 'no sentinel markers leak', out)
}

// -- Multiple detail blocks ---------------------------------------------------

console.log('multiple detail blocks:')
{
  const input = '<details>\n<summary>stage 1</summary>\n\nbodyA\n</details>\n' +
                '<details>\n<summary>stage 2</summary>\n\nbodyB\n</details>'
  const out = renderChatContent(input, false)
  ok((out.match(/<details>/g) || []).length === 2, 'two <details> blocks', out)
  ok(out.includes('<div class="detail-body">bodyA</div>'), 'first body populated', out)
  ok(out.includes('<div class="detail-body">bodyB</div>'), 'second body populated', out)
  ok(noSentinelLeak(out), 'no sentinel markers leak', out)
}

// -- HTML escaping (no injection) ---------------------------------------------

console.log('HTML escaping in detail body:')
{
  const input = '<details>\n<summary>s</summary>\n\n<script>alert(1)</script>\n</details>'
  const out = renderChatContent(input, false)
  ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'),
    'body HTML is escaped (rendered as text)', out)
  ok(!out.includes('<script>alert'), 'no live <script> injected', out)
  ok(noSentinelLeak(out), 'no sentinel markers leak', out)
}

// -- Trailing text on the same line as </details> -----------------------------

console.log('text on the same line after </details>:')
{
  const input = '<details>\n<summary>s</summary>\n\nbody</details> trailing'
  const out = renderChatContent(input, false)
  ok(out.includes('<div class="detail-body">body</div>'), 'body populated', out)
  ok(out.includes('trailing'), 'same-line trailing text rendered', out)
  ok(noSentinelLeak(out), 'no sentinel markers leak', out)
}

// -- CRLF line endings in the body --------------------------------------------

console.log('CRLF line endings in body:')
{
  const input = '<details>\n<summary>s</summary>\n\nline1\r\nline2\r\nline3\n</details>'
  const out = renderChatContent(input, false)
  ok(out.includes('<div class="detail-body">line1\nline2\nline3</div>'),
    'CRLF normalized to LF in the body', out)
  ok(noSentinelLeak(out), 'no sentinel markers leak', out)
}

// -- User messages are escaped, not detail-parsed (regression) ----------------

console.log('user message path (isUser=true):')
{
  const input = 'hello <b>world</b>'
  const out = renderChatContent(input, true)
  ok(out === esc(input), 'user content is escaped verbatim, no detail parsing', out)
}

// -- inlineFormat / esc sanity (helpers the renderer depends on) --------------

console.log('helper sanity:')
{
  ok(esc('<a>') === '&lt;a&gt;', 'esc escapes angle brackets', esc('<a>'))
  ok(inlineFormat('**bold**').includes('<strong>bold</strong>'),
    'inlineFormat bold', inlineFormat('**bold**'))
}

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
