import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { audit } from '../audit/log.js'
import { getConfig } from '../config.js'
import { getDb, schema } from '../db/client.js'
import type { PolicyCategory } from '../db/schema.js'
import { logger } from '../logger.js'
import { CATEGORY_LABELS, isPolicyCategory } from '../policy/categories.js'
import { sendToAll } from '../telegram/send.js'

/**
 * What the household spends, and what it says no to.
 *
 * Three jobs live here, and they share one idea: the assistant should be able
 * to explain itself in money and in judgement, without anyone opening a
 * database.
 *
 *  1. `src/agent/run-turn.ts` writes one `turn_metrics` row per model turn.
 *  2. `costReport` / `checkDailyBudget` turn those rows into spend a spouse can
 *     read, and a single daily nudge when the bill is running hot.
 *  3. `approvalRetro` reads the approvals that were *rejected* and describes the
 *     pattern in plain language. That text is the raw material for the weekly
 *     self-improvement suggestion — the assistant noticing "you keep saying no
 *     to the same thing" and proposing a rule or an issue instead of asking again.
 *
 * The aggregation is deliberately split into pure functions (`rollupCosts`,
 * `formatCostReport`, `rollupRejections`, `describeRejections`) with thin async
 * wrappers around them. Everything interesting is therefore testable without a
 * database.
 */

const log = logger.child({ mod: 'ops/cost' })

/** Widest window either report will read. Anything longer is a database query, not a chat reply. */
export const MAX_REPORT_DAYS = 90

/** Dedupe key shared with the watchdog's own budget check, so the two never double-alert. */
export const BUDGET_ALERT_KEY = 'daily-budget'
/** Audit event used as the alert cooldown store. Matches `src/jobs/crons.ts`. */
export const WATCHDOG_ALERT_EVENT = 'watchdog.alert'

/* ────────────────────────────── small utilities ──────────────────────────── */

function clampDays(days: number, fallback = 7): number {
  if (!Number.isFinite(days)) return fallback
  return Math.min(MAX_REPORT_DAYS, Math.max(1, Math.trunc(days)))
}

/** Non-negative integer, or 0. Token counts and durations never go backwards. */
function intOf(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(n))
}

/** Non-negative float, or 0. A negative cost is a bug, not a credit. */
function floatOf(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n
}

const round = (n: number, dp = 6): number => {
  const f = 10 ** dp
  return Math.round(n * f) / f
}

/** Dollars for a human. Sub-cent amounts keep four places so they are not all "$0.00". */
export function money(value: number): string {
  const v = Number.isFinite(value) && value > 0 ? value : 0
  if (v > 0 && v < 0.01) return `$${v.toFixed(4)}`
  return `$${v.toFixed(2)}`
}

/** 1_240_000 -> "1.2M". Used for token counts, which are otherwise unreadable. */
export function compactCount(value: number): string {
  const v = intOf(value)
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  return String(v)
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many
}

/** The household clock. Falls back to the configured zone, then UTC — never Invalid. */
function safeZone(candidate: string | null | undefined, fallback: string): string {
  if (candidate && DateTime.now().setZone(candidate).isValid) return candidate
  if (DateTime.now().setZone(fallback).isValid) return fallback
  return 'UTC'
}

/**
 * Household timezone, read from the `households` row so a `/setup` change takes
 * effect without a redeploy. Never throws: a missing row or an unreadable
 * database falls back to the configured default.
 */
export async function householdZone(): Promise<string> {
  let configured = 'UTC'
  try {
    configured = getConfig().HOUSEHOLD_TIMEZONE
  } catch (err) {
    log.warn({ err }, 'config unavailable, defaulting the report timezone to UTC')
  }
  try {
    const rows = await getDb()
      .select({ timezone: schema.households.timezone })
      .from(schema.households)
      .orderBy(asc(schema.households.id))
      .limit(1)
    return safeZone(rows[0]?.timezone, configured)
  } catch (err) {
    log.warn({ err }, 'could not read the household timezone')
    return safeZone(null, configured)
  }
}

/** Start of the window: local midnight, `days - 1` days back, so "1 day" means today. */
function windowStart(days: number, zone: string, now: Date): DateTime {
  return DateTime.fromJSDate(now)
    .setZone(zone)
    .startOf('day')
    .minus({ days: clampDays(days) - 1 })
}

