/**
 * The browser worker's pure guts: the route-guard decision, the task budget,
 * and the error type that redacts URLs. None of this launches a browser —
 * `import('playwright')` in worker.ts is dynamic and only runs on a real task.
 *
 * The route-guard tests exist because of a specific hole: Playwright calls a
 * route handler only for the FIRST url of a redirect chain, for every resource
 * type. A guard that pins redirects only on navigations lets an allowlisted
 * subresource 302 its way off the allowlist unseen. The decision function must
 * therefore answer `pin-redirects` for every allowed network request.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { __resetAllowlistWarnings } from '../src/browser/allowlist.js'
import {
  BROWSER_BUDGET_MS,
  BrowserError,
  errorText,
  isBrowserError,
  routeDecisionFor,
  withDeadline,
} from '../src/browser/worker.js'
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

beforeAll(() => {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  saved.BROWSER_ALLOWED_DOMAINS = process.env.BROWSER_ALLOWED_DOMAINS
  delete process.env.BROWSER_ALLOWED_DOMAINS // the shipped default: amazon.com + www + smile
  __setConfigForTests(null)
  __resetAllowlistWarnings()
})

afterEach(() => {
  delete process.env.BROWSER_ALLOWED_DOMAINS
  __setConfigForTests(null)
  __resetAllowlistWarnings()
})

afterAll(() => {
  for (const key of Object.keys(saved)) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  __setConfigForTests(null)
})

describe('routeDecisionFor', () => {
  it('continues non-network schemes that cannot hop hosts', () => {
    expect(routeDecisionFor('about:blank', true)).toBe('continue')
    expect(routeDecisionFor('data:text/plain,hello', false)).toBe('continue')
    expect(routeDecisionFor('blob:https://www.amazon.com/uuid', false)).toBe('continue')
  })

  it('aborts everything off the allowlist, navigation or not', () => {
    expect(routeDecisionFor('https://evil.tld/x', true)).toBe('abort')
    expect(routeDecisionFor('https://evil.tld/beacon.gif', false)).toBe('abort')
    expect(routeDecisionFor('http://www.amazon.com/', true)).toBe('abort')
    expect(routeDecisionFor('file:///etc/passwd', false)).toBe('abort')
    expect(routeDecisionFor('ftp://www.amazon.com/x', false)).toBe('abort')
    expect(routeDecisionFor('https://amazon.com.evil.tld/x', true)).toBe('abort')
  })

  it('pins redirects on an allowlisted navigation', () => {
    expect(routeDecisionFor('https://www.amazon.com/dp/B0TEST1234', true)).toBe('pin-redirects')
  })

  it('pins redirects on an allowlisted SUBRESOURCE too — Chromium follows a 3xx internally for every resource type', () => {
    // The regression this file exists for: an amazon.com script or XHR that
    // 302s to evil.tld must face the guard on the hop. A plain `continue` here
    // hands the redirect to the network stack, which follows it unseen.
    expect(routeDecisionFor('https://www.amazon.com/script.js', false)).toBe('pin-redirects')
    expect(routeDecisionFor('https://www.amazon.com/api/cart', false)).toBe('pin-redirects')
    expect(routeDecisionFor('https://images.amazon.com/x.png', false)).toBe('pin-redirects')
  })
})

describe('withDeadline', () => {
  it('returns the result when the work beats the budget', async () => {
    await expect(withDeadline(Promise.resolve(42), 1_000)).resolves.toBe(42)
  })

  it('propagates a rejection from the work unchanged', async () => {
    await expect(withDeadline(Promise.reject(new Error('boom')), 1_000)).rejects.toThrow('boom')
  })

  it('rejects with a timeout BrowserError when the budget expires', async () => {
    const never = new Promise<never>(() => undefined)
    const err = await withDeadline(never, 25).then(
      () => null,
      (e: unknown) => e,
    )
    expect(isBrowserError(err)).toBe(true)
    if (isBrowserError(err)) {
      expect(err.code).toBe('timeout')
      expect(err.message).toContain('budget')
    }
  })

  it('gives the losing promise a listener, so its late rejection is not unhandled', async () => {
    let rejectLate!: (e: Error) => void
    const work = new Promise<never>((_resolve, reject) => {
      rejectLate = reject
    })
    await expect(withDeadline(work, 10)).rejects.toMatchObject({ code: 'timeout' })
    // The page underneath a timed-out task rejects a moment later. If nothing
    // is listening, the process dies — vitest surfaces that as a failure here.
    rejectLate(new Error('late rejection after the deadline'))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  it('has a budget that is actually 90 seconds', () => {
    expect(BROWSER_BUDGET_MS).toBe(90_000)
  })
})

describe('BrowserError', () => {
  it('redacts the URL it carries: no query, no userinfo', () => {
    const err = new BrowserError('blocked', 'Blocked.', 'https://user:hunter2@evil.tld/p?token=abc#f')
    expect(err.message).toContain('evil.tld')
    expect(err.message).not.toContain('hunter2')
    expect(err.message).not.toContain('token=abc')
    expect(err.url).toBeDefined()
    expect(err.url).not.toContain('token=abc')
    expect(err.url).not.toContain('hunter2')
  })

  it('errorText returns the message and never a stack', () => {
    const err = new BrowserError('busy', 'The browser is busy.')
    expect(errorText(err)).toBe('The browser is busy.')
    expect(errorText(new Error('plain'))).toBe('plain')
    expect(errorText('a string')).toBe('a string')
    expect(errorText(42)).toBe('42')
  })
})
