// -- Controlled page fetch (pure leaf) -----------------------------------------
// Pure, dependency-free contract for the controlled page-fetch tool (frontier A5):
// which URLs an agent may fetch (documentation domains only, SSRF-safe) and how an
// HTML page is reduced to readable text. No I/O, no network -- the actual fetch
// lives in core/tools.ts; this leaf owns the decision logic so the contract is
// unit-testable in isolation (webfetch.check.mjs), following the terminal.ts /
// cost.ts leaf pattern.
//
// A5 context: the architect / single-agent "rarely use web search" and "search
// returns snippets only." The page-fetch tool lets an agent pull the FULL text of a
// docs page it found via web_search, not just the snippet. It is deliberately
// controlled: only http(s), only documentation domains (an allowlist + a docs-marker
// heuristic), and never a private/loopback/link-local address or internal hostname
// (SSRF guard). The docs-domain restriction is a product boundary (fetch docs, not
// arbitrary pages); the SSRF guard is the security boundary.

// A URL is fetchable only if it is http(s), has no embedded credentials, is not a
// private/loopback/link-local address or internal hostname, and is a docs domain.
export type FetchUrlVerdict =
  | { ok: true;  url: string; host: string }
  | { ok: false; error: string }

// Hostname labels that mark a documentation domain (substring match, lowercased).
// Bias: a false positive (allowing a non-docs page) is low-harm on a trusted
// single-user box; a false negative (blocking a real docs domain) defeats the tool,
// so the set is kept broad. `api` is deliberately EXCLUDED -- it matches JSON API
// endpoints (api.github.com) that are not documentation pages.
export const DOCS_MARKERS: readonly string[] = [
  'docs', 'documentation', 'readthedocs', 'manual', 'guides', 'guide',
  'reference', 'developer', 'learn', 'tutorials', 'tutorial', 'wiki',
  'handbook', 'cookbook',
]

// Well-known documentation domains that carry no marker above (nodejs.org, ...).
// Extensible at runtime via the `extraDomains` argument (tools.ts reads
// WEBFETCH_EXTRA_DOMAINS and passes it in).
export const DOCS_DOMAIN_ALLOWLIST: ReadonlySet<string> = new Set([
  'nodejs.org', 'python.org', 'golang.org', 'rust-lang.org', 'kubernetes.io',
  'docker.com', 'nginx.org', 'redis.io', 'postgres.org', 'postgresql.org',
  'sqlite.org', 'w3.org', 'ietf.org', 'datatracker.ietf.org', 'cloud.google.com',
  'aws.amazon.com', 'azure.microsoft.com', 'oracle.com', 'php.net',
  'ruby-lang.org', 'swift.org', 'kotlinlang.org', 'typescriptlang.org',
  'deno.com', 'bun.sh', 'pypi.org', 'npmjs.com', 'crates.io', 'docs.rs',
])

// True when the (lowercased) host is a documentation domain: in the allowlist, in
// the caller-supplied extra set, or carrying a docs marker in any label.
export function isDocsDomain(host: string, extraDomains?: Iterable<string>): boolean {
  const h = (host ?? '').toLowerCase()
  if (!h) return false
  if (DOCS_DOMAIN_ALLOWLIST.has(h)) return true
  if (extraDomains) {
    for (const d of extraDomains) if (d && d.toLowerCase() === h) return true
  }
  return DOCS_MARKERS.some(m => h.includes(m))
}

// True when the host is an IP literal (IPv4 dotted-quad or an IPv6 literal, with or
// without the surrounding brackets a URL parser may leave in).
function isIpLiteral(host: string): boolean {
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true
  return h.includes(':')
}

// True for private / loopback / link-local / reserved addresses -- the addresses an
// SSRF attack targets. IPv4: 0/8, 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16
// (link-local + cloud metadata), 100.64/10 (CGN). IPv6: ::, ::1, fc00::/7, fe80::/10,
// and IPv4-mapped ::ffff:a.b.c.d.
function isPrivateOrReservedIp(host: string): boolean {
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const p = h.split('.').map(Number)
    const a = p[0] ?? 0
    const b = p[1] ?? 0
    if (a === 0 || a === 127) return true
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  const lower = h.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  if (/^fe[89ab]/.test(lower.slice(0, 4))) return true
  const v4mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (v4mapped) return isPrivateOrReservedIp(v4mapped[1]!)
  return false
}