/* ══════════════════════════════════════════════════════════════════════════
   2. Spend reporting
   ══════════════════════════════════════════════════════════════════════════ */

export interface TurnCostRow {
  ts: Date
  model: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
  durationMs: number
  numTurns: number
  trigger: string
  ok: boolean
}

export interface DayBucket {
  /** ISO date in the household zone, e.g. `2026-08-31`. */
  day: string
  usd: number
  turns: number
  failed: number
}

export interface TriggerBucket {
  trigger: string
  usd: number
  turns: number
  failed: number
  /** Fraction of total spend, 0–1. */
  share: number
}

export interface ModelBucket {
  model: string
  usd: number
  turns: number
}

export interface TopTurn {
  day: string
  /** Local time-of-day, `HH:mm`. */
  time: string
  trigger: string
  model: string
  usd: number
  numTurns: number
  durationMs: number
  ok: boolean
}

export interface CostRollup {
  days: number
  zone: string
  from: string
  to: string
  totalUsd: number
  turns: number
  failed: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  dailyAverageUsd: number
  /** Chronological, one entry per day in the window including silent days. */
  byDay: DayBucket[]
  /** Most expensive first. */
  byTrigger: TriggerBucket[]
  /** Most expensive first. */
  byModel: ModelBucket[]
  /** The individual turns that cost the most, most expensive first. */
  topTurns: TopTurn[]
  busiestDay: DayBucket | null
}

/** How many individual turns the report names. */
export const TOP_TURN_COUNT = 5

/**
 * Aggregates raw `turn_metrics` rows into everything the report needs. Pure:
 * same rows plus same `now` always give the same answer, which is what makes
 * the formatting testable.
 *
 * Rows outside the window are ignored rather than folded into the first day, so
 * a caller that over-fetches cannot skew the daily average.
 */
export function rollupCosts(
  rows: TurnCostRow[],
  opts: { days: number; zone: string; now?: Date },
): CostRollup {
  const days = clampDays(opts.days)
  const zone = safeZone(opts.zone, 'UTC')
  const now = opts.now ?? new Date()
  const start = windowStart(days, zone, now)
  const end = start.plus({ days })

  const dayOrder: string[] = []
  const byDay = new Map<string, DayBucket>()
  for (let i = 0; i < days; i += 1) {
    const key = start.plus({ days: i }).toISODate() ?? `day-${i}`
    dayOrder.push(key)
    byDay.set(key, { day: key, usd: 0, turns: 0, failed: 0 })
  }

  const byTrigger = new Map<string, TriggerBucket>()
  const byModel = new Map<string, ModelBucket>()
  const scored: Array<{ usd: number; turn: TopTurn }> = []

  let totalUsd = 0
  let turns = 0
  let failed = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0

  for (const row of rows) {
    const at = DateTime.fromJSDate(row.ts instanceof Date ? row.ts : new Date(row.ts)).setZone(zone)
    if (!at.isValid) continue
    if (at < start || at >= end) continue

    const dayKey = at.toISODate()
    if (dayKey === null) continue
    const bucket = byDay.get(dayKey)
    if (!bucket) continue

    const usd = floatOf(row.costUsd)
    const ok = row.ok !== false
    const trigger = typeof row.trigger === 'string' && row.trigger.trim() ? row.trigger.trim() : 'chat'
    const model = typeof row.model === 'string' && row.model.trim() ? row.model.trim() : 'unknown'

    totalUsd += usd
    turns += 1
    if (!ok) failed += 1
    inputTokens += intOf(row.inputTokens)
    outputTokens += intOf(row.outputTokens)
    cacheReadTokens += intOf(row.cacheReadTokens)
    cacheCreationTokens += intOf(row.cacheCreationTokens)

    bucket.usd = round(bucket.usd + usd)
    bucket.turns += 1
    if (!ok) bucket.failed += 1

    const t = byTrigger.get(trigger) ?? { trigger, usd: 0, turns: 0, failed: 0, share: 0 }
    t.usd = round(t.usd + usd)
    t.turns += 1
    if (!ok) t.failed += 1
    byTrigger.set(trigger, t)

    const mb = byModel.get(model) ?? { model, usd: 0, turns: 0 }
    mb.usd = round(mb.usd + usd)
    mb.turns += 1
    byModel.set(model, mb)

    scored.push({
      usd,
      turn: {
        day: dayKey,
        time: at.toFormat('HH:mm'),
        trigger,
        model,
        usd: round(usd),
        numTurns: intOf(row.numTurns),
        durationMs: intOf(row.durationMs),
        ok,
      },
    })
  }

  totalUsd = round(totalUsd)

  const triggers = [...byTrigger.values()]
    .map((t) => ({ ...t, share: totalUsd > 0 ? t.usd / totalUsd : 0 }))
    .sort((a, b) => b.usd - a.usd || b.turns - a.turns || a.trigger.localeCompare(b.trigger))

  const models = [...byModel.values()].sort(
    (a, b) => b.usd - a.usd || b.turns - a.turns || a.model.localeCompare(b.model),
  )

  const orderedDays = dayOrder.map((key) => byDay.get(key)).filter((d): d is DayBucket => Boolean(d))

  // `reduce` over a possibly-empty list, so the seed carries the null case.
  const busiestDay = orderedDays.reduce<DayBucket | null>((best, day) => {
    if (day.turns === 0 && day.usd === 0) return best
    if (!best) return day
    return day.usd > best.usd ? day : best
  }, null)

  const topTurns = scored
    .sort((a, b) => b.usd - a.usd || a.turn.day.localeCompare(b.turn.day))
    .slice(0, TOP_TURN_COUNT)
    .map((s) => s.turn)

  return {
    days,
    zone,
    from: start.toISODate() ?? '',
    to: end.minus({ days: 1 }).toISODate() ?? '',
    totalUsd,
    turns,
    failed,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    dailyAverageUsd: round(totalUsd / days),
    byDay: orderedDays,
    byTrigger: triggers,
    byModel: models,
    topTurns,
    busiestDay,
  }
}

