import { DateTime } from 'luxon'
import type { WeekdayNumbers } from 'luxon'

/**
 * Pure time arithmetic for the job layer. No database, no config, no network —
 * everything takes its inputs explicitly so it can be tested against a fixed
 * reference instant on either side of a DST boundary.
 *
 * Two jobs live here:
 *
 *  1. **Household-local hour -> UTC cron expression.** pg-boss evaluates a
 *     schedule's cron expression in the schedule's own timezone, defaulting to
 *     UTC, and we deliberately keep every stored expression in UTC (see
 *     `dailyCronUtc`). That means the expression is only correct for the
 *     offset in force when it was computed, so the caller must recompute and
 *     re-upsert on boot and periodically thereafter.
 *
 *  2. **Follow-up nag backoff** — 1 day, then 2, then 3, capped at 3, never
 *     landing inside the household's quiet hours.
 */

/* ────────────────────────── local hour -> UTC cron ───────────────────────── */

/** Luxon weekday numbers, for callers that would otherwise hard-code them. */
export const WEEKDAY = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
} as const

function assertHourMinute(hour: number, minute: number): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError(`hour must be an integer 0-23, got ${hour}`)
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new RangeError(`minute must be an integer 0-59, got ${minute}`)
  }
}

function zoned(zone: string, reference: Date): DateTime {
  const dt = DateTime.fromJSDate(reference, { zone })
  if (!dt.isValid) throw new RangeError(`invalid timezone "${zone}": ${dt.invalidReason ?? ''}`)
  return dt
}

/**
 * The next instant at which the wall clock in `zone` reads `hour:minute`,
 * strictly after `reference`.
 *
 * Resolving the *next* occurrence rather than today's matters on a DST
 * changeover day: at 12:00 PST on the Saturday before spring-forward, "07:00
 * local" next happens on Sunday at UTC-7, not at today's UTC-8.
 */
export function nextLocalOccurrence(
  zone: string,
  hour: number,
  minute: number,
  reference: Date = new Date(),
): DateTime {
  assertHourMinute(hour, minute)
  const now = zoned(zone, reference)
  const today = now.set({ hour, minute, second: 0, millisecond: 0 })
  return today > now ? today : today.plus({ days: 1 })
}

/**
 * The next instant at which the wall clock in `zone` reads `hour:minute` on
 * the given luxon `weekday` (1 = Monday … 7 = Sunday), strictly after
 * `reference`.
 */
export function nextLocalWeekdayOccurrence(
  zone: string,
  weekday: number,
  hour: number,
  minute: number,
  reference: Date = new Date(),
): DateTime {
  assertHourMinute(hour, minute)
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
    throw new RangeError(`weekday must be an integer 1-7 (Mon-Sun), got ${weekday}`)
  }
  const now = zoned(zone, reference)
  // `set({ weekday })` moves within the current ISO week, which starts Monday.
  const thisWeek = now.set({
    weekday: weekday as WeekdayNumbers,
    hour,
    minute,
    second: 0,
    millisecond: 0,
  })
  return thisWeek > now ? thisWeek : thisWeek.plus({ weeks: 1 })
}

/**
 * A UTC `m h * * *` expression that fires when the wall clock in `zone` reads
 * `hour:minute`, given the UTC offset in force at the next such occurrence.
 *
 * The offset is baked in, so this expression is only valid until the zone next
 * changes offset. Callers must recompute it on boot and on a recurring sweep;
 * `src/jobs/crons.ts` re-upserts every schedule hourly for exactly that reason.
 */
export function dailyCronUtc(
  zone: string,
  hour: number,
  minute: number,
  reference: Date = new Date(),
): string {
  const utc = nextLocalOccurrence(zone, hour, minute, reference).toUTC()
  return `${utc.minute} ${utc.hour} * * *`
}

/**
 * A UTC `m h * * dow` expression that fires when the wall clock in `zone`
 * reads `hour:minute` on luxon `weekday` (1 = Monday … 7 = Sunday).
 *
 * The day-of-week field shifts too: Sunday 17:00 in America/Los_Angeles is
 * Monday 00:00 UTC in summer and Monday 01:00 UTC in winter. Cron numbers the
 * days 0-6 from Sunday, so luxon's 7 folds to 0.
 */
export function weeklyCronUtc(
  zone: string,
  weekday: number,
  hour: number,
  minute: number,
  reference: Date = new Date(),
): string {
  const utc = nextLocalWeekdayOccurrence(zone, weekday, hour, minute, reference).toUTC()
  return `${utc.minute} ${utc.hour} * * ${utc.weekday % 7}`
}

/* ───────────────────────── floating-date conversion ──────────────────────── */

