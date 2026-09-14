import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { audit } from '../audit/log.js'
import { getConfig } from '../config.js'
import { getDb, schema } from '../db/client.js'
import { getBoss, QUEUES } from '../jobs/queue.js'
import { logger } from '../logger.js'
import { callerHint, constantTimeEqual, shouldAuditRejection } from './telegram-webhook.js'

/**
 * Vapi webhook ingress.
 *
 * Two gates, both required:
 *   1. the `x-vapi-secret` header matches VAPI_WEBHOOK_SECRET (constant-time)
 *   2. the event's call id matches a row this service created in `call_records`
 *
 * Gate 2 is what makes a leaked secret survivable. Without it, anyone holding
 * the secret could post a fabricated `end-of-call-report` and feed the agent an
 * invented call outcome — "the dentist confirmed Tuesday at 3" — which the
 * household would then act on. Binding every event to a call we ourselves
 * placed means an attacker also has to know a real call id.
 *
 * Like the Telegram handler, this never runs an agent turn: it acks and
 * enqueues.
 */

/* ─────────────────────────── payload shape helpers ───────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringAt(source: Record<string, unknown> | null, key: string): string | null {
  if (source === null) return null
  const value = source[key]
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function recordAt(source: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  if (source === null) return null
  const value = source[key]
  return isRecord(value) ? value : null
}

/**
 * Pulls the Vapi call id out of a server message. Vapi has shipped the id in
 * several places over time, so check each of them rather than assume one.
 */
export function extractVapiCallId(body: unknown): string | null {
  const root = isRecord(body) ? body : null
  const message = recordAt(root, 'message')
  return (
    stringAt(recordAt(message, 'call'), 'id') ??
    stringAt(message, 'callId') ??
    stringAt(recordAt(root, 'call'), 'id') ??
    stringAt(root, 'callId')
  )
}

/** Payload of a `vapi-event` job. */
export interface VapiEventJob {
  /** Vapi's own call id. */
  callId: string
  /** Primary key of the matching `call_records` row — already verified to exist. */
  callRecordId: number
  /** e.g. `status-update`, `end-of-call-report`, `transcript`, `hang`. */
  messageType: string
  /** The `message` object exactly as Vapi sent it. Treat its contents as untrusted data. */
  message: unknown
  /**
   * The whole webhook body, verbatim. Duplicated from `message` on purpose:
   * `src/jobs/queue.ts` types this queue as `{ payload: unknown }` and its
   * worker reads `job.data.payload`. Without this field every phone-call event
   * would reach the worker as `undefined` — including the end-of-call report.
   */
  payload: unknown
  receivedAt: string
}

/* ───────────────────────────── rejection auditing ────────────────────────── */

/**
 * Audits a refusal, at most once per (event, source) per minute.
 *
 * The throttle is not decoration. This route is reachable by anyone on the
 * internet and the secret check runs before anything else, so an unthrottled
 * audit would let a scanner drive one Postgres INSERT per request against the
 * same pool the assistant needs to place calls and write approvals.
 */
async function auditRejection(
  c: Context,
  event: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const source = callerHint(c)
  logger.warn({ event, source, ...extra }, 'vapi webhook rejected')
  if (!shouldAuditRejection(`${event}:${source}`)) return
  await audit({
    actor: 'anonymous',
    event,
    category: 'phone_call',
    ok: false,
    resultSummary: `rejected from ${source}`,
    args: extra ?? {},
  })
}

function unauthorized(c: Context): Response {
  return c.body(null, 401)
}

/* ──────────────────────────────── the handler ────────────────────────────── */

/** Handles `POST /webhooks/vapi`. */
export async function handleVapiWebhook(c: Context): Promise<Response> {
  const cfg = getConfig()

  // VAPI_WEBHOOK_SECRET is optional in config; an unset secret means the phone
  // integration is not configured, and an unconfigured endpoint accepts nothing.
  if (!constantTimeEqual(c.req.header('x-vapi-secret'), cfg.VAPI_WEBHOOK_SECRET)) {
    await auditRejection(c, 'vapi_webhook_bad_secret')
    return unauthorized(c)
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    logger.warn('vapi webhook body was not valid json')
    return unauthorized(c)
  }

  const callId = extractVapiCallId(body)
  if (callId === null) {
    await auditRejection(c, 'vapi_webhook_missing_call_id')
    return unauthorized(c)
  }

  let callRecordId: number
  try {
    const rows = await getDb()
      .select({ id: schema.callRecords.id })
      .from(schema.callRecords)
      .where(eq(schema.callRecords.vapiCallId, callId))
      .limit(1)
    const row = rows[0]
    if (row === undefined) {
      // Either a forged event, or a real one that beat our own record write.
      // Both are refused; Vapi redelivers, by which time the row exists.
      await auditRejection(c, 'vapi_webhook_unknown_call', { callId })
      return unauthorized(c)
    }
    callRecordId = row.id
  } catch (err) {
    logger.error({ err, callId }, 'vapi call lookup failed')
    // Do not ack an event we could not authenticate — ask for a redelivery.
    return c.body(null, 503)
  }

  const root = isRecord(body) ? body : null
  const message = recordAt(root, 'message')
  const messageType = stringAt(message, 'type') ?? 'unknown'

  const job: VapiEventJob = {
    callId,
    callRecordId,
    messageType,
    message: message ?? body,
    payload: body,
    receivedAt: new Date().toISOString(),
  }

  try {
    const boss = await getBoss()
    // No singleton key here: a single call emits several distinct event types
    // and collapsing them would discard the end-of-call report.
    const jobId = await boss.send(QUEUES.vapiEvent, job)
    if (jobId === null) {
      // Nothing was queued, so this event is not handled. Never ack it —
      // an unacked event is one Vapi redelivers.
      logger.error({ callId, messageType }, 'vapi-event was not queued')
      return c.body(null, 503)
    }
    logger.debug({ callId, callRecordId, messageType, jobId }, 'vapi-event enqueued')
  } catch (err) {
    logger.error({ err, callId, messageType }, 'failed to enqueue vapi-event')
    return c.body(null, 503)
  }

  return c.json({ ok: true })
}
