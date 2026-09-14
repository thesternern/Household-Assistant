import { and, eq, ne } from 'drizzle-orm'
import type { Bot, CallbackQueryContext, Context } from 'grammy'
import { InlineKeyboard } from 'grammy'
import { registerGroceryCallbacks } from './grocery-card.js'
import { DateTime } from 'luxon'
import { audit } from '../audit/log.js'
import { getConfig } from '../config.js'
import { getDb, schema } from '../db/client.js'
import type { PolicyCategory } from '../db/schema.js'
import { calendar, familyCalendarId, isMissingOnGoogle } from '../integrations/google.js'
import { enqueueAgentTask, enqueueExecuteAction, retryDeadLetterJob } from '../jobs/queue.js'
import type { AgentTaskPayload } from '../jobs/queue.js'
import { logger } from '../logger.js'
import { CATEGORY_LABELS } from '../policy/categories.js'
import { approvePending, getPending, rejectPending } from '../policy/pending.js'
import type { PendingRow } from '../policy/pending.js'
import { wrapUntrusted } from '../tools/untrusted.js'
import { editMessage, md, primaryChatId, resolveActorName, sendToChat } from './send.js'

const log = logger.child({ mod: 'telegram/approvals' })

/** Callback data budget is 64 bytes; `ap:<id>:edit` leaves plenty of room. */
export const CB = {
  approve: (id: number) => `ap:${id}:yes`,
  reject: (id: number) => `ap:${id}:no`,
  edit: (id: number) => `ap:${id}:edit`,
  removeEvent: (extractedEventId: number) => `rm:${extractedEventId}`,
  followupDone: (id: number) => `fu:${id}:done`,
  retryJob: (jobId: string) => `dlq:${jobId}:retry`,
} as const

/**
 * Arg keys a card reads to show a purchase total, most specific first. Display
 * only — the authoritative cap check lives in the policy engine.
 */
const AMOUNT_KEYS = [
  'amountUsd',
  'totalUsd',
  'estimatedTotalUsd',
  'totalPriceUsd',
  'priceUsd',
  'total',
  'amount',
  'price',
] as const

/** Arg keys a card reads to show the number a call would dial. */
const PHONE_KEYS = ['calleeNumber', 'phoneNumber', 'number', 'phone', 'to'] as const

/* ─────────────────────────────── queue plumbing ──────────────────────────── */