function dayLabel(iso: string, zone: string): string {
  const dt = DateTime.fromISO(iso, { zone })
  return dt.isValid ? dt.toFormat('ccc d LLL') : iso
}

/** Plain text — the caller sends it with `markdown: false`. */
export function formatCostReport(rollup: CostRollup): string {
  const windowText =
    rollup.days === 1 ? 'today' : `last ${rollup.days} days (${dayLabel(rollup.from, rollup.zone)} → ${dayLabel(rollup.to, rollup.zone)})`

  const lines: string[] = [`💸 Model spend — ${windowText}`, '']

  if (rollup.turns === 0) {
    lines.push('No model turns in that window. Nothing was spent.')
    return lines.join('\n')
  }

  const failedNote = rollup.failed > 0 ? `, ${rollup.failed} failed` : ''
  lines.push(
    `${money(rollup.totalUsd)} over ${rollup.turns} ${plural(rollup.turns, 'turn')}${failedNote}.`,
  )
  if (rollup.days > 1) lines.push(`${money(rollup.dailyAverageUsd)} a day on average.`)
  lines.push(
    `Tokens: ${compactCount(rollup.inputTokens)} in · ${compactCount(rollup.outputTokens)} out · ` +
      `${compactCount(rollup.cacheReadTokens)} cache read · ${compactCount(rollup.cacheCreationTokens)} cache write.`,
  )

  const spentDays = rollup.byDay.filter((d) => d.turns > 0)
  if (spentDays.length > 0) {
    lines.push('', 'By day')
    const width = Math.max(...rollup.byDay.map((d) => dayLabel(d.day, rollup.zone).length))
    for (const day of rollup.byDay) {
      const label = pad(dayLabel(day.day, rollup.zone), width)
      if (day.turns === 0) {
        lines.push(`  ${label}  ${padStart('—', 8)}`)
        continue
      }
      const failedTail = day.failed > 0 ? ` (${day.failed} failed)` : ''
      lines.push(
        `  ${label}  ${padStart(money(day.usd), 8)}  ${day.turns} ${plural(day.turns, 'turn')}${failedTail}`,
      )
    }
  }

  if (rollup.byTrigger.length > 0) {
    lines.push('', 'By trigger')
    const width = Math.max(...rollup.byTrigger.map((t) => t.trigger.length))
    for (const t of rollup.byTrigger) {
      const share = `${Math.round(t.share * 100)}%`
      lines.push(
        `  ${pad(t.trigger, width)}  ${padStart(money(t.usd), 8)}  ${padStart(share, 4)}  ` +
          `${t.turns} ${plural(t.turns, 'turn')}`,
      )
    }
  }

  if (rollup.byModel.length > 1) {
    lines.push('', 'By model')
    const width = Math.max(...rollup.byModel.map((m) => m.model.length))
    for (const m of rollup.byModel) {
      lines.push(
        `  ${pad(m.model, width)}  ${padStart(money(m.usd), 8)}  ${m.turns} ${plural(m.turns, 'turn')}`,
      )
    }
  }

  if (rollup.topTurns.length > 0) {
    lines.push('', `Top ${rollup.topTurns.length === 1 ? 'spender' : 'spenders'}`)
    for (const t of rollup.topTurns) {
      const seconds = t.durationMs > 0 ? `, ${(t.durationMs / 1000).toFixed(1)}s` : ''
      const bad = t.ok ? '' : ', failed'
      lines.push(
        `  ${dayLabel(t.day, rollup.zone)} ${t.time}  ${padStart(money(t.usd), 8)}  ` +
          `${t.trigger} · ${t.model} · ${t.numTurns} ${plural(t.numTurns, 'step')}${seconds}${bad}`,
      )
    }
  }

  return lines.join('\n')
}

