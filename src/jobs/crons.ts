import { and, asc, eq, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm'
import { DateTime } from 'luxon'
import type { PgBoss } from 'pg-boss'
import { audit } from '../audit/log.js'
import { getConfig } from '../config.js'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { expireStale, getPending } from '../policy/pending.js'
import { editMessage, primaryChatId, sendToChat } from '../telegram/send.js'
import { CRON_QUEUE, QUEUES, enqueueReminder, enqueueWatcherPoll, getBoss, hasJobHandler } from './queue.js'
import { TYPES_BY_KIND } from '../watchers/pipeline.js'
import type { WatcherKind } from '../watchers/pipeline.js'
import {
  MAX_NAGS,
  WEEKDAY,
  dailyCronUtc,
  isQuietHourAt,
  nagsExhausted,
  nextNagAt,
  quietHoursEndAfter,
  weeklyCronUtc,
} from './schedule-math.js'

/**
 * The household's scheduled routines.
 *
 * ## Why the cron expressions are recomputed, not written down
 *
 * pg-boss stores a schedule's cron expression alongside a timezone that
 * defaults to UTC, and we keep every expression in UTC deliberately rather
 * than handing pg-boss an IANA zone. Two reasons:
 *
 *  1. The household's brief hour and timezone live in the `households` row and
 *     change through `/setup`, so the schedule has to be re-derived from the
 *     database anyway. One code path that recomputes everything beats two that
 *     can disagree.
 *  2. A stored UTC expression is directly comparable against `getSchedules()`,
 *     so the resync can tell "unchanged" from "drifted" without reasoning
 *     about pg-boss's own zone handling.
 *
 * The cost is that a UTC expression encodes the offset in force when it was
 * computed. 07:00 in `America/Los_Angeles` is `0 15 * * *` in winter and
 * `0 14 * * *` in summer, so an expression written in January would fire the
 * March brief an hour late. `scheduleHouseholdCrons` therefore runs on boot
 * **and** at the top of every hourly nag sweep, upserting only the expressions
 * that actually moved. Worst-case drift is one hour on the changeover day, and
 * in practice the 03:07-local resync lands well before the 07:00 brief.
 *
 * ## Failure isolation
 *
 * Each routine is a separate job on `household-cron`, keyed by task name, and
 * `runCronTask` wraps the handler: a throwing routine is logged, audited, and
 * rethrown so pg-boss retries and finally dead-letters it. It can never take
 * the other routines with it. `scheduleHouseholdCrons` wraps each `schedule()`
 * call for the same reason, and the sweeps that fan out over rows wrap each row.
 */

const log = logger.child({ mod: 'cron' })

export const CRON_TASKS = {
  morningBrief: 'morning-brief',
  weeklyReview: 'weekly-review',
  followupNags: 'followup-nags',
  pendingExpiry: 'pending-expiry',
  watcherPollEmail: 'watcher-poll-email',
  watcherPollIcs: 'watcher-poll-ics',
  watcherPollPortal: 'watcher-poll-portal',
  watcherPollReply: 'watcher-poll-reply',
  watchdog: 'watchdog',
  dataHygiene: 'data-hygiene',
  birthdaySweep: 'birthday-sweep',
} as const

export type CronTask = (typeof CRON_TASKS)[keyof typeof CRON_TASKS]

/* ────────────────────────── household configuration ──────────────────────── */

export interface HouseholdSettings {
  timezone: string
  briefHour: number
  quietHoursStart: number
  quietHoursEnd: number
}

function clampHour(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? Math.trunc(value) : Number.NaN
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback
}

function validZone(candidate: string | null | undefined, fallback: string): string {
  if (!candidate) return fallback
  return DateTime.now().setZone(candidate).isValid ? candidate : fallback
}

/**
 * The household row, with every field defaulted. Read by the crons and by the
 * reminder worker, which needs the same quiet hours for its follow-up backoff.
 */
export async function loadHouseholdSettings(): Promise<HouseholdSettings> {
  const cfg = getConfig()
  const fallback: HouseholdSettings = {
    timezone: cfg.HOUSEHOLD_TIMEZONE,
    briefHour: 7,
    quietHoursStart: 21,
    quietHoursEnd: 7,
  }
  try {
    const rows = await getDb()
      .select({
        timezone: schema.households.timezone,
        briefHour: schema.households.briefHour,
        quietHoursStart: schema.households.quietHoursStart,
        quietHoursEnd: schema.households.quietHoursEnd,
      })
      .from(schema.households)
      .orderBy(asc(schema.households.id))
      .limit(1)
    const row = rows[0]
    if (!row) return fallback
    return {
      timezone: validZone(row.timezone, fallback.timezone),
      briefHour: clampHour(row.briefHour, fallback.briefHour),
      quietHoursStart: clampHour(row.quietHoursStart, fallback.quietHoursStart),
      quietHoursEnd: clampHour(row.quietHoursEnd, fallback.quietHoursEnd),
    }
  } catch (err) {
    log.error({ err }, 'could not read household settings; using defaults')
    return fallback
  }
}

/* ──────────────────────────────── scheduling ─────────────────────────────── */

interface CronSpec {
  key: CronTask
  cron: string
}

async function buildCronSpecs(reference: Date = new Date()): Promise<CronSpec[]> {
  const s = await loadHouseholdSettings()
  return [
    // Household-local hours, converted to UTC against the offset in force at
    // the next occurrence. See the module comment on why these are recomputed.
    { key: CRON_TASKS.morningBrief, cron: dailyCronUtc(s.timezone, s.briefHour, 0, reference) },
    // Six in the evening, deliberately far from the brief. The brief carries
    // birthdays too, but as one line of an LLM turn under a word cap, which can
    // drop it; this sweep is the deterministic backstop. Five minutes after the
    // rundown it read as an echo of it. Twelve hours later it reads as an
    // evening nudge, which is when a forgotten card can still be signed.
    { key: CRON_TASKS.birthdaySweep, cron: dailyCronUtc(s.timezone, 18, 0, reference) },
    {
      key: CRON_TASKS.weeklyReview,
      cron: weeklyCronUtc(s.timezone, WEEKDAY.sunday, 17, 0, reference),
    },
    // ICS feeds change slowly; poll once, early, so the brief reads fresh data.
    { key: CRON_TASKS.watcherPollIcs, cron: dailyCronUtc(s.timezone, 5, 30, reference) },
    // Portals change about as slowly as feeds, and each poll costs a browser
    // session. pollPortalWatchers itself no-ops when BROWSER_ENABLED is false.
    { key: CRON_TASKS.watcherPollPortal, cron: dailyCronUtc(s.timezone, 6, 0, reference) },
    { key: CRON_TASKS.dataHygiene, cron: dailyCronUtc(s.timezone, 3, 15, reference) },

    // Fixed-interval routines need no conversion — "every 15 minutes" reads the
    // same in every zone.
    { key: CRON_TASKS.followupNags, cron: '7 * * * *' },
    { key: CRON_TASKS.pendingExpiry, cron: '*/5 * * * *' },
    { key: CRON_TASKS.watcherPollEmail, cron: '*/15 * * * *' },
    // Replies to the assistant's own mail deserve the same attention as the inbox.
    { key: CRON_TASKS.watcherPollReply, cron: '*/15 * * * *' },
    { key: CRON_TASKS.watchdog, cron: '*/10 * * * *' },
  ]
}

/**
 * Upserts every household schedule, skipping the ones whose expression has not
 * moved. Called on boot and hourly; safe to call as often as you like.
 */
export async function scheduleHouseholdCrons(boss: PgBoss): Promise<void> {
  const specs = await buildCronSpecs()

  const existing = new Map<string, string>()
  try {
    for (const row of await boss.getSchedules(CRON_QUEUE)) existing.set(row.key, row.cron)
  } catch (err) {
    log.warn({ err }, 'could not read existing schedules; upserting all of them')
  }

  for (const spec of specs) {
    if (existing.get(spec.key) === spec.cron) continue
    try {
      await boss.schedule(CRON_QUEUE, spec.cron, { task: spec.key }, { key: spec.key })
      log.info(
        { task: spec.key, cron: spec.cron, previous: existing.get(spec.key) ?? null },
        'cron schedule upserted',
      )
    } catch (err) {
      // One unusable expression must not cost us the other seven routines.
      log.error({ err, task: spec.key, cron: spec.cron }, 'failed to upsert cron schedule')
    }
  }

  // Drop schedules left by an older release, so nothing keeps firing a task
  // this build no longer handles.
  const owned = new Set<string>(specs.map((s) => s.key))
  for (const key of existing.keys()) {
    if (owned.has(key)) continue
    try {
      await boss.unschedule(CRON_QUEUE, key)
      log.info({ task: key }, 'removed an orphaned cron schedule')
    } catch (err) {
      log.warn({ err, task: key }, 'could not remove an orphaned cron schedule')
    }
  }
}

/* ─────────────────────────────── the dispatch ────────────────────────────── */

const CRON_HANDLERS: Record<string, () => Promise<void>> = {
  [CRON_TASKS.morningBrief]: morningBriefCron,
  [CRON_TASKS.weeklyReview]: weeklyReviewCron,
  [CRON_TASKS.followupNags]: followupNagSweep,
  [CRON_TASKS.pendingExpiry]: pendingExpirySweep,
  [CRON_TASKS.watcherPollEmail]: () => watcherPollSweep('email'),
  [CRON_TASKS.watcherPollIcs]: () => watcherPollSweep('ics'),
  [CRON_TASKS.watcherPollPortal]: () => watcherPollSweep('portal'),
  [CRON_TASKS.watcherPollReply]: () => watcherPollSweep('reply'),
  [CRON_TASKS.watchdog]: watchdogSweep,
  [CRON_TASKS.dataHygiene]: dataHygieneSweep,
  [CRON_TASKS.birthdaySweep]: birthdaySweepCron,
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return typeof err === 'string' ? err : JSON.stringify(err)
}

/**
 * Runs one scheduled routine. Logs and audits every failure, then rethrows so
 * pg-boss retries it and eventually dead-letters it with a Retry button.
 */
export async function runCronTask(task: string): Promise<void> {
  const handler = CRON_HANDLERS[task]
  if (!handler) {
    log.warn({ task }, 'ignoring an unknown cron task')
    return
  }

  const started = Date.now()
  try {
    await handler()
    log.info({ task, durationMs: Date.now() - started }, 'cron finished')
  } catch (err) {
    log.error({ err, task, durationMs: Date.now() - started }, 'cron failed')
    await audit({
      actor: 'system',
      event: 'cron.failed',
      toolName: task,
      resultSummary: errorMessage(err).slice(0, 500),
      ok: false,
    })
    throw err
  }
}

/* ──────────────────────── brief and review (delegated) ───────────────────── */

/**
 * The brief and the review are the same routines `/brief` and `/review` run, so
 * they live in `src/workflows/` and the cron only supplies the trigger. Loaded
 * on demand: a workflow pulls in the agent, the tool registry, and Google, and
 * a static import of that from the queue module would be a cycle back through
 * `src/jobs/queue.ts`.
 */
export async function morningBriefCron(): Promise<void> {
  const { morningBrief } = await import('../workflows/morning-brief.js')
  await morningBrief('cron')
}

export async function weeklyReviewCron(): Promise<void> {
  const { weeklyReview } = await import('../workflows/weekly-review.js')
  await weeklyReview('cron')
}

/**
 * Loaded on demand, the same convention `morningBriefCron` and
 * `weeklyReviewCron` follow: this file is imported by `./queue.js` (for
 * `runCronTask`/`scheduleHouseholdCrons`), so a static import here of a module
 * that ever grows a path back to `queue.js` would become a cycle. Deferring
 * the import keeps that risk out of this file regardless of what
 * `birthday-sweep.js` imports today or later.
 */
export async function birthdaySweepCron(): Promise<void> {
  const { birthdaySweep } = await import('../contacts/birthday-sweep.js')
  await birthdaySweep()
}

/* ───────────────────────────── follow-up nags ────────────────────────────── */

/** How many follow-ups one sweep will chase, so a backlog cannot stall the hour. */
const NAG_BATCH_LIMIT = 50

type FollowupRow = typeof schema.followups.$inferSelect

/**
 * Hourly. Chases open follow-ups on a 1-day, 2-day, 3-day backoff, never
 * inside quiet hours, and gives up after {@link MAX_NAGS}.
 *
 * No model call: a nag is the description the user already gave us plus a Done
 * button, and paying for a turn to rephrase it would make the feature cost more
 * than it saves.
 */
export async function followupNagSweep(): Promise<void> {
  // The hourly sweep doubles as the DST / settings resync — see the module
  // comment. A failure there must not stop the nags.
  try {
    await scheduleHouseholdCrons(await getBoss())
  } catch (err) {
    log.error({ err }, 'cron resync failed during the nag sweep')
  }

  const s = await loadHouseholdSettings()
  const now = new Date()
  const db = getDb()

  const due = await db
    .select()
    .from(schema.followups)
    .where(
      and(
        eq(schema.followups.status, 'open'),
        isNotNull(schema.followups.nextNagAt),
        lte(schema.followups.nextNagAt, now),
      ),
    )
    .orderBy(asc(schema.followups.nextNagAt))
    .limit(NAG_BATCH_LIMIT)

  if (due.length === 0) return

  if (isQuietHourAt(now, s.timezone, s.quietHoursStart, s.quietHoursEnd)) {
    const resumeAt = quietHoursEndAfter(now, s.timezone, s.quietHoursStart, s.quietHoursEnd)
    await db
      .update(schema.followups)
      .set({ nextNagAt: resumeAt })
      .where(
        inArray(
          schema.followups.id,
          due.map((f) => f.id),
        ),
      )
    log.info({ count: due.length, resumeAt }, 'quiet hours; nags deferred')
    return
  }

  for (const followup of due) {
    try {
      await nagOne(followup, s, now)
    } catch (err) {
      // One unreachable chat must not silence the rest of the sweep.
      log.error({ err, followupId: followup.id }, 'failed to chase a follow-up')
    }
  }
}

async function nagOne(
  followup: FollowupRow,
  settings: HouseholdSettings,
  now: Date,
): Promise<void> {
  const db = getDb()
  const chatId = followup.telegramChatId ?? (await primaryChatId())

  if (nagsExhausted(followup.nagCount)) {
    await db
      .update(schema.followups)
      .set({ status: 'abandoned', closedAt: now, nextNagAt: null })
      .where(eq(schema.followups.id, followup.id))
    if (chatId) {
      await sendToChat(
        chatId,
        `I have asked ${MAX_NAGS} times about "${followup.description}" and will stop chasing it. Say the word if you want it back.`,
        { markdown: false },
      )
    }
    await audit({
      actor: 'system',
      event: 'followup.abandoned',
      resultSummary: followup.description.slice(0, 300),
      ok: true,
    })
    log.info({ followupId: followup.id }, 'follow-up abandoned after the nag limit')
    return
  }

  const nagNumber = followup.nagCount + 1

  if (chatId) {
    await sendToChat(
      chatId,
      `🔔 Still open: ${followup.description}\n(nudge ${nagNumber} of ${MAX_NAGS})`,
      {
        markdown: false,
        replyMarkup: {
          inline_keyboard: [[{ text: '✅ Done', callback_data: `fu:${followup.id}:done` }]],
        },
      },
    )
  } else {
    log.warn({ followupId: followup.id }, 'no chat to nag in; only advancing the schedule')
  }

  await db
    .update(schema.followups)
    .set({
      nagCount: nagNumber,
      nextNagAt: nextNagAt({
        from: now,
        nagCount: nagNumber,
        zone: settings.timezone,
        quietHoursStart: settings.quietHoursStart,
        quietHoursEnd: settings.quietHoursEnd,
      }),
    })
    .where(eq(schema.followups.id, followup.id))

  await audit({
    actor: 'system',
    event: 'followup.nagged',
    resultSummary: `nudge ${nagNumber}: ${followup.description.slice(0, 300)}`,
    ok: true,
  })
}

/* ──────────────────────────── pending expiry ─────────────────────────────── */

/**
 * Card copies recorded on a pending row, defensively parsed.
 *
 * `sendApprovalCard` writes `[{ chatId, messageId }, ...]` — one entry per
 * spouse — because the two copies live in two different private chats, so a
 * bare message id would not say which chat to edit. Reading them as a flat
 * `number[]` paired with `row.telegramChatId` yields `NaN` for every entry and
 * leaves both cards on screen still showing live buttons.
 */
interface CardRef {
  chatId: string
  messageId: number
}

function cardRefsOf(value: unknown, fallbackChatId: string | null): CardRef[] {
  if (!Array.isArray(value)) return []
  const out: CardRef[] = []
  for (const entry of value) {
    if (typeof entry === 'object' && entry !== null) {
      const bag = entry as { chatId?: unknown; messageId?: unknown }
      const messageId = Number(bag.messageId)
      const chatId = typeof bag.chatId === 'string' ? bag.chatId : fallbackChatId
      if (chatId && Number.isInteger(messageId) && messageId > 0) out.push({ chatId, messageId })
      continue
    }
    // Tolerate rows written by an older build that stored bare ids.
    const messageId = Number(entry)
    if (fallbackChatId && Number.isInteger(messageId) && messageId > 0) {
      out.push({ chatId: fallbackChatId, messageId })
    }
  }
  return out
}

/**
 * Every five minutes. Flips stale approvals to `expired` and rewrites their
 * Telegram cards, so a card left on screen never looks tappable after the
 * window has closed.
 */
export async function pendingExpirySweep(): Promise<void> {
  const db = getDb()

  // Snapshot first: `expireStale()` reports a count, not the rows, and we need
  // to know which cards to rewrite.
  const candidates = await db
    .select({ id: schema.pendingActions.id })
    .from(schema.pendingActions)
    .where(
      and(
        eq(schema.pendingActions.status, 'pending'),
        lt(schema.pendingActions.expiresAt, sql`now()`),
      ),
    )

  const expired = await expireStale()
  if (expired === 0 || candidates.length === 0) return

  for (const candidate of candidates) {
    try {
      const row = await getPending(candidate.id)
      // Someone may have tapped Approve in the gap; only rewrite what expired.
      if (!row || row.status !== 'expired') continue

      // Every copy, each in its own chat — both spouses are looking at one.
      const refs = cardRefsOf(row.telegramMessageIds, row.telegramChatId)
      if (refs.length === 0) continue

      const body = `⌛ Expired — ${row.humanSummary}\n\nNobody tapped in time, so nothing ran. Ask again if you still want it.`
      for (const ref of refs) {
        await editMessage(ref.chatId, ref.messageId, body, {
          // An empty keyboard clears the Approve / Reject buttons.
          markdown: false,
          replyMarkup: { inline_keyboard: [] },
        })
      }
    } catch (err) {
      log.warn({ err, pendingActionId: candidate.id }, 'could not rewrite an expired card')
    }
  }

  log.info({ expired }, 'expired stale approvals')
}

/* ─────────────────────────────── watcher poll ────────────────────────────── */

/**
 * Fans out one poll job per active watcher. Email and reply watchers run every
 * fifteen minutes; ICS feeds and portals change slowly enough to be daily jobs.
 *
 * The type lists come from `watchers/pipeline.js` — the same source
 * `createWatcher` and the pollers use — so a watcher stored under the
 * canonical type can never fall out of the sweep. (A local copy here once
 * omitted `email_sender`, which silently orphaned every watcher created
 * through `watcher_add`.)
 */
export async function watcherPollSweep(kind: WatcherKind): Promise<void> {
  if (!hasJobHandler(QUEUES.watcherPoll)) {
    log.warn({ kind }, 'no watcher-poll handler is registered; skipping the sweep')
    return
  }

  const types = [...TYPES_BY_KIND[kind]]
  const watchers = await getDb()
    .select({ id: schema.watchers.id, name: schema.watchers.name, type: schema.watchers.type })
    .from(schema.watchers)
    .where(and(eq(schema.watchers.active, true), inArray(schema.watchers.type, types)))

  if (watchers.length === 0) return

  for (const watcher of watchers) {
    try {
      await enqueueWatcherPoll(watcher.id, { type: watcher.type, trigger: kind })
    } catch (err) {
      log.error(
        { err, watcherId: watcher.id, name: watcher.name },
        'failed to queue a watcher poll',
      )
    }
  }
  log.info({ kind, count: watchers.length }, 'watcher polls queued')
}

/* ──────────────────────────────── watchdog ───────────────────────────────── */

/** A reminder stuck mid-fire this long lost its worker to a restart. */
const STUCK_REMINDER_MINUTES = 15

async function step(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (err) {
    log.error({ err, step: name }, 'watchdog step failed')
  }
}

/**
 * Every ten minutes. The probes, the self-fixes (webhook re-registration,
 * cron resync, queue supervision, volume pruning), and the audit-log alert
 * cooldowns all live in `runWatchdog` in `src/ops/watchdog.ts` — loaded on
 * demand because that module imports this one back for the task names, and a
 * static import would be a cycle. The two checks it does not carry — the daily
 * budget line and reminders stuck mid-fire — run here. Each step is
 * independent; a failing step reports and moves on.
 */
export async function watchdogSweep(): Promise<void> {
  await step('sweep', async () => {
    const { runWatchdog } = await import('../ops/watchdog.js')
    await runWatchdog()
  })
  await step('budget', async () => {
    const { checkDailyBudget } = await import('../ops/cost.js')
    await checkDailyBudget()
  })
  await step('stuck-reminders', releaseStuckReminders)
}

/**
 * A reminder claimed but never finished — its worker died mid-send — is
 * released and queued again.
 *
 * Releasing alone is not enough. The pg-boss job that claimed the row has
 * long since expired, retried into "not claimable; skipping", and completed;
 * nothing is left that would fire it. A row put back to `scheduled` with no
 * job behind it reads as healthy and never rings.
 */
async function releaseStuckReminders(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_REMINDER_MINUTES * 60_000)
  const released = await getDb()
    .update(schema.reminders)
    .set({ status: 'scheduled' })
    .where(and(eq(schema.reminders.status, 'firing'), lt(schema.reminders.fireAt, cutoff)))
    .returning({ id: schema.reminders.id })
  if (released.length === 0) return
  log.warn({ count: released.length }, 'released reminders stuck mid-fire, re-queueing them')

  for (const row of released) {
    try {
      const jobId = await enqueueReminder(row.id, new Date())
      await getDb()
        .update(schema.reminders)
        .set({ bossJobId: jobId })
        .where(eq(schema.reminders.id, row.id))
      if (jobId === null) log.error({ reminderId: row.id }, 'stuck reminder was released but not re-queued')
    } catch (err) {
      log.error({ err, reminderId: row.id }, 'could not re-queue a released reminder')
    }
  }
}

