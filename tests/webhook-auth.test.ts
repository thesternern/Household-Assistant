import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Webhook authentication.
 *
 * The property under test is that the ingress is both closed and quiet: a
 * caller who fails a check learns the request failed and nothing else, and
 * — critically — a rejected caller never causes an agent turn to be queued.
 */

const WEBHOOK_SECRET = 'telegram-webhook-secret-value'
const VAPI_SECRET = 'vapi-webhook-secret-value'

const H = vi.hoisted(() => ({
  /** Every `boss.send()` the handlers issued. */
  sends: [] as Array<{ name: string; data: unknown; options: unknown }>,
  sendResult: 'job-1' as string | null,
  sendError: null as Error | null,
  audits: [] as Array<Record<string, unknown>>,
  /** Rows the fake `select()` returns for the call_records lookup. */
  callRows: [] as Array<{ id: number }>,
  /** Every `insert().values()` the handlers issued. */
  inserts: [] as Array<{ values: unknown }>,
  config: {} as Record<string, unknown>,
}))

vi.mock('../src/config.js', () => ({ getConfig: () => H.config }))

vi.mock('../src/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return { logger, child: () => logger }
})

vi.mock('../src/audit/log.js', () => ({
  audit: async (entry: Record<string, unknown>) => {
    H.audits.push(entry)
  },
}))

vi.mock('../src/jobs/queue.js', () => ({
  QUEUES: {
    tgUpdate: 'tg-update',
    vapiEvent: 'vapi-event',
    executeAction: 'execute-action',
    fireReminder: 'fire-reminder',
    agentTask: 'agent-task',
    watcherPoll: 'watcher-poll',
    browserTask: 'browser-task',
  },
  getBoss: async () => ({
    send: async (name: string, data: unknown, options?: unknown) => {
      if (H.sendError) throw H.sendError
      H.sends.push({ name, data, options })
      return H.sendResult
    },
  }),
  startQueue: async () => {},
  stopQueue: async () => {},
}))

vi.mock('../src/db/client.js', async () => {
  const realSchema = await vi.importActual<typeof import('../src/db/schema.js')>(
    '../src/db/schema.js',
  )
  type Then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => unknown
  const thenTo = (rows: () => unknown[]): Then => (resolve, reject) =>
    Promise.resolve(rows()).then(resolve, reject)

  const makeSelect = () => {
    const builder = {
      from: () => builder,
      where: () => builder,
      limit: () => builder,
      then: thenTo(() => H.callRows),
    }
    return builder
  }
  const makeInsert = () => {
    const builder = {
      values: (values: unknown) => {
        H.inserts.push({ values })
        return builder
      },
      onConflictDoNothing: () => builder,
      onConflictDoUpdate: () => builder,
      returning: () => builder,
      then: thenTo(() => []),
    }
    return builder
  }
  const makeDelete = () => {
    const builder = { where: () => builder, returning: () => builder, then: thenTo(() => []) }
    return builder
  }
  const makeUpdate = () => {
    const builder = { set: () => builder, where: () => builder, then: thenTo(() => []) }
    return builder
  }
  const db = {
    select: () => makeSelect(),
    insert: () => makeInsert(),
    delete: () => makeDelete(),
    update: () => makeUpdate(),
  }
  return {
    getDb: () => db,
    getPool: () => ({}),
    closeDb: async () => {},
    schema: realSchema,
  }
})

vi.mock('../src/integrations/crypto.js', () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ''),
}))

vi.mock('../src/integrations/google.js', () => ({
  authUrl: (state: string) => `https://accounts.google.test/o/oauth2/v2/auth?state=${state}`,
  exchangeCode: async () => ({ refreshToken: 'rt', email: 'alex@example.com', scope: 'scope' }),
  oauthClient: () => ({}),
  GOOGLE_SCOPES: [] as string[],
}))

vi.mock('../src/telegram/send.js', () => ({
  sendToChat: async () => [1],
  sendToAll: async () => {},
}))

const { handleTelegramWebhook, constantTimeEqual, __resetAuditThrottleForTests } = await import(
  '../src/http/telegram-webhook.js'
)
const { handleVapiWebhook } = await import('../src/http/vapi-webhook.js')
const { handleGoogleOAuthStart, googleStartUrl, START_LINK_TTL_MS } = await import(
  '../src/http/google-oauth.js',
)

/* ─────────────────────────────────── harness ─────────────────────────────── */