/** Spend by day, by trigger, and the priciest individual turns. Plain text for Telegram. */
export async function costReport(days: number): Promise<string> {
  const window = clampDays(days)
  const zone = await householdZone()
  const now = new Date()
  const since = windowStart(window, zone, now).toJSDate()

  let rows: TurnCostRow[] = []
  try {
    const selected = await getDb()
      .select({
        ts: schema.turnMetrics.ts,
        model: schema.turnMetrics.model,
        inputTokens: schema.turnMetrics.inputTokens,
        outputTokens: schema.turnMetrics.outputTokens,
        cacheReadTokens: schema.turnMetrics.cacheReadTokens,
        cacheCreationTokens: schema.turnMetrics.cacheCreationTokens,
        costUsd: schema.turnMetrics.costUsd,
        durationMs: schema.turnMetrics.durationMs,
        numTurns: schema.turnMetrics.numTurns,
        trigger: schema.turnMetrics.trigger,
        ok: schema.turnMetrics.ok,
      })
      .from(schema.turnMetrics)
      .where(gte(schema.turnMetrics.ts, since))
      .orderBy(asc(schema.turnMetrics.ts))
    rows = selected as TurnCostRow[]
  } catch (err) {
    log.error({ err, days: window }, 'could not read turn metrics')
    return 'I could not read the spend history just now. The database did not answer.'
  }

  return formatCostReport(rollupCosts(rows, { days: window, zone, now }))
}

/* ────────────────────────────── the daily budget ─────────────────────────── */

/**
 * Alerts both spouses once per household day when model spend passes
 * `DAILY_BUDGET_ALERT_USD`.
 *
 * "Once" comes from the audit log, not a timer, so it survives a redeploy and a
 * second worker. The cooldown key is shared with the watchdog's own budget
 * check in `src/jobs/crons.ts`, so whichever one notices first is the only one
 * that speaks.
 */
