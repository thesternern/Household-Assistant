import { readdir, rm, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm'
import { DateTime } from 'luxon'
import type { PgBoss } from 'pg-boss'
import { audit } from '../audit/log.js'
import { getConfig } from '../config.js'
import { getDb, schema } from '../db/client.js'
import {
  calendar as googleCalendar,
  isInvalidGrant,
  reportInvalidGrant,
} from '../integrations/google.js'
import { CRON_TASKS, loadHouseholdSettings, scheduleHouseholdCrons } from '../jobs/crons.js'
import { CRON_QUEUE, DEAD_LETTER_QUEUE, QUEUES, getBoss } from '../jobs/queue.js'
import { logger } from '../logger.js'
import { listPending } from '../policy/pending.js'
import { getBot, sendToAll } from '../telegram/send.js'

/**
 * The self-maintenance sweep.
 *
 * Two jobs, one set of probes:
 *
 *  - `runWatchdog()` runs on a cron. Every check is independently try/caught, so
 *    a Telegram outage cannot stop the disk check from running. Anything the
 *    watchdog can put right, it puts right and stays quiet about — unless the
 *    same fix keeps being needed, which is itself the problem. Anything it
 *    cannot fix goes to both spouses as one message saying what is broken and
 *    what it already tried.
 *  - `statusReport()` answers `/status`. Same probes, read-only: it never
 *    re-registers, requeues, or deletes anything.
 *
 * The rule that shapes the whole file: **a health check must never be the thing
 * that breaks the house.** Nothing here throws, nothing here blocks forever, and
 * every self-fix is idempotent.
 */

const log = logger.child({ mod: 'ops/watchdog' })

/* ─────────────────────────────── thresholds ──────────────────────────────── */

/** A queue this deep is not draining. Matches the inline check in `src/jobs/crons.ts`. */
export const QUEUE_BACKLOG_ALERT = 50
/** Retained failures per queue past which something is failing repeatedly, not once. */
export const QUEUE_FAILURE_ALERT = 10
/** Undelivered Telegram updates past which the webhook is effectively down. */
const PENDING_UPDATE_ALERT = 50
/** Telegram delivery errors newer than this still count as current. */
const WEBHOOK_ERROR_WINDOW_SECONDS = 1800
/** Postgres connection use past which the pool is close to the ceiling. */
const CONNECTION_PRESSURE = 0.8
/** `/data` use past which the volume gets pruned. */
export const VOLUME_PRUNE_PERCENT = 80
/** Agent SDK session transcripts older than this are prunable. */
export const SESSION_MAX_AGE_DAYS = 30
/** The Railway volume. Everything durable the app writes lives under here. */
export const DATA_DIR = '/data'
/**
 * How long a cron job row survives in `household-cron` before pg-boss deletes
 * it (`deleteAfterSeconds: 172_800` in `src/jobs/queue.ts`). A routine whose
 * window is longer than this legitimately has no job on file, so "no record" is
 * reported as unknown rather than stale.
 */
export const CRON_JOB_RETENTION_MINUTES = 2880

/** How long a self-fix is remembered when deciding whether it keeps happening. */
const REPEAT_FIX_WINDOW_HOURS = 24
/** This many fixes of the same thing inside the window turns a silent fix into an alert. */
const REPEAT_FIX_THRESHOLD = 3

/** Default gap between two alerts about the same thing. */
const DEFAULT_COOLDOWN_HOURS = 6
/** Per-key overrides. A dead Google grant needs one nag a day, not four. */
const COOLDOWN_HOURS: Record<string, number> = {
  google: 24,
  vapi: 24,
  browser: 24,
  volume: 12,
}

/** Audit events. `watchdog.alert` is shared with `src/jobs/crons.ts` so the two dedupe together. */
export const ALERT_EVENT = 'watchdog.alert'
export const FIX_EVENT = 'watchdog.fixed'
export const SNAPSHOT_EVENT = 'watchdog.queue_snapshot'

/**
 * How long each cron may go without running before it counts as stale. Generous
 * on purpose: a late brief is not an incident, a brief that has not run in a day
 * is. Windows longer than the cron queue's retention cannot be checked at all
 * when there is no job on file, and are reported as unknown rather than stale.
 */
const CRON_WINDOW_MINUTES: Record<string, number> = {
  [CRON_TASKS.morningBrief]: 26 * 60,
  [CRON_TASKS.weeklyReview]: 8 * 24 * 60,
  [CRON_TASKS.followupNags]: 3 * 60,
  [CRON_TASKS.pendingExpiry]: 30,
  [CRON_TASKS.watcherPollEmail]: 60,
  [CRON_TASKS.watcherPollIcs]: 26 * 60,
  [CRON_TASKS.watcherPollPortal]: 26 * 60,
  [CRON_TASKS.watcherPollReply]: 60,
  [CRON_TASKS.watchdog]: 40,
  [CRON_TASKS.dataHygiene]: 26 * 60,
  [CRON_TASKS.birthdaySweep]: 26 * 60,
}

const CRON_LABELS: Record<string, string> = {
  [CRON_TASKS.morningBrief]: 'morning brief',
  [CRON_TASKS.weeklyReview]: 'weekly review',
  [CRON_TASKS.followupNags]: 'follow-up nags',
  [CRON_TASKS.pendingExpiry]: 'approval expiry',
  [CRON_TASKS.watcherPollEmail]: 'email watchers',
  [CRON_TASKS.watcherPollIcs]: 'calendar-feed watchers',
  [CRON_TASKS.watcherPollPortal]: 'portal watchers',
  [CRON_TASKS.watcherPollReply]: 'reply watchers',
  [CRON_TASKS.watchdog]: 'watchdog',
  [CRON_TASKS.dataHygiene]: 'data hygiene',
}

const ALL_CRON_TASKS: readonly string[] = Object.values(CRON_TASKS)

/* ───────────────────────────────── the report ────────────────────────────── */

export type CheckStatus = 'ok' | 'fixed' | 'degraded' | 'broken' | 'skipped'

export interface WatchdogCheck {
  /** Stable key. Doubles as the alert cooldown key. */
  key: string
  /** Short human name, e.g. `Google`. */
  label: string
  status: CheckStatus
  /** What is true right now, in one or two sentences. */
  detail: string
  /** What the watchdog already did about it. */
  tried?: string
  /** What a human would have to do. */
  advice?: string
}

export interface WatchdogReport {
  ranAt: string
  durationMs: number
  /** Every check, in run order. */
  checks: WatchdogCheck[]
  /** Checks the watchdog put right on its own. */
  fixed: WatchdogCheck[]
  /** Checks a human has to look at. */
  problems: WatchdogCheck[]
  /** True when nothing is broken or degraded. */
  healthy: boolean
  /** Keys included in the Telegram message this sweep (the rest were on cooldown). */
  alerted: string[]
}

const ok = (key: string, label: string, detail: string): WatchdogCheck => ({
  key,
  label,
  status: 'ok',
  detail,
})
const skipped = (key: string, label: string, detail: string): WatchdogCheck => ({
  key,
  label,
  status: 'skipped',
  detail,
})
const fixedCheck = (
  key: string,
  label: string,
  detail: string,
  tried: string,
): WatchdogCheck => ({ key, label, status: 'fixed', detail, tried })
const problem = (
  status: 'degraded' | 'broken',
  key: string,
  label: string,
  detail: string,
  extra?: { tried?: string; advice?: string },
): WatchdogCheck => ({ key, label, status, detail, ...extra })

function describe(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err) ?? 'unknown error'
  } catch {
    return 'unknown error'
  }
}

