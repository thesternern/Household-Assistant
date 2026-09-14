/**
 * The browser allowlist is the only thing standing between a logged-in Amazon
 * session and whatever a product page suggests the agent visit next. These tests
 * are mostly hostile inputs, because the interesting failures are all the ways a
 * string can contain "amazon.com" without being Amazon.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  __resetAllowlistWarnings,
  allowedDomains,
  assertAllowedUrl,
  checkUrl,
  hostMatchesDomain,
  isAllowedUrl,
  normalizeHost,
  redactUrl,
} from '../src/browser/allowlist.js'
import { __setConfigForTests } from '../src/config.js'

const REQUIRED_ENV: Record<string, string> = {
  APP_SECRET: 'test-app-secret-0123456789abcdefghijklmn',
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  DATABASE_URL: 'postgres://localhost:5432/home_assistant_test',
  APP_URL: 'https://example.test',
  TELEGRAM_BOT_TOKEN: 'test-bot-token',
  TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
  TELEGRAM_USER_ID_1: '1000001',
}

const saved: Record<string, string | undefined> = {}

/** Repoint BROWSER_ALLOWED_DOMAINS and drop the cached config. */
function useDomains(csv: string | undefined): void {
  if (csv === undefined) delete process.env.BROWSER_ALLOWED_DOMAINS
  else process.env.BROWSER_ALLOWED_DOMAINS = csv
  __setConfigForTests(null)
  __resetAllowlistWarnings()
}

beforeAll(() => {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  saved.BROWSER_ALLOWED_DOMAINS = process.env.BROWSER_ALLOWED_DOMAINS
  // The shipped default: amazon.com, www.amazon.com, smile.amazon.com.
  useDomains(undefined)
})

afterEach(() => {
  useDomains(undefined)
})

afterAll(() => {
  for (const key of Object.keys(saved)) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  __setConfigForTests(null)
})

describe('isAllowedUrl — the hostile cases', () => {
  it('rejects a lookalike host that merely starts with the allowed domain', () => {
    // The classic. Substring matching on the raw URL lets this through.
    expect(isAllowedUrl('https://amazon.com.evil.tld/x')).toBe(false)
  })

  it('rejects plain http', () => {
    expect(isAllowedUrl('http://amazon.com')).toBe(false)
    expect(isAllowedUrl('http://www.amazon.com/dp/B0TEST12345')).toBe(false)
  })

  it('rejects a hostile host that only mentions the allowed domain in the query', () => {
    expect(isAllowedUrl('https://evil.tld/?u=amazon.com')).toBe(false)
  })

  it('allows a real product URL', () => {
    expect(isAllowedUrl('https://www.amazon.com/dp/X')).toBe(true)
  })

  it('allows another allowlisted subdomain', () => {
    expect(isAllowedUrl('https://smile.amazon.com/x')).toBe(true)
  })

  it('rejects the userinfo trick, where the real host hides after the @', () => {
    // `new URL()` reads amazon.com as a username and evil.tld as the host.
    expect(new URL('https://amazon.com@evil.tld/').hostname).toBe('evil.tld')
    expect(isAllowedUrl('https://amazon.com@evil.tld/')).toBe(false)
  })
})

describe('isAllowedUrl — more ways to not be Amazon', () => {
  it('rejects a suffix that is not on a label boundary', () => {
    expect(isAllowedUrl('https://notamazon.com/x')).toBe(false)
    expect(isAllowedUrl('https://xamazon.com/x')).toBe(false)
  })

  it('rejects other schemes outright', () => {
    expect(isAllowedUrl('javascript:fetch("https://www.amazon.com")')).toBe(false)
    expect(isAllowedUrl('data:text/html,<b>www.amazon.com</b>')).toBe(false)
    expect(isAllowedUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedUrl('ftp://www.amazon.com/x')).toBe(false)
  })

  it('rejects a non-https port on a real allowlisted host', () => {
    expect(isAllowedUrl('https://www.amazon.com:8443/dp/X')).toBe(false)
    expect(isAllowedUrl('https://www.amazon.com:443/dp/X')).toBe(true)
  })

  it('rejects embedded credentials even on a genuinely allowlisted host', () => {
    expect(isAllowedUrl('https://user:pass@www.amazon.com/dp/X')).toBe(false)
  })

  it('rejects a Unicode homograph, which punycodes to a different host', () => {
    // Cyrillic "а" in place of the Latin one.
    const homograph = 'https://аmazon.com/dp/X'
    expect(new URL(homograph).hostname).toBe('xn--mazon-3ve.com')
    expect(isAllowedUrl(homograph)).toBe(false)
  })

  it('rejects raw IP addresses', () => {
    expect(isAllowedUrl('https://192.0.2.10/dp/X')).toBe(false)
    expect(isAllowedUrl('https://[2001:db8::1]/dp/X')).toBe(false)
  })

  it('rejects things that are not absolute URLs at all', () => {
    expect(isAllowedUrl('www.amazon.com')).toBe(false)
    expect(isAllowedUrl('/dp/X')).toBe(false)
    expect(isAllowedUrl('')).toBe(false)
    expect(isAllowedUrl('   ')).toBe(false)
    expect(isAllowedUrl(undefined as unknown as string)).toBe(false)
    expect(isAllowedUrl(42 as unknown as string)).toBe(false)
  })

  it('rejects an absurdly long URL before parsing it', () => {
    const long = `https://www.amazon.com/dp/X?q=${'a'.repeat(5000)}`
    expect(isAllowedUrl(long)).toBe(false)
  })

  it('accepts the shapes a real Amazon session produces', () => {
    expect(isAllowedUrl('https://amazon.com/')).toBe(true)
    expect(isAllowedUrl('https://WWW.AMAZON.COM/dp/X')).toBe(true)
    expect(isAllowedUrl('https://www.amazon.com./dp/X')).toBe(true) // trailing root dot
    expect(isAllowedUrl('https://www.amazon.com/gp/cart/view.html?ref=nav')).toBe(true)
    // Suffix matching means any Amazon subdomain is in, via the amazon.com entry.
    expect(isAllowedUrl('https://images.amazon.com/x.png')).toBe(true)
  })
})