export async function checkDailyBudget(): Promise<void> {
  let limit: number
  try {
    limit = getConfig().DAILY_BUDGET_ALERT_USD
  } catch (err) {
    log.error({ err }, 'cannot check the daily budget: config unavailable')
    return
  }
  if (!Number.isFinite(limit) || limit <= 0) return

  const zone = await householdZone()
  const dayStart = DateTime.now().setZone(zone).startOf('day').toJSDate()

  let rows: TurnCostRow[]
  try {
    const selected = await getDb()
      .select({
        ts: schema.turnMetrics.ts,
        model: schema.turnMetrics.model,
        inputTokens: schema.turnMetrics.inputTokens,
        outputTokens: schema.turnMetrics.outputTokens,
        cacheReadTokens: schema.turnMetrics.cacheReadTokens,
        cacheCreationTokens: schema.turnMetrics.cacheCreationTokens,
        costUsd: schema.turnMetrics.costUsd,
        durationMs: schema.turnMetrics.durationMs,
        numTurns: schema.turnMetrics.numTurns,
        trigger: schema.turnMetrics.trigger,
        ok: schema.turnMetrics.ok,
      })
      .from(schema.turnMetrics)
      .where(gte(schema.turnMetrics.ts, dayStart))
    rows = selected as TurnCostRow[]
  } catch (err) {
    log.error({ err }, 'could not read today’s spend')
    return
  }

  const today = rollupCosts(rows, { days: 1, zone })
  if (today.totalUsd < limit) return

  // Already said something today? Then stay quiet.
  try {
    const prior = await getDb()
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.event, WATCHDOG_ALERT_EVENT),
          eq(schema.auditLog.toolName, BUDGET_ALERT_KEY),
          gte(schema.auditLog.ts, dayStart),
        ),
      )
      .limit(1)
    if (prior.length > 0) {
      log.debug({ spent: today.totalUsd }, 'daily budget alert suppressed: already sent today')
      return
    }
  } catch (err) {
    // An unreadable cooldown must not turn into a message every ten minutes.
    log.error({ err }, 'could not read the budget alert cooldown; staying quiet')
    return
  }

  const biggest = today.byTrigger[0]
  const detail = biggest
    ? ` The biggest slice is ${biggest.trigger} at ${money(biggest.usd)}.`
    : ''
  const text =
    `Model spend today is ${money(today.totalUsd)}, past the ${money(limit)} alert line — ` +
    `${today.turns} ${plural(today.turns, 'turn')} so far.${detail} ` +
    'Ask me for /cost if you want the breakdown.'

  // Audit before sending. If Telegram is the broken thing, we must not re-alert
  // on every sweep for the rest of the day.
  await audit({
    actor: 'system',
    event: WATCHDOG_ALERT_EVENT,
    toolName: BUDGET_ALERT_KEY,
    resultSummary: text.slice(0, 500),
    args: { spentUsd: today.totalUsd, limitUsd: limit, turns: today.turns },
    ok: false,
  })

  try {
    await sendToAll(`🩺 ${text}`, { markdown: false })
  } catch (err) {
    log.error({ err }, 'could not deliver the daily budget alert')
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   3. Approval retrospective
   ══════════════════════════════════════════════════════════════════════════ */

/** One `pending_actions` row, as the retro reads it. */
export interface RetroInputRow {
  toolName: string
  category: string
  status: string
  humanSummary: string
  argsJson: unknown
  requestedBy: string | null
  origin: string
  createdAt: Date
}

export interface RetroTrait {
  /** Stable key, for tests and for the improvement suggestion. */
  key: string
  /** How the sentence says it, e.g. `before 9am`. */
  phrase: string
  /** How many of the group's rejections carry it. */
  count: number
}

export interface RetroGroup {
  category: string
  /** Short noun for a sentence, e.g. `calendar`. */
  noun: string
  label: string
  proposed: number
  rejected: number
  /** Rejections per tool, most rejected first. */
  tools: Array<{ tool: string; rejected: number }>
  /** Traits every rejection in the group shares. */
  sharedTraits: RetroTrait[]
  /** Traits at least two thirds of them share (and which are not already shared). */
  commonTraits: RetroTrait[]
  /** Up to two human summaries, so the household recognises what is meant. */
  examples: string[]
}

export interface RetroSummary {
  days: number
  zone: string
  proposed: number
  rejected: number
  /** Most rejections first. */
  groups: RetroGroup[]
}

/** Statuses that mean a human, or the clock, actually saw the proposal. */
const DECIDED_STATUSES = ['approved', 'rejected', 'expired', 'executed', 'failed'] as const

/** Short nouns, so a sentence reads "3 of 4 calendar proposals" not "3 of 4 Change the family calendar". */
const CATEGORY_NOUNS: Record<PolicyCategory, string> = {
  read: 'lookup',
  memory_write: 'memory',
  todo_write: 'to-do',
  reminder_write: 'reminder',
  recipe_write: 'recipe',
  calendar_write: 'calendar',
  calendar_write_from_watcher: 'watcher calendar',
  email_send: 'email',
  phone_call: 'phone call',
  sms_send: 'text',
  purchase: 'purchase',
  booking_cancel: 'cancellation',
  browser_task: 'browser',
}

function categoryNoun(category: string): string {
  return isPolicyCategory(category) ? CATEGORY_NOUNS[category] : category.replace(/_/g, ' ')
}

function categoryLabelOf(category: string): string {
  return isPolicyCategory(category) ? CATEGORY_LABELS[category] : category.replace(/_/g, ' ')
}

/* ─────────────────────────── trait extraction ────────────────────────────── */

/**
 * Arg keys that plausibly carry a date or a time. Compared against the key with
 * its punctuation and case stripped, so `startTime`, `start_time`, and `START`
 * all land in the same place. A false positive costs nothing: a value that is
 * not an ISO datetime simply fails to parse.
 */
const TIME_KEYS: ReadonlySet<string> = new Set([
  'start', 'starts', 'startat', 'starttime', 'startdate', 'startsat',
  'end', 'endat', 'endtime', 'enddate',
  'when', 'date', 'datetime', 'time', 'day',
  'due', 'duedate', 'dueat', 'fireat', 'firetime',
  'at', 'on', 'scheduledfor', 'begins', 'beginsat',
])

function isTimeKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z]/g, '')
  if (k.length === 0) return false
  if (TIME_KEYS.has(k)) return true
  return /^(start|end|due|fire|sched)/.test(k) || /(date|time|at)$/.test(k)
}