function describe(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

/**
 * Hands a turn to the queue instead of running it inline. Telegram handlers
 * must return in milliseconds; an agent turn takes tens of seconds.
 *
 * Never throws: a queue outage must not leave a button spinning.
 */
export async function enqueueAgentTurn(job: AgentTaskPayload): Promise<void> {
  try {
    // pg-boss returns null rather than throwing when it declines to queue.
    // Silence there would look exactly like a model that had nothing to say.
    if ((await enqueueAgentTask(job)) === null) {
      log.error({ chatId: job.chatId, trigger: job.trigger }, 'agent turn was not queued')
    }
  } catch (err) {
    log.error({ err: describe(err), chatId: job.chatId }, 'could not enqueue an agent turn')
  }
}

/* ──────────────────────────────── card rendering ─────────────────────────── */

function firstString(args: unknown, keys: readonly string[]): string | null {
  if (typeof args !== 'object' || args === null) return null
  const bag = args as Record<string, unknown>
  for (const key of keys) {
    const value = bag[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

function amountUsd(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null
  const bag = args as Record<string, unknown>
  for (const key of AMOUNT_KEYS) {
    const raw = bag[key]
    const n =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? Number(raw.replace(/[$,\s]/g, ''))
          : Number.NaN
    if (Number.isFinite(n)) return `$${n.toFixed(2)}`
  }
  return null
}

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category as PolicyCategory] ?? category
}

function zone(): string {
  try {
    return getConfig().HOUSEHOLD_TIMEZONE
  } catch {
    return 'UTC'
  }
}

function expiryLine(expiresAt: Date): string {
  const when = DateTime.fromJSDate(expiresAt).setZone(zone())
  const minutes = Math.round(when.diffNow('minutes').minutes)
  const clock = when.toFormat('h:mm a')
  if (minutes <= 0) return `Expired at ${clock}`
  if (minutes === 1) return `Expires at ${clock} (1 minute)`
  return `Expires at ${clock} (${minutes} minutes)`
}

/** The three-button row every approval card carries. */
export function approvalKeyboard(pendingId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Approve', CB.approve(pendingId))
    .text('✏️ Edit', CB.edit(pendingId))
    .text('❌ Reject', CB.reject(pendingId))
}

/** MarkdownV2 body of a live card: what will happen, who asked, and by when. */
function renderCard(row: PendingRow): string {
  const lines: string[] = [md.bold('🔐 Approval needed'), '', md.escape(row.humanSummary), '']

  if (row.category === 'phone_call') {
    const number = firstString(row.argsJson, PHONE_KEYS)
    if (number) lines.push(`${md.bold('Number')}: ${md.escape(number)}`)
  }
  if (row.category === 'purchase') {
    const total = amountUsd(row.argsJson)
    if (total) lines.push(`${md.bold('Total')}: ${md.escape(total)}`)
  }

  lines.push(`${md.bold('Category')}: ${md.escape(categoryLabel(row.category))}`)
  lines.push(`${md.bold('Asked by')}: ${md.escape(row.requestedBy ?? 'the assistant')}`)
  lines.push(md.escape(expiryLine(row.expiresAt)))
  lines.push('')
  lines.push(md.italic(`Request #${row.id}`))

  return lines.join('\n')
}

/** Body of a card that has been resolved: no buttons, states who decided. */
function renderResolved(row: PendingRow, headline: string): string {
  return [
    md.bold(headline),
    '',
    md.escape(row.humanSummary),
    '',
    md.escape(
      `${categoryLabel(row.category)} · asked by ${row.requestedBy ?? 'the assistant'} · request #${row.id}`,
    ),
  ].join('\n')
}

/** `{chatId, messageId}` pairs written on the pending row when the card was sent. */
interface CardRef {
  chatId: string
  messageId: number
}

function cardRefs(value: unknown): CardRef[] {
  if (!Array.isArray(value)) return []
  const out: CardRef[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const bag = entry as { chatId?: unknown; messageId?: unknown }
    if (typeof bag.chatId === 'string' && typeof bag.messageId === 'number') {
      out.push({ chatId: bag.chatId, messageId: bag.messageId })
    }
  }
  return out
}

/**
 * Rewrites every copy of a card once one spouse has decided, so the other does
 * not tap a button that no longer does anything.
 */
export async function editApprovalCards(row: PendingRow, headline: string): Promise<void> {
  const refs = cardRefs(row.telegramMessageIds)
  if (refs.length === 0) return
  const body = renderResolved(row, headline)
  for (const ref of refs) {
    await editMessage(ref.chatId, ref.messageId, body, {
      markdown: true,
      replyMarkup: { inline_keyboard: [] },
    })
  }
}

/**
 * Renders the pending action and sends it to both spouses, recording every
 * message id so all copies can be retired together.
 */
export async function sendApprovalCard(pendingId: number): Promise<void> {
  let row: PendingRow | undefined
  try {
    row = await getPending(pendingId)
  } catch (err) {
    log.error({ pendingActionId: pendingId, err: describe(err) }, 'could not load pending action')
    return
  }
  if (!row) {
    log.warn({ pendingActionId: pendingId }, 'no pending action to card')
    return
  }
  if (row.status !== 'pending') {
    log.info(
      { pendingActionId: pendingId, status: row.status },
      'skipping card for an already-resolved action',
    )
    return
  }

  const body = renderCard(row)
  const keyboard = approvalKeyboard(row.id)

  let recipients: string[] = []
  try {
    recipients = getConfig().telegramUserIds
  } catch (err) {
    log.error({ err: describe(err) }, 'no telegram recipients configured for an approval card')
  }
  if (recipients.length === 0) {
    const fallback = await primaryChatId()
    if (fallback) recipients = [fallback]
  }

  const refs: CardRef[] = []
  for (const chatId of recipients) {
    const ids = await sendToChat(chatId, body, { markdown: true, replyMarkup: keyboard })
    for (const messageId of ids) refs.push({ chatId, messageId })
  }

  if (refs.length === 0) {
    log.error({ pendingActionId: row.id }, 'approval card could not be delivered to anyone')
    return
  }

  try {
    await getDb()
      .update(schema.pendingActions)
      .set({ telegramMessageIds: refs })
      .where(eq(schema.pendingActions.id, row.id))
  } catch (err) {
    // The card is out; losing the message ids only costs us the tidy-up edit.
    log.error(
      { pendingActionId: row.id, err: describe(err) },
      'could not record approval card message ids',
    )
  }

  log.info({ pendingActionId: row.id, copies: refs.length }, 'approval card sent')
}

/* ─────────────────────────────── decision paths ──────────────────────────── */

/**
 * The result of one decision. `stale` means the row had already moved on, so
 * nothing changed — the caller retires the button that was tapped.
 */
interface Outcome {
  answer: string
  stale: boolean
}

/** Why a second tap found nothing to do. Kept specific so the card is honest. */
async function alreadyResolved(id: number): Promise<Outcome> {
  const row = await getPending(id)
  if (!row) return { answer: `Request #${id} no longer exists.`, stale: true }
  // `approvePending` refuses expired rows without changing their status, so a
  // still-"pending" row here is one that ran out of time.
  if (row.status === 'pending' || row.status === 'expired') {
    return { answer: 'That request expired.', stale: true }
  }
  return { answer: `Already handled by ${row.resolvedBy ?? 'someone else'}.`, stale: true }
}

/**
 * Approve and run. Safe to call twice: `approvePending()` is an atomic
 * pending→approved flip, so only the first caller ever enqueues the execution.
 */
export async function approveAction(pendingId: number, actor: string): Promise<string> {
  return (await doApprove(pendingId, actor)).answer
}

async function doApprove(pendingId: number, actor: string): Promise<Outcome> {
  const row = await approvePending(pendingId, actor)
  if (!row) return alreadyResolved(pendingId)

  // Queue first, rewrite the cards second, so the headline both spouses are
  // left looking at matches what actually happened. The atomic flip above has
  // already claimed the row, so a second tap arriving in this window still
  // finds nothing to do and cannot queue a duplicate execution.
  let queued = false
  let why = 'the job queue refused the job'
  try {
    // A null job id is pg-boss declining to queue, not an error. Treat it as a
    // failure to start: reporting "running it now" for an action that will
    // never run is how an unsent email becomes a missed appointment.
    queued = (await enqueueExecuteAction(row.id)) !== null
    if (!queued) log.error({ pendingActionId: row.id }, 'execute-action send returned no job id')
  } catch (err) {
    why = describe(err)
    log.error(
      { pendingActionId: row.id, err: why },
      'approved but could not enqueue the execution',
    )
  }

  if (!queued) {
    await audit({
      actor,
      event: 'action.enqueue_failed',
      category: row.category,
      toolName: row.toolName,
      resultSummary: why,
      ok: false,
      pendingActionId: row.id,
    })
  }

  await editApprovalCards(
    row,
    queued ? `✅ Approved by ${actor}` : `⚠️ Approved by ${actor} — but it did not start`,
  )

  if (!queued) {
    return { answer: 'Approved, but the job queue is down — I could not start it.', stale: false }
  }
  return { answer: 'Approved — running it now.', stale: false }
}

/**
 * Text lifted off a pending row and dropped into a model prompt.
 *
 * A row the orchestrator raised carries the model's own words, so it goes in
 * verbatim. A row a watcher raised carries text lifted out of a school email,
 * an ICS feed, or a scraped page — attacker-controlled — and the reject and
 * revise prompts would otherwise feed it straight back to the model unfenced,
 * which is the whole injection path the watcher blast radius exists to close.
 * Anything whose provenance is not exactly `agent`, including a row written by
 * an older build with no origin recorded, is fenced.
 */
function forPrompt(row: PendingRow, label: string, text: string): string {
  if (row.origin === 'agent') return text
  return wrapUntrusted(`pending-action-${label}:${row.origin || 'unknown'}`, text)
}

/** Reject, retire the cards, and let the model respond to the refusal. */
export async function rejectAction(pendingId: number, actor: string): Promise<string> {
  return (await doReject(pendingId, actor)).answer
}

async function doReject(pendingId: number, actor: string): Promise<Outcome> {
  const row = await rejectPending(pendingId, actor)
  if (!row) return alreadyResolved(pendingId)

  await editApprovalCards(row, `❌ Rejected by ${actor}`)

  const chatId = row.telegramChatId ?? (await primaryChatId()) ?? ''
  if (chatId) {
    await enqueueAgentTurn({
      chatId,
      actor,
      trigger: 'approval',
      maxTurns: 6,
      prompt:
        `${actor} rejected this pending action, so it did NOT happen. Tool: ${row.toolName}.\n` +
        `What it would have done:\n${forPrompt(row, 'summary', row.humanSummary)}\n\n` +
        `Acknowledge that in one short sentence and ask whether they want a different approach. ` +
        `Do not retry the action.`,
    })
  }

  return { answer: 'Rejected.', stale: false }
}

/**
 * Edit: cancel the stale version, then hand the original arguments to the model
 * so it can ask what to change and re-issue a corrected call. The correction
 * arrives as the household's next message, on the same session.
 */
async function doRevise(
  pendingId: number,
  actor: string,
  fallbackChatId: string,
): Promise<Outcome> {
  const row = await rejectPending(pendingId, actor)
  if (!row) return alreadyResolved(pendingId)

  await editApprovalCards(row, `✏️ ${actor} is revising this`)

  let argsText: string
  try {
    argsText = JSON.stringify(row.argsJson)
  } catch {
    argsText = '(unreadable)'
  }

  const chatId = row.telegramChatId ?? fallbackChatId ?? ''
  if (chatId) {
    await enqueueAgentTurn({
      chatId,
      actor,
      trigger: 'approval',
      maxTurns: 8,
      prompt:
        `${actor} tapped Edit on a pending action instead of approving it. It was cancelled and ` +
        `nothing ran.\nTool: ${row.toolName}\n` +
        `What it would have done:\n${forPrompt(row, 'summary', row.humanSummary)}\n` +
        `Original arguments:\n${forPrompt(row, 'args', argsText)}\n\n` +
        `Ask ${actor}, in one short sentence, exactly what to change. When they answer, re-issue ` +
        `the same tool with the corrected arguments — a fresh approval card is sent automatically. ` +
        `Do not re-issue it before they answer.`,
    })
  }

  return { answer: 'Tell me what to change.', stale: false }
}

/* ───────────────────────────── callback dispatch ─────────────────────────── */

type CbCtx = CallbackQueryContext<Context>

function groups(ctx: CbCtx): string[] {
  const m = ctx.match
  if (typeof m === 'string') return [m]
  if (Array.isArray(m)) return m.map((part) => (typeof part === 'string' ? part : ''))
  return []
}

function intAt(ctx: CbCtx, index: number): number | null {
  const raw = groups(ctx)[index]
  if (!raw) return null
  const n = Number.parseInt(raw, 10)
  return Number.isInteger(n) ? n : null
}

async function actorOf(ctx: CbCtx): Promise<string> {
  const id = ctx.from?.id
  if (id === undefined) return 'someone'
  return resolveActorName(String(id), ctx.from?.first_name)
}

function chatOf(ctx: CbCtx): string {
  const id = ctx.chat?.id ?? ctx.from?.id
  return id === undefined ? '' : String(id)
}

/** Drops the inline keyboard on the tapped message. Failure is cosmetic only. */
async function dropKeyboard(ctx: CbCtx): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } })
  } catch (err) {
    log.debug({ err: describe(err) }, 'could not clear an inline keyboard')
  }
}

