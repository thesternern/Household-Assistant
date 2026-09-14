import { and, eq } from 'drizzle-orm'
import rrule from 'rrule'
import { audit } from '../audit/log.js'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { sendToChat } from '../telegram/send.js'
import { loadHouseholdSettings } from './crons.js'
import { enqueueReminder } from './queue.js'
import { fromFloatingUtc, nextNagAt, toFloatingUtc } from './schedule-math.js'

const { rrulestr } = rrule

/**
 * The `fire-reminder` worker.
 *
 * **This worker never calls the model.** A household fires thousands of
 * reminders a year and every one of them is a sentence the user already wrote;
 * paying for a turn to repeat it back would be the single largest avoidable
 * cost in the system. The reminder text goes straight to Telegram.
 *
 * What it does do:
 *  1. Claims the reminder atomically, so a redelivered job cannot double-fire.
 *  2. Opens a follow-up so the hourly nag sweep chases the reminder until
 *     somebody taps Done.
 *  3. Sends the text with that Done button attached.
 *  4. Schedules the next occurrence when the reminder recurs, expanding the
 *     rule in household wall-clock time so "every day at 7am" stays at 7am
 *     across a DST change.
 */

const log = logger.child({ mod: 'fire-reminder' })

/** How many occurrences the recurrence walk will skip to catch up after downtime. */
const MAX_CATCHUP_STEPS = 1000

export interface FireReminderInput {
  reminderId: number
}

/* ───────────────────────────── recurrence rules ──────────────────────────── */

const SHORTHAND: Record<string, string> = {
  hourly: 'FREQ=HOURLY',
  daily: 'FREQ=DAILY',
  everyday: 'FREQ=DAILY',
  weekly: 'FREQ=WEEKLY',
  biweekly: 'FREQ=WEEKLY;INTERVAL=2',
  fortnightly: 'FREQ=WEEKLY;INTERVAL=2',
  monthly: 'FREQ=MONTHLY',
  quarterly: 'FREQ=MONTHLY;INTERVAL=3',
  yearly: 'FREQ=YEARLY',
  annually: 'FREQ=YEARLY',
  weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  weekends: 'FREQ=WEEKLY;BYDAY=SA,SU',
}

/**
 * Turn whatever is in `reminders.recurrence` into something `rrulestr` accepts.
 *
 * Any `DTSTART` in the stored value is dropped: the anchor is always the
 * reminder's own `fire_at`, converted to floating wall-clock time by the
 * caller, and a stale `DTSTART` would silently override it.
 */
export function normalizeRecurrence(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null

  const key = trimmed.toLowerCase().replace(/[\s_-]+/g, '')
  const shorthand = SHORTHAND[key]
  if (shorthand) return `RRULE:${shorthand}`

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^DTSTART/i.test(line))
  if (lines.length === 0) return null

  const body = lines.join('\n')
  return /^(RRULE|EXRULE|RDATE|EXDATE)[:;]/i.test(body) ? body : `RRULE:${body}`
}

/**
 * The next occurrence strictly after both `after` and `notBefore`, or null when
 * the rule is finished or unparseable.
 *
 * The expansion runs in floating wall-clock time and is mapped back into
 * `zone` afterwards. rrule does its arithmetic in UTC, so expanding a real
 * instant directly would hold the UTC hour fixed and move a 7am reminder to
 * 6am or 8am the day the clocks change.
 *
 * `notBefore` exists for catch-up: after a redeploy or an outage the stored
 * `fire_at` can be days behind, and the walk skips forward to the first
 * occurrence still in the future rather than scheduling a burst of past ones.
 */
export function nextRecurrence(
  recurrence: string | null | undefined,
  after: Date,
  zone: string,
  notBefore: Date = new Date(),
): Date | null {
  const rule = normalizeRecurrence(recurrence)
  if (!rule) return null

  let parsed: ReturnType<typeof rrulestr>
  try {
    parsed = rrulestr(rule, { dtstart: toFloatingUtc(after, zone), forceset: false })
  } catch (err) {
    log.warn({ err, recurrence }, 'unparseable recurrence rule; treating reminder as one-shot')
    return null
  }

  const floor = Math.max(after.getTime(), notBefore.getTime())
  let cursor = toFloatingUtc(after, zone)

  for (let step = 0; step < MAX_CATCHUP_STEPS; step += 1) {
    let candidate: Date | null
    try {
      candidate = parsed.after(cursor, false)
    } catch (err) {
      log.warn({ err, recurrence }, 'recurrence expansion failed')
      return null
    }
    if (!candidate) return null
    const instant = fromFloatingUtc(candidate, zone)
    if (instant.getTime() > floor) return instant
    cursor = candidate
  }

  log.warn(
    { recurrence, after, steps: MAX_CATCHUP_STEPS },
    'recurrence never reached the future; stopping the series',
  )
  return null
}