/** Arg keys that plausibly carry a person or a destination. */
const RECIPIENT_KEYS = ['to', 'recipient', 'recipients', 'email', 'address', 'number', 'phone']

interface Extracted {
  /** Every datetime we could read out of the args. */
  moments: DateTime[]
  /** Lower-cased recipients: email domains, or a bare name. */
  recipients: string[]
}

function pushMoment(out: DateTime[], raw: string, zone: string): void {
  const text = raw.trim()
  if (text.length < 8 || text.length > 40) return
  // A bare `HH:mm` is not a moment; we need at least a date to reason about weekends.
  const parsed = DateTime.fromISO(text, { zone })
  if (!parsed.isValid) return
  out.push(parsed)
}

function collect(value: unknown, key: string, depth: number, zone: string, out: Extracted): void {
  if (depth > 4) return
  if (typeof value === 'string') {
    if (isTimeKey(key)) pushMoment(out.moments, value, zone)
    if (RECIPIENT_KEYS.includes(key.toLowerCase())) {
      const lower = value.trim().toLowerCase()
      if (lower) out.recipients.push(lower.includes('@') ? (lower.split('@')[1] ?? lower) : lower)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, key, depth + 1, zone, out)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      collect(child, childKey, depth + 1, zone, out)
    }
  }
}

function extract(args: unknown, zone: string): Extracted {
  const out: Extracted = { moments: [], recipients: [] }
  try {
    collect(args, '', 0, zone, out)
  } catch {
    // A hostile or cyclic payload must not take the retro down.
  }
  return out
}

/**
 * The observable traits of one rejected proposal. Keys are stable; phrases are
 * what the sentence prints.
 */
export function traitsOf(row: RetroInputRow, zone: string): RetroTrait[] {
  const traits = new Map<string, string>()

  const tool = typeof row.toolName === 'string' ? row.toolName.trim() : ''
  if (tool) traits.set(`tool:${tool}`, `from ${tool}`)

  if (row.origin === 'watcher') {
    traits.set('origin:watcher', 'proposed by a watcher rather than by either of you')
  }

  const who = typeof row.requestedBy === 'string' ? row.requestedBy.trim() : ''
  if (who && who.toLowerCase() !== 'system') traits.set(`actor:${who}`, `asked for by ${who}`)

  const found = extract(row.argsJson, zone)

  for (const moment of found.moments) {
    const weekend = moment.weekday >= 6
    traits.set(weekend ? 'day:weekend' : 'day:weekday', weekend ? 'on a weekend' : 'on a weekday')
    // A date-only value parses to local midnight, which is not a real "before
    // 9am" — only claim an hour trait when the source carried a time.
    if (moment.hour !== 0 || moment.minute !== 0) {
      if (moment.hour < 9) traits.set('hour:early', 'before 9am')
      else if (moment.hour >= 21) traits.set('hour:late', 'after 9pm')
      else if (moment.hour >= 17) traits.set('hour:evening', 'in the evening')
    }
  }

  for (const recipient of found.recipients) {
    traits.set(`to:${recipient}`, `addressed to ${recipient}`)
  }

  return [...traits.entries()].map(([key, phrase]) => ({ key, phrase, count: 1 }))
}