/** Runs one probe, converting any throw into a `broken` check rather than a dead sweep. */
async function guard(
  key: string,
  label: string,
  probe: () => Promise<WatchdogCheck>,
): Promise<WatchdogCheck> {
  try {
    return await probe()
  } catch (err) {
    const detail = describe(err)
    log.error({ err, check: key }, 'watchdog check failed')
    return problem('broken', key, label, `The ${label.toLowerCase()} check itself failed: ${detail}`)
  }
}

/* ───────────────────────────── formatting helpers ────────────────────────── */

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many)

function bytesText(bytes: number): string {
  const n = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i] ?? 'B'}`
}

function agoText(at: Date | null, zone: string): string {
  if (!at) return 'never'
  const dt = DateTime.fromJSDate(at).setZone(zone)
  if (!dt.isValid) return 'unknown'
  const minutes = Math.max(0, Math.round(DateTime.now().diff(dt, 'minutes').minutes))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 60 * 36) return `${Math.round(minutes / 60)}h ago`
  return dt.toFormat('ccc d LLL HH:mm')
}

/* ══════════════════════════════════════════════════════════════════════════
   Probes — each one is read-only unless `fix` is true
   ══════════════════════════════════════════════════════════════════════════ */

/* ─────────────────────────────────── database ────────────────────────────── */

export interface DbHealth {
  reachable: boolean
  used: number
  cap: number
  error?: string
}

export async function probeDatabase(): Promise<DbHealth> {
  try {
    const result = await getDb().execute<{ used: number; cap: number }>(sql`
      select
        (select count(*) from pg_stat_activity where datname = current_database())::int as used,
        (select setting::int from pg_settings where name = 'max_connections') as cap
    `)
    const row = result.rows[0]
    return {
      reachable: true,
      used: Number(row?.used ?? 0),
      cap: Number(row?.cap ?? 0),
    }
  } catch (err) {
    return { reachable: false, used: 0, cap: 0, error: describe(err) }
  }
}

function databaseCheck(health: DbHealth): WatchdogCheck {
  if (!health.reachable) {
    return problem(
      'broken',
      'database',
      'Database',
      `Postgres did not answer: ${health.error ?? 'unknown error'}.`,
      { advice: 'Check the Railway Postgres service — nothing works until it is back.' },
    )
  }
  const detail =
    health.cap > 0
      ? `Reachable. ${health.used} of ${health.cap} connections in use.`
      : `Reachable. ${health.used} connections in use.`
  if (health.cap > 0 && health.used / health.cap >= CONNECTION_PRESSURE) {
    return problem('degraded', 'database', 'Database', detail, {
      advice:
        'Something is leaking connections, or another service shares this database. ' +
        'A redeploy clears the app’s own pools.',
    })
  }
  return ok('database', 'Database', detail)
}

/* ─────────────────────────────── telegram webhook ────────────────────────── */

/**
 * Health of the Telegram webhook.
 *
 * There is no `url` field here, and that is deliberate: the registered webhook
 * carries `TELEGRAM_WEBHOOK_SECRET` in its path. Nothing in this module logs it,
 * puts it in an audit row, or prints it into a chat message — only whether it is
 * the URL this deployment expects.
 */
export interface WebhookHealth {
  /** `polling` locally, where the bot long-polls and there is no webhook. */
  mode: 'webhook' | 'polling'
  /** True when Telegram has any webhook registered at all. */
  registered: boolean
  /** True when what Telegram holds is not what this deployment expects. */
  drifted: boolean
  pending: number
  lastError: string | null
  lastErrorRecent: boolean
  error?: string
}

export async function probeWebhook(): Promise<WebhookHealth> {
  const cfg = getConfig()
  const blank: WebhookHealth = {
    mode: cfg.isProd ? 'webhook' : 'polling',
    registered: false,
    drifted: false,
    pending: 0,
    lastError: null,
    lastErrorRecent: false,
  }
  if (!cfg.isProd) return blank

  try {
    // Loaded on demand: `src/telegram/bot.ts` pulls in the command handlers,
    // which import this module back.
    const { expectedWebhookUrl } = await import('../telegram/bot.js')
    const info = await getBot().api.getWebhookInfo()
    const current = info.url ?? ''
    const nowSeconds = Date.now() / 1000
    const lastErrorRecent =
      typeof info.last_error_date === 'number' &&
      nowSeconds - info.last_error_date < WEBHOOK_ERROR_WINDOW_SECONDS
    return {
      mode: 'webhook',
      registered: current.length > 0,
      drifted: current !== expectedWebhookUrl(),
      pending: info.pending_update_count ?? 0,
      lastError: lastErrorRecent ? (info.last_error_message ?? 'no detail') : null,
      lastErrorRecent,
    }
  } catch (err) {
    return { ...blank, error: describe(err) }
  }
}

async function webhookCheck(health: WebhookHealth, fix: boolean): Promise<WatchdogCheck> {
  const label = 'Telegram'
  if (health.mode === 'polling') {
    return skipped('telegram-webhook', label, 'Long polling locally — there is no webhook to police.')
  }
  if (health.error) {
    return problem('broken', 'telegram-webhook', label, `Telegram did not answer: ${health.error}.`, {
      advice: 'Check TELEGRAM_BOT_TOKEN and whether api.telegram.org is reachable from Railway.',
    })
  }

  if (health.drifted) {
    const was = health.registered
      ? 'pointed somewhere that is not this deployment'
      : 'not registered at all'
    if (!fix) {
      return problem(
        'broken',
        'telegram-webhook',
        label,
        `The webhook is ${was}, so your messages are not reaching me.`,
        { advice: 'The watchdog re-registers this automatically on its next sweep.' },
      )
    }
    const { registerWebhook } = await import('../telegram/bot.js')
    await registerWebhook()
    // Never log either URL: both carry the webhook secret in the path.
    log.warn({ hadUrl: health.registered }, 'telegram webhook re-registered')
    return fixedCheck(
      'telegram-webhook',
      label,
      `The webhook was ${was}; it now points at this deployment.`,
      're-registered the webhook with Telegram',
    )
  }

  if (health.lastErrorRecent) {
    return problem(
      'degraded',
      'telegram-webhook',
      label,
      `Telegram is reporting delivery errors: ${health.lastError ?? 'no detail'}. ` +
        `${health.pending} ${plural(health.pending, 'update')} waiting.`,
      {
        tried: 'the webhook URL is correct, so there was nothing to re-register',
        advice: 'Usually the app was restarting. If it persists, check the Railway deploy logs.',
      },
    )
  }

  if (health.pending >= PENDING_UPDATE_ALERT) {
    return problem(
      'degraded',
      'telegram-webhook',
      label,
      `${health.pending} Telegram updates are queued but undelivered.`,
      { advice: 'The app may be down or too slow to answer. Check the Railway service.' },
    )
  }

  return ok(
    'telegram-webhook',
    label,
    `Webhook registered and healthy${health.pending > 0 ? `, ${health.pending} waiting` : ''}.`,
  )
}

/* ───────────────────────────────── queues ────────────────────────────────── */

export interface QueueDepth {
  name: string
  ready: number
  active: number
  failed: number
  deferred: number
}

export interface QueueHealth {
  reachable: boolean
  queues: QueueDepth[]
  deadLetter: QueueDepth | null
  error?: string
}

const WORK_QUEUES: readonly string[] = [...Object.values(QUEUES), CRON_QUEUE]

export async function probeQueues(boss?: PgBoss): Promise<QueueHealth> {
  try {
    const instance = boss ?? (await getBoss())
    const rows = await instance.getQueues([...WORK_QUEUES, DEAD_LETTER_QUEUE])
    const depths: QueueDepth[] = rows.map((q) => ({
      name: q.name,
      ready: q.readyCount ?? 0,
      active: q.activeCount ?? 0,
      failed: q.failedCount ?? 0,
      deferred: q.deferredCount ?? 0,
    }))
    return {
      reachable: true,
      queues: depths.filter((q) => q.name !== DEAD_LETTER_QUEUE),
      deadLetter: depths.find((q) => q.name === DEAD_LETTER_QUEUE) ?? null,
    }
  } catch (err) {
    return { reachable: false, queues: [], deadLetter: null, error: describe(err) }
  }
}

/** The previous sweep's depths, when one was recorded recently enough to compare against. */
async function previousQueueSnapshot(): Promise<Map<string, QueueDepth>> {
  const out = new Map<string, QueueDepth>()
  try {
    const since = new Date(Date.now() - 30 * 60_000)
    const rows = await getDb()
      .select({ args: schema.auditLog.argsJson })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.event, SNAPSHOT_EVENT), gte(schema.auditLog.ts, since)))
      .orderBy(desc(schema.auditLog.ts))
      .limit(1)
    const args = rows[0]?.args
    const queues = (args as { queues?: unknown } | null)?.queues
    if (!Array.isArray(queues)) return out
    for (const entry of queues) {
      if (!entry || typeof entry !== 'object') continue
      const q = entry as Partial<QueueDepth>
      if (typeof q.name !== 'string') continue
      out.set(q.name, {
        name: q.name,
        ready: Number(q.ready ?? 0),
        active: Number(q.active ?? 0),
        failed: Number(q.failed ?? 0),
        deferred: Number(q.deferred ?? 0),
      })
    }
  } catch (err) {
    log.warn({ err }, 'could not read the previous queue snapshot')
  }
  return out
}

async function recordQueueSnapshot(queues: QueueDepth[]): Promise<void> {
  const busy = queues.filter((q) => q.ready > 0 || q.active > 0 || q.failed > 0)
  await audit({
    actor: 'system',
    event: SNAPSHOT_EVENT,
    resultSummary: busy.length === 0 ? 'all queues idle' : busy.map((q) => `${q.name}:${q.ready}`).join(' '),
    args: { queues: busy },
    ok: true,
  })
}

/**
 * Depth, wedged work, and repeat failures.
 *
 * The self-fix is `supervise()`: pg-boss's own maintenance pass, which expires
 * jobs whose worker died holding them. An expired job goes back for its next
 * retry, or — if its retries are spent — into the dead-letter queue, which
 * already tells the household and offers a Retry button. That is exactly the
 * "requeue or dead-letter" this needs, and it is the only safe version of it:
 * blindly re-sending a dead-lettered payload could place a second phone call or
 * spend money twice, so that stays a human decision behind the Retry button.
 */
async function queueCheck(
  health: QueueHealth,
  previous: Map<string, QueueDepth>,
  fix: boolean,
  boss: PgBoss | null,
): Promise<WatchdogCheck> {
  const label = 'Job queues'
  if (!health.reachable) {
    return problem('broken', 'queues', label, `pg-boss did not answer: ${health.error ?? 'unknown error'}.`, {
      advice: 'The job database is unreachable. Nothing scheduled will run until it is back.',
    })
  }

  const backed = health.queues.filter((q) => q.ready >= QUEUE_BACKLOG_ALERT)
  const failing = health.queues.filter((q) => q.failed >= QUEUE_FAILURE_ALERT)

  // Wedged: work is waiting, something claims to be running it, and the backlog
  // has not moved since the last sweep ten minutes ago.
  const wedged = health.queues.filter((q) => {
    const before = previous.get(q.name)
    return before !== undefined && q.ready > 0 && q.active > 0 && q.ready >= before.ready
  })

  let supervised: string[] = []
  if (fix && wedged.length > 0 && boss) {
    for (const q of wedged) {
      try {
        await boss.supervise(q.name)
        supervised.push(q.name)
      } catch (err) {
        log.error({ err, queue: q.name }, 'could not supervise a wedged queue')
      }
    }
  }
  supervised = [...new Set(supervised)]

  const deadLetterWaiting = health.deadLetter?.ready ?? 0

  if (backed.length === 0 && failing.length === 0 && wedged.length === 0 && deadLetterWaiting === 0) {
    const busy = health.queues.filter((q) => q.ready > 0 || q.active > 0)
    return ok(
      'queues',
      label,
      busy.length === 0
        ? 'All queues idle.'
        : `Draining normally — ${busy.map((q) => `${q.name} ${q.ready}/${q.active}`).join(', ')} (waiting/running).`,
    )
  }

  const parts: string[] = []
  if (backed.length > 0) {
    parts.push(`backed up: ${backed.map((q) => `${q.name} ${q.ready} waiting`).join(', ')}`)
  }
  if (wedged.length > 0) {
    parts.push(`not moving since the last sweep: ${wedged.map((q) => q.name).join(', ')}`)
  }
  if (failing.length > 0) {
    parts.push(`failing repeatedly: ${failing.map((q) => `${q.name} ${q.failed} failures`).join(', ')}`)
  }
  if (deadLetterWaiting > 0) {
    parts.push(`${deadLetterWaiting} dead-lettered ${plural(deadLetterWaiting, 'job')} unannounced`)
  }

  if (supervised.length > 0 && backed.length === 0 && failing.length === 0 && deadLetterWaiting === 0) {
    return fixedCheck(
      'queues',
      label,
      `${supervised.join(', ')} was wedged; expired jobs have been released.`,
      `ran pg-boss maintenance on ${supervised.join(', ')} so stalled jobs retry or dead-letter`,
    )
  }

  return problem('degraded', 'queues', label, `Background work is not healthy — ${parts.join('; ')}.`, {
    tried:
      supervised.length > 0
        ? `ran pg-boss maintenance on ${supervised.join(', ')} so stalled jobs retry or dead-letter`
        : 'nothing safe to retry automatically — replaying an approved action could act twice',
    advice:
      'Check the Railway logs for the failing worker. Dead-lettered jobs each carry their own Retry button in chat.',
  })
}

/* ────────────────────────────── cron freshness ───────────────────────────── */

export interface CronHealth {
  reachable: boolean
  /** Cron keys pg-boss has a schedule for. */
  scheduled: string[]
  /** Last time each task was enqueued, in run order. */
  lastRun: Array<{ task: string; at: Date | null }>
  error?: string
}

export async function probeCrons(boss?: PgBoss): Promise<CronHealth> {
  try {
    const instance = boss ?? (await getBoss())
    const schedules = await instance.getSchedules(CRON_QUEUE)
    const jobs = await instance.findJobs<{ task?: unknown }>(CRON_QUEUE)

    const latest = new Map<string, Date>()
    for (const job of jobs) {
      const task = typeof job.data?.task === 'string' ? job.data.task : null
      if (!task) continue
      const at = job.createdOn instanceof Date ? job.createdOn : new Date(job.createdOn)
      if (Number.isNaN(at.getTime())) continue
      const seen = latest.get(task)
      if (!seen || at > seen) latest.set(task, at)
    }

    return {
      reachable: true,
      scheduled: schedules.map((s) => s.key),
      lastRun: ALL_CRON_TASKS.map((task) => ({ task, at: latest.get(task) ?? null })),
    }
  } catch (err) {
    return { reachable: false, scheduled: [], lastRun: [], error: describe(err) }
  }
}

interface CronVerdict {
  task: string
  label: string
  at: Date | null
  state: 'fresh' | 'stale' | 'unknown'
}

export function judgeCrons(
  health: CronHealth,
  now: Date = new Date(),
  uptimeMinutes: number = process.uptime() / 60,
): CronVerdict[] {
  return health.lastRun.map(({ task, at }) => {
    const label = CRON_LABELS[task] ?? task
    const window = CRON_WINDOW_MINUTES[task] ?? 24 * 60
    if (!at) {
      // Cron job rows age out after two days, so a weekly routine legitimately
      // has nothing on file. Only claim "stale" when a run should still be here.
      if (window > CRON_JOB_RETENTION_MINUTES) return { task, label, at: null, state: 'unknown' }

      // And a routine cannot be behind before this process has been alive long
      // enough to have run it. A daily job on a service that deployed an hour
      // ago has no record because its hour has not come round yet, which is not
      // the same as being late — and reporting it as late sends the household
      // to check whether the worker is running, which it plainly is.
      if (uptimeMinutes < window) return { task, label, at: null, state: 'unknown' }

      return { task, label, at: null, state: 'stale' }
    }
    const minutes = (now.getTime() - at.getTime()) / 60_000
    return { task, label, at, state: minutes > window ? 'stale' : 'fresh' }
  })
}

async function cronCheck(health: CronHealth, fix: boolean, boss: PgBoss | null): Promise<WatchdogCheck> {
  const label = 'Scheduled routines'
  if (!health.reachable) {
    return problem('broken', 'crons', label, `Could not read the schedules: ${health.error ?? 'unknown error'}.`)
  }

  const registered = new Set(health.scheduled)
  const missing = ALL_CRON_TASKS.filter((task) => !registered.has(task))
  const verdicts = judgeCrons(health)
  const stale = verdicts.filter((v) => v.state === 'stale')

  if (missing.length === 0 && stale.length === 0) {
    return ok('crons', label, `All ${verdicts.length} routines are scheduled and running on time.`)
  }

  // Re-upserting is cheap and idempotent, and it is the actual fix for both
  // failure modes: a schedule dropped by a bad deploy, and a UTC expression
  // that drifted an hour when the clocks changed.
  let resynced = false
  if (fix && boss) {
    try {
      await scheduleHouseholdCrons(boss)
      resynced = true
    } catch (err) {
      log.error({ err }, 'could not resync the cron schedules')
    }
  }

  const names = (list: Array<{ label: string }>): string => list.map((v) => v.label).join(', ')

  if (missing.length > 0 && stale.length === 0 && resynced) {
    return fixedCheck(
      'crons',
      label,
      `${missing.length} ${plural(missing.length, 'routine')} had no schedule; re-registered.`,
      'rewrote the pg-boss cron schedules from the household settings',
    )
  }

  const parts: string[] = []
  if (missing.length > 0) {
    parts.push(`${missing.map((t) => CRON_LABELS[t] ?? t).join(', ')} had no schedule at all`)
  }
  if (stale.length > 0) {
    parts.push(`${names(stale)} ${stale.length === 1 ? 'has' : 'have'} not run inside their window`)
  }

  return problem('degraded', 'crons', label, `Scheduled work is behind — ${parts.join('; ')}.`, {
    tried: resynced
      ? 'rewrote the pg-boss cron schedules from the household settings'
      : 'could not reach pg-boss to rewrite the schedules',
    advice: 'If they stay behind, the worker process is not running. Check the Railway service is awake.',
  })
}

/* ────────────────────────────────── google ───────────────────────────────── */

export interface GoogleAccount {
  userId: number
  displayName: string
  email: string | null
  invalid: boolean
  updatedAt: Date | null
}

export interface GoogleHealth {
  configured: boolean
  accounts: GoogleAccount[]
  /** null when there was nothing to test. */
  apiOk: boolean | null
  invalidGrant: boolean
  error?: string
}

/** Every stored grant, labelled with whichever spouse authorised it. */
async function googleAccounts(): Promise<GoogleAccount[]> {
  const rows = await getDb()
    .select({
      userId: schema.googleTokens.userId,
      email: schema.googleTokens.email,
      invalid: schema.googleTokens.invalid,
      updatedAt: schema.googleTokens.updatedAt,
      displayName: schema.users.displayName,
    })
    .from(schema.googleTokens)
    .leftJoin(schema.users, eq(schema.users.id, schema.googleTokens.userId))
    .orderBy(asc(schema.googleTokens.id))

  return rows.map((r) => ({
    userId: r.userId,
    displayName: r.displayName ?? `user ${r.userId}`,
    email: r.email,
    invalid: r.invalid,
    updatedAt: r.updatedAt,
  }))
}

/**
 * A single, cheap Calendar call. `calendarList.list` with one result is the
 * lightest thing the API offers that still proves the grant works.
 */
export async function probeGoogle(): Promise<GoogleHealth> {
  const cfg = getConfig()
  if (!cfg.googleConfigured) {
    return { configured: false, accounts: [], apiOk: null, invalidGrant: false }
  }

  let accounts: GoogleAccount[] = []
  try {
    accounts = await googleAccounts()
  } catch (err) {
    return { configured: true, accounts: [], apiOk: null, invalidGrant: false, error: describe(err) }
  }

  if (accounts.length === 0 || accounts.every((a) => a.invalid)) {
    return { configured: true, accounts, apiOk: false, invalidGrant: accounts.length > 0 }
  }

  const client = await googleCalendar()
  if (!client) {
    // `calendar()` returns null after it has already flagged the grant invalid.
    return { configured: true, accounts: await safeAccounts(accounts), apiOk: false, invalidGrant: true }
  }

  try {
    await client.calendarList.list({ maxResults: 1 })
    return { configured: true, accounts, apiOk: true, invalidGrant: false }
  } catch (err) {
    if (isInvalidGrant(err)) {
      // Flags the row, audits it, and tells both spouses exactly once.
      await reportInvalidGrant(err)
      return {
        configured: true,
        accounts: await safeAccounts(accounts),
        apiOk: false,
        invalidGrant: true,
        error: 'invalid_grant',
      }
    }
    return { configured: true, accounts, apiOk: false, invalidGrant: false, error: describe(err) }
  }
}

/** Re-reads the grant rows after something may have flipped one to invalid. */
async function safeAccounts(fallback: GoogleAccount[]): Promise<GoogleAccount[]> {
  try {
    return await googleAccounts()
  } catch {
    return fallback
  }
}

function googleCheck(health: GoogleHealth): WatchdogCheck {
  const label = 'Google'
  if (!health.configured) {
    return skipped('google', label, 'Not configured — GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are unset.')
  }
  if (health.accounts.length === 0) {
    return problem('degraded', 'google', label, 'No Google account is linked, so Calendar and Gmail are unavailable.', {
      advice: 'Send /connect_google to link the household account.',
    })
  }
  if (health.invalidGrant) {
    return problem('broken', 'google', label, 'Google has revoked my access — Calendar and Gmail are offline.', {
      tried: 'refreshed the stored token, which Google rejected with invalid_grant',
      advice: 'Send /connect_google and follow the link. Nothing else fixes this.',
    })
  }
  if (health.apiOk === false) {
    return problem('degraded', 'google', label, `The Calendar API did not answer: ${health.error ?? 'unknown error'}.`, {
      tried: 'a single calendarList read',
      advice: 'Usually a transient Google outage. If it lasts, run /connect_google.',
    })
  }
  const live = health.accounts.filter((a) => !a.invalid)
  const named = live.map((a) => `${a.displayName}${a.email ? ` (${a.email})` : ''}`).join(', ')
  return ok('google', label, `Connected and answering — ${named}.`)
}

/* ─────────────────────────────────── vapi ────────────────────────────────── */

export interface VapiHealth {
  configured: boolean
  reachable: boolean
  status: number
  dryRun: boolean
  error?: string
}

export async function probeVapi(): Promise<VapiHealth> {
  const cfg = getConfig()
  if (!cfg.vapiConfigured) {
    return { configured: false, reachable: false, status: 0, dryRun: cfg.DRY_RUN_CALLS }
  }
  try {
    const response = await fetch(
      `https://api.vapi.ai/phone-number/${encodeURIComponent(cfg.VAPI_PHONE_NUMBER_ID)}`,
      {
        headers: { authorization: `Bearer ${cfg.VAPI_API_KEY}`, accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      },
    )
    return {
      configured: true,
      reachable: response.ok,
      status: response.status,
      dryRun: cfg.DRY_RUN_CALLS,
    }
  } catch (err) {
    return {
      configured: true,
      reachable: false,
      status: 0,
      dryRun: cfg.DRY_RUN_CALLS,
      error: describe(err),
    }
  }
}

