import { serve, type ServerType } from '@hono/node-server'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { secureHeaders } from 'hono/secure-headers'
import { getConfig } from '../config.js'
import { getDb } from '../db/client.js'
import { logger } from '../logger.js'
import { handleGoogleOAuthCallback, handleGoogleOAuthStart } from './google-oauth.js'
import { handleHome, handlePrivacy, handleTerms } from './public-pages.js'
import { handleTelegramWebhook } from './telegram-webhook.js'
import { handleTwilioSmsWebhook } from './twilio-webhook.js'
import { handleVapiWebhook } from './vapi-webhook.js'

/**
 * The public HTTP surface.
 *
 * Every route here finishes in milliseconds. Nothing in this file awaits an
 * agent turn: webhooks authenticate, drop a job on the queue, and return.
 * Telegram gives a webhook a few seconds; a turn takes 10–120. Running one
 * inline would guarantee a timeout, a redelivery storm, and eventually a
 * webhook that Telegram switches off.
 */

/** An env var that is set but empty is not a value; Railway hands those out. */
function envValue(name: string): string | undefined {
  const raw = process.env[name]
  const trimmed = raw?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}

/** Deploy identifier for `/healthz`. Read from the process env, not `getConfig()`. */
const VERSION =
  envValue('APP_VERSION') ??
  envValue('RAILWAY_GIT_COMMIT_SHA')?.slice(0, 7) ??
  envValue('npm_package_version') ??
  'dev'

/** Bodies larger than this are refused before a handler ever sees them. */
const MAX_WEBHOOK_BODY_BYTES = 1_048_576 // 1 MiB

/** The health probe answers even when Postgres does not; cap how long it waits. */
const DB_PROBE_TIMEOUT_MS = 2_000

/**
 * `/healthz` is public and unauthenticated. Without a cache every hit is a
 * round trip on the same ten-connection pool the assistant uses to place calls
 * and record approvals, which makes the probe a free amplifier for anyone with
 * the URL. One second is far below any sane healthcheck interval.
 */
const DB_PROBE_CACHE_MS = 1_000

/** How long a shutdown waits for in-flight requests before dropping sockets. */
const SHUTDOWN_GRACE_MS = 10_000

let server: ServerType | null = null
let lastProbe: { at: number; status: 'up' | 'down' } | null = null
let probeInFlight: Promise<'up' | 'down'> | null = null

/* ─────────────────────────────── health probe ────────────────────────────── */

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Never throws. Railway restarts a container whose healthcheck fails, so a
 * thirty-second Postgres blip must not take the whole service down with it —
 * the status goes in the body and the response stays 200.
 */
async function probeDb(): Promise<'up' | 'down'> {
  const cached = lastProbe
  if (cached !== null && Date.now() - cached.at < DB_PROBE_CACHE_MS) return cached.status
  // Concurrent probes share one query rather than each taking a connection.
  if (probeInFlight !== null) return probeInFlight

  const run = (async (): Promise<'up' | 'down'> => {
    try {
      await withTimeout(
        (async () => {
          await getDb().execute(sql`select 1`)
        })(),
        DB_PROBE_TIMEOUT_MS,
      )
      return 'up'
    } catch (err) {
      logger.warn({ err }, 'healthz database probe failed')
      return 'down'
    }
  })()

  probeInFlight = run
  try {
    const status = await run
    lastProbe = { at: Date.now(), status }
    return status
  } finally {
    probeInFlight = null
  }
}

/* ──────────────────────────────── the app ────────────────────────────────── */

/** Keeps the Telegram path secret out of the logs. */
function redactPath(path: string): string {
  return path.replace(/^(\/webhooks\/telegram\/).+$/, '$1***')
}

