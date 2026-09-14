import { and, asc, eq } from 'drizzle-orm'
import { Auth, google } from 'googleapis'
import type { calendar_v3, gmail_v1 } from 'googleapis'
import { audit } from '../audit/log.js'
import { getConfig } from '../config.js'
import { getDb, schema } from '../db/client.js'
import { GOOGLE_ACCOUNT_ROLES } from '../db/schema.js'
import type { GoogleAccountRole } from '../db/schema.js'
import { logger } from '../logger.js'
import { decrypt, encrypt } from './crypto.js'

/**
 * The household's two Google connections.
 *
 * Every function here takes a `role`, and the role decides which mailbox the
 * call acts as:
 *
 *  - `personal` — a spouse's own Gmail and the family calendar. Read-mostly:
 *    the daycare watchers, inbox triage, and the morning brief all need to see
 *    what actually arrives. This is the default everywhere, so a caller that
 *    passes no role keeps the behaviour it had when there was only one account.
 *  - `assistant` — the assistant's own Workspace mailbox on the family domain.
 *    It is what the assistant SENDS as, and where replies to its own mail land
 *    so they never drown in a human's inbox.
 *
 * `google_tokens` is unique on role, so there is exactly one grant per role.
 * Each refresh token lives encrypted in that row; nothing here ever logs or
 * returns one.
 *
 * The roles never substitute for one another. A caller that asks for the
 * assistant account and finds it unconnected gets `null` — never the personal
 * account wearing a different hat. Mail from the wrong address is the exact
 * failure this split exists to prevent.
 *
 * The contract every caller depends on: **these functions return `null` rather
 * than throwing when Google is unavailable.** A revoked grant is an ordinary
 * Tuesday — the token expires, someone changes their password, Google rotates
 * consent — and it must degrade into "I can't see the calendar right now",
 * never into a crashed worker. When the grant is genuinely dead we mark the row
 * invalid, write an audit line, and ask both spouses to reconnect that one
 * account exactly once — naming which account died, because the fix differs.
 */

export type OAuth2Client = Auth.OAuth2Client

/**
 * Everything the assistant is allowed to do as the household.
 *
 * `calendar` is read/write because the scheduler creates and moves events.
 * Gmail is split deliberately: `readonly` to search and read, `compose` to build
 * drafts, `send` to actually deliver — no `gmail.modify`, so the assistant can
 * never label, archive, or delete anyone's mail. `userinfo.email` only exists so
 * the connect flow can tell the household which account it just linked.
 */
export const GOOGLE_SCOPES: string[] = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
]

/** Path the OAuth consent screen redirects back to. The HTTP router serves this. */
export const GOOGLE_CALLBACK_PATH = '/oauth/google/callback'

/** Google Calendar's own name for "the authorised account's default calendar". */
export const PRIMARY_CALENDAR_ID = 'primary'

const log = logger.child({ mod: 'google' })

/* ─────────────────────────────────── roles ───────────────────────────────── */

/**
 * What a caller gets when it says nothing.
 *
 * `personal` on purpose: every call site that predates the second account —
 * the calendar tools, the watchers, the morning brief — means the family's own
 * mailbox, and silence must keep meaning that.
 */
export const DEFAULT_GOOGLE_ROLE: GoogleAccountRole = 'personal'

/** How each account is described to a human, in a sentence. */
export const GOOGLE_ROLE_LABELS: Record<GoogleAccountRole, string> = {
  personal: "the family's own Google account",
  assistant: "the assistant's own Google account",
}

/** The one-line explanation of what each account is for. */
export const GOOGLE_ROLE_PURPOSE: Record<GoogleAccountRole, string> = {
  personal: 'your own Gmail and the family calendar — what I read.',
  assistant: 'my own mailbox on the family domain — what I send as, and where replies to my mail land.',
}

export function isGoogleAccountRole(value: unknown): value is GoogleAccountRole {
  return typeof value === 'string' && (GOOGLE_ACCOUNT_ROLES as readonly string[]).includes(value)
}

/** The exact command that reconnects one account. Always quote this, never bare `/connect_google`. */
export function connectCommandFor(role: GoogleAccountRole): string {
  return `/connect_google ${role}`
}