function vapiCheck(health: VapiHealth): WatchdogCheck {
  const label = 'Phone (Vapi)'
  if (!health.configured) {
    return skipped('vapi', label, 'Not configured — VAPI_API_KEY and VAPI_PHONE_NUMBER_ID are unset.')
  }
  const mode = health.dryRun ? 'dry-run calls only' : 'live calls enabled'
  if (health.reachable) return ok('vapi', label, `Reachable, ${mode}.`)

  if (health.status === 401 || health.status === 403) {
    return problem('broken', 'vapi', label, 'Vapi rejected the API key, so no calls can be placed.', {
      advice: 'Regenerate VAPI_API_KEY in the Vapi dashboard and update it in Railway.',
    })
  }
  if (health.status === 404) {
    return problem('broken', 'vapi', label, 'Vapi does not recognise VAPI_PHONE_NUMBER_ID.', {
      advice: 'Copy the phone number id from the Vapi dashboard into Railway.',
    })
  }
  return problem(
    'degraded',
    'vapi',
    label,
    `Vapi is not answering${health.status ? ` (HTTP ${health.status})` : ''}: ${health.error ?? 'no detail'}.`,
    { advice: 'Calls will fail until it recovers. Usually transient.' },
  )
}

/* ────────────────────────────────── browser ──────────────────────────────── */

