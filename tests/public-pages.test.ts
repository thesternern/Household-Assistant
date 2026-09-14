import { describe, expect, it, vi } from 'vitest'

/**
 * The two unauthenticated pages Google's OAuth consent screen requires before
 * it will let an External app switch to production: an application home page
 * and a privacy policy.
 *
 * The property under test is that both answer without touching the database or
 * the config. Google fetches these while the assistant may be mid-deploy or
 * pointed at a cold Postgres, and a page that 500s there blocks publishing for
 * reasons nobody can see from the Cloud Console.
 */

vi.mock('../src/config.js', () => ({
  getConfig: () => {
    throw new Error('the public pages must not read config')
  },
}))

vi.mock('../src/db/client.js', () => ({
  getDb: () => {
    throw new Error('the public pages must not read the database')
  },
}))

vi.mock('../src/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return { logger, child: () => logger }
})

const { handleHome, handlePrivacy } = await import('../src/http/public-pages.js')

/** Minimal Hono context stand-in: the handlers only ever build a response. */
function ctx() {
  return {
    html: (body: string, status = 200) =>
      new Response(body, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } }),
  }
}

describe('GET /privacy', () => {
  it('answers 200 with HTML', async () => {
    const res = await handlePrivacy(ctx() as never)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
  })

  it('discloses every Google scope the assistant actually requests', async () => {
    const body = await (await handlePrivacy(ctx() as never)).text()
    // Sourced from GOOGLE_SCOPES. A scope the policy fails to disclose is the
    // exact thing that gets an app rejected, so assert on all five.
    expect(body).toMatch(/read/i)
    expect(body).toMatch(/draft|compose/i)
    expect(body).toMatch(/send/i)
    expect(body).toMatch(/calendar/i)
    expect(body).toMatch(/email address/i)
  })

  it('tells the reader how to revoke access', async () => {
    const body = await (await handlePrivacy(ctx() as never)).text()
    expect(body).toContain('myaccount.google.com/permissions')
  })

  it('states that data is neither sold nor shared', async () => {
    const body = await (await handlePrivacy(ctx() as never)).text()
    expect(body).toMatch(/not (sold|shared)|never (sold|shared)/i)
  })

  it('escapes nothing dynamic — the page is a constant', async () => {
    const a = await (await handlePrivacy(ctx() as never)).text()
    const b = await (await handlePrivacy(ctx() as never)).text()
    expect(a).toBe(b)
  })
})

describe('GET /', () => {
  it('answers 200 and points at the privacy policy', async () => {
    const res = await handleHome(ctx() as never)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('/privacy')
  })

  it('leaks no operational detail', async () => {
    const body = await (await handleHome(ctx() as never)).text()
    // The old handler returned a bare "ok" precisely to avoid a brochure. The
    // page now has to satisfy Google, but it still must not name internals.
    expect(body).not.toMatch(/telegram|webhook|postgres|railway|vapi/i)
  })
})
