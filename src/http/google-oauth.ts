import { createHmac, randomBytes } from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import type { Context } from 'hono'
import { audit } from '../audit/log.js'
import { getConfig } from '../config.js'
import { getDb, schema } from '../db/client.js'
import { GOOGLE_ACCOUNT_ROLES } from '../db/schema.js'
import type { GoogleAccountRole } from '../db/schema.js'
import { authUrl, exchangeCode, storeToken } from '../integrations/google.js'
import { logger } from '../logger.js'
import { sendToChat } from '../telegram/send.js'
import { callerHint, constantTimeEqual, shouldAuditRejection } from './telegram-webhook.js'

/**
 * Google OAuth consent flow, for either of the household's two accounts.
 *
 *   GET /oauth/google/start     -> mints a state row, redirects to Google
 *   GET /oauth/google/callback  -> validates state, exchanges the code, stores
 *                                  an encrypted refresh token under its role
 *
 * The role — `personal` (a spouse's own Gmail and the family calendar) or
 * `assistant` (the assistant's own Workspace mailbox) — is chosen at `/start`
 * and has to survive a round trip through Google. It travels inside the state
 * token, which means it is stored in the `oauth_states` row and read back from
 * that row, never from the callback's query string. A caller who tampers with
 * the role on the way back changes nothing: the stored state is the authority,
 * and the state itself is what the single-use DELETE consumes.
 *
 * `/start` requires a valid APP_SECRET-derived `sig`, so the only way to begin
 * a flow is a link this service generated with {@link googleStartUrl}. Without
 * that requirement the route is a takeover of the household's Google
 * integration: the callback upserts on `google_tokens.user_id`, so a stranger
 * who reaches consent replaces the household's refresh token with one for their
 * own account, and every subsequent calendar read and email send runs there.
 *
 * The state row is the whole of the CSRF defence. It is random, it expires in
 * ten minutes, it is bound to one Telegram user id, and it is consumed by an
 * atomic `DELETE ... RETURNING` so a replayed callback finds nothing.
 *
 * Every failure — bad state, expired state, Google saying no, a database
 * error — renders the same neutral page. A page that explained which check
 * failed would hand an attacker a debugger for their own probing.
 */

const STATE_TTL_MINUTES = 10

/* ──────────────────────────────── start links ────────────────────────────── */

/**
 * How long a start link stays usable after `/connect_google` minted it.
 *
 * The link is a bearer capability: whoever opens it can consent with any
 * Google account, and the callback upserts on the role, replacing the
 * household's grant. It is sent as a plain Telegram message and stays in the
 * chat history for good, so without an expiry a screenshot or an unlocked
 * phone from months ago still works today. Fifteen minutes is enough to read
 * the message and tap it; it is not enough to be dug up later.
 */
export const START_LINK_TTL_MS = 15 * 60_000

/** Clock skew tolerated before an issued-at stamp counts as from the future. */
const START_LINK_SKEW_MS = 60_000

/** An issued-at stamp is epoch milliseconds, and nothing else. */
const ISSUED_AT_RE = /^\d{1,16}$/

/**
 * Signs a Telegram user id, a role, and the moment the link was minted, so a
 * start link cannot be forged by someone who merely guesses APP_URL and a
 * Telegram user id — and cannot be kept. Prefer {@link googleStartUrl} when
 * generating the link the household clicks.
 */
function signStartLink(telegramUserId: string, role: GoogleAccountRole, issuedAt: number): string {
  const { APP_SECRET } = getConfig()
  // The role is signed too, so a link for the personal account cannot be
  // edited into one that replaces the assistant's grant; the timestamp is
  // signed so the expiry below cannot be pushed out by editing the query.
  return createHmac('sha256', APP_SECRET)
    .update(`google-oauth-start:${telegramUserId}:${role}:${issuedAt}`)
    .digest('base64url')
    .slice(0, 32)
}

/**
 * Builds the consent link to send a spouse over Telegram, e.g. from `/setup`.
 * This is the only way to produce a link `/oauth/google/start` accepts — the
 * `sig` it appends is mandatory there.
 */
export function googleStartUrl(
  telegramUserId: string,
  role: GoogleAccountRole = DEFAULT_ROLE,
): string {
  const { APP_URL } = getConfig()
  const base = APP_URL.replace(/\/+$/, '')
  const issuedAt = Date.now()
  const params = new URLSearchParams({
    uid: telegramUserId,
    role,
    ts: String(issuedAt),
    sig: signStartLink(telegramUserId, role, issuedAt),
  })
  return `${base}/oauth/google/start?${params.toString()}`
}