export interface BrowserHealth {
  enabled: boolean
  available: boolean
  executable: string
  dryRun: boolean
  error?: string
}

export async function probeBrowser(): Promise<BrowserHealth> {
  const cfg = getConfig()
  if (!cfg.BROWSER_ENABLED) {
    return { enabled: false, available: false, executable: '', dryRun: cfg.DRY_RUN_BROWSER }
  }
  try {
    const { chromium } = await import('playwright')
    const executable = chromium.executablePath()
    // `executablePath()` answers from the registry; only a stat proves the
    // binary survived the image build.
    await stat(executable)
    return { enabled: true, available: true, executable, dryRun: cfg.DRY_RUN_BROWSER }
  } catch (err) {
    return {
      enabled: true,
      available: false,
      executable: '',
      dryRun: cfg.DRY_RUN_BROWSER,
      error: describe(err),
    }
  }
}

function browserCheck(health: BrowserHealth): WatchdogCheck {
  const label = 'Browser'
  if (!health.enabled) return skipped('browser', label, 'Disabled — BROWSER_ENABLED is off.')
  if (health.available) {
    return ok('browser', label, `Chromium present${health.dryRun ? ', dry-run only' : ''}.`)
  }
  return problem('broken', 'browser', label, `BROWSER_ENABLED is on but Chromium is missing: ${health.error ?? 'not found'}.`, {
    advice:
      'Add `npx playwright install --with-deps chromium` to the build, or set BROWSER_ENABLED=false until it is there.',
  })
}

