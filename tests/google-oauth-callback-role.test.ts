import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The OAuth callback has to store the grant under the role the flow began with.
 *
 * Migration 0001 moved the unique index on `google_tokens` from `user_id` to
 * `role`, and added `storeToken(role, …)` to write through it. The callback was
 * never switched over: it kept its own insert with `onConflictDoUpdate` still
 * targeting `user_id`, a constraint that no longer exists. Postgres rejects
 * that query outright, so every single connection attempt failed at the last
 * step — after consent, after the token exchange, with only a neutral error
 * page to show for it.
 *
 * Two properties, both regressions of that bug:
 *   1. the role from the state reaches storage, so `/connect_google assistant`
 *      cannot file the assistant's mailbox as the family's own;
 *   2. the callback writes through `storeToken` rather than hand-rolling an
 *      insert that can drift from the schema again.
 */

const H = vi.hoisted(() => ({
  /** The `oauth_states` row the fake DELETE ... RETURNING hands back. */
  stateRow: null as Record<string, unknown> | null,
  /** Every table the callback inserted into directly. */
  directInserts: [] as unknown[],
  /** Every storeToken() call, in order. */
  storeTokenCalls: [] as Array<{ role: string; userId: number; email: string | null }>,
  exchange: {
    refreshToken: 'refresh-token-value',
    email: 'alex@example.com',
    scope: 'https://www.googleapis.com/auth/calendar',
  },
}))

/** A drizzle-ish builder: every method chains, awaiting yields `result`. */
function chain(result: unknown, onCall?: (method: string, arg: unknown) => void) {
  const obj: Record<string, unknown> = {}
  const methods = [
    'where',
    'limit',
    'returning',
    'values',
    'from',
    'set',
    'onConflictDoNothing',
    'onConflictDoUpdate',
    'orderBy',
  ]
  for (const m of methods) {
    obj[m] = (arg: unknown) => {
      onCall?.(m, arg)
      return obj
    }
  }
  obj.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej)
  return obj
}

vi.mock('../src/db/client.js', async () => {
  const schema = await vi.importActual<typeof import('../src/db/schema.js')>('../src/db/schema.js')
  const db = {
    delete: () => chain(H.stateRow === null ? [] : [H.stateRow]),
    select: () => chain([{ id: 7, displayName: 'Alex', telegramUserId: '1001' }]),
    insert: (table: unknown) => {
      H.directInserts.push(table)
      return chain([{ id: 7, displayName: 'Alex' }])
    },
    update: () => chain([]),
  }
  return { schema, getDb: () => db }
})

vi.mock('../src/config.js', () => ({
  getConfig: () => ({
    APP_URL: 'https://your-app.up.railway.app',
    APP_SECRET: 'x'.repeat(48),
    TELEGRAM_USER_ID_1: '1001',
    telegramUserIds: ['1001'],
    googleConfigured: true,
    isProd: true,
  }),
}))

vi.mock('../src/integrations/google.js', () => ({
  authUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
  exchangeCode: async () => H.exchange,
  storeToken: async (
    role: string,
    input: { userId: number; email: string | null; refreshToken: string },
  ) => {
    H.storeTokenCalls.push({ role, userId: input.userId, email: input.email })
  },
}))

vi.mock('../src/integrations/crypto.js', () => ({ encrypt: (v: string) => `enc:${v}` }))
vi.mock('../src/audit/log.js', () => ({ audit: async () => {} }))
vi.mock('../src/telegram/send.js', () => ({ sendToChat: async () => [1] }))

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const l: Record<string, unknown> = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  }
  l.child = () => l
  return { logger: l, child: () => l }
})

const { handleGoogleOAuthCallback } = await import('../src/http/google-oauth.js')
const { schema } = await import('../src/db/client.js')

/** Minimal Hono context: query params in, a Response out. */
function ctx(query: Record<string, string>) {
  return {
    req: {
      query: (k: string) => query[k],
      header: () => undefined,
      path: '/oauth/google/callback',
    },
    html: (body: string, status = 200) => new Response(body, { status }),
    redirect: (url: string) => new Response(null, { status: 302, headers: { location: url } }),
  } as never
}

function freshState(state: string) {
  H.stateRow = {
    id: 1,
    state,
    telegramUserId: '1001',
    expiresAt: new Date(Date.now() + 5 * 60_000),
    createdAt: new Date(),
  }
}

beforeEach(() => {
  H.directInserts.length = 0
  H.storeTokenCalls.length = 0
  H.stateRow = null
})

describe('the oauth callback stores the grant under its role', () => {
  it('stores an assistant grant when the flow began as assistant', async () => {
    freshState('assistant~Ti8qyXNulyFQgsRaa0l')

    const res = await handleGoogleOAuthCallback(ctx({ code: 'auth-code', state: H.stateRow!.state as string }))

    expect(res.status).toBe(200)
    expect(H.storeTokenCalls).toHaveLength(1)
    expect(H.storeTokenCalls[0]?.role).toBe('assistant')
  })

  it('stores a personal grant when the flow began as personal', async () => {
    freshState('personal~Ti8qyXNulyFQgsRaa0l')

    await handleGoogleOAuthCallback(ctx({ code: 'auth-code', state: H.stateRow!.state as string }))

    expect(H.storeTokenCalls[0]?.role).toBe('personal')
  })

  it('treats a state minted before roles existed as personal', async () => {
    freshState('Ti8qyXNulyFQgsRaa0l')

    await handleGoogleOAuthCallback(ctx({ code: 'auth-code', state: H.stateRow!.state as string }))

    expect(H.storeTokenCalls[0]?.role).toBe('personal')
  })

  it('never inserts into google_tokens itself', async () => {
    freshState('personal~Ti8qyXNulyFQgsRaa0l')

    await handleGoogleOAuthCallback(ctx({ code: 'auth-code', state: H.stateRow!.state as string }))

    // The hand-rolled insert is what drifted from the schema. Writing through
    // storeToken is the only way the conflict target stays correct.
    expect(H.directInserts).not.toContain(schema.googleTokens)
  })

  it('passes the linked email and resolved user id through to storage', async () => {
    freshState('personal~Ti8qyXNulyFQgsRaa0l')

    await handleGoogleOAuthCallback(ctx({ code: 'auth-code', state: H.stateRow!.state as string }))

    expect(H.storeTokenCalls[0]?.email).toBe('alex@example.com')
    expect(H.storeTokenCalls[0]?.userId).toBe(7)
  })
})