/* ──────────────────────────────── oauth client ───────────────────────────── */

/** Absolute redirect URI registered in the Google Cloud console. */
export function googleRedirectUri(): string {
  const { APP_URL } = getConfig()
  return new URL(GOOGLE_CALLBACK_PATH, APP_URL.endsWith('/') ? APP_URL : `${APP_URL}/`).toString()
}

/**
 * A bare, credential-less OAuth2 client. Throws when Google is not configured —
 * that is a deployment mistake, not a runtime condition, so it should be loud.
 */
export function oauthClient(): OAuth2Client {
  const cfg = getConfig()
  if (!cfg.googleConfigured) {
    throw new Error(
      'Google is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then redeploy.',
    )
  }
  return new google.auth.OAuth2(cfg.GOOGLE_CLIENT_ID, cfg.GOOGLE_CLIENT_SECRET, googleRedirectUri())
}

/**
 * Consent URL for /connect_google.
 *
 * `access_type: 'offline'` + `prompt: 'consent'` is what forces Google to hand
 * back a refresh token. Without the forced prompt, a re-authorisation of an
 * already-consented account returns an access token only, and the connection
 * silently dies an hour later.
 */
export function authUrl(state: string): string {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: GOOGLE_SCOPES,
    state,
  })
}

/**
 * Trades the one-time `code` from the callback for a refresh token and reads
 * back which account was linked. The caller encrypts and stores the result.
 */
export async function exchangeCode(
  code: string,
): Promise<{ refreshToken: string; email: string; scope: string }> {
  const client = oauthClient()
  const { tokens } = await client.getToken(code)

  const refreshToken = tokens.refresh_token ?? ''
  if (!refreshToken) {
    throw new Error(
      'Google returned no refresh token. Remove this app at myaccount.google.com/permissions and run /connect_google again.',
    )
  }

  client.setCredentials(tokens)

  let email = ''
  try {
    const info = await google.oauth2({ version: 'v2', auth: client }).userinfo.get()
    email = info.data.email ?? ''
  } catch (err) {
    // Not fatal: we have the grant, we just cannot label it in the UI.
    log.warn({ err: describeError(err) }, 'could not read the linked account email')
  }

  return { refreshToken, email, scope: tokens.scope ?? GOOGLE_SCOPES.join(' ') }
}

/* ─────────────────────────────── authed client ───────────────────────────── */

type TokenRow = typeof schema.googleTokens.$inferSelect

/**
 * One live client per stored grant, keyed by role.
 *
 * Per role, not one global: the two accounts hold different refresh tokens and
 * a single slot would hand whichever account asked second the other's client —
 * the assistant sending as a spouse, or worse. `google-auth-library` caches and
 * refreshes the access token internally, so reusing the object avoids a token
 * round-trip on every tool call. Each entry's key includes `updatedAt`, so a
 * reconnect (a new row version) is picked up on the very next call.
 */
const clientCache = new Map<GoogleAccountRole, { key: string; client: OAuth2Client }>()

/**
 * Drops cached clients. Call after storing a new grant.
 *
 * With no argument it clears every role — the safe default, and what a
 * reconnect, a rotated `APP_SECRET`, or a test between cases wants.
 */
export function clearGoogleClientCache(role?: GoogleAccountRole): void {
  if (role === undefined) clientCache.clear()
  else clientCache.delete(role)
}

/** The grant for one role. A row already marked invalid is skipped. */
async function loadTokenRow(role: GoogleAccountRole): Promise<TokenRow | undefined> {
  const rows = await getDb()
    .select()
    .from(schema.googleTokens)
    .where(and(eq(schema.googleTokens.role, role), eq(schema.googleTokens.invalid, false)))
    .orderBy(asc(schema.googleTokens.id))
    .limit(1)
  return rows[0]
}

/**
 * The authorised client for one account, or `null` when that account has no
 * usable Google connection. Never throws for a connection problem, and never
 * substitutes the other account.
 */