/* ─────────────────────────────────── volume ──────────────────────────────── */

export interface VolumeHealth {
  present: boolean
  totalBytes: number
  freeBytes: number
  usedPercent: number
  error?: string
}

export async function probeVolume(path: string = DATA_DIR): Promise<VolumeHealth> {
  try {
    const fs = await statfs(path)
    const block = Number(fs.bsize) || 0
    const total = Number(fs.blocks) * block
    const free = Number(fs.bavail) * block
    if (total <= 0) return { present: false, totalBytes: 0, freeBytes: 0, usedPercent: 0 }
    return {
      present: true,
      totalBytes: total,
      freeBytes: free,
      usedPercent: Math.round(((total - free) / total) * 100),
    }
  } catch (err) {
    return { present: false, totalBytes: 0, freeBytes: 0, usedPercent: 0, error: describe(err) }
  }
}

export interface PruneResult {
  files: number
  bytes: number
}

/**
 * Session ids the app still points at: every conversation's stored resume
 * session, plus the session recorded on any approval that has not yet reached a
 * terminal state. The SDK names each transcript `<sessionId>.jsonl`, so these
 * are exactly the files age-based pruning must never touch — deleting the
 * transcript behind a live `resume` would sever the very conversation someone
 * is in the middle of. Unreadable tables degrade to an empty set (with a log
 * line), never to a throw: age-based pruning alone is still safe, because a
 * transcript untouched for a month recovers via the clean-retry path in
 * `run-turn`.
 */
