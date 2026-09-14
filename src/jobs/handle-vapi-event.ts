import { and, eq, isNull } from 'drizzle-orm'
import { audit } from '../audit/log.js'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { wrapUntrusted } from '../tools/untrusted.js'
import { enqueueAgentTask } from './queue.js'

/**
 * The `vapi-event` worker.
 *
 * Vapi posts a server message for every phase of a call. Two of them matter:
 *
 *  - `status-update` moves `call_records.status` along (queued -> ringing ->
 *    in-progress -> ended), which is what `/status` and the phone tools read.
 *  - `end-of-call-report` arrives once, after post-processing, carrying the
 *    transcript, the summary, the structured extraction, the success rubric,
 *    and the cost. It is stored, and then an `agent-task` is queued so the
 *    model narrates the outcome in chat and offers the obvious next step.
 *
 * The transcript and summary are third-party speech. Everything that reaches
 * the model goes through `wrapUntrusted` first.
 */

const log = logger.child({ mod: 'vapi-event' })

/** Transcripts can run long; the model gets a generous but bounded slice. */
const TRANSCRIPT_MAX_CHARS = 6000

type Rec = Record<string, unknown>

function asRecord(value: unknown): Rec | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Rec)
    : undefined
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function asDate(value: unknown): Date | undefined {
  const text = asString(value)
  if (!text) return undefined
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

const TRUTHY_EVALUATIONS = new Set(['true', 'pass', 'passed', 'yes', 'success', 'successful'])
const FALSY_EVALUATIONS = new Set(['false', 'fail', 'failed', 'no', 'failure', 'unsuccessful'])

/**
 * Vapi's `successEvaluation` follows whichever rubric the assistant was built
 * with: a boolean, a pass/fail word, or a numeric score. Anything this cannot
 * read confidently becomes `null` — "we do not know" — rather than a guess.
 */
function asSuccess(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Rubrics are either 0-1 or 1-10; both treat the upper third as a success.
    return value <= 1 ? value >= 0.5 : value >= 7
  }
  const text = asString(value)?.toLowerCase()
  if (!text) return null
  if (TRUTHY_EVALUATIONS.has(text)) return true
  if (FALSY_EVALUATIONS.has(text)) return false
  const numeric = asNumber(text)
  if (numeric !== undefined) return numeric <= 1 ? numeric >= 0.5 : numeric >= 7
  return null
}

/** JSON-safe copy for a `jsonb` column. Never throws. */
function toJsonValue(value: unknown): unknown {
  if (value === undefined) return null
  try {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? null : (JSON.parse(encoded) as unknown)
  } catch {
    return null
  }
}

/** The Vapi call id, wherever this particular message shape happens to carry it. */
function callIdOf(message: Rec): string | undefined {
  return (
    asString(asRecord(message.call)?.id) ??
    asString(message.callId) ??
    asString(asRecord(message.artifact)?.callId)
  )
}

/**
 * Handles one Vapi server message. `payload` is the raw webhook body; Vapi
 * nests the message under `message`, but a bare message object is accepted too.
 */
export async function handleVapiEvent(payload: unknown): Promise<void> {
  const body = asRecord(payload)
  if (!body) {
    log.warn('discarding a vapi job with a non-object payload')
    return
  }

  const message = asRecord(body.message) ?? body
  const type = asString(message.type)
  const callId = callIdOf(message)

  if (!type) {
    log.warn({ callId }, 'vapi message has no type')
    return
  }

  switch (type) {
    case 'status-update':
      await handleStatusUpdate(message, callId)
      return
    case 'end-of-call-report':
      await handleEndOfCallReport(message, callId)
      return
    default:
      // transcript, speech-update, conversation-update, hang, tool-calls, and
      // friends are high-volume and carry nothing we persist.
      log.debug({ type, callId }, 'ignoring vapi message type')
  }
}