/** A trait must appear this often, proportionally, to be worth mentioning. */
export const COMMON_TRAIT_RATIO = 2 / 3

/**
 * Groups rejected proposals by category and finds what they have in common.
 * Pure — the caller supplies the rows and the zone.
 */
export function rollupRejections(rows: RetroInputRow[], opts: { days: number; zone: string }): RetroSummary {
  const days = clampDays(opts.days)
  const zone = safeZone(opts.zone, 'UTC')

  interface Acc {
    category: string
    proposed: number
    rejected: number
    tools: Map<string, number>
    traits: Map<string, RetroTrait>
    examples: string[]
  }
  const groups = new Map<string, Acc>()
  const accFor = (category: string): Acc => {
    const existing = groups.get(category)
    if (existing) return existing
    const fresh: Acc = {
      category,
      proposed: 0,
      rejected: 0,
      tools: new Map(),
      traits: new Map(),
      examples: [],
    }
    groups.set(category, fresh)
    return fresh
  }

  let proposed = 0
  let rejected = 0

  for (const row of rows) {
    const category = typeof row.category === 'string' && row.category ? row.category : 'unknown'
    const acc = accFor(category)
    acc.proposed += 1
    proposed += 1
    if (row.status !== 'rejected') continue

    acc.rejected += 1
    rejected += 1

    const tool = typeof row.toolName === 'string' && row.toolName ? row.toolName : 'unknown'
    acc.tools.set(tool, (acc.tools.get(tool) ?? 0) + 1)

    const summary = typeof row.humanSummary === 'string' ? row.humanSummary.trim() : ''
    if (summary && acc.examples.length < 2 && !acc.examples.includes(summary)) {
      acc.examples.push(summary)
    }

    for (const trait of traitsOf(row, zone)) {
      const seen = acc.traits.get(trait.key)
      if (seen) seen.count += 1
      else acc.traits.set(trait.key, { ...trait })
    }
  }

  const out: RetroGroup[] = []
  for (const acc of groups.values()) {
    if (acc.rejected === 0) continue
    const threshold = Math.max(2, Math.ceil(acc.rejected * COMMON_TRAIT_RATIO))
    const all = [...acc.traits.values()].sort(
      (a, b) => b.count - a.count || a.key.localeCompare(b.key),
    )
    out.push({
      category: acc.category,
      noun: categoryNoun(acc.category),
      label: categoryLabelOf(acc.category),
      proposed: acc.proposed,
      rejected: acc.rejected,
      tools: [...acc.tools.entries()]
        .map(([tool, count]) => ({ tool, rejected: count }))
        .sort((a, b) => b.rejected - a.rejected || a.tool.localeCompare(b.tool)),
      sharedTraits: all.filter((t) => t.count === acc.rejected),
      commonTraits: all.filter((t) => t.count < acc.rejected && t.count >= threshold),
      examples: acc.examples,
    })
  }

  out.sort(
    (a, b) => b.rejected - a.rejected || b.proposed - a.proposed || a.category.localeCompare(b.category),
  )

  return { days, zone, proposed, rejected, groups: out }
}

/** "a, b and c" — the phrases already read as clauses, so no serial comma needed. */
function joinPhrases(phrases: string[]): string {
  if (phrases.length === 0) return ''
  if (phrases.length === 1) return phrases[0] ?? ''
  const head = phrases.slice(0, -1).join(', ')
  return `${head} and ${phrases[phrases.length - 1] ?? ''}`
}

/**
 * Traits worth printing. `tool:` is dropped when the group has exactly one tool
 * — the category line already said it — and identity traits come last.
 */