/**
 * Re-express an instant as the UTC date whose *UTC* fields equal the wall-clock
 * fields the instant has in `zone`.
 *
 * rrule does all of its arithmetic in UTC, so "every day at 07:00 local" only
 * survives a DST change if the recurrence is expanded in floating wall-clock
 * time and mapped back afterwards. Pair with `fromFloatingUtc`.
 */
export function toFloatingUtc(instant: Date, zone: string): Date {
  const l = zoned(zone, instant)
  return new Date(Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second, l.millisecond))
}

/** Inverse of `toFloatingUtc`: read the UTC fields as wall-clock time in `zone`. */
export function fromFloatingUtc(floating: Date, zone: string): Date {
  return DateTime.fromObject(
    {
      year: floating.getUTCFullYear(),
      month: floating.getUTCMonth() + 1,
      day: floating.getUTCDate(),
      hour: floating.getUTCHours(),
      minute: floating.getUTCMinutes(),
      second: floating.getUTCSeconds(),
      millisecond: floating.getUTCMilliseconds(),
    },
    { zone },
  ).toJSDate()
}

/* ────────────────────────────── quiet hours ──────────────────────────────── */

/**
 * True when the wall clock sits inside the household's quiet window.
 *
 * The window normally wraps midnight (21 -> 7). A non-wrapping window (1 -> 5)
 * is read literally, and `start === end` means the household has no quiet
 * hours at all rather than 24 hours of them.
 */
export function isQuietHour(at: DateTime, quietHoursStart: number, quietHoursEnd: number): boolean {
  const start = normalizeHour(quietHoursStart)
  const end = normalizeHour(quietHoursEnd)
  if (start === end) return false
  const hour = at.hour
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

/** Same test against a plain instant, resolved in `zone`. */
export function isQuietHourAt(
  instant: Date,
  zone: string,
  quietHoursStart: number,
  quietHoursEnd: number,
): boolean {
  return isQuietHour(zoned(zone, instant), quietHoursStart, quietHoursEnd)
}

/**
 * Push an instant forward to the moment quiet hours end, or return it
 * unchanged when it was already outside them.
 */
export function shiftOutOfQuietHours(
  at: DateTime,
  quietHoursStart: number,
  quietHoursEnd: number,
): DateTime {
  if (!isQuietHour(at, quietHoursStart, quietHoursEnd)) return at
  const end = normalizeHour(quietHoursEnd)
  const sameDay = at.set({ hour: end, minute: 0, second: 0, millisecond: 0 })
  return sameDay > at ? sameDay : sameDay.plus({ days: 1 })
}

function normalizeHour(hour: number): number {
  if (!Number.isFinite(hour)) return 0
  const h = Math.trunc(hour)
  return ((h % 24) + 24) % 24
}

/* ─────────────────────────── follow-up nag backoff ───────────────────────── */

/**
 * Days to wait before nag N+1, indexed by how many nags have already been
 * sent: 1 day, then 2, then 3. Past the third the gap holds at 3 days so a
 * long-running follow-up does not go quiet for a fortnight.
 */
export const NAG_INTERVAL_DAYS = [1, 2, 3] as const

/** After this many nags the assistant gives up and closes the follow-up. */
export const MAX_NAGS = 5

/** Gap in days between the `nagCount`-th nag and the next one. */
export function nagIntervalDays(nagCount: number): number {
  const n = Number.isFinite(nagCount) ? Math.max(0, Math.trunc(nagCount)) : 0
  const idx = Math.min(n, NAG_INTERVAL_DAYS.length - 1)
  return NAG_INTERVAL_DAYS[idx] ?? 3
}

/** True once the assistant has chased this follow-up as often as it is allowed to. */
export function nagsExhausted(nagCount: number): boolean {
  const n = Number.isFinite(nagCount) ? Math.max(0, Math.trunc(nagCount)) : 0
  return n >= MAX_NAGS
}

export interface NextNagInput {
  /** The instant the nag backoff is measured from — usually "now". */
  from: Date
  /** How many nags have already been sent for this follow-up. */
  nagCount: number
  zone: string
  quietHoursStart: number
  quietHoursEnd: number
}

/**
 * When to chase a follow-up next: `from` plus the backoff for `nagCount`,
 * pushed out of quiet hours if it landed inside them.
 */
export function nextNagAt(input: NextNagInput): Date {
  const base = zoned(input.zone, input.from).plus({ days: nagIntervalDays(input.nagCount) })
  return shiftOutOfQuietHours(base, input.quietHoursStart, input.quietHoursEnd).toJSDate()
}

/**
 * When an hourly sweep wakes inside quiet hours, every due nag is deferred to
 * the moment the quiet window ends rather than being sent or skipped.
 */
export function quietHoursEndAfter(
  instant: Date,
  zone: string,
  quietHoursStart: number,
  quietHoursEnd: number,
): Date {
  return shiftOutOfQuietHours(zoned(zone, instant), quietHoursStart, quietHoursEnd).toJSDate()
}