/**
 * Wraps a handler so it always answers the callback query — otherwise the
 * client spins forever — and so a thrown handler never kills the update.
 */
function guarded(
  name: string,
  fn: (ctx: CbCtx) => Promise<string | undefined>,
): (ctx: CbCtx) => Promise<void> {
  return async (ctx: CbCtx): Promise<void> => {
    let answer: string | undefined
    try {
      answer = await fn(ctx)
    } catch (err) {
      log.error({ handler: name, err: describe(err) }, 'callback handler failed')
      answer = 'Something went wrong. Nothing was changed.'
    }
    try {
      await ctx.answerCallbackQuery(answer === undefined ? undefined : { text: answer.slice(0, 190) })
    } catch (err) {
      log.debug({ handler: name, err: describe(err) }, 'answerCallbackQuery failed')
    }
  }
}

async function onApprovalTap(ctx: CbCtx): Promise<string | undefined> {
  const id = intAt(ctx, 1)
  const verb = groups(ctx)[2] ?? ''
  if (id === null) return 'That button is malformed.'
  const actor = await actorOf(ctx)

  let outcome: Outcome
  if (verb === 'yes') outcome = await doApprove(id, actor)
  else if (verb === 'no') outcome = await doReject(id, actor)
  else if (verb === 'edit') outcome = await doRevise(id, actor, chatOf(ctx))
  else return 'That button is malformed.'

  // Nothing changed, so no card was rewritten — but the buttons in front of
  // this person are dead. Take them away rather than leave a live-looking card.
  if (outcome.stale) await dropKeyboard(ctx)

  return outcome.answer
}

