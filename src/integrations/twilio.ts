/**
 * Twilio — the household's text messages.
 *
 * Structured like `vapi.ts`: a narrow surface, a dry-run path that exercises
 * everything except the network call, and configuration that is checked for
 * shape rather than mere presence.
 *
 * Vapi was considered for this and rejected. Its assistants cannot send the
 * first message in a conversation, which is the entire use case here — Chessy
 * texting the sitter. Vapi keeps the voice calls; the same number carries both,
 * with Vapi's SMS toggle off so it does not rewrite the messaging webhook.
 *
 * There is no `twilio` package dependency. The REST call is one form POST with
 * basic auth, and a dependency that ships an HTTP client, a TwiML builder and a
 * CLI to make it is not worth the supply chain.
 */
import { getConfig } from '../config.js'
import { logger } from '../logger.js'

const log = logger.child({ mod: 'integrations/twilio' })

/** Twilio's REST base. Account SID is interpolated per call. */
const API_BASE = 'https://api.twilio.com/2010-04-01'

/** Longest body we will send. Three GSM-7 segments; past that, phone a person. */
export const MAX_SMS_CHARS = 480

const REQUEST_TIMEOUT_MS = 15_000

/**
 * Twilio error codes this integration reasons about by name.
 *
 * `21610` is the opt-out: the recipient replied STOP, Twilio enforces it
 * permanently, and no amount of retrying changes it. It is not a failure to
 * paper over — it is a person saying no, and the household has to be told.
 *
 * `30034` is an unregistered A2P 10DLC sender. It fires on US-bound traffic
 * from this Canadian long code and is the reason the household's own mobiles
 * cannot be texted.
 */
export const TWILIO_OPT_OUT_CODE = 21610
export const TWILIO_UNREGISTERED_CODE = 30034

export interface SmsSendInput {
  /** E.164, already normalised and already past the guardrails. */
  to: string
  body: string
  /** Overrides the configured flag. Tests and the executor pass it explicitly. */
  dryRun?: boolean
}

export interface SmsSent {
  ok: true
  sid: string
  dryRun: boolean
  /** Twilio's own view of the message at creation time. */
  status: string
}

export interface SmsFailed {
  ok: false
  /** Twilio's numeric code when it gave one. */
  code: number | null
  message: string
  /** True when the recipient has opted out; the contact must be marked unreachable. */
  optedOut: boolean
  /** True when A2P registration is what is missing, not the number. */
  unregisteredSender: boolean
}

export type SmsResult = SmsSent | SmsFailed

/** The number texts come from, for the approval card and the audit trail. */
export function twilioFromNumber(): string {
  return getConfig().TWILIO_FROM_NUMBER.trim()
}

function failure(code: number | null, message: string): SmsFailed {
  return {
    ok: false,
    code,
    message,
    optedOut: code === TWILIO_OPT_OUT_CODE,
    unregisteredSender: code === TWILIO_UNREGISTERED_CODE,
  }
}

/** Twilio returns `{ code, message, ... }` on failure, with wide shape tolerance needed. */
function readError(payload: unknown): { code: number | null; message: string } {
  const body = (payload ?? {}) as Record<string, unknown>
  const rawCode = body.code
  const code = typeof rawCode === 'number' ? rawCode : Number.parseInt(String(rawCode ?? ''), 10)
  const message = typeof body.message === 'string' ? body.message : 'Twilio rejected the message.'
  return { code: Number.isInteger(code) ? code : null, message }
}

/**
 * Send one message.
 *
 * Never called directly by the model. `sms_send` proposes, the household
 * approves, and the executor replays the stored arguments through here — so the
 * text that goes out is byte-for-byte the text that was on the card.
 */
export async function sendSms(input: SmsSendInput): Promise<SmsResult> {
  const cfg = getConfig()
  const dryRun = input.dryRun ?? cfg.DRY_RUN_SMS
  const body = input.body.trim()

  if (body === '') return failure(null, 'The message was empty, so nothing was sent.')
  if (body.length > MAX_SMS_CHARS) {
    return failure(null, `The message is ${body.length} characters, over the ${MAX_SMS_CHARS} limit.`)
  }

  if (dryRun) {
    // Everything except the network. The synthetic sid is marked on its face so
    // it can never be mistaken for a Twilio one in an audit row.
    const sid = `DRYRUN${Date.now().toString(36).toUpperCase()}`
    log.info({ to: input.to, chars: body.length, sid }, 'dry run: no text was sent')
    return { ok: true, sid, dryRun: true, status: 'dry-run' }
  }

  if (!cfg.twilioConfigured) {
    return failure(
      null,
      'Twilio is not configured — the account SID, auth token, or from-number is missing or a placeholder.',
    )
  }

  const sid = cfg.TWILIO_ACCOUNT_SID.trim()
  const auth = Buffer.from(`${sid}:${cfg.TWILIO_AUTH_TOKEN.trim()}`).toString('base64')

  let response: Response
  try {
    response = await fetch(`${API_BASE}/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        To: input.to,
        From: cfg.TWILIO_FROM_NUMBER.trim(),
        Body: body,
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err: message, to: input.to }, 'the Twilio request never completed')
    return failure(null, `Twilio could not be reached: ${message}`)
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    const { code, message } = readError(payload)
    log.error({ status: response.status, code, to: input.to }, 'Twilio refused the message')
    return failure(code, message)
  }

  const okBody = (payload ?? {}) as Record<string, unknown>
  const messageSid = typeof okBody.sid === 'string' ? okBody.sid : ''
  if (messageSid === '') {
    return failure(null, 'Twilio accepted the request but returned no message id.')
  }

  const status = typeof okBody.status === 'string' ? okBody.status : 'queued'
  log.info({ sid: messageSid, status, to: input.to, chars: body.length }, 'text sent')
  return { ok: true, sid: messageSid, dryRun: false, status }
}
