// Verifies the controlled page-fetch contract (see src/utils/webfetch.ts, a pure
// leaf following the terminal.ts / cost.ts pattern). Follows the check.mjs
// pattern: a standalone assertion script, no test framework. Run after a build:
//   npm run build && node webfetch.check.mjs
//
// It unit-tests the pure decision logic behind frontier A5 (the fetch_page tool):
// which URLs an agent may fetch (http(s) only, no embedded credentials, no
// private/loopback/link-local address or internal hostname, docs domains only)
// and how an HTML page is reduced to readable text. All pure (no I/O, no network)
// so they can be asserted deterministically. The actual fetch lives in
// core/tools.ts and is exercised end-to-end, not here.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const MODULE = process.env.WEBFETCH_MODULE || path.join(here, 'dist', 'utils', 'webfetch.js')

const {
  DOCS_MARKERS, DOCS_DOMAIN_ALLOWLIST, FETCH_URL_MAX_LEN, FETCH_TEXT_MAX_CHARS,
  isDocsDomain, validateFetchUrl, extractPageText, buildFetchResult,
} = await import(pathToFileURL(MODULE).href)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}
function isOk(v) { return v.ok === true }
function err(v) { return v.ok === false ? v.error : '(no error)' }

// -- constants ------------------------------------------------------------------

console.log('constants:')
{
  ok(Array.isArray(DOCS_MARKERS) && DOCS_MARKERS.length > 0, 'DOCS_MARKERS is a non-empty array')
  ok(!DOCS_MARKERS.includes('api'), "'api' is deliberately excluded (JSON API endpoints are not docs)", DOCS_MARKERS.join(','))
  ok(DOCS_DOMAIN_ALLOWLIST instanceof Set && DOCS_DOMAIN_ALLOWLIST.size > 0, 'DOCS_DOMAIN_ALLOWLIST is a non-empty Set')
  ok(DOCS_DOMAIN_ALLOWLIST.has('nodejs.org'), 'allowlist carries a marker-less docs domain (nodejs.org)')
  ok(FETCH_URL_MAX_LEN === 2048, 'URL length cap is 2048', String(FETCH_URL_MAX_LEN))
  ok(FETCH_TEXT_MAX_CHARS === 12000, 'page-text cap is 12000', String(FETCH_TEXT_MAX_CHARS))
}

// -- isDocsDomain ---------------------------------------------------------------

console.log('\nisDocsDomain:')
{
  ok(isDocsDomain('docs.python.org') === true, 'marker host (docs.) is a docs domain')
  ok(isDocsDomain('readthedocs.io') === true, 'marker host (readthedocs) is a docs domain')
  ok(isDocsDomain('developer.mozilla.org') === true, 'marker host (developer.) is a docs domain')
  ok(isDocsDomain('nodejs.org') === true, 'allowlisted host is a docs domain')
  ok(isDocsDomain('NODEJS.ORG') === true, 'allowlist match is case-insensitive')
  ok(isDocsDomain('example.com') === false, 'plain host with no marker is not a docs domain')
  ok(isDocsDomain('') === false, 'empty host is not a docs domain')
  ok(isDocsDomain('corp.example.net') === false, 'marker-less host is rejected without extra domains')
  ok(isDocsDomain('corp.example.net', ['corp.example.net']) === true, 'extra-domains set widens the allowlist')
  ok(isDocsDomain('corp.example.net', ['CORP.EXAMPLE.NET']) === true, 'extra-domains match is case-insensitive')
}

// -- validateFetchUrl: accepted --------------------------------------------------

console.log('\nvalidateFetchUrl (accepted):')
{
  const a = validateFetchUrl('https://docs.python.org/3/library/json.html')
  ok(isOk(a), 'https docs URL is accepted', err(a))
  ok(a.ok && a.url === 'https://docs.python.org/3/library/json.html', 'returns the canonical URL', a.ok ? a.url : err(a))
  ok(a.ok && a.host === 'docs.python.org', 'returns the lowercased host', a.ok ? a.host : err(a))

  ok(isOk(validateFetchUrl('https://nodejs.org/api/http.html')), 'allowlisted docs URL is accepted')
  ok(isOk(validateFetchUrl('http://docs.example.com/guide')), 'http (not just https) docs URL is accepted')
  ok(!isOk(validateFetchUrl('http://example.com/docs/foo')), "'docs' in the path (not the host) is not a docs domain")
  ok(isOk(validateFetchUrl('https://docs.python.org/3/library/json.html?x=1#sec')), 'query + fragment preserved in canonical URL')
  ok(isOk(validateFetchUrl('  https://docs.python.org/3/  ')), 'surrounding whitespace is trimmed')
  ok(isOk(validateFetchUrl('https://docs.python.org:443/')), 'explicit port does not break host matching')
}

// -- validateFetchUrl: rejected --------------------------------------------------