/** True when Google says the event is already gone. */
async function onRemoveEvent(ctx: CbCtx): Promise<string | undefined> {
  const id = intAt(ctx, 1)
  if (id === null) return 'That button is malformed.'
  const actor = await actorOf(ctx)

  const rows = await getDb()
    .select()
    .from(schema.extractedEvents)
    .where(eq(schema.extractedEvents.id, id))
    .limit(1)
  const row = rows[0]
  if (!row) {
    await dropKeyboard(ctx)
    return 'That entry is already gone.'
  }

  let removed = false
  if (row.calendarEventId) {
    const cal = await calendar()
    if (!cal) {
      return 'Google is not connected right now, so I could not remove it.'
    }
    try {
      await cal.events.delete({
        calendarId: await familyCalendarId(),
        eventId: row.calendarEventId,
      })
      removed = true
    } catch (err) {
      if (!isMissingOnGoogle(err)) {
        log.error(
          { extractedEventId: id, err: describe(err) },
          'could not delete a watcher-created event',
        )
        return 'Google refused the delete. Nothing was changed.'
      }
      removed = true
    }
  }

  await getDb()
    .update(schema.extractedEvents)
    .set({ calendarEventId: null })
    .where(eq(schema.extractedEvents.id, id))

  if (row.reminderId !== null) {
    await getDb()
      .update(schema.reminders)
      .set({ status: 'cancelled' })
      .where(eq(schema.reminders.id, row.reminderId))
  }

  await audit({
    actor,
    event: 'watcher.event_removed',
    category: 'calendar_write_from_watcher',
    resultSummary: `Removed "${row.title}" added by a watcher`,
    ok: true,
  })

  await dropKeyboard(ctx)
  const chatId = chatOf(ctx)
  if (chatId) {
    await sendToChat(
      chatId,
      md.escape(
        removed
          ? `🗑 Removed "${row.title}" from the family calendar.`
          : `🗑 "${row.title}" was not on the calendar; nothing to remove.`,
      ),
      { markdown: true },
    )
  }
  return removed ? 'Removed.' : 'Nothing to remove.'
}