function telegramApp(): Hono {
  const app = new Hono()
  app.post('/webhooks/telegram/:secret', handleTelegramWebhook)
  return app
}

function vapiApp(): Hono {
  const app = new Hono()
  app.post('/webhooks/vapi', handleVapiWebhook)
  return app
}

/** A plausible private-chat text message from `fromId`. */
function textUpdate(fromId: number | string, text = 'what is on the calendar tomorrow?') {
  return {
    update_id: 4242,
    message: {
      message_id: 17,
      date: 1_756_000_000,
      from: { id: fromId, is_bot: false, first_name: 'Alex' },
      chat: { id: fromId, type: 'private' },
      text,
    },
  }
}

async function postTelegram(opts: {
  pathSecret: string
  headerSecret?: string | null
  body?: unknown
}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.headerSecret !== null && opts.headerSecret !== undefined) {
    headers['X-Telegram-Bot-Api-Secret-Token'] = opts.headerSecret
  }
  return telegramApp().request(`/webhooks/telegram/${encodeURIComponent(opts.pathSecret)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? textUpdate(111)),
  })
}

function oauthApp(): Hono {
  const app = new Hono()
  app.get('/oauth/google/start', handleGoogleOAuthStart)
  return app
}

async function getStart(query: string): Promise<Response> {
  return oauthApp().request(`/oauth/google/start${query}`)
}

async function postVapi(opts: { secret?: string | null; body: unknown }): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.secret !== null && opts.secret !== undefined) headers['x-vapi-secret'] = opts.secret
  return vapiApp().request('/webhooks/vapi', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body),
  })
}

beforeEach(() => {
  H.sends.length = 0
  H.audits.length = 0
  H.callRows.length = 0
  H.inserts.length = 0
  H.sendResult = 'job-1'
  H.sendError = null
  H.config = {
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    VAPI_WEBHOOK_SECRET: VAPI_SECRET,
    TELEGRAM_USER_ID_1: '111',
    TELEGRAM_USER_ID_2: '222',
    telegramUserIds: ['111', '222'],
    APP_URL: 'https://household.example',
    APP_SECRET: 'a'.repeat(48),
    googleConfigured: true,
  }
  __resetAuditThrottleForTests()
})

/* ──────────────────────────────── telegram ───────────────────────────────── */

describe('POST /webhooks/telegram/:secret', () => {
  it('rejects a wrong path secret with a bare 401', async () => {
    const res = await postTelegram({
      pathSecret: 'not-the-secret',
      headerSecret: WEBHOOK_SECRET,
    })

    expect(res.status).toBe(401)
    expect(await res.text()).toBe('')
    expect(H.sends).toHaveLength(0)
  })

  it('rejects a right path secret with a wrong header secret', async () => {
    const res = await postTelegram({
      pathSecret: WEBHOOK_SECRET,
      headerSecret: 'wrong-header-value',
    })

    expect(res.status).toBe(401)
    expect(await res.text()).toBe('')
    expect(H.sends).toHaveLength(0)
  })

  it('rejects a missing header secret even when the path secret is right', async () => {
    const res = await postTelegram({ pathSecret: WEBHOOK_SECRET, headerSecret: null })

    expect(res.status).toBe(401)
    expect(H.sends).toHaveLength(0)
  })

  it('checks the path secret before the header secret', async () => {
    await postTelegram({ pathSecret: 'not-the-secret', headerSecret: 'also-wrong' })

    expect(H.audits.map((a) => a.event)).toEqual(['telegram_webhook_bad_path_secret'])
  })

  it('does not accept a secret that merely shares a prefix', async () => {
    const res = await postTelegram({
      pathSecret: WEBHOOK_SECRET.slice(0, -1),
      headerSecret: WEBHOOK_SECRET,
    })

    expect(res.status).toBe(401)
    expect(H.sends).toHaveLength(0)
  })

  it('never matches an unset configured secret, and only matches an exact one', () => {
    // An empty configured secret means "not configured", which must match
    // nothing — including an omitted or empty candidate.
    expect(constantTimeEqual('', '')).toBe(false)
    expect(constantTimeEqual('', WEBHOOK_SECRET)).toBe(false)
    expect(constantTimeEqual(WEBHOOK_SECRET, '')).toBe(false)
    expect(constantTimeEqual(undefined, WEBHOOK_SECRET)).toBe(false)
    expect(constantTimeEqual(`${WEBHOOK_SECRET}x`, WEBHOOK_SECRET)).toBe(false)
    expect(constantTimeEqual(WEBHOOK_SECRET, WEBHOOK_SECRET)).toBe(true)
  })

  it('answers 200 and queues nothing when the sender is not whitelisted', async () => {
    const res = await postTelegram({
      pathSecret: WEBHOOK_SECRET,
      headerSecret: WEBHOOK_SECRET,
      body: textUpdate(999_999),
    })

    // Same status as the accepted case: the status code must not reveal
    // whether a given Telegram user id is in the household.
    expect(res.status).toBe(200)
    expect(H.sends).toHaveLength(0)
    expect(H.audits.map((a) => a.event)).toContain('telegram_webhook_unauthorized_user')
  })

  it('is indistinguishable from success for a stranger', async () => {
    const stranger = await postTelegram({
      pathSecret: WEBHOOK_SECRET,
      headerSecret: WEBHOOK_SECRET,
      body: textUpdate(999_999),
    })
    const strangerBody = await stranger.text()

    H.sends.length = 0
    __resetAuditThrottleForTests()

    const member = await postTelegram({
      pathSecret: WEBHOOK_SECRET,
      headerSecret: WEBHOOK_SECRET,
      body: textUpdate(111),
    })

    expect(stranger.status).toBe(member.status)
    expect(strangerBody).toBe(await member.text())
  })

  it('accepts a whitelisted sender and enqueues exactly one job', async () => {
    const res = await postTelegram({
      pathSecret: WEBHOOK_SECRET,
      headerSecret: WEBHOOK_SECRET,
      body: textUpdate(222, 'add milk to the list'),
    })

    expect(res.status).toBe(200)
    expect(H.sends).toHaveLength(1)

    const sent = H.sends[0]
    expect(sent?.name).toBe('tg-update')
    expect(sent?.options).toEqual({ singletonKey: 'chat:222' })

    const job = sent?.data as Record<string, unknown>
    expect(job.chatId).toBe('222')
    expect(job.fromId).toBe('222')
    expect(job.actor).toBe('Alex')
    expect(job.text).toBe('add milk to the list')
    expect(job.update).toMatchObject({ update_id: 4242 })
  })

  it('enqueues callback queries with the same per-chat singleton key', async () => {
    const res = await postTelegram({
      pathSecret: WEBHOOK_SECRET,
      headerSecret: WEBHOOK_SECRET,
      body: {
        update_id: 99,
        callback_query: {
          id: 'cbq-1',
          from: { id: 111, first_name: 'Alex' },
          data: 'ap:12:yes',
          message: { message_id: 3, chat: { id: 111, type: 'private' } },
        },
      },
    })

    expect(res.status).toBe(200)
    expect(H.sends).toHaveLength(1)
    expect(H.sends[0]?.options).toEqual({ singletonKey: 'chat:111' })
    const job = H.sends[0]?.data as Record<string, unknown>
    expect(job.callbackData).toBe('ap:12:yes')
    expect(job.callbackQueryId).toBe('cbq-1')
  })

  it('does not pass the bot\u2019s own card text off as the sender\u2019s message', async () => {
    // `callback_query.message` is the approval card we sent. Forwarding its
    // text as `text` would let the worker feed the bot's own words back into a
    // turn as if a spouse had typed them.
    await postTelegram({
      pathSecret: WEBHOOK_SECRET,
      headerSecret: WEBHOOK_SECRET,
      body: {
        update_id: 100,
        callback_query: {
          id: 'cbq-2',
          from: { id: 111, first_name: 'Alex' },
          data: 'ap:12:yes',
          message: {
            message_id: 8,
            chat: { id: 111, type: 'private' },
            text: 'Send an email to the plumber? [Approve] [Reject]',
          },
        },
      },
    })

    const job = H.sends[0]?.data as Record<string, unknown>
    expect(job.text).toBeNull()
    expect(job.callbackData).toBe('ap:12:yes')
    // The card's id is still forwarded so the worker can edit it in place.
    expect(job.messageId).toBe(8)
  })

  it('does not let a non-scalar id coerce its way past the whitelist', async () => {
    // `String(['111']) === '111'`, so a loose coercion would admit this.
    const res = await postTelegram({
      pathSecret: WEBHOOK_SECRET,
      headerSecret: WEBHOOK_SECRET,
      body: {
        update_id: 7,
        message: {
          message_id: 1,
          from: { id: ['111'], first_name: 'Mallory' },
          chat: { id: ['111'], type: 'private' },
          text: 'delete everything',
        },
      },
    })

    expect(res.status).toBe(200)
    expect(H.sends).toHaveLength(0)
  })

  it('returns 500 so Telegram redelivers when the enqueue fails', async () => {
    H.sendError = new Error('queue unavailable')

    const res = await postTelegram({ pathSecret: WEBHOOK_SECRET, headerSecret: WEBHOOK_SECRET })

    expect(res.status).toBe(500)
  })

  it('acks a malformed body instead of triggering a Telegram retry loop', async () => {
    const res = await telegramApp().request(`/webhooks/telegram/${WEBHOOK_SECRET}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
      },
      body: 'not json at all',
    })

    expect(res.status).toBe(200)
    expect(H.sends).toHaveLength(0)
  })
})

