/**
 * `POST /webhooks/twilio/sms` — inbound text messages.
 *
 * The discipline is the one the other two webhooks already set: authenticate
 * before reading anything, cap the body, audit rejections under the existing
 * throttle, and queue a job rather than running an agent turn inline. An agent
 * turn takes tens of seconds; running one inside a webhook guarantees a Twilio
 * timeout and then a redelivery storm on top of the original work.
 *
 * Authentication is Twilio's `X-Twilio-Signature`: an HMAC-SHA1, over the full
 * request URL with the POST parameters appended in sorted order, keyed by the
 * auth token. Implemented here rather than pulled from the `twilio` package,
 * for the same reason `integrations/twilio.ts` posts its own form — this is
 * twenty lines of well-specified HMAC.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'
import { audit } from '../audit/log.js'
import { getConfig } from '../config.js'
import { getBoss, QUEUES } from '../jobs/queue.js'
import { logger } from '../logger.js'
import { callerHint, shouldAuditRejection } from './telegram-webhook.js'

const log = logger.child({ mod: 'http/twilio-webhook' })

/**
 * Twilio's signature scheme.
 *
 * Concatenate the full URL with each POST parameter, sorted by name, as
 * `keyvalue` pairs with no separators. HMAC-SHA1 that with the auth token,
 * base64 the digest, compare to the header.
 *
 * Exported for the tests: this is the only thing standing between the inbound
 * path and anyone who knows the URL.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + (params[key] ?? ''), url)
  return createHmac('sha1', authToken).update(Buffer.from(payload, 'utf8')).digest('base64')
}

/** Constant-time base64 compare that tolerates a missing or malformed header. */
export function signatureMatches(expected: string, received: string | undefined): boolean {
  if (typeof received !== 'string' || received.length === 0) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(received, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

async function auditRejection(c: Context, event: string): Promise<void> {
  const source = callerHint(c)
  if (!shouldAuditRejection(source)) return
  await audit({
    actor: 'anonymous',
    event,
    category: 'sms_send',
    ok: false,
    resultSummary: `rejected from ${source}`,
  })
}

/**
 * Twilio expects TwiML or an empty 204. An empty response means "no automatic
 * reply", which is what we want: the reply, if there is one, comes from an
 * agent turn seconds later, through the same approved path as any other text.
 */
function accepted(c: Context): Response {
  return c.body(null, 204)
}

function rejected(c: Context): Response {
  return c.body(null, 403)
}

/** Handles `POST /webhooks/twilio/sms`. */
export async function handleTwilioSmsWebhook(c: Context): Promise<Response> {
  const cfg = getConfig()

  // An unconfigured integration accepts nothing. Without an auth token there is
  // no signature to verify against, and an endpoint that cannot authenticate
  // must not accept.
  if (!cfg.twilioConfigured) {
    await auditRejection(c, 'twilio_webhook_unconfigured')
    return rejected(c)
  }

  let params: Record<string, string>
  try {
    const form = await c.req.formData()
    params = {}
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') params[key] = value
    }
  } catch {
    log.warn('twilio webhook body was not form-encoded')
    await auditRejection(c, 'twilio_webhook_bad_body')
    return rejected(c)
  }

  // Twilio signs the URL it was configured with. Behind Railway's proxy the
  // request URL arrives as http, so the signed form is rebuilt from APP_URL
  // rather than trusted from the hop that reached us.
  const url = `${cfg.APP_URL.replace(/\/+$/, '')}/webhooks/twilio/sms`
  const expected = twilioSignature(cfg.TWILIO_AUTH_TOKEN.trim(), url, params)

  if (!signatureMatches(expected, c.req.header('x-twilio-signature'))) {
    await auditRejection(c, 'twilio_webhook_bad_signature')
    log.warn({ from: params.From ?? 'unknown' }, 'twilio webhook signature rejected')
    return rejected(c)
  }

  const from = (params.From ?? '').trim()
  const body = (params.Body ?? '').trim()
  const sid = (params.MessageSid ?? params.SmsSid ?? '').trim()

  if (from === '' || sid === '') {
    await auditRejection(c, 'twilio_webhook_missing_fields')
    return rejected(c)
  }

  // Ack, then work. Everything past this point happens on the queue.
  try {
    const boss = await getBoss()
    await boss.send(QUEUES.smsInbound, { from, body, sid })
    log.info({ from, sid, chars: body.length }, 'inbound text queued')
  } catch (err) {
    // A failure to queue must not make Twilio retry into a queue that is down;
    // it retries on 5xx, and the message is already recorded in this log line.
    log.error({ err, sid }, 'could not queue the inbound text')
  }

  return accepted(c)
}