async function onFollowupDone(ctx: CbCtx): Promise<string | undefined> {
  const id = intAt(ctx, 1)
  if (id === null) return 'That button is malformed.'
  const actor = await actorOf(ctx)

  const updated = await getDb()
    .update(schema.followups)
    .set({ status: 'done', closedAt: new Date(), nextNagAt: null })
    .where(and(eq(schema.followups.id, id), ne(schema.followups.status, 'done')))
    .returning({ id: schema.followups.id, description: schema.followups.description })

  await dropKeyboard(ctx)
  const row = updated[0]
  if (!row) return 'Already marked done.'

  await audit({
    actor,
    event: 'followup.acknowledged',
    resultSummary: row.description,
    ok: true,
  })
  return 'Marked done — I will stop nagging.'
}

async function onRetryJob(ctx: CbCtx): Promise<string | undefined> {
  const jobId = groups(ctx)[1] ?? ''
  if (!jobId) return 'That button is malformed.'

  const result = await retryDeadLetterJob(jobId)
  // Only clear the button on success; a failure the household can retry later
  // should keep its button.
  if (result.ok) await dropKeyboard(ctx)
  return result.message
}

/**
 * Registers every inline-button handler. Call once, after the whitelist
 * middleware — a stranger's tap must never reach these.
 */
export function registerCallbackHandlers(bot: Bot): void {
  bot.callbackQuery(/^ap:(\d+):(yes|no|edit)$/, guarded('approval', onApprovalTap))
  bot.callbackQuery(/^rm:(\d+)$/, guarded('remove-event', onRemoveEvent))
  bot.callbackQuery(/^fu:(\d+):done$/, guarded('followup-done', onFollowupDone))
  bot.callbackQuery(/^dlq:(.+):retry$/, guarded('retry-job', onRetryJob))
  // Must be registered here, above the catch-all: grammY dispatches in
  // registration order, so a handler added after it would never fire.
  registerGroceryCallbacks(bot, guarded)

  // Anything else is a button from an older deploy. Answer it so the client
  // stops spinning, and say something true rather than nothing.
  bot.on('callback_query:data', async (ctx) => {
    log.warn({ data: ctx.callbackQuery.data }, 'unrecognised callback data')
    try {
      await ctx.answerCallbackQuery({ text: 'That button is from an older message.' })
    } catch (err) {
      log.debug({ err: describe(err) }, 'answerCallbackQuery failed')
    }
  })
}