export async function getAuthedClient(
  role: GoogleAccountRole = DEFAULT_GOOGLE_ROLE,
): Promise<OAuth2Client | null> {
  let row: TokenRow | undefined
  try {
    row = await loadTokenRow(role)
  } catch (err) {
    log.error({ err: describeError(err), role }, 'could not read google_tokens')
    return null
  }

  if (!row) {
    log.debug({ role }, 'no usable Google grant stored for this account')
    return null
  }

  const key = `${row.id}:${row.updatedAt instanceof Date ? row.updatedAt.getTime() : String(row.updatedAt)}`
  const cached = clientCache.get(role)
  if (cached && cached.key === key) return cached.client

  let refreshToken: string
  try {
    refreshToken = decrypt(row.refreshTokenEncrypted)
  } catch (err) {
    // Undecryptable means APP_SECRET rotated or the row was tampered with.
    // Either way the grant is unusable and only a reconnect fixes it.
    log.error(
      { err: describeError(err), tokenRowId: row.id, role },
      'could not decrypt refresh token',
    )
    await markGrantInvalid(role, row.id, 'the stored refresh token could not be decrypted')
    return null
  }

  let client: OAuth2Client
  try {
    client = oauthClient()
  } catch (err) {
    log.error({ err: describeError(err) }, 'Google client credentials are missing')
    return null
  }
  client.setCredentials({ refresh_token: refreshToken })

  // Force one refresh now so a dead grant is discovered here — at the single
  // place that knows how to report it — instead of inside twelve tool handlers.
  try {
    await client.getAccessToken()
  } catch (err) {
    if (isInvalidGrant(err)) {
      await reportInvalidGrant(err, { role, tokenRowId: row.id })
      return null
    }
    // Transient: Google 5xx, DNS, a flaky network. Hand back the client and let
    // the individual API call fail with its own, more specific error.
    log.warn({ err: describeError(err), role }, 'could not pre-refresh the Google access token')
  }

  clientCache.set(role, { key, client })
  return client
}

/** Calendar API for one account, or `null` when that account is not connected. */
export async function calendar(
  role: GoogleAccountRole = DEFAULT_GOOGLE_ROLE,
): Promise<calendar_v3.Calendar | null> {
  const auth = await getAuthedClient(role)
  if (!auth) return null
  return google.calendar({ version: 'v3', auth })
}

/** Gmail API for one account, or `null` when that account is not connected. */
export async function gmail(
  role: GoogleAccountRole = DEFAULT_GOOGLE_ROLE,
): Promise<gmail_v1.Gmail | null> {
  const auth = await getAuthedClient(role)
  if (!auth) return null
  return google.gmail({ version: 'v1', auth })
}

/* ──────────────────────────────── stored grants ──────────────────────────── */

/**
 * Writes the grant for one role, replacing whatever was there.
 *
 * The upsert targets `role`, not `user_id`: the household has exactly one
 * personal account and one assistant account, and either spouse may be the
 * human who authorised either of them. Encryption happens here so no caller
 * ever holds a plaintext refresh token longer than the OAuth callback that
 * received it.
 */
export async function storeToken(
  role: GoogleAccountRole,
  input: {
    userId: number
    email: string | null
    refreshToken: string
    scope?: string | null
  },
): Promise<void> {
  const refreshToken = input.refreshToken.trim()
  if (refreshToken === '') {
    throw new Error(`storeToken(${role}) was given an empty refresh token`)
  }

  const email = input.email === null ? null : input.email.trim().toLowerCase() || null
  const scope = input.scope ?? null
  const now = new Date()
  const refreshTokenEncrypted = encrypt(refreshToken)

  await getDb()
    .insert(schema.googleTokens)
    .values({
      userId: input.userId,
      role,
      email,
      refreshTokenEncrypted,
      scope,
      invalid: false,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.googleTokens.role,
      set: {
        userId: input.userId,
        email,
        refreshTokenEncrypted,
        scope,
        // A reconnect is exactly how a dead grant is revived, so clear the flag.
        invalid: false,
        updatedAt: now,
      },
    })

  // The cached client for this role now holds a stale refresh token.
  clearGoogleClientCache(role)
  log.info({ role, email }, 'stored a Google grant')
}