/* ────────────────────────────── data hygiene ─────────────────────────────── */

function rowCountOf(result: unknown): number | null {
  const r = result as { rowCount?: number | null } | null
  return r && typeof r.rowCount === 'number' ? r.rowCount : null
}

async function prune(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    const result = await run()
    log.info({ step: label, rows: rowCountOf(result) }, 'hygiene step done')
  } catch (err) {
    log.error({ err, step: label }, 'hygiene step failed')
  }
}

const DAY_MS = 86_400_000
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY_MS)

/**
 * Nightly. The audit log (summarise into a monthly aggregate, then delete),
 * stale approvals, extracted-event compaction, vacuum, and the weekly backup
 * live in `runHygiene` in `src/ops/hygiene.ts` — loaded on demand for the same
 * cycle-avoidance as the watchdog. The table prunes that module does not carry
 * run here. Each step is independent, so a lock on one table cannot cost us
 * the rest of the pass.
 *
 * Deliberately NOT pruned here:
 *  - `audit_log` — `runHygiene` owns it. It writes each month's aggregate row
 *    BEFORE deleting the detail; a plain delete here would race that pass and
 *    destroy the `audit.monthly_summary` rows, which are timestamped inside
 *    the month they describe and so always look "old".
 *  - `extracted_events` — `runHygiene` compacts year-old rows down to their
 *    content hash instead of deleting, because that hash is the only thing
 *    stopping a watcher from re-extracting the same old item on its next poll.
 */