/* ──────────────────────────────── the worker ─────────────────────────────── */

export async function fireReminder(input: FireReminderInput): Promise<void> {
  const reminderId = Number(input?.reminderId)
  if (!Number.isInteger(reminderId)) {
    log.warn({ input }, 'fire-reminder job has no usable reminder id')
    return
  }

  const db = getDb()

  // Atomic claim. A redelivered job, or a second worker, finds the row already
  // in `firing` and returns nothing — so the household is never told twice.
  const claimed = await db
    .update(schema.reminders)
    .set({ status: 'firing' })
    .where(and(eq(schema.reminders.id, reminderId), eq(schema.reminders.status, 'scheduled')))
    .returning()

  const reminder = claimed[0]
  if (!reminder) {
    const existing = await db
      .select({ id: schema.reminders.id, status: schema.reminders.status })
      .from(schema.reminders)
      .where(eq(schema.reminders.id, reminderId))
      .limit(1)
    log.info(
      { reminderId, status: existing[0]?.status ?? 'missing' },
      'reminder not claimable; skipping',
    )
    return
  }

  const settings = await loadHouseholdSettings()

  // The follow-up is created first so its id can ride on the reminder's own
  // Done button — one tap closes the chase instead of starting it.
  const inserted = await db
    .insert(schema.followups)
    .values({
      description: reminder.text,
      nextNagAt: nextNagAt({
        from: new Date(),
        nagCount: 0,
        zone: settings.timezone,
        quietHoursStart: settings.quietHoursStart,
        quietHoursEnd: settings.quietHoursEnd,
      }),
      nagCount: 0,
      status: 'open',
      telegramChatId: reminder.telegramChatId,
    })
    .returning({ id: schema.followups.id })
  const followupId = inserted[0]?.id

  // `sendToChat` never throws; it reports failure as an empty list of ids.
  const delivered = await sendToChat(reminder.telegramChatId, `⏰ ${reminder.text}`, {
    markdown: false,
    replyMarkup:
      followupId === undefined
        ? undefined
        : {
            inline_keyboard: [[{ text: '✅ Done', callback_data: `fu:${followupId}:done` }]],
          },
  })

  if (delivered.length === 0) {
    // Roll the claim back so pg-boss's retry can fire this reminder properly,
    // and drop the follow-up we opened for a message nobody received.
    if (followupId !== undefined) {
      await db.delete(schema.followups).where(eq(schema.followups.id, followupId))
    }
    await db
      .update(schema.reminders)
      .set({ status: 'scheduled' })
      .where(eq(schema.reminders.id, reminder.id))
    log.error({ reminderId }, 'reminder was not delivered; released for retry')
    throw new Error(`reminder ${reminderId} could not be delivered to Telegram`)
  }

  const next = nextRecurrence(reminder.recurrence, reminder.fireAt, settings.timezone)

  if (next) {
    let bossJobId: string | null = null
    try {
      bossJobId = await enqueueReminder(reminder.id, next)
    } catch (err) {
      // The reminder was delivered. Losing the *next* occurrence is bad but
      // recoverable; re-firing this one would not be. Leave the row marked
      // fired and say so loudly.
      log.error({ err, reminderId, next }, 'failed to schedule the next occurrence')
    }
    await db
      .update(schema.reminders)
      .set(
        bossJobId
          ? { status: 'scheduled', fireAt: next, bossJobId }
          : { status: 'fired', fireAt: next },
      )
      .where(eq(schema.reminders.id, reminder.id))
    log.info({ reminderId, next, bossJobId }, 'recurring reminder rescheduled')
  } else {
    await db
      .update(schema.reminders)
      .set({ status: 'fired' })
      .where(eq(schema.reminders.id, reminder.id))
    log.info({ reminderId }, 'reminder fired')
  }

  await audit({
    actor: 'system',
    event: 'reminder.fired',
    category: 'reminder_write',
    toolName: 'reminder_fire',
    resultSummary: reminder.text.slice(0, 500),
    ok: true,
  })
}