/* ────────────────────────────────── vapi ─────────────────────────────────── */

describe('POST /webhooks/vapi', () => {
  const report = (callId: string) => ({
    message: {
      type: 'end-of-call-report',
      call: { id: callId },
      summary: 'The clinic confirmed Tuesday at 3pm.',
    },
  })

  it('rejects a wrong secret with a bare 401', async () => {
    const res = await postVapi({ secret: 'wrong', body: report('call-1') })

    expect(res.status).toBe(401)
    expect(await res.text()).toBe('')
    expect(H.sends).toHaveLength(0)
  })

  it('rejects a missing secret', async () => {
    const res = await postVapi({ secret: null, body: report('call-1') })

    expect(res.status).toBe(401)
    expect(H.sends).toHaveLength(0)
  })

  it('rejects everything when VAPI_WEBHOOK_SECRET is unset', async () => {
    H.config.VAPI_WEBHOOK_SECRET = ''

    const res = await postVapi({ secret: '', body: report('call-1') })

    expect(res.status).toBe(401)
    expect(H.sends).toHaveLength(0)
  })

  it('rejects a valid secret carrying an unknown call id', async () => {
    H.callRows.length = 0

    const res = await postVapi({ secret: VAPI_SECRET, body: report('forged-call') })

    // A leaked secret alone must not let anyone inject a fabricated outcome.
    expect(res.status).toBe(401)
    expect(H.sends).toHaveLength(0)
    expect(H.audits.map((a) => a.event)).toContain('vapi_webhook_unknown_call')
  })

  it('rejects a payload with no call id at all', async () => {
    const res = await postVapi({ secret: VAPI_SECRET, body: { message: { type: 'hang' } } })

    expect(res.status).toBe(401)
    expect(H.sends).toHaveLength(0)
  })

  it('accepts a known call id and enqueues exactly one job', async () => {
    H.callRows.push({ id: 77 })

    const res = await postVapi({ secret: VAPI_SECRET, body: report('call-abc') })

    expect(res.status).toBe(200)
    expect(H.sends).toHaveLength(1)

    const sent = H.sends[0]
    expect(sent?.name).toBe('vapi-event')
    const job = sent?.data as Record<string, unknown>
    expect(job.callId).toBe('call-abc')
    expect(job.callRecordId).toBe(77)
    expect(job.messageType).toBe('end-of-call-report')
    // src/jobs/queue.ts types this queue as `{ payload: unknown }` and its
    // worker reads `job.data.payload`. Drop this and every call event — the
    // end-of-call report included — reaches the worker as `undefined`.
    expect(job.payload).toEqual(report('call-abc'))
  })

  it('never queues an event it could not queue', async () => {
    H.callRows.push({ id: 77 })
    H.sendResult = null

    const res = await postVapi({ secret: VAPI_SECRET, body: report('call-abc') })

    // Acking an event nothing will process loses the call outcome outright.
    expect(res.status).toBe(503)
  })

  it('throttles rejection audits so a scanner cannot amplify into Postgres', async () => {
    await postVapi({ secret: 'wrong', body: report('call-1') })
    await postVapi({ secret: 'wrong', body: report('call-2') })
    await postVapi({ secret: 'wrong', body: report('call-3') })

    const rows = H.audits.filter((a) => a.event === 'vapi_webhook_bad_secret')
    expect(rows).toHaveLength(1)
  })
})