describe('allowedDomains', () => {
  it('uses the shipped default when the env var is unset', () => {
    expect(allowedDomains()).toEqual(['amazon.com', 'www.amazon.com', 'smile.amazon.com'])
  })

  it('normalises the shapes people type', () => {
    useDomains('*.Example.COM, .other.test , trailing.test. ,')
    expect(allowedDomains()).toEqual(['example.com', 'other.test', 'trailing.test'])
  })

  it('drops a single-label entry rather than opening a whole TLD', () => {
    useDomains('com')
    expect(allowedDomains()).toEqual([])
    // And with no usable entry, nothing is reachable.
    expect(isAllowedUrl('https://www.amazon.com/dp/X')).toBe(false)
    expect(isAllowedUrl('https://evil.com/x')).toBe(false)
  })

  it('drops malformed entries', () => {
    useDomains('https://amazon.com/path, ok.test, bad_host.test, a..b.test')
    expect(allowedDomains()).toEqual(['ok.test'])
  })

  it('honours a narrowed allowlist', () => {
    useDomains('smile.amazon.com')
    expect(isAllowedUrl('https://smile.amazon.com/x')).toBe(true)
    expect(isAllowedUrl('https://www.amazon.com/dp/X')).toBe(false)
  })
})

describe('hostMatchesDomain', () => {
  it('matches an exact host and a dotted subdomain, and nothing else', () => {
    expect(hostMatchesDomain('amazon.com', 'amazon.com')).toBe(true)
    expect(hostMatchesDomain('www.amazon.com', 'amazon.com')).toBe(true)
    expect(hostMatchesDomain('a.b.amazon.com', 'amazon.com')).toBe(true)
    expect(hostMatchesDomain('notamazon.com', 'amazon.com')).toBe(false)
    expect(hostMatchesDomain('amazon.com.evil.tld', 'amazon.com')).toBe(false)
    expect(hostMatchesDomain('', 'amazon.com')).toBe(false)
    expect(hostMatchesDomain('amazon.com', '')).toBe(false)
  })
})

describe('normalizeHost', () => {
  it('lowercases, strips the root dot, and unwraps IPv6 brackets', () => {
    expect(normalizeHost('WWW.Amazon.COM.')).toBe('www.amazon.com')
    expect(normalizeHost('[2001:db8::1]')).toBe('2001:db8::1')
    expect(normalizeHost('  amazon.com  ')).toBe('amazon.com')
  })
})

describe('checkUrl reasons', () => {
  it('says why, in words a human can act on', () => {
    expect(checkUrl('http://amazon.com')).toMatchObject({ ok: false })
    expect(checkUrl('http://amazon.com').ok ? '' : checkUrl('http://amazon.com').reason).toContain(
      'https',
    )

    const userinfo = checkUrl('https://amazon.com@evil.tld/')
    expect(userinfo.ok).toBe(false)
    if (!userinfo.ok) expect(userinfo.reason).toContain('credentials')

    const lookalike = checkUrl('https://amazon.com.evil.tld/x')
    expect(lookalike.ok).toBe(false)
    if (!lookalike.ok) expect(lookalike.reason).toContain('amazon.com.evil.tld')

    const good = checkUrl('https://www.amazon.com/dp/X')
    expect(good.ok).toBe(true)
    if (good.ok) expect(good.host).toBe('www.amazon.com')
  })
})

describe('assertAllowedUrl', () => {
  it('passes an allowlisted URL through silently', () => {
    expect(() => assertAllowedUrl('https://www.amazon.com/dp/X')).not.toThrow()
  })

  it('throws with the reason for a blocked one', () => {
    expect(() => assertAllowedUrl('https://amazon.com.evil.tld/x')).toThrow(/Blocked URL/)
    expect(() => assertAllowedUrl('http://amazon.com')).toThrow(/https/)
  })
})

describe('redactUrl', () => {
  it('strips userinfo and the query before anything is logged', () => {
    const redacted = redactUrl('https://user:hunter2@evil.tld/x?token=abc#frag')
    expect(redacted).not.toContain('hunter2')
    expect(redacted).not.toContain('token=abc')
    expect(redacted).toContain('evil.tld')
  })

  it('caps a hostile length and survives an unparseable input', () => {
    expect(redactUrl(`https://evil.tld/${'a'.repeat(1000)}`).length).toBeLessThanOrEqual(200)
    expect(redactUrl('not a url at all')).toBe('not a url at all')
  })
})