function printableTraits(group: RetroGroup, traits: RetroTrait[]): string[] {
  const singleTool = group.tools.length === 1
  const rank = (key: string): number => {
    if (key.startsWith('hour:')) return 0
    if (key.startsWith('day:')) return 1
    if (key.startsWith('to:')) return 2
    if (key.startsWith('origin:')) return 3
    if (key.startsWith('actor:')) return 4
    return 5
  }
  return traits
    .filter((t) => !(singleTool && t.key.startsWith('tool:')))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key))
    .slice(0, 3)
    .map((t) => t.phrase)
}

/** Plain-language description of the rejection pattern. Plain text for Telegram. */
export function describeRejections(summary: RetroSummary): string {
  const window = summary.days === 1 ? 'today' : `the last ${summary.days} days`
  const lines: string[] = [`🔎 What you turned down — ${window}`, '']

  if (summary.proposed === 0) {
    lines.push('I did not put a single approval in front of you in that window.')
    return lines.join('\n')
  }
  if (summary.rejected === 0) {
    lines.push(
      `You approved everything I asked about — ${summary.proposed} ${plural(summary.proposed, 'proposal')}. ` +
        'Nothing to learn from yet.',
    )
    return lines.join('\n')
  }

  lines.push(
    `You rejected ${summary.rejected} of ${summary.proposed} ${plural(summary.proposed, 'proposal')}.`,
  )

  let sawPattern = false
  for (const group of summary.groups) {
    lines.push('')
    const tools =
      group.tools.length === 1 && group.tools[0]
        ? ` (${group.tools[0].tool})`
        : group.tools.length > 1
          ? ` (${group.tools.map((t) => `${t.tool} ×${t.rejected}`).join(', ')})`
          : ''
    lines.push(
      `${group.rejected} of ${group.proposed} ${group.noun} ${plural(group.proposed, 'proposal')} ` +
        `${plural(group.rejected, 'was', 'were')} rejected${tools}.`,
    )

    const shared = printableTraits(group, group.sharedTraits)
    const common = printableTraits(group, group.commonTraits)
    if (shared.length > 0) {
      sawPattern = true
      lines.push(
        `  ${group.rejected === 1 ? 'It was' : 'Every one was'} ${joinPhrases(shared)}.`,
      )
    }
    if (common.length > 0) {
      sawPattern = true
      lines.push(`  Most were ${joinPhrases(common)}.`)
    }
    if (shared.length === 0 && common.length === 0) {
      lines.push('  No pattern I can see — the rejections had nothing in common.')
    }
    for (const example of group.examples) {
      // No wrapping quotes: a summary usually carries its own.
      lines.push(`  e.g. ${example}`)
    }
  }

  if (sawPattern) {
    lines.push(
      '',
      'If any of that is a standing preference, tell me once and I will stop asking: ' +
        '/rules add <the rule>. If it needs new behaviour instead, /improve <what should change> ' +
        'files it for a human to build.',
    )
  }

  return lines.join('\n')
}

/**
 * Reads the approvals the household rejected in the window and describes the
 * pattern. Feeds the weekly self-improvement suggestion.
 */
export async function approvalRetro(days: number): Promise<string> {
  const window = clampDays(days)
  const zone = await householdZone()
  const since = windowStart(window, zone, new Date()).toJSDate()

  let rows: RetroInputRow[] = []
  try {
    const selected = await getDb()
      .select({
        toolName: schema.pendingActions.toolName,
        category: schema.pendingActions.category,
        status: schema.pendingActions.status,
        humanSummary: schema.pendingActions.humanSummary,
        argsJson: schema.pendingActions.argsJson,
        requestedBy: schema.pendingActions.requestedBy,
        origin: schema.pendingActions.origin,
        createdAt: schema.pendingActions.createdAt,
      })
      .from(schema.pendingActions)
      .where(
        and(
          gte(schema.pendingActions.createdAt, since),
          inArray(schema.pendingActions.status, [...DECIDED_STATUSES]),
        ),
      )
      .orderBy(desc(schema.pendingActions.createdAt))
    rows = selected as RetroInputRow[]
  } catch (err) {
    log.error({ err, days: window }, 'could not read the approval history')
    return 'I could not read the approval history just now. The database did not answer.'
  }

  return describeRejections(rollupRejections(rows, { days: window, zone }))
}