export async function liveSessionIds(): Promise<Set<string>> {
  const out = new Set<string>()
  try {
    const conversations = await getDb()
      .select({ sessionId: schema.conversations.agentSessionId })
      .from(schema.conversations)
    for (const row of conversations) {
      if (row.sessionId) out.add(row.sessionId)
    }
    const pending = await getDb()
      .select({ sessionId: schema.pendingActions.agentSessionId })
      .from(schema.pendingActions)
      .where(sql`${schema.pendingActions.status} in ('pending', 'approved')`)
    for (const row of pending) {
      if (row.sessionId) out.add(row.sessionId)
    }
  } catch (err) {
    log.warn({ err }, 'could not read the live session ids; pruning by age alone')
  }
  return out
}

/**
 * Deletes Agent SDK session transcripts older than `olderThanDays` from the
 * Claude config directory.
 *
 * Only `.jsonl` files are eligible: those are the append-only transcripts, and
 * they are the only thing under there that grows without bound. Settings,
 * credentials, and anything else are never touched. Symlinks are skipped so a
 * planted link cannot walk the deletion out of the directory. A file whose
 * name (minus the extension) is in `keep` — the current session of any chat or
 * open approval — is never deleted, whatever its age.
 */
export async function pruneSessionFiles(
  root: string,
  olderThanDays = SESSION_MAX_AGE_DAYS,
  keep: ReadonlySet<string> = new Set(),
): Promise<PruneResult> {
  const cutoff = Date.now() - olderThanDays * 86_400_000
  const result: PruneResult = { files: 0, bytes: 0 }

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      if (keep.has(entry.name.slice(0, -'.jsonl'.length))) continue
      try {
        const info = await stat(full)
        if (info.mtimeMs >= cutoff) continue
        await rm(full, { force: true })
        result.files += 1
        result.bytes += info.size
      } catch (err) {
        log.warn({ err, file: full }, 'could not prune a session file')
      }
    }
  }

  await walk(root, 0)
  return result
}

async function volumeCheck(health: VolumeHealth, fix: boolean): Promise<WatchdogCheck> {
  const label = 'Storage'
  if (!health.present) {
    return skipped('volume', label, `No volume mounted at ${DATA_DIR}${health.error ? ` (${health.error})` : ''}.`)
  }

  const summary = `${health.usedPercent}% of ${bytesText(health.totalBytes)} used, ${bytesText(health.freeBytes)} free`
  if (health.usedPercent < VOLUME_PRUNE_PERCENT) return ok('volume', label, `${summary}.`)

  if (!fix) {
    return problem('degraded', 'volume', label, `${DATA_DIR} is filling up — ${summary}.`, {
      advice: 'The watchdog prunes old session transcripts on its next sweep.',
    })
  }

  let sessionDir = join(DATA_DIR, 'claude')
  try {
    sessionDir = getConfig().CLAUDE_CONFIG_DIR
  } catch {
    // Fall back to the documented default rather than skipping the prune.
  }

  const pruned = await pruneSessionFiles(sessionDir, SESSION_MAX_AGE_DAYS, await liveSessionIds())
  const after = await probeVolume()
  const freedText =
    pruned.files > 0
      ? `pruned ${pruned.files} session ${plural(pruned.files, 'transcript')} older than ${SESSION_MAX_AGE_DAYS} days, freeing ${bytesText(pruned.bytes)}`
      : `looked for session transcripts older than ${SESSION_MAX_AGE_DAYS} days and found none`

  if (after.present && after.usedPercent < VOLUME_PRUNE_PERCENT) {
    return fixedCheck(
      'volume',
      label,
      `${DATA_DIR} was ${health.usedPercent}% full, now ${after.usedPercent}%.`,
      freedText,
    )
  }

  const now = after.present ? after : health
  return problem(
    'degraded',
    'volume',
    label,
    `${DATA_DIR} is ${now.usedPercent}% full (${bytesText(now.freeBytes)} free) and pruning did not bring it down.`,
    {
      tried: freedText,
      advice: 'Grow the Railway volume, or find what else is writing to /data.',
    },
  )
}

/* ══════════════════════════════════════════════════════════════════════════
   The sweep
   ══════════════════════════════════════════════════════════════════════════ */

/** How many times this exact fix has already been applied inside the window. */
async function priorFixCount(key: string): Promise<number> {
  try {
    const since = new Date(Date.now() - REPEAT_FIX_WINDOW_HOURS * 3_600_000)
    const rows = await getDb()
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.event, FIX_EVENT),
          eq(schema.auditLog.toolName, key),
          gte(schema.auditLog.ts, since),
        ),
      )
      .limit(REPEAT_FIX_THRESHOLD + 1)
    return rows.length
  } catch (err) {
    log.warn({ err, key }, 'could not count prior self-fixes')
    return 0
  }
}

/** True when this key was already alerted on inside its cooldown. */
async function onCooldown(key: string): Promise<boolean> {
  const hours = COOLDOWN_HOURS[key] ?? DEFAULT_COOLDOWN_HOURS
  try {
    const since = new Date(Date.now() - hours * 3_600_000)
    const rows = await getDb()
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.event, ALERT_EVENT),
          eq(schema.auditLog.toolName, key),
          gte(schema.auditLog.ts, since),
        ),
      )
      .limit(1)
    return rows.length > 0
  } catch (err) {
    // An unreadable cooldown must not become a message every ten minutes.
    log.error({ err, key }, 'could not read the alert cooldown; staying quiet')
    return true
  }
}

const STATUS_ICON: Record<CheckStatus, string> = {
  ok: '✅',
  fixed: '🔧',
  degraded: '⚠️',
  broken: '❌',
  skipped: '➖',
}

function alertText(problems: WatchdogCheck[]): string {
  const lines = [
    problems.length === 1
      ? '🩺 Something needs you.'
      : `🩺 ${problems.length} things need you.`,
    '',
  ]
  for (const p of problems) {
    lines.push(`${STATUS_ICON[p.status]} ${p.label} — ${p.detail}`)
    if (p.tried) lines.push(`   I tried: ${p.tried}.`)
    if (p.advice) lines.push(`   You can fix it: ${p.advice}`)
    lines.push('')
  }
  lines.push('Send /status for the full picture.')
  return lines.join('\n').trim()
}