/* ─────────────────────────── google oauth /start ─────────────────────────── */

describe('GET /oauth/google/start', () => {
  it('refuses an unsigned start link and writes no state row', async () => {
    // Anyone can reach this URL. The callback upserts on google_tokens.user_id,
    // so an accepted unsigned start lets a stranger replace the household's
    // refresh token with one for their own Google account.
    const res = await getStart('?uid=111')

    expect(res.status).toBe(400)
    expect(H.inserts).toHaveLength(0)
    expect(H.audits.map((a) => a.event)).toContain('google_oauth_start_rejected')
  })

  it('refuses a bare start link even when only one user is configured', async () => {
    H.config.telegramUserIds = ['111']
    H.config.TELEGRAM_USER_ID_2 = ''

    const res = await getStart('')

    expect(res.status).toBe(400)
    expect(H.inserts).toHaveLength(0)
  })

  it('refuses a signature minted for a different user', async () => {
    const forOther = new URL(googleStartUrl('222'))

    const res = await getStart(`?uid=111&sig=${forOther.searchParams.get('sig') ?? ''}`)

    expect(res.status).toBe(400)
    expect(H.inserts).toHaveLength(0)
  })

  it('accepts a link built by googleStartUrl and redirects to Google', async () => {
    const link = new URL(googleStartUrl('111'))
    expect(link.origin).toBe('https://household.example')

    const res = await getStart(`?${link.searchParams.toString()}`)

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/^https:\/\/accounts\.google\.test\//)
    expect(H.inserts).toHaveLength(1)
    const row = H.inserts[0]?.values as Record<string, unknown>
    expect(row.telegramUserId).toBe('111')
    expect(typeof row.state).toBe('string')
  })

  it('refuses a signed link for a user who is not whitelisted', async () => {
    const link = new URL(googleStartUrl('333'))
    H.config.telegramUserIds = ['111', '222']

    const res = await getStart(`?${link.searchParams.toString()}`)

    expect(res.status).toBe(400)
    expect(H.inserts).toHaveLength(0)
  })

  it('refuses a link once it is older than its lifetime', async () => {
    // The link sits in Telegram history for good. A screenshot from months ago
    // must not still be able to replace the household's Google grant.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-07T12:00:00Z'))
      const link = new URL(googleStartUrl('111'))

      vi.setSystemTime(new Date(Date.now() + START_LINK_TTL_MS + 1_000))
      const res = await getStart(`?${link.searchParams.toString()}`)

      expect(res.status).toBe(400)
      expect(H.inserts).toHaveLength(0)
      expect(H.audits.map((a) => a.event)).toContain('google_oauth_start_rejected')
    } finally {
      vi.useRealTimers()
    }
  })

  it('still accepts a link inside its lifetime', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-07T12:00:00Z'))
      const link = new URL(googleStartUrl('111'))

      vi.setSystemTime(new Date(Date.now() + START_LINK_TTL_MS - 60_000))
      const res = await getStart(`?${link.searchParams.toString()}`)

      expect(res.status).toBe(302)
      expect(H.inserts).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a link whose issued-at stamp was pushed forward', async () => {
    // The stamp is under the signature, so editing it cannot buy more time.
    const link = new URL(googleStartUrl('111'))
    link.searchParams.set('ts', String(Date.now() + 10 * 60_000))

    const res = await getStart(`?${link.searchParams.toString()}`)

    expect(res.status).toBe(400)
    expect(H.inserts).toHaveLength(0)
  })

  it('refuses a link with no issued-at stamp at all', async () => {
    const link = new URL(googleStartUrl('111'))
    link.searchParams.delete('ts')

    const res = await getStart(`?${link.searchParams.toString()}`)

    expect(res.status).toBe(400)
    expect(H.inserts).toHaveLength(0)
  })
})

/* ──────────────────────── rejection-audit throttle key ───────────────────── */

describe('rejection audit throttle', () => {
  it('keys on the proxy-appended forwarded-for entry, not the one the client chose', async () => {
    // A scanner that changes the first X-Forwarded-For entry on every request
    // must not get a fresh throttle key each time, or every rejected POST is
    // one Postgres insert on the pool the assistant runs on.
    for (let i = 0; i < 5; i += 1) {
      await telegramApp().request('/webhooks/telegram/wrong-secret', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `10.0.0.${i}, 203.0.113.7`,
        },
        body: JSON.stringify(textUpdate(111)),
      })
    }

    const rows = H.audits.filter((a) => a.event === 'telegram_webhook_bad_path_secret')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.resultSummary).toBe('rejected from 203.0.113.7')
  })
})
