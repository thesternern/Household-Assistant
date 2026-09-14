/**
 * The single gate that decides whether the browser worker may touch a URL.
 *
 * Everything about this module is deliberately paranoid, because it is the only
 * thing standing between a logged-in Amazon session and a page that asked the
 * agent to visit somewhere else.
 *
 * Three rules, and they are the whole design:
 *
 *  1. **Parse, never pattern-match.** The host is read off a real `URL`, never
 *     found by searching the raw string. Substring matching is exactly how
 *     `https://amazon.com.evil.tld/x` and `https://evil.tld/?u=amazon.com` get
 *     through — both contain "amazon.com" and neither is Amazon.
 *  2. **https only, no userinfo, no odd port.** `http://amazon.com` is not
 *     Amazon-you-can-trust, `https://amazon.com@evil.tld/` is evil.tld wearing
 *     Amazon's name in the username field, and `https://www.amazon.com:8443/`
 *     is some other service on Amazon's address.
 *  3. **Exact host or a dotted suffix.** `amazon.com` matches `amazon.com` and
 *     `www.amazon.com`; it never matches `notamazon.com`, and it never matches
 *     `amazon.com.evil.tld`.
 *
 * Redirects take a special case, and the worker owns it: Chromium follows a
 * 3xx internally without re-running route handlers — for subresources exactly
 * as for navigations — so the worker fetches each allowed request with
 * redirects disabled and replays every hop as a fresh request. Each hop
 * therefore comes back through `isAllowedUrl`, and one that is off the
 * allowlist is aborted like any other blocked request.
 */
import { getConfig } from '../config.js'
import { logger } from '../logger.js'

const log = logger.child({ mod: 'browser/allowlist' })

/** The only ports a plain https site answers on. Anything else is a different service. */
const ALLOWED_PORTS = new Set(['', '443'])

/** A hostname label set. Anything outside it is not a hostname we will resolve. */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

/** No sane URL we drive is longer than this; a giant one is an attack, not a link. */
const MAX_URL_CHARS = 4096

/** Config entries we have already complained about, so a bad entry logs once, not per request. */
const warned = new Set<string>()

function warnOnce(key: string, message: string, detail: Record<string, unknown>): void {
  if (warned.has(key)) return
  warned.add(key)
  log.warn(detail, message)
}

/** Test seam: forget which bad config entries have already been logged. */
export function __resetAllowlistWarnings(): void {
  warned.clear()
}

/**
 * Lowercase, strip a trailing root dot, strip IPv6 brackets.
 *
 * `new URL()` has already lowercased the host and punycoded any non-ASCII, so a
 * homograph such as `аmazon.com` (Cyrillic а) arrives here as
 * `xn--mazon-3ve.com` and cannot match the ASCII allowlist entry.
 */
export function normalizeHost(host: string): string {
  let h = String(host ?? '')
    .trim()
    .toLowerCase()
  while (h.endsWith('.')) h = h.slice(0, -1)
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  return h
}

/**
 * Turn one `BROWSER_ALLOWED_DOMAINS` entry into a bare host suffix, or null when
 * the entry is not usable.
 *
 * A single-label entry (`com`, `localhost`) is dropped on purpose: as a suffix
 * it would allow an entire TLD, which is not an allowlist.
 */
function normalizeDomainEntry(entry: unknown): string | null {
  if (typeof entry !== 'string') return null
  let d = entry.trim().toLowerCase()
  if (d === '') return null

  // Tolerate the shapes people actually type: "*.amazon.com", ".amazon.com".
  if (d.startsWith('*.')) d = d.slice(2)
  while (d.startsWith('.')) d = d.slice(1)
  while (d.endsWith('.')) d = d.slice(0, -1)
  if (d === '') return null

  if (!d.includes('.')) {
    warnOnce(
      `single-label:${d}`,
      'BROWSER_ALLOWED_DOMAINS entry has a single label and would allow a whole TLD, ignoring it',
      { entry: d },
    )
    return null
  }
  if (!HOSTNAME_RE.test(d)) {
    warnOnce(`malformed:${d}`, 'BROWSER_ALLOWED_DOMAINS entry is not a bare hostname, ignoring it', {
      entry: d,
    })
    return null
  }
  return d
}