/**
 * One health sweep. Every check runs even when the ones before it failed.
 *
 * Self-fixes are silent: they are logged and audited, and only surface to the
 * household when the same fix has been needed {@link REPEAT_FIX_THRESHOLD}
 * times in a day — at which point "I keep fixing this" is the actual problem.
 */
export async function runWatchdog(): Promise<WatchdogReport> {
  const started = Date.now()
  const checks: WatchdogCheck[] = []

  // The database first: almost every other check reads it, and a dead database
  // explains all the noise that follows.
  const dbHealth = await guard('database', 'Database', async () => databaseCheck(await probeDatabase()))
  checks.push(dbHealth)

  let boss: PgBoss | null = null
  try {
    boss = await getBoss()
  } catch (err) {
    log.error({ err }, 'watchdog could not reach pg-boss')
  }

  checks.push(await guard('telegram-webhook', 'Telegram', async () => webhookCheck(await probeWebhook(), true)))

  const previous = await previousQueueSnapshot()
  const queueHealth = await probeQueues(boss ?? undefined)
  checks.push(
    await guard('queues', 'Job queues', async () => queueCheck(queueHealth, previous, true, boss)),
  )
  if (queueHealth.reachable) {
    try {
      await recordQueueSnapshot(queueHealth.queues)
    } catch (err) {
      log.warn({ err }, 'could not record the queue snapshot')
    }
  }

  checks.push(
    await guard('crons', 'Scheduled routines', async () => cronCheck(await probeCrons(boss ?? undefined), true, boss)),
  )
  checks.push(await guard('google', 'Google', async () => googleCheck(await probeGoogle())))
  checks.push(await guard('vapi', 'Phone (Vapi)', async () => vapiCheck(await probeVapi())))
  checks.push(await guard('browser', 'Browser', async () => browserCheck(await probeBrowser())))
  checks.push(await guard('volume', 'Storage', async () => volumeCheck(await probeVolume(), true)))

  /* ── fixes: audit them, and promote the ones that keep recurring ── */

  const fixed = checks.filter((c) => c.status === 'fixed')
  const problems: WatchdogCheck[] = checks.filter((c) => c.status === 'broken' || c.status === 'degraded')

  for (const fix of fixed) {
    const priors = await priorFixCount(fix.key)
    log.info({ check: fix.key, priors }, fix.detail)
    await audit({
      actor: 'system',
      event: FIX_EVENT,
      toolName: fix.key,
      resultSummary: `${fix.detail} (${fix.tried ?? 'fixed'})`.slice(0, 500),
      ok: true,
    })
    if (priors + 1 >= REPEAT_FIX_THRESHOLD) {
      problems.push({
        key: `${fix.key}-recurring`,
        label: fix.label,
        status: 'degraded',
        detail:
          `I have had to fix this ${priors + 1} times in the last ${REPEAT_FIX_WINDOW_HOURS} hours. ` +
          `Most recently: ${fix.detail}`,
        tried: fix.tried ?? 'the same automatic fix each time',
        advice: 'Something keeps undoing it. This one needs a human to look at the cause.',
      })
    }
  }

  /* ── alerts: one message, only for keys not already on cooldown ── */

  const toSend: WatchdogCheck[] = []
  for (const p of problems) {
    if (await onCooldown(p.key)) {
      log.debug({ check: p.key }, 'watchdog alert suppressed by cooldown')
      continue
    }
    toSend.push(p)
  }

  if (toSend.length > 0) {
    // Audit before sending. If Telegram is the broken thing, we must not
    // re-alert on every sweep for the rest of the day.
    for (const p of toSend) {
      await audit({
        actor: 'system',
        event: ALERT_EVENT,
        toolName: p.key,
        resultSummary: `${p.detail}${p.tried ? ` | tried: ${p.tried}` : ''}`.slice(0, 500),
        ok: false,
      })
    }
    try {
      await sendToAll(alertText(toSend), { markdown: false })
    } catch (err) {
      log.error({ err }, 'could not deliver the watchdog alert')
    }
  }

  const report: WatchdogReport = {
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    checks,
    fixed,
    problems,
    healthy: problems.length === 0,
    alerted: toSend.map((p) => p.key),
  }

  log.info(
    {
      durationMs: report.durationMs,
      healthy: report.healthy,
      fixed: fixed.map((f) => f.key),
      problems: problems.map((p) => p.key),
      alerted: report.alerted,
    },
    'watchdog sweep finished',
  )

  return report
}

/* ══════════════════════════════════════════════════════════════════════════
   /status
   ══════════════════════════════════════════════════════════════════════════ */

interface WatcherRow {
  name: string
  type: string
  active: boolean
  lastCheckedAt: Date | null
  lastError: string | null
}

async function watcherRows(): Promise<WatcherRow[]> {
  try {
    return await getDb()
      .select({
        name: schema.watchers.name,
        type: schema.watchers.type,
        active: schema.watchers.active,
        lastCheckedAt: schema.watchers.lastCheckedAt,
        lastError: schema.watchers.lastError,
      })
      .from(schema.watchers)
      .orderBy(asc(schema.watchers.name))
  } catch (err) {
    log.warn({ err }, 'could not read the watchers')
    return []
  }
}

interface SetupState {
  completedAt: Date | null
  timezone: string
  familyCalendarId: string | null
  spouses: number
}

async function setupState(): Promise<SetupState> {
  const fallback: SetupState = { completedAt: null, timezone: 'UTC', familyCalendarId: null, spouses: 0 }
  try {
    const rows = await getDb()
      .select({
        setupCompletedAt: schema.households.setupCompletedAt,
        timezone: schema.households.timezone,
        familyCalendarId: schema.households.familyCalendarId,
      })
      .from(schema.households)
      .orderBy(asc(schema.households.id))
      .limit(1)
    const row = rows[0]
    const people = await getDb().select({ id: schema.users.id }).from(schema.users)
    return {
      completedAt: row?.setupCompletedAt ?? null,
      timezone: row?.timezone ?? fallback.timezone,
      familyCalendarId: row?.familyCalendarId ?? null,
      spouses: people.length,
    }
  } catch (err) {
    log.warn({ err }, 'could not read the setup state')
    return fallback
  }
}

function section(lines: string[], title: string): void {
  lines.push('', title)
}

/**
 * The `/status` text: what is connected, what is healthy, and what is waiting.
 *
 * Read-only by construction — it shares the probes with `runWatchdog` but never
 * passes `fix`, so asking for status can never re-register a webhook, requeue a
 * job, or delete a file.
 */