/* ──────────────────────────────── account roles ──────────────────────────── */

/** What a link with no role means: the family's own account. */
const DEFAULT_ROLE: GoogleAccountRole = 'personal'

/**
 * Separates the role from the random half of a state token.
 *
 * `~` is outside the base64url alphabet, so it can never appear in the random
 * part and the split is unambiguous.
 */
const STATE_SEPARATOR = '~'

function isRole(value: unknown): value is GoogleAccountRole {
  return typeof value === 'string' && (GOOGLE_ACCOUNT_ROLES as readonly string[]).includes(value)
}

/**
 * A state token that carries its own role.
 *
 * The role has to be stored with the state so the callback knows which grant it
 * is writing, and `oauth_states` has no column for it — so it rides inside the
 * value that column already holds. The randomness is unchanged: 32 bytes, the
 * whole of the CSRF strength, with a prefix that is not secret and does not
 * need to be.
 */
function mintState(role: GoogleAccountRole): string {
  return `${role}${STATE_SEPARATOR}${randomBytes(32).toString('base64url')}`
}

/** Reads the role back off a stored state. States minted before roles are personal. */
function roleFromState(state: string): GoogleAccountRole {
  const prefix = state.split(STATE_SEPARATOR)[0]
  return isRole(prefix) ? prefix : DEFAULT_ROLE
}

/* ─────────────────────────────────── pages ───────────────────────────────── */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 24px; }
  main { max-width: 30rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0; opacity: .8; }