async function handleStatusUpdate(message: Rec, callId: string | undefined): Promise<void> {
  const status = asString(message.status)
  if (!callId || !status) {
    log.debug({ callId, status }, 'vapi status-update missing call id or status')
    return
  }

  // Guarded on `ended_at IS NULL`, like the end-of-call report: a status
  // update that arrives late — or is replayed — must not walk a finished call
  // back to "in-progress".
  const updated = await getDb()
    .update(schema.callRecords)
    .set({ status })
    .where(and(eq(schema.callRecords.vapiCallId, callId), isNull(schema.callRecords.endedAt)))
    .returning({ id: schema.callRecords.id })

  if (updated.length === 0) {
    // An inbound call we never placed, the status beat our own row into the
    // table, or the call has already ended. None is worth failing the job over.
    log.debug({ callId, status }, 'no open call record for vapi status-update')
    return
  }
  log.info({ callId, status, callRecordId: updated[0]?.id }, 'call status updated')
}

async function handleEndOfCallReport(message: Rec, callId: string | undefined): Promise<void> {
  if (!callId) {
    log.warn('vapi end-of-call-report has no call id')
    return
  }

  const analysis = asRecord(message.analysis) ?? {}
  const artifact = asRecord(message.artifact) ?? {}
  const call = asRecord(message.call) ?? {}

  const transcript = asString(artifact.transcript) ?? asString(message.transcript) ?? null
  const summary = asString(analysis.summary) ?? asString(message.summary) ?? null
  const structuredData = toJsonValue(analysis.structuredData)
  const success = asSuccess(analysis.successEvaluation)
  const costUsd = asNumber(message.cost) ?? asNumber(call.cost) ?? null
  const endedReason = asString(message.endedReason) ?? 'unknown'
  const endedAt = asDate(message.endedAt) ?? new Date()

  // Conditional on `ended_at IS NULL`, so a redelivered report updates nothing
  // twice and — more importantly — never narrates the same call twice.
  const claimed = await getDb()
    .update(schema.callRecords)
    .set({
      status: 'ended',
      transcript,
      summary,
      structuredData,
      success,
      costUsd,
      endedAt,
    })
    .where(and(eq(schema.callRecords.vapiCallId, callId), isNull(schema.callRecords.endedAt)))
    .returning()

  const record = claimed[0]
  if (!record) {
    const existing = await getDb()
      .select({ id: schema.callRecords.id })
      .from(schema.callRecords)
      .where(eq(schema.callRecords.vapiCallId, callId))
      .limit(1)
    if (existing.length > 0) {
      log.info({ callId }, 'duplicate end-of-call-report ignored')
    } else {
      log.warn({ callId }, 'end-of-call-report for a call we have no record of')
      await audit({
        actor: 'system',
        event: 'call.unattributed',
        category: 'phone_call',
        resultSummary: `Received an end-of-call report for unknown Vapi call ${callId}.`,
        ok: false,
      })
    }
    return
  }

  await audit({
    actor: 'system',
    event: 'call.completed',
    category: 'phone_call',
    toolName: 'phone_place_call',
    resultSummary: `${record.goal} — ended ${endedReason}${
      success === null ? '' : success ? ', looks successful' : ', looks unsuccessful'
    }`,
    ok: success !== false,
    pendingActionId: record.pendingActionId ?? undefined,
  })

  log.info(
    { callId, callRecordId: record.id, endedReason, success, costUsd },
    'call report stored',
  )

  await queueOutcomeNarration({
    record,
    endedReason,
    success,
    summary,
    structuredData,
    transcript,
  })
}

interface NarrationInput {
  record: typeof schema.callRecords.$inferSelect
  endedReason: string
  success: boolean | null
  summary: string | null
  structuredData: unknown
  transcript: string | null
}

/**
 * Hands the call outcome to the model so it can tell the household what
 * happened and offer the follow-through — book the slot, add the to-do, call
 * back later. The model, not this worker, decides what to say.
 */