export async function statusReport(): Promise<string> {
  const settings = await loadHouseholdSettings().catch(() => ({
    timezone: 'UTC',
    briefHour: 7,
    quietHoursStart: 21,
    quietHoursEnd: 7,
  }))
  const zone = settings.timezone
  const now = DateTime.now().setZone(zone)

  let boss: PgBoss | null = null
  try {
    boss = await getBoss()
  } catch (err) {
    log.warn({ err }, 'status could not reach pg-boss')
  }

  const [db, webhook, queues, crons, google, vapi, browser, volume, watchers, setup, pending] =
    await Promise.all([
      probeDatabase(),
      probeWebhook().catch(
        (err): WebhookHealth => ({
          mode: 'webhook',
          registered: false,
          drifted: false,
          pending: 0,
          lastError: null,
          lastErrorRecent: false,
          error: describe(err),
        }),
      ),
      probeQueues(boss ?? undefined),
      probeCrons(boss ?? undefined),
      probeGoogle().catch(
        (err): GoogleHealth => ({
          configured: true,
          accounts: [],
          apiOk: null,
          invalidGrant: false,
          error: describe(err),
        }),
      ),
      probeVapi().catch(
        (err): VapiHealth => ({
          configured: true,
          reachable: false,
          status: 0,
          dryRun: true,
          error: describe(err),
        }),
      ),
      probeBrowser().catch(
        (err): BrowserHealth => ({
          enabled: true,
          available: false,
          executable: '',
          dryRun: true,
          error: describe(err),
        }),
      ),
      probeVolume(),
      watcherRows(),
      setupState(),
      listPending().catch((): Awaited<ReturnType<typeof listPending>> => []),
    ])

  const lines: string[] = [`🩺 Household status — ${now.toFormat('ccc d LLL, h:mm a ZZZZ')}`]

  /* Connections */
  section(lines, 'Connections')
  const wh = await webhookCheck(webhook, false)
  lines.push(`  ${STATUS_ICON[wh.status]} Telegram — ${wh.detail}`)

  if (!google.configured) {
    lines.push('  ➖ Google — not configured.')
  } else if (google.accounts.length === 0) {
    lines.push('  ⚠️ Google — nobody has linked an account. Send /connect_google.')
  } else {
    for (const account of google.accounts) {
      const who = account.displayName
      const email = account.email ? ` (${account.email})` : ''
      lines.push(
        account.invalid
          ? `  ❌ Google — ${who}${email}: access revoked, run /connect_google.`
          : `  ✅ Google — ${who}${email}: connected${google.apiOk === false ? ', but the API is not answering' : ''}.`,
      )
    }
  }

  const vc = vapiCheck(vapi)
  lines.push(`  ${STATUS_ICON[vc.status]} Phone — ${vc.detail}`)
  const bc = browserCheck(browser)
  lines.push(`  ${STATUS_ICON[bc.status]} Browser — ${bc.detail}`)

  if (watchers.length === 0) {
    lines.push('  ➖ Watchers — none set up.')
  } else {
    const active = watchers.filter((w) => w.active)
    lines.push(`  ${active.length > 0 ? '✅' : '➖'} Watchers — ${active.length} of ${watchers.length} active.`)
    for (const w of watchers) {
      const state = w.active ? agoText(w.lastCheckedAt, zone) : 'paused'
      const err = w.lastError ? ` — last error: ${w.lastError.slice(0, 120)}` : ''
      lines.push(`      ${w.name} (${w.type}): checked ${state}${err}`)
    }
  }

  /* Queues */
  section(lines, 'Queues')
  if (!queues.reachable) {
    lines.push(`  ❌ pg-boss did not answer: ${queues.error ?? 'unknown error'}.`)
  } else {
    const busy = queues.queues.filter((q) => q.ready > 0 || q.active > 0 || q.failed > 0)
    if (busy.length === 0) {
      lines.push('  ✅ All idle.')
    } else {
      for (const q of busy) {
        const bits = [`${q.ready} waiting`, `${q.active} running`]
        if (q.failed > 0) bits.push(`${q.failed} failed`)
        lines.push(`  ${q.ready >= QUEUE_BACKLOG_ALERT ? '⚠️' : '•'} ${q.name}: ${bits.join(', ')}`)
      }
    }
    const dl = queues.deadLetter
    if (dl && (dl.ready > 0 || dl.active > 0)) {
      lines.push(`  ⚠️ dead-letter: ${dl.ready} waiting to be announced`)
    }
  }

  /* Crons */
  section(lines, 'Scheduled routines (last run)')
  if (!crons.reachable) {
    lines.push(`  ❌ Could not read the schedules: ${crons.error ?? 'unknown error'}.`)
  } else {
    const registered = new Set(crons.scheduled)
    for (const verdict of judgeCrons(crons)) {
      const icon = verdict.state === 'fresh' ? '•' : verdict.state === 'unknown' ? '➖' : '⚠️'
      const when =
        verdict.state === 'unknown' && !verdict.at ? 'no record kept this long' : agoText(verdict.at, zone)
      const unscheduled = registered.has(verdict.task) ? '' : ' — NOT SCHEDULED'
      lines.push(`  ${icon} ${verdict.label}: ${when}${unscheduled}`)
    }
  }

  /* Approvals */
  section(lines, 'Approvals')
  if (pending.length === 0) {
    lines.push('  ✅ Nothing waiting.')
  } else {
    lines.push(`  ⏳ ${pending.length} waiting:`)
    for (const row of pending.slice(0, 10)) {
      const expires = DateTime.fromJSDate(row.expiresAt).setZone(zone)
      const mins = Math.max(0, Math.round(expires.diff(now, 'minutes').minutes))
      lines.push(`      #${row.id} ${row.humanSummary} (expires in ${mins}m)`)
    }
    if (pending.length > 10) lines.push(`      …and ${pending.length - 10} more. Send /approve.`)
  }

  /* Setup */
  section(lines, 'Setup')
  if (setup.completedAt) {
    const done = DateTime.fromJSDate(setup.completedAt).setZone(zone)
    lines.push(`  ✅ Complete — finished ${done.toFormat('d LLL yyyy')}.`)
  } else {
    lines.push('  ⚠️ Not finished. Send /setup — it takes about ten minutes.')
  }
  lines.push(`      Timezone ${setup.timezone} · brief at ${settings.briefHour}:00 · quiet ${settings.quietHoursStart}:00–${settings.quietHoursEnd}:00`)
  lines.push(`      ${setup.spouses} ${plural(setup.spouses, 'person')} known · family calendar ${setup.familyCalendarId ?? 'primary'}`)

  /* Storage and database */
  section(lines, 'Storage')
  if (!volume.present) {
    lines.push(`  ➖ ${DATA_DIR} — no volume mounted${volume.error ? ` (${volume.error})` : ''}.`)
  } else {
    const icon = volume.usedPercent >= VOLUME_PRUNE_PERCENT ? '⚠️' : '✅'
    lines.push(
      `  ${icon} ${DATA_DIR} — ${volume.usedPercent}% of ${bytesText(volume.totalBytes)} used, ` +
        `${bytesText(volume.freeBytes)} free.`,
    )
  }
  const dbc = databaseCheck(db)
  lines.push(`  ${STATUS_ICON[dbc.status]} Database — ${dbc.detail}`)

  return lines.join('\n')
}