</style>
</head>
<body><main>${body}</main></body>
</html>`
}

function successPage(email: string): string {
  return page(
    'Connected',
    `<h1>Google account connected</h1><p>${escapeHtml(email)} is linked. You can close this tab.</p>`,
  )
}

/** One page for every failure. It says nothing about which check failed. */
function errorPage(): string {
  return page(
    'Something went wrong',
    '<h1>Something went wrong</h1><p>The connection could not be completed. Ask the assistant for a fresh link and try again.</p>',
  )
}

function neutralError(c: Context): Response {
  return c.html(errorPage(), 400)
}

/**
 * A provider error is not safe to log whole.
 *
 * A googleapis token-exchange failure is a `GaxiosError` carrying an enumerable
 * `config`, and that config's body is `client_secret=…&code=…`. pino's default
 * error serializer copies an error's own enumerable properties into the log
 * line, so `logger.error({ err })` on this path would print the Google client
 * secret and a live authorisation code. Keep the name and the message; drop
 * everything else.
 */
function describeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message.slice(0, 500) }
  return { name: 'Error', message: String(err).slice(0, 500) }
}

/**
 * Audits a refusal on one of the two anonymous OAuth routes, at most once per
 * (event, source) per minute — the same throttle the webhooks use. Both routes
 * are GET, reachable by anyone, and refuse before authenticating anything, so
 * an unthrottled audit hands a scanner one Postgres INSERT per request.
 */
async function auditRefusal(
  c: Context,
  event: string,
  resultSummary: string,
  actor = 'anonymous',
): Promise<void> {
  if (!shouldAuditRejection(`${event}:${callerHint(c)}`)) return
  await audit({ actor, event, ok: false, resultSummary })
}

/* ─────────────────────────────── /oauth/google/start ─────────────────────── */

type StartTarget =
  | { ok: true; id: string; role: GoogleAccountRole }
  | { ok: false; reason: 'unknown_user' | 'bad_signature' | 'unknown_role' | 'expired_link' }

/**
 * Resolves which household member this flow is for, and refuses unless the
 * link was signed by this service.
 *
 * `uid` must name a whitelisted Telegram user; when exactly one is configured
 * an omitted `uid` resolves to them, since there is nothing to choose between.
 * Either way the `sig` must match — the whitelist alone is not authentication,
 * because a Telegram user id is not a secret and leaks to every bot its owner
 * has ever messaged. The signature covers the role as well, so which account a
 * consent flow will overwrite is fixed when the link is minted.
 */
function resolveTelegramUserId(c: Context): StartTarget {
  const cfg = getConfig()
  const requested =
    c.req.query('uid') ?? c.req.query('u') ?? c.req.query('telegram_user_id') ?? null
  const only = cfg.telegramUserIds.length === 1 ? cfg.telegramUserIds[0] : undefined
  const id = requested ?? only ?? null

  const requestedRole = c.req.query('role') ?? c.req.query('account') ?? null
  if (requestedRole !== null && !isRole(requestedRole)) return { ok: false, reason: 'unknown_role' }
  const role: GoogleAccountRole = requestedRole ?? DEFAULT_ROLE

  if (id === null || !cfg.telegramUserIds.includes(id)) return { ok: false, reason: 'unknown_user' }

  // The stamp is read as text and re-signed, never trusted on its own: a
  // rewritten `ts` fails the signature, and a link signed without one (any
  // link minted before stamps existed) fails it too.
  const stamp = c.req.query('ts') ?? ''
  if (!ISSUED_AT_RE.test(stamp)) return { ok: false, reason: 'bad_signature' }
  const issuedAt = Number(stamp)
  if (!constantTimeEqual(c.req.query('sig'), signStartLink(id, role, issuedAt))) {
    return { ok: false, reason: 'bad_signature' }
  }

  const age = Date.now() - issuedAt
  if (age > START_LINK_TTL_MS || age < -START_LINK_SKEW_MS) {
    return { ok: false, reason: 'expired_link' }
  }
  return { ok: true, id, role }
}

/** Handles `GET /oauth/google/start`. */
export async function handleGoogleOAuthStart(c: Context): Promise<Response> {
  const cfg = getConfig()

  if (!cfg.googleConfigured) {
    logger.warn('google oauth start hit while GOOGLE_CLIENT_ID/SECRET are unset')
    await auditRefusal(
      c,
      'google_oauth_start_unconfigured',
      'google client credentials are not configured',
    )
    return neutralError(c)
  }

  const target = resolveTelegramUserId(c)
  if (!target.ok) {
    // Refused before the state row is written, so an unsigned caller cannot
    // turn this route into an unauthenticated INSERT loop either.
    logger.warn({ reason: target.reason }, 'google oauth start refused')
    await auditRefusal(
      c,
      'google_oauth_start_rejected',
      target.reason === 'unknown_user'
        ? 'no whitelisted telegram user id on the start link'
        : target.reason === 'unknown_role'
          ? `start link named an account that does not exist (expected ${GOOGLE_ACCOUNT_ROLES.join(' or ')})`
          : target.reason === 'expired_link'
            ? 'start link is older than its lifetime — run /connect_google again for a fresh one'
            : 'start link was unsigned or carried a bad signature — generate links with googleStartUrl()',
    )
    return neutralError(c)
  }

  // The role rides inside the state, so it is stored with it and read back from
  // the stored row rather than from anything the callback is handed.
  const state = mintState(target.role)
  const expiresAt = new Date(Date.now() + STATE_TTL_MINUTES * 60_000)

  try {
    const db = getDb()
    // Housekeeping: expired states are dead weight and this is the only route
    // that creates them. Best-effort — a failed sweep must not block a real
    // connection attempt.
    try {
      await db.delete(schema.oauthStates).where(lt(schema.oauthStates.expiresAt, new Date()))
    } catch (err) {
      logger.warn({ err }, 'could not sweep expired oauth states')
    }
    await db.insert(schema.oauthStates).values({ state, telegramUserId: target.id, expiresAt })
  } catch (err) {
    logger.error({ err }, 'failed to persist google oauth state')
    return neutralError(c)
  }

  await audit({
    actor: target.id,
    event: 'google_oauth_start',
    ok: true,
    resultSummary: `signed start link for the ${target.role} account`,
  })

  return c.redirect(authUrl(state), 302)
}

/* ────────────────────────────── /oauth/google/callback ───────────────────── */

/** Derives a display name for a user row we are meeting for the first time. */
function nameFromEmail(email: string, fallback: string): string {
  const local = email.split('@')[0] ?? ''
  const cleaned = local.replace(/[._-]+/g, ' ').trim()
  if (cleaned.length === 0) return `user ${fallback}`
  return cleaned
    .split(/\s+/)
    .map((part) => (part.length === 0 ? part : (part[0] ?? '').toUpperCase() + part.slice(1)))
    .join(' ')
}

/** Handles `GET /oauth/google/callback`. */
export async function handleGoogleOAuthCallback(c: Context): Promise<Response> {
  const cfg = getConfig()

  const denied = c.req.query('error')
  if (denied !== undefined && denied !== '') {
    // Query text from whoever hit the URL. Bound it and strip control
    // characters before it lands in a log line or an audit summary.
    const reason = denied.replace(/[\u0000-\u001F\u007F]/g, '?').slice(0, 80)
    logger.warn({ error: reason }, 'google oauth consent was declined')
    await auditRefusal(c, 'google_oauth_callback_denied', `google returned error=${reason}`)
    return neutralError(c)
  }

  const code = c.req.query('code')
  const state = c.req.query('state')
  if (!code || !state) {
    await auditRefusal(c, 'google_oauth_callback_malformed', 'callback was missing code or state')
    return neutralError(c)
  }

  const db = getDb()

  // Single-use, atomically: whoever wins the DELETE owns this state. A replay
  // — or two tabs racing — finds no row and gets the neutral page.
  let consumed: typeof schema.oauthStates.$inferSelect | undefined
  try {
    const rows = await db
      .delete(schema.oauthStates)
      .where(eq(schema.oauthStates.state, state))
      .returning()
    consumed = rows[0]
  } catch (err) {
    logger.error({ err }, 'failed to consume google oauth state')
    return neutralError(c)
  }

  if (consumed === undefined) {
    logger.warn('google oauth callback presented an unknown or already-used state')
    await auditRefusal(
      c,
      'google_oauth_callback_bad_state',
      'state was unknown or already consumed',
    )
    return neutralError(c)
  }

  if (consumed.expiresAt.getTime() <= Date.now()) {
    logger.warn({ telegramUserId: consumed.telegramUserId }, 'google oauth state had expired')
    await audit({
      actor: consumed.telegramUserId,
      event: 'google_oauth_callback_expired_state',
      ok: false,
      resultSummary: `state older than ${STATE_TTL_MINUTES} minutes`,
    })
    return neutralError(c)
  }

  // The whitelist can change between start and callback.
  if (!cfg.telegramUserIds.includes(consumed.telegramUserId)) {
    logger.warn(
      { telegramUserId: consumed.telegramUserId },
      'google oauth state belonged to a user who is no longer whitelisted',
    )
    await audit({
      actor: consumed.telegramUserId,
      event: 'google_oauth_callback_unwhitelisted',
      ok: false,
      resultSummary: 'telegram user is no longer in the household whitelist',
    })
    return neutralError(c)
  }

  try {
    const { refreshToken, email, scope } = await exchangeCode(code)

    // Resolve — or create — the household user row this token belongs to.
    const existing = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.telegramUserId, consumed.telegramUserId))
      .limit(1)
    let user = existing[0]
    if (user === undefined) {
      const inserted = await db
        .insert(schema.users)
        .values({
          telegramUserId: consumed.telegramUserId,
          displayName: nameFromEmail(email, consumed.telegramUserId),
          isPrimary: consumed.telegramUserId === cfg.TELEGRAM_USER_ID_1,
        })
        .onConflictDoNothing({ target: schema.users.telegramUserId })
        .returning()
      user = inserted[0]
      if (user === undefined) {
        // Lost the insert race; the row exists now.
        const reread = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.telegramUserId, consumed.telegramUserId))
          .limit(1)
        user = reread[0]
      }
    }
    if (user === undefined) throw new Error('could not resolve a user row for the oauth callback')

    // The role comes off the stored state, never the callback's query string,
    // so which grant this flow may overwrite was fixed when the link was minted.
    //
    // `storeToken` owns the write because it owns the conflict target. Migration
    // 0001 moved the unique index from `user_id` to `role`; an insert spelled
    // out here drifted from that and failed every callback outright.
    const role = roleFromState(consumed.state)
    await storeToken(role, { userId: user.id, email, refreshToken, scope })

    await db.update(schema.users).set({ googleConnected: true }).where(eq(schema.users.id, user.id))

    await audit({
      actor: user.displayName,
      event: 'google_oauth_connected',
      ok: true,
      // `email` is household data, not a secret; the refresh token never appears.
      resultSummary: `connected ${email} as the ${role} account`,
    })

    // A failed Telegram notice must not undo a successful connection.
    try {
      await sendToChat(
        consumed.telegramUserId,
        `Google account connected: ${email}. Calendar and Gmail are live.`,
      )
    } catch (err) {
      // A grammY HttpError can carry the bot-token URL in its cause; log the
      // shape of the failure, not the object.
      logger.warn(
        { err: describeError(err) },
        'google connected but the telegram confirmation failed to send',
      )
    }

    logger.info({ userId: user.id, email, role }, 'google account connected')
    return c.html(successPage(email))
  } catch (err) {
    const described = describeError(err)
    logger.error({ err: described }, 'google oauth callback failed')
    await audit({
      actor: consumed.telegramUserId,
      event: 'google_oauth_callback_failed',
      ok: false,
      resultSummary: described.message.length > 0 ? described.message : 'unknown error',
    })
    return neutralError(c)
  }
}