async function queueOutcomeNarration(input: NarrationInput): Promise<void> {
  const { record } = input
  const chatId = await chatIdForCall(record.conversationId)

  const outcome =
    input.success === null
      ? 'unclear from the rubric'
      : input.success
        ? 'the goal appears to have been met'
        : 'the goal does not appear to have been met'

  const parts: string[] = [
    'A phone call you placed has finished. Nobody has been told yet.',
    `Goal: ${record.goal}`,
    `Callee: ${record.calleeName ?? 'unknown'} at ${record.calleeNumber}`,
    `Ended because: ${input.endedReason}`,
    `Outcome: ${outcome}`,
  ]
  if (record.dryRun) parts.push('This was a DRY RUN — no number was actually dialled. Say so.')
  if (input.summary) {
    parts.push(`Vapi's summary of the call:\n${wrapUntrusted('vapi:summary', input.summary)}`)
  }
  if (input.structuredData !== null && input.structuredData !== undefined) {
    parts.push(
      `Structured data extracted from the call:\n${wrapUntrusted(
        'vapi:structured-data',
        JSON.stringify(input.structuredData),
      )}`,
    )
  }
  if (input.transcript) {
    parts.push(
      `Transcript:\n${wrapUntrusted('vapi:transcript', input.transcript, {
        maxChars: TRANSCRIPT_MAX_CHARS,
      })}`,
    )
  }
  parts.push(
    [
      'Report this call to the household. Use these headings, and drop any heading with nothing under it.',
      '',
      '*Answers* — go through everything the household wanted to know, one at a time, and say what was',
      'actually said about each. This includes the questions listed above and anything they asked for in',
      'passing when they set the call up. Also put here anything useful the other party volunteered that',
      'nobody thought to ask.',
      '',
      '*Agreed* — what was actually settled. Dates, times, prices, party sizes, names, spellings, the name a',
      'booking is held under. Anything either side could later be held to.',
      '',
      '*Still open* — what needs a decision here, and what would need a second call.',
      '',
      'How to write it:',
      '- Never drop a question because it went unanswered. Say it did not come up, or that they would not',
      '  say, or that you did not get to it. An unanswered question is information — silently omitting it',
      '  reads as though it was never asked, and the household makes decisions on that.',
      '- Report the answers even when the call did not achieve its goal. A booking that failed on payment',
      '  still learned whether there was a table, and that is usually the thing worth knowing.',
      '- Specifics beat summary. Carry every number, date, name and spelling through exactly as you heard it.',
      '- Quote the other party directly where their exact words matter. One sentence per quote.',
      '- Never write something under *Agreed* that you cannot point at in the transcript. If you are unsure',
      '  whether it was agreed or merely discussed, it goes under *What they said*.',
      '- If the goal was missed or the call went badly, say that first and plainly. Do not soften it.',
      '- Length follows the call. A two-minute booking is a few lines; a long conversation earns more.',
      '',
      'If the household rules in your system prompt say anything about how call reports should read, those',
      'win over the shape above.',
      '',
      'Then take or offer the obvious follow-through — an event, a to-do, a reminder, or a second call.',
      'Anything consequential still goes through the normal approval card.',
    ].join('\n'),
  )

  try {
    await enqueueAgentTask({
      prompt: parts.join('\n\n'),
      chatId: chatId ?? undefined,
      actor: 'system',
      trigger: 'call',
      resume: true,
      // The prompt carries the callee's words. Contained: no web, no
      // delegation, and every follow-through is a card — see ToolOrigin.
      origin: 'inbound',
      maxTurns: 12,
    })
  } catch (err) {
    // The record is already stored; a failed enqueue must not roll the report back.
    log.error({ err, callRecordId: record.id }, 'failed to queue call outcome narration')
  }
}

async function chatIdForCall(conversationId: number | null): Promise<string | null> {
  if (conversationId === null) return null
  const rows = await getDb()
    .select({ telegramChatId: schema.conversations.telegramChatId })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, conversationId))
    .limit(1)
  return rows[0]?.telegramChatId ?? null
}