console.log('\nvalidateFetchUrl (rejected):')
{
  const cases = [
    ['', 'empty string'],
    ['   ', 'whitespace only'],
    ['not a url', 'unparseable string'],
    ['ftp://docs.python.org/', 'non-http protocol (ftp)'],
    ['file:///etc/passwd', 'non-http protocol (file)'],
    ['javascript:alert(1)', 'non-http protocol (javascript)'],
    ['https://user:pass@docs.python.org/', 'embedded credentials'],
    ['https://192.168.1.1/docs/', 'private IPv4 (192.168/16) even with a docs marker'],
    ['https://10.0.0.5/docs/', 'private IPv4 (10/8)'],
    ['https://172.16.0.1/docs/', 'private IPv4 (172.16/12)'],
    ['https://127.0.0.1/docs', 'loopback IPv4 (127/8)'],
    ['https://0.0.0.0/docs', 'this-network IPv4 (0/8)'],
    ['https://169.254.169.254/latest/meta-data/', 'link-local / cloud-metadata IPv4'],
    ['https://100.64.0.1/docs', 'CGN IPv4 (100.64/10)'],
    ['https://[::1]/docs', 'loopback IPv6 (::1)'],
    ['https://[fd12::1]/docs', 'unique-local IPv6 (fc00::/7)'],
    ['https://[fe80::1]/docs', 'link-local IPv6 (fe80::/10)'],
    ['https://[::ffff:192.168.0.1]/docs', 'IPv4-mapped private address'],
    ['https://localhost/docs', 'localhost hostname'],
    ['https://foo.localhost/docs', '*.localhost hostname'],
    ['https://foo.internal/docs', '*.internal hostname'],
    ['https://foo.local/docs', '*.local hostname'],
    ['https://metadata.google.internal/', 'cloud metadata hostname'],
    ['https://example.com/about', 'non-docs domain (no marker, not allowlisted)'],
    ['https://api.github.com/repos', 'api.* host is not treated as docs'],
  ]
  for (const [input, label] of cases) {
    const v = validateFetchUrl(input)
    ok(!isOk(v) && typeof v.error === 'string' && v.error.length > 0, label, v.ok ? 'was accepted: ' + v.url : v.error)
  }

  // Length cap.
  const longUrl = 'https://docs.python.org/' + 'a'.repeat(FETCH_URL_MAX_LEN)
  ok(!isOk(validateFetchUrl(longUrl)), 'URL longer than the cap is rejected', err(validateFetchUrl(longUrl)))

  // Extra domains gate.
  ok(!isOk(validateFetchUrl('https://corp.example.net/page')), 'marker-less host rejected by default')
  ok(isOk(validateFetchUrl('https://corp.example.net/page', ['corp.example.net'])), 'marker-less host accepted via extra domains')
}

// -- extractPageText -------------------------------------------------------------

console.log('\nextractPageText:')
{
  const basic = extractPageText('<html><head><title>T</title></head><body><p>Hello world</p></body></html>')
  ok(basic.text.includes('Hello world'), 'visible paragraph text is kept', basic.text)
  ok(!basic.truncated, 'short page is not truncated')

  const script = extractPageText('<body><script>var secret = 42;</script><p>Body</p></body>')
  ok(!script.text.includes('secret') && !script.text.includes('var'), 'script content is dropped', script.text)
  ok(script.text.includes('Body'), 'text after the script is kept', script.text)

  const style = extractPageText('<style>.x{color:red}</style><p>Body</p>')
  ok(!style.text.includes('color:red'), 'style content is dropped', style.text)

  const comment = extractPageText('<!-- hidden note --><p>Body</p>')
  ok(!comment.text.includes('hidden note'), 'HTML comments are dropped', comment.text)

  const blocks = extractPageText('<p>One</p><p>Two</p><ul><li>A</li><li>B</li></ul>')
  ok(blocks.text.includes('One\nTwo'), 'block boundaries become newlines', JSON.stringify(blocks.text))
  ok(blocks.text.includes('A') && blocks.text.includes('B'), 'list items are kept', JSON.stringify(blocks.text))

  const nav = extractPageText('<body><nav>Menu Home About</nav><main>Real content</main></body>')
  ok(!nav.text.includes('Menu'), 'nav boilerplate is dropped', nav.text)
  ok(nav.text.includes('Real content'), 'main content is kept', nav.text)

  const named = extractPageText('<p>&amp; &lt;tag&gt; &quot;quoted&quot; &mdash; done</p>')
  ok(named.text.includes('& <tag> "quoted" \u2014 done'), 'named entities are decoded', JSON.stringify(named.text))

  const numeric = extractPageText('<p>&#65;&#x42; 33</p>')
  ok(numeric.text.includes('AB 33'), 'numeric entities are decoded', JSON.stringify(numeric.text))

  const unknown = extractPageText('<p>&notanentity; kept</p>')
  ok(unknown.text.includes('&notanentity;'), 'unknown entities are left as-is', JSON.stringify(unknown.text))

  const ws = extractPageText('<p>   a    b   </p>')
  ok(ws.text === 'a b', 'intra-line whitespace is collapsed', JSON.stringify(ws.text))

  const longBody = '<p>' + 'word '.repeat(5000) + '</p>'
  const trunc = extractPageText(longBody, 1000)
  ok(trunc.truncated === true, 'over-long page is flagged truncated')
  ok(trunc.text.length <= 1000, 'truncated text respects the cap', String(trunc.text.length))

  const empty = extractPageText('')
  ok(empty.text === '' && empty.truncated === false, 'empty input yields empty non-truncated text')
}

// -- buildFetchResult ------------------------------------------------------------

console.log('\nbuildFetchResult:')
{
  const r = buildFetchResult('https://docs.python.org/3/library/json.html', 200, 'text/html', '<p>Hello &amp; welcome</p>')
  ok(r.url === 'https://docs.python.org/3/library/json.html', 'result carries the URL', r.url)
  ok(r.status === 200, 'result carries the status', String(r.status))
  ok(r.content_type === 'text/html', 'result carries the content type', r.content_type)
  ok(r.text.includes('Hello & welcome'), 'result text is the reduced page', JSON.stringify(r.text))
  ok(r.chars === r.text.length, 'chars matches the text length', `${r.chars} vs ${r.text.length}`)
  ok(r.truncated === false, 'short body is not truncated')

  const big = buildFetchResult('https://docs.python.org/x', 200, 'text/html', '<p>' + 'z '.repeat(20000) + '</p>', 500)
  ok(big.truncated === true, 'large body is truncated to the cap')
  ok(big.chars <= 500, 'truncated result respects the cap', String(big.chars))
}

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