// Hostnames that are internal by name even when not an IP literal.
function isInternalHostname(host: string): boolean {
  const h = (host ?? '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h.endsWith('.local') || h.endsWith('.internal')) return true
  if (h === 'metadata.google.internal') return true
  return false
}

export const FETCH_URL_MAX_LEN = 2048

// Validate a URL for the controlled page-fetch. Returns the canonical URL on
// success, or a specific reason on rejection. `extraDomains` optionally widens the
// docs-domain allowlist (tools.ts passes WEBFETCH_EXTRA_DOMAINS here).
export function validateFetchUrl(rawUrl: string, extraDomains?: Iterable<string>): FetchUrlVerdict {
  const trimmed = (rawUrl ?? '').trim()
  if (!trimmed) return { ok: false, error: 'url is required' }
  if (trimmed.length > FETCH_URL_MAX_LEN) {
    return { ok: false, error: `url too long (max ${FETCH_URL_MAX_LEN} chars)` }
  }
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return { ok: false, error: `not a valid URL: ${trimmed.slice(0, 120)}` }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: `only http/https URLs are allowed (got ${u.protocol.replace(':', '')})` }
  }
  if (u.username || u.password) {
    return { ok: false, error: 'URLs with embedded credentials are not allowed' }
  }
  const host = u.hostname.toLowerCase()
  if (!host) return { ok: false, error: 'URL has no host' }

  if (isIpLiteral(host)) {
    if (isPrivateOrReservedIp(host)) {
      return { ok: false, error: `blocked: ${host} is a private/loopback/link-local address` }
    }
  } else if (isInternalHostname(host)) {
    return { ok: false, error: `blocked: ${host} is an internal hostname` }
  }

  if (!isDocsDomain(host, extraDomains)) {
    return { ok: false, error: `not a docs domain: ${host} -- this tool fetches documentation pages only` }
  }
  return { ok: true, url: u.href, host }
}

// Decode the common named + numeric HTML entities. Unknown entities are left as-is.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', copy: '\u00a9',
  reg: '\u00ae', trade: '\u2122', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d',
}

function fromCodePointSafe(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return ''
  try { return String.fromCodePoint(cp) } catch { return '' }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => fromCodePointSafe(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => fromCodePointSafe(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => {
      const v = NAMED_ENTITIES[name.toLowerCase()]
      return v !== undefined ? v : m
    })
}

export const FETCH_TEXT_MAX_CHARS = 12000

// Reduce an HTML page to readable text: drop scripts/styles/comments and the
// nav/header/footer/aside boilerplate, turn block boundaries into newlines, strip
// the remaining tags, decode entities, and collapse whitespace. The result is capped
// at maxChars (truncated flag set when cut). Pure -- no DOM, no network.
export function extractPageText(html: string, maxChars: number = FETCH_TEXT_MAX_CHARS): { text: string; truncated: boolean } {
  let s = html ?? ''
  // Drop non-content elements entirely (their inner text is code or boilerplate).
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
  s = s.replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ')
  // Block boundaries -> newlines (so paragraphs / list items / headings separate).
  s = s.replace(/<\/(p|div|section|article|li|tr|table|blockquote|pre|figure|fieldset|ul|ol|h[1-6])\s*>/gi, '\n')
  s = s.replace(/<h[1-6]\b[^>]*>/gi, '\n')
  s = s.replace(/<(br|hr)\s*\/?\s*>/gi, '\n')
  // Strip every remaining tag.
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  // Normalize whitespace: one space run per line, no more than one blank line.
  s = s.split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).join('\n')
  s = s.replace(/\n{3,}/g, '\n\n').trim()
  const truncated = s.length > maxChars
  const text = truncated ? s.slice(0, maxChars) : s
  return { text, truncated }
}

// The object the fetch_page tool returns on success. tools.ts JSON.stringifies it.
export interface FetchPageResult {
  url: string
  status: number
  content_type: string
  chars: number
  truncated: boolean
  text: string
}

// Build the success payload from a fetched body. `contentType` is the response
// Content-Type header (may be empty). The body is reduced with extractPageText.
export function buildFetchResult(
  url: string,
  status: number,
  contentType: string,
  body: string,
  maxChars: number = FETCH_TEXT_MAX_CHARS,
): FetchPageResult {
  const { text, truncated } = extractPageText(body, maxChars)
  return { url, status, content_type: contentType, chars: text.length, truncated, text }
}
