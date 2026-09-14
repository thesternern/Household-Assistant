import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'
import { audit } from '../audit/log.js'
import { getConfig } from '../config.js'
import { getBoss, QUEUES } from '../jobs/queue.js'
import { logger } from '../logger.js'

/**
 * Telegram webhook ingress.
 *
 * The single hard rule of this module: it never runs an agent turn. A turn
 * takes 10–120 seconds; Telegram gives a webhook a few seconds before it
 * retries and, if that keeps happening, drops the webhook entirely. So the
 * handler authenticates, enqueues one job, and returns.
 *
 * Authentication is three gates, in this order:
 *   1. the `:secret` path segment                 -> 401, empty body
 *   2. the X-Telegram-Bot-Api-Secret-Token header -> 401, empty body
 *   3. the sender is on the household whitelist   -> 200, no work queued
 *
 * Gate 3 deliberately answers 200. A distinct status there would turn the
 * endpoint into an oracle for "is this Telegram user id in the household?".
 */

/* ───────────────────────────── secret comparison ─────────────────────────── */

/**
 * Per-process key for the comparison HMAC below. Random, never persisted, never
 * logged — it exists only so two strings of different lengths can still be
 * compared in constant time.
 */
const COMPARE_KEY = randomBytes(32)

/**
 * Constant-time string comparison. Shared by every webhook in this directory.
 *
 * `timingSafeEqual` throws on unequal buffer lengths, so a naive implementation
 * has to length-check first and thereby leaks the length of the expected
 * secret. Comparing HMACs instead makes both operands 32 bytes whatever the
 * inputs were, so there is no length-dependent branch at all. An empty or
 * non-string candidate always fails, which keeps an unconfigured (empty) secret
 * from matching an omitted header.
 */