export function buildServer(): Hono {
  const app = new Hono()

  app.use('*', secureHeaders())

  app.use('*', async (c, next) => {
    const startedAt = Date.now()
    await next()
    logger.debug(
      {
        method: c.req.method,
        path: redactPath(c.req.path),
        status: c.res.status,
        ms: Date.now() - startedAt,
      },
      'http request',
    )
  })

  /**
   * Liveness plus a database read-out. Always 200 while the process is alive.
   */
  app.get('/healthz', async (c) =>
    c.json({
      ok: true,
      version: VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
      db: await probeDb(),
    }),
  )

  /**
   * Public, unauthenticated, and constant. Google's OAuth consent screen needs
   * a home page and a privacy policy before an External app can leave Testing
   * mode, and Twilio's A2P 10DLC review needs the privacy policy and the terms.
   * All three are fetched at moments we do not control — so no page here reads
   * the config or the database.
   */
  app.get('/', handleHome)
  app.get('/privacy', handlePrivacy)
  app.get('/terms', handleTerms)

  const limitBody = bodyLimit({
    maxSize: MAX_WEBHOOK_BODY_BYTES,
    onError: (c) => c.body(null, 413),
  })

  app.post('/webhooks/telegram/:secret', limitBody, handleTelegramWebhook)
  app.post('/webhooks/vapi', limitBody, handleVapiWebhook)
  app.post('/webhooks/twilio/sms', limitBody, handleTwilioSmsWebhook)

  // The callback page names the linked account; neither page is for a cache.
  app.use('/oauth/google/*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store')
  })
  app.get('/oauth/google/start', handleGoogleOAuthStart)
  app.get('/oauth/google/callback', handleGoogleOAuthCallback)

  app.notFound((c) => c.text('not found', 404))

  app.onError((err, c) => {
    logger.error({ err, path: redactPath(c.req.path) }, 'unhandled http error')
    return c.text('internal error', 500)
  })

  return app
}

/* ──────────────────────────────── lifecycle ──────────────────────────────── */

/** Binds the app to `PORT`. Resolves once the socket is actually listening. */
export async function startServer(): Promise<void> {
  const { PORT } = getConfig()
  const app = buildServer()

  await new Promise<void>((resolve, reject) => {
    let instance: ServerType | undefined
    const onFailure = (err: Error): void => {
      // A bind failure leaves a half-open handle that would keep the process
      // alive after the caller has already given up on it.
      instance?.close(() => undefined)
      reject(err)
    }
    instance = serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
      const bound = instance
      if (bound === undefined) return
      bound.off('error', onFailure)
      bound.on('error', (err: Error) => logger.error({ err }, 'http server error'))
      server = bound
      logger.info({ port: info.port, version: VERSION }, 'http server listening')
      resolve()
    })
    instance.once('error', onFailure)
  })
}

/**
 * Node keeps `close()` pending until every socket is gone, and a keep-alive
 * socket sitting idle between requests counts. Telegram, Vapi, and Railway's
 * probe all use keep-alive, so a plain `close()` on SIGTERM waits for their
 * idle timeouts — past the platform's grace period, at which point the process
 * is killed mid-job instead of drained. Close idle sockets first, then give
 * live requests a bounded window before dropping what is left.
 */
type ConnectionCloser = {
  closeIdleConnections?: () => void
  closeAllConnections?: () => void
}

/** Stops accepting connections. Safe to call when the server never started. */
export async function stopServer(): Promise<void> {
  const instance = server
  if (instance === null) return
  server = null

  const closer = instance as unknown as ConnectionCloser

  await new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve()
    }

    timer = setTimeout(() => {
      logger.warn(
        { graceMs: SHUTDOWN_GRACE_MS },
        'http server did not drain in time; dropping remaining connections',
      )
      closer.closeAllConnections?.()
      done()
    }, SHUTDOWN_GRACE_MS)
    timer.unref()

    // Stop accepting first, then hang up the sockets that are only being held
    // open by keep-alive. Requests already in flight keep their connection.
    instance.close(() => {
      logger.info('http server stopped')
      done()
    })
    closer.closeIdleConnections?.()
  })
}