export async function dataHygieneSweep(): Promise<void> {
  try {
    const { runHygiene } = await import('../ops/hygiene.js')
    await runHygiene()
  } catch (err) {
    log.error({ err }, 'the ops hygiene pass failed')
  }

  const cfg = getConfig()
  const db = getDb()
  const metricsCutoff = daysAgo(cfg.AUDIT_RETENTION_DAYS)

  await prune('turn-metrics', () =>
    db.delete(schema.turnMetrics).where(lt(schema.turnMetrics.ts, metricsCutoff)),
  )

  await prune('pending-actions', () =>
    db
      .delete(schema.pendingActions)
      .where(
        and(
          inArray(schema.pendingActions.status, ['executed', 'rejected', 'expired', 'failed']),
          lt(schema.pendingActions.createdAt, daysAgo(30)),
        ),
      ),
  )

  await prune('followups', () =>
    db
      .delete(schema.followups)
      .where(
        and(
          inArray(schema.followups.status, ['done', 'abandoned', 'closed']),
          isNotNull(schema.followups.closedAt),
          lt(schema.followups.closedAt, daysAgo(90)),
        ),
      ),
  )

  // Recurring reminders stay `scheduled` forever, so only terminal rows go.
  await prune('reminders', () =>
    db
      .delete(schema.reminders)
      .where(
        and(
          inArray(schema.reminders.status, ['fired', 'cancelled']),
          lt(schema.reminders.fireAt, daysAgo(90)),
        ),
      ),
  )

  await prune('todos', () =>
    db
      .delete(schema.todos)
      .where(
        and(
          eq(schema.todos.status, 'done'),
          isNotNull(schema.todos.completedAt),
          lt(schema.todos.completedAt, daysAgo(180)),
        ),
      ),
  )

  await prune('oauth-states', () =>
    db.delete(schema.oauthStates).where(lt(schema.oauthStates.expiresAt, new Date())),
  )

  await prune('setup-state', () =>
    db
      .delete(schema.setupState)
      .where(and(eq(schema.setupState.active, false), lt(schema.setupState.updatedAt, daysAgo(30)))),
  )
}