/**
 * Who the assistant is, when it writes as itself: the address on its own
 * mailbox and an honest display name for the From header and signature.
 *
 * `null` when the assistant account is not connected or its grant is dead —
 * which is a refusal to send, not a licence to fall back to a human's address.
 * The name is never a person's: it is the household's name plus "Assistant",
 * so a recipient can tell at a glance that no human typed the mail.
 */
export async function assistantIdentity(): Promise<{ email: string; name: string } | null> {
  try {
    const rows = await getDb()
      .select({ email: schema.googleTokens.email })
      .from(schema.googleTokens)
      .where(
        and(
          eq(schema.googleTokens.role, 'assistant'),
          eq(schema.googleTokens.invalid, false),
        ),
      )
      .limit(1)

    const email = (rows[0]?.email ?? '').trim()
    if (email === '') return null

    let household = ''
    try {
      const houses = await getDb()
        .select({ name: schema.households.name })
        .from(schema.households)
        .orderBy(asc(schema.households.id))
        .limit(1)
      household = (houses[0]?.name ?? '').trim()
    } catch (err) {
      log.warn({ err: describeError(err) }, 'could not read the household name for the assistant')
    }

    // "Smith Household" -> "Smith Household Assistant". A name the household
    // already calls its assistant is left exactly as it is.
    if (household === '') return { email, name: 'Household Assistant' }
    if (/assistant/i.test(household)) return { email, name: household }
    return { email, name: `${household} Assistant` }
  } catch (err) {
    log.error({ err: describeError(err) }, 'could not read the assistant identity')
    return null
  }
}

/* ─────────────────────────────── family calendar ─────────────────────────── */

/**
 * The calendar every household write targets. Falls back to the authorised
 * account's own default calendar when /setup never chose a shared one.
 */
export async function familyCalendarId(): Promise<string> {
  const rows = await getDb()
    .select({ familyCalendarId: schema.households.familyCalendarId })
    .from(schema.households)
    .orderBy(asc(schema.households.id))
    .limit(1)

  const configured = rows[0]?.familyCalendarId
  const trimmed = typeof configured === 'string' ? configured.trim() : ''
  return trimmed === '' ? PRIMARY_CALENDAR_ID : trimmed
}

/* ────────────────────────────── error handling ───────────────────────────── */

/**
 * True when Google says the entry is not there. Deleting something that has
 * already been deleted is the goal reached, not a failure, so every caller
 * that removes a calendar entry treats this as success — which is only safe
 * because it is a narrow match on 404 and 410 and nothing else.
 */
export function isMissingOnGoogle(err: unknown): boolean {
  const code = (err as { code?: unknown; status?: unknown } | null)?.code ?? null
  const status = (err as { status?: unknown } | null)?.status ?? null
  return code === 404 || code === 410 || status === 404 || status === 410
}

/** Safe, loggable shape for an unknown throwable. Never carries a token. */
function describeError(err: unknown): { message: string; status?: number } {
  if (err instanceof Error) {
    const status = (err as { status?: number; code?: number }).status
    return status === undefined ? { message: err.message } : { message: err.message, status }
  }
  return { message: typeof err === 'string' ? err : 'unknown error' }
}

/**
 * True when Google says the refresh token itself is dead: revoked, expired
 * after long disuse, or invalidated by a password change. Distinguishing this
 * from a 401 on one request matters — only this warrants nagging the household.
 */
export function isInvalidGrant(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const e = err as {
    message?: unknown
    response?: { data?: unknown }
    // GaxiosError surfaces the parsed body here on newer versions.
    data?: unknown
  }

  const bodies: unknown[] = [e.response?.data, e.data]
  for (const body of bodies) {
    if (body && typeof body === 'object') {
      const error = (body as { error?: unknown }).error
      if (error === 'invalid_grant') return true
      if (
        error &&
        typeof error === 'object' &&
        (error as { message?: unknown }).message === 'invalid_grant'
      ) {
        return true
      }
    }
  }

  return typeof e.message === 'string' && e.message.toLowerCase().includes('invalid_grant')
}