/**
 * The effective allowlist, normalised. Empty when the config is unreadable or
 * every entry was rejected — and an empty allowlist blocks everything, which is
 * the fail-safe direction.
 */
export function allowedDomains(): string[] {
  let raw: readonly string[]
  try {
    raw = getConfig().BROWSER_ALLOWED_DOMAINS
  } catch (err) {
    // A browser that cannot read its allowlist gets no allowlist.
    warnOnce('no-config', 'could not read BROWSER_ALLOWED_DOMAINS, blocking every URL', {
      err: String(err),
    })
    return []
  }
  if (!Array.isArray(raw)) return []

  const out: string[] = []
  for (const entry of raw) {
    const domain = normalizeDomainEntry(entry)
    if (domain !== null && !out.includes(domain)) out.push(domain)
  }
  return out
}

/** Exact host, or a dotted subdomain of it. Never a bare substring. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  if (host === '' || domain === '') return false
  return host === domain || host.endsWith(`.${domain}`)
}

export type AllowlistCheck = { ok: true; host: string } | { ok: false; reason: string }

/**
 * The full decision, with the reason kept, so callers can say *why* something
 * was blocked instead of shrugging. {@link isAllowedUrl} is the boolean view.
 */
export function checkUrl(url: string): AllowlistCheck {
  if (typeof url !== 'string') return { ok: false, reason: 'the URL is not a string' }
  const trimmed = url.trim()
  if (trimmed === '') return { ok: false, reason: 'the URL is empty' }
  if (trimmed.length > MAX_URL_CHARS) {
    return { ok: false, reason: `the URL is ${trimmed.length} characters long` }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'it is not a parseable absolute URL' }
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `the scheme is "${parsed.protocol}" and only https is allowed` }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    // "https://amazon.com@evil.tld/" — the host is evil.tld and "amazon.com" is
    // a username. Refuse the whole shape rather than trusting the parse.
    return { ok: false, reason: 'it carries embedded credentials before the host' }
  }
  if (!ALLOWED_PORTS.has(parsed.port)) {
    return { ok: false, reason: `port ${parsed.port} is not the https port` }
  }

  const host = normalizeHost(parsed.hostname)
  if (host === '') return { ok: false, reason: 'it has no hostname' }
  if (!HOSTNAME_RE.test(host)) {
    // Bracketed IPv6 and anything else that is not a name. (A bare IPv4
    // address is all digit labels and passes this regex, but it can never
    // match a domain entry, so the allowlist check below still refuses it.)
    return { ok: false, reason: `"${host}" is not a hostname on the allowlist` }
  }

  const domains = allowedDomains()
  if (domains.length === 0) {
    return { ok: false, reason: 'BROWSER_ALLOWED_DOMAINS is empty, so nothing is reachable' }
  }
  for (const domain of domains) {
    if (hostMatchesDomain(host, domain)) return { ok: true, host }
  }
  return {
    ok: false,
    reason: `host "${host}" is not on BROWSER_ALLOWED_DOMAINS (${domains.join(', ')})`,
  }
}

/** True only for an https URL on an allowlisted host. Everything else is false. */
export function isAllowedUrl(url: string): boolean {
  return checkUrl(url).ok
}

/**
 * A URL safe to put in a log line or an error message: userinfo removed, query
 * dropped, length capped. A blocked URL is attacker-supplied text.
 */
export function redactUrl(url: string): string {
  const raw = typeof url === 'string' ? url.trim() : String(url ?? '')
  try {
    const parsed = new URL(raw)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    const clean = parsed.toString()
    return clean.length > 200 ? `${clean.slice(0, 197)}...` : clean
  } catch {
    // Unparseable: strip control characters so foreign text cannot write ANSI
    // escapes or newlines into an operator's terminal, then cap it.
    const stripped = raw.replace(/[\u0000-\u001F\u007F]/g, ' ')
    return stripped.length > 200 ? `${stripped.slice(0, 197)}...` : stripped
  }
}

/** Throws with a reason a human can act on. Use before every navigation. */
export function assertAllowedUrl(url: string): void {
  const check = checkUrl(url)
  if (check.ok) return
  throw new Error(`Blocked URL ${redactUrl(url)}: ${check.reason}.`)
}