export function constantTimeEqual(
  candidate: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false
  if (candidate.length === 0 || expected.length === 0) return false
  const a = createHmac('sha256', COMPARE_KEY).update(candidate, 'utf8').digest()
  const b = createHmac('sha256', COMPARE_KEY).update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/* ───────────────────────────── rejection auditing ────────────────────────── */

/**
 * Rejected requests are audited, but a scanner hammering the endpoint must not
 * turn into thousands of Postgres inserts. One audit row per (event, source)
 * per minute is enough to notice an attack without amplifying it.
 *
 * This throttle is shared with the Vapi webhook — both endpoints are
 * unauthenticated until their secret check passes, so both need it.
 */
const AUDIT_THROTTLE_MS = 60_000
const MAX_THROTTLE_ENTRIES = 500
const lastAuditedAt = new Map<string, number>()

/**
 * True when this (event, source) pair has not been audited in the last minute.
 * Exported so every webhook in this directory shares one bounded map instead of
 * each keeping its own.
 */
export function shouldAuditRejection(key: string): boolean {
  const now = Date.now()
  const previous = lastAuditedAt.get(key)
  if (previous !== undefined && now - previous < AUDIT_THROTTLE_MS) return false
  if (lastAuditedAt.size >= MAX_THROTTLE_ENTRIES) {
    for (const [k, ts] of lastAuditedAt) {
      if (now - ts >= AUDIT_THROTTLE_MS) lastAuditedAt.delete(k)
    }
    // Still full of fresh entries: drop the oldest so the map stays bounded.
    if (lastAuditedAt.size >= MAX_THROTTLE_ENTRIES) {
      const oldest = lastAuditedAt.keys().next()
      if (!oldest.done) lastAuditedAt.delete(oldest.value)
    }
  }
  // Re-inserting keeps the map in least-recently-audited order, so the eviction
  // above drops a genuinely stale key rather than whichever was seen first.
  lastAuditedAt.delete(key)
  lastAuditedAt.set(key, now)
  return true
}

/** Exported for tests: clears the rejection-audit throttle between cases. */
export function __resetAuditThrottleForTests(): void {
  lastAuditedAt.clear()
}

/**
 * Best-effort caller identity for audit rows. Never trusted for authorisation.
 * Shared with the Vapi webhook so both endpoints attribute rejections the same
 * way — and so both feed the same throttle key space.
 *
 * The LAST `X-Forwarded-For` entry is the one the hop in front of us appended,
 * so it is the only one a client cannot choose. The first entry is whatever the
 * client sent, and a scanner that puts a fresh value in it on every request
 * would get a fresh throttle key each time — one audit INSERT per rejected
 * request, which is exactly the amplification the throttle exists to stop.
 */
export function callerHint(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for')
  const hops = (forwarded ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0)
  const last = hops[hops.length - 1]
  if (last !== undefined) return last
  const cloudflare = c.req.header('cf-connecting-ip')?.trim()
  return cloudflare !== undefined && cloudflare.length > 0 ? cloudflare : 'unknown'
}

async function auditRejection(
  c: Context,
  event: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const source = callerHint(c)
  logger.warn({ event, source, ...extra }, 'telegram webhook rejected')
  if (!shouldAuditRejection(`${event}:${source}`)) return
  await audit({
    actor: 'anonymous',
    event,
    ok: false,
    resultSummary: `rejected from ${source}`,
    args: extra ?? {},
  })
}

/* ─────────────────────────────── update shapes ───────────────────────────── */

interface TgUser {
  id?: number | string
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

interface TgChat {
  id?: number | string
  type?: string
  title?: string
}

interface TgMessage {
  message_id?: number
  from?: TgUser
  chat?: TgChat
  text?: string
  caption?: string
  date?: number
}

interface TgCallbackQuery {
  id?: string
  from?: TgUser
  data?: string
  message?: TgMessage
}

interface TgChatMemberUpdate {
  from?: TgUser
  chat?: TgChat
}

/** The subset of Telegram's Update we read here. The full body is forwarded verbatim. */
export interface TelegramUpdate {
  update_id?: number
  message?: TgMessage
  edited_message?: TgMessage
  channel_post?: TgMessage
  edited_channel_post?: TgMessage
  callback_query?: TgCallbackQuery
  my_chat_member?: TgChatMemberUpdate
  chat_member?: TgChatMemberUpdate
}

/** Payload of a `tg-update` job. The worker owns everything past this point. */
export interface TgUpdateJob {
  /** The raw Telegram Update, unmodified — the worker may need fields we ignore. */
  update: TelegramUpdate
  updateId: number | null
  chatId: string
  fromId: string
  /** Telegram-supplied display name. The worker maps it to a household user row. */
  actor: string
  /** Message text or caption, when the update carries one. */
  text: string | null
  /** Inline-keyboard callback payload, e.g. `ap:12:yes`. */
  callbackData: string | null
  callbackQueryId: string | null
  messageId: number | null
  receivedAt: string
}

function pickFrom(u: TelegramUpdate): TgUser | undefined {
  return (
    u.message?.from ??
    u.edited_message?.from ??
    u.callback_query?.from ??
    u.channel_post?.from ??
    u.edited_channel_post?.from ??
    u.my_chat_member?.from ??
    u.chat_member?.from
  )
}

function pickChat(u: TelegramUpdate): TgChat | undefined {
  return (
    u.message?.chat ??
    u.edited_message?.chat ??
    u.callback_query?.message?.chat ??
    u.channel_post?.chat ??
    u.edited_channel_post?.chat ??
    u.my_chat_member?.chat ??
    u.chat_member?.chat
  )
}

function pickMessage(u: TelegramUpdate): TgMessage | undefined {
  return (
    u.message ??
    u.edited_message ??
    u.callback_query?.message ??
    u.channel_post ??
    u.edited_channel_post
  )
}

/**
 * Telegram ids are integers, and JSON gives us either a number or a string.
 * Anything else — an array, an object with a `toString` — is refused rather
 * than coerced, because `String(['111'])` is `'111'` and would otherwise sail
 * through the whitelist check.
 */
function idToString(value: number | string | undefined): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'string') return value.length > 0 ? value : null
  return null
}