/**
 * Marks the stored grant dead and tells both spouses, once.
 *
 * The "once" comes from the database, not a timer: the update matches only a
 * row that is still valid, so the second caller to notice the same dead grant
 * updates nothing and stays quiet.
 */
export async function reportInvalidGrant(
  err?: unknown,
  where?: { role?: GoogleAccountRole; tokenRowId?: number },
): Promise<void> {
  const role = where?.role ?? DEFAULT_GOOGLE_ROLE
  log.error(
    { err: describeError(err), role, tokenRowId: where?.tokenRowId },
    'Google refresh token is no longer valid',
  )
  await markGrantInvalid(
    role,
    where?.tokenRowId,
    'Google rejected the stored refresh token (invalid_grant)',
  )
}

async function markGrantInvalid(
  role: GoogleAccountRole,
  tokenRowId: number | undefined,
  reason: string,
): Promise<void> {
  clearGoogleClientCache(role)

  let flipped: Array<{ id: number; email: string | null }> = []
  try {
    // Exactly one row, always — the one for this role. A caller that knows
    // which grant died names it; everyone else is reporting a failure of the
    // account they were acting as. A blanket `WHERE invalid = false` would
    // disconnect the household's other Google account, which is still fine.
    const rowId = tokenRowId ?? (await loadTokenRow(role))?.id
    if (rowId === undefined) return

    flipped = await getDb()
      .update(schema.googleTokens)
      .set({ invalid: true, updatedAt: new Date() })
      // `invalid = false` is the whole de-dupe, and it has to be here even when
      // the id was supplied: two tool calls can hit the same dead grant at the
      // same moment, and only the one that actually flips the row may nag.
      .where(and(eq(schema.googleTokens.id, rowId), eq(schema.googleTokens.invalid, false)))
      .returning({ id: schema.googleTokens.id, email: schema.googleTokens.email })
  } catch (dbErr) {
    log.error({ err: describeError(dbErr), role }, 'could not flag the Google grant as invalid')
  }

  // Nothing changed: another caller already handled this grant. Stay quiet.
  if (flipped.length === 0) return

  await audit({
    actor: 'system',
    event: 'google.disconnected',
    resultSummary: `${role}: ${reason}`,
    ok: false,
  })

  const account = flipped[0]?.email
  // Naming the account is the whole point of the message: the two grants break
  // independently, and reconnecting the wrong one fixes nothing.
  const consequence =
    role === 'assistant'
      ? 'I can still read your mail and calendar, but I cannot send anything as myself until this is reconnected.'
      : 'Your calendar and inbox are out of reach until this is reconnected.'
  const message = [
    `Heads up: I have lost access to ${GOOGLE_ROLE_LABELS[role]}`,
    account ? ` (${account})` : '',
    '.\n\n',
    reason,
    '.\n\n',
    consequence,
    `\n\nSend ${connectCommandFor(role)} and follow the link.`,
  ].join('')

  try {
    // Imported lazily: the Telegram module builds a bot at first use, and this
    // file is also loaded by the OAuth callback route before a bot is wanted.
    const { sendToAll } = await import('../telegram/send.js')
    await sendToAll(message)
  } catch (sendErr) {
    log.error({ err: describeError(sendErr) }, 'could not alert the household about Google access')
  }
}

/**
 * One-line, human-readable reason a Google call failed — for tool results.
 * Also handles the invalid_grant bookkeeping so callers do not have to.
 */
export async function googleFailure(
  context: string,
  err: unknown,
  role: GoogleAccountRole = DEFAULT_GOOGLE_ROLE,
): Promise<string> {
  if (isInvalidGrant(err)) {
    await reportInvalidGrant(err, { role })
    return `${context}: ${GOOGLE_ROLE_LABELS[role]} has expired. Send ${connectCommandFor(role)} to reconnect.`
  }

  const e = err as { errors?: Array<{ message?: string }>; status?: number; message?: string }
  const detail =
    e?.errors?.[0]?.message ?? (typeof e?.message === 'string' ? e.message : 'unknown error')
  const status = typeof e?.status === 'number' ? ` (HTTP ${e.status})` : ''
  log.warn({ context, role, err: describeError(err) }, 'Google API call failed')
  return `${context}: ${detail}${status}`
}