function displayName(from: TgUser, fallbackId: string): string {
  const full = [from.first_name, from.last_name].filter(Boolean).join(' ').trim()
  if (full.length > 0) return full
  if (from.username && from.username.length > 0) return from.username
  return `user ${fallbackId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* ──────────────────────────────── the handler ────────────────────────────── */

/** 401 with an empty body. Every failure looks identical from the outside. */
function unauthorized(c: Context): Response {
  return c.body(null, 401)
}

/**
 * Handles `POST /webhooks/telegram/:secret`.
 *
 * Once the two secrets check out the caller is Telegram, so every remaining
 * outcome answers 200: a 4xx/5xx would make Telegram retry the same update and,
 * repeated often enough, disable the webhook. The one exception is a failed
 * enqueue, where a retry is exactly what we want.
 */
export async function handleTelegramWebhook(c: Context): Promise<Response> {
  const cfg = getConfig()

  // 1. Path secret. Keeps the URL itself unguessable.
  if (!constantTimeEqual(c.req.param('secret'), cfg.TELEGRAM_WEBHOOK_SECRET)) {
    await auditRejection(c, 'telegram_webhook_bad_path_secret')
    return unauthorized(c)
  }

  // 2. Header secret. Survives a URL leaking through a log or a proxy.
  if (
    !constantTimeEqual(
      c.req.header('X-Telegram-Bot-Api-Secret-Token'),
      cfg.TELEGRAM_WEBHOOK_SECRET,
    )
  ) {
    await auditRejection(c, 'telegram_webhook_bad_header_secret')
    return unauthorized(c)
  }

  let parsed: unknown
  try {
    parsed = await c.req.json()
  } catch {
    logger.warn('telegram webhook body was not valid json')
    return c.json({ ok: true })
  }
  if (!isRecord(parsed)) {
    logger.warn('telegram webhook body was not a json object')
    return c.json({ ok: true })
  }
  const update = parsed as TelegramUpdate

  // 3. Household whitelist. Answers 200 so the status code reveals nothing.
  const from = pickFrom(update)
  const fromId = from === undefined ? null : idToString(from.id)
  if (from === undefined || fromId === null || !cfg.telegramUserIds.includes(fromId)) {
    await auditRejection(c, 'telegram_webhook_unauthorized_user', {
      fromId: fromId ?? 'absent',
      updateId: update.update_id ?? null,
    })
    return c.json({ ok: true })
  }

  const chat = pickChat(update)
  // In a private chat the chat id equals the user id; fall back to it so an
  // update with an unusual envelope still lands on the right conversation.
  const chatId = idToString(chat?.id) ?? fromId
  const message = pickMessage(update)
  const callback = update.callback_query

  // A callback query carries no text of its own: `callback_query.message` is
  // the card *we* sent. Reporting that as `text` would hand the worker the
  // bot's own words as if a spouse had typed them, so only a genuine incoming
  // message contributes text. The card's `message_id` is still useful — it is
  // what an edit-in-place reply targets.
  const incoming = callback === undefined ? message : undefined

  const job: TgUpdateJob = {
    update,
    updateId: typeof update.update_id === 'number' ? update.update_id : null,
    chatId,
    fromId,
    actor: displayName(from, fromId),
    text: incoming?.text ?? incoming?.caption ?? null,
    callbackData: callback?.data ?? null,
    callbackQueryId: callback?.id ?? null,
    messageId: message?.message_id ?? null,
    receivedAt: new Date().toISOString(),
  }

  try {
    const boss = await getBoss()
    // Per-chat singleton key: turns for one chat serialise behind each other
    // while a different chat stays free to run in parallel. This is correct
    // only while `tg-update` is created with the `singleton` policy (one job
    // ACTIVE per key, unlimited queued) or `key_strict_fifo`. Under `short`,
    // `stately`, or `exclusive` the key means "one job per key" and a second
    // message arriving mid-turn would be dropped, which `send()` reports by
    // returning null.
    const jobId = await boss.send(QUEUES.tgUpdate, job, { singletonKey: `chat:${chatId}` })
    if (jobId === null) {
      logger.error(
        { chatId, updateId: job.updateId },
        'tg-update was NOT queued: the tg-update queue policy is collapsing per-chat jobs and this message is lost — the queue must use policy "singleton" or "key_strict_fifo"',
      )
      await audit({
        actor: 'system',
        event: 'telegram_update_dropped_by_queue_policy',
        ok: false,
        resultSummary: 'boss.send returned null for tg-update; check the queue policy',
        args: { chatId, updateId: job.updateId },
      })
    } else {
      logger.debug({ chatId, jobId, updateId: job.updateId }, 'tg-update enqueued')
    }
  } catch (err) {
    // Answering 500 asks Telegram to redeliver. Losing the message silently is
    // the worse failure, so take the retry.
    logger.error({ err, chatId }, 'failed to enqueue tg-update')
    return c.body(null, 500)
  }

  return c.json({ ok: true })
}
