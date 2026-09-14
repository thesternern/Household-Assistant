/**
 * Reminders: "ping us at a time", as opposed to to-dos, which are "remember to
 * do this".
 *
 * A reminder is two writes that must agree — a `reminders` row and a pg-boss
 * job — so the handler treats the row as the record and the job as its delivery
 * mechanism. If the job cannot be scheduled the row is marked `failed` rather
 * than left as a promise nobody will keep.
 *
 * The wording a person types ("tomorrow 8am", "in 2 hours", "next Tuesday 6pm")
 * is resolved by `parseWhen()` below: a small, deterministic, fully unit-tested
 * parser. A tool must never call a model to understand its own arguments — that
 * would make the same sentence mean different things on different days.
 */
import { and, asc, desc, eq } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { DateTime } from 'luxon'
import rrule from 'rrule'
import { z } from 'zod'
import { audit } from '../audit/log.js'
import { getConfig } from '../config.js'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { fail, ok } from './types.js'
import type { ToolContext, ToolDef } from './types.js'

// `rrule` ships as CommonJS, so under NodeNext it has to come in via the default
// export rather than a named one.
const { RRule } = rrule

const log = logger.child({ mod: 'tools/reminders' })

/**
 * Lifecycle of a reminder row, shared with the `fire-reminder` worker: it
 * claims `scheduled` rows as `firing`, marks them `fired` once delivered, and
 * re-arms recurring ones back to `scheduled`.
 */
const REMINDER_STATUSES = ['scheduled', 'firing', 'fired', 'cancelled'] as const
type ReminderStatus = (typeof REMINDER_STATUSES)[number]

const MAX_LIST = 50
const MAX_TEXT_LINES = 20

/** Time of day used when someone names a day but no clock time. */
const DEFAULT_HOUR = 9
const DEFAULT_MINUTE = 0

type ReminderRow = typeof schema.reminders.$inferSelect

/* ────────────────────────────── time vocabulary ──────────────────────────── */

const WEEKDAY_NUMBERS: Record<string, number> = {
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  weds: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
  sunday: 7,
  sun: 7,
}

/** RRULE day codes indexed by luxon weekday (1 = Monday). */
const RRULE_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const

const MONTH_NUMBERS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
}

/**
 * Words that carry a clock time on their own. `hint` biases a bare hour that
 * sits next to them, so "tonight at 9" is 21:00 rather than 09:00.
 */
const NAMED_TIMES: Record<string, { hour: number; minute: number; today?: boolean; hint?: 'am' | 'pm' }> = {
  noon: { hour: 12, minute: 0 },
  midday: { hour: 12, minute: 0 },
  midnight: { hour: 0, minute: 0 },
  morning: { hour: 9, minute: 0, hint: 'am' },
  afternoon: { hour: 14, minute: 0, hint: 'pm' },
  evening: { hour: 19, minute: 0, hint: 'pm' },
  tonight: { hour: 20, minute: 0, today: true, hint: 'pm' },
  night: { hour: 20, minute: 0, hint: 'pm' },
}

const WHEN_HELP =
  "Try 'tomorrow 8am', 'in 2 hours', 'next Tuesday 6pm', 'Friday', 'tonight', or an exact '2026-09-04 18:30'."

/* ───────────────────────────────── the parser ────────────────────────────── */

export type WhenParse = { ok: true; dt: DateTime; label: string } | { ok: false; error: string }

interface TimeOfDay {
  hour: number
  minute: number
  /** Set by words like "tonight" that pin the day as well as the clock. */
  pinToToday?: boolean
}

interface DayResolution {
  /** Start of the resolved day, in the reference zone. */
  day: DateTime
  /** True when the wording named a day. Bare times may roll to tomorrow; named days may not. */
  explicit: boolean
  /**
   * Set when the day came from a weekday name. "Saturday" said on a Saturday
   * afternoon means the next one, so a resolved instant in the past rolls a
   * whole week rather than being refused.
   */
  weekdayName?: boolean
}

/**
 * Resolves natural wording to an instant in `now`'s zone, or explains why it
 * could not. Anything at or before `now` is rejected — a reminder in the past
 * is always a mistake, and silently moving it would be worse than saying so.
 *
 * Rules worth knowing:
 *  - a bare clock time ("8am") means today, or tomorrow if today's has passed;
 *  - a named day with no clock time fires at 9:00 am;
 *  - a bare hour with no am/pm between 1 and 6 is read as pm ("at 6" = 18:00);
 *  - a bare weekday is the next one that has not happened yet — including
 *    today's, which rolls a week once its time has passed — while
 *    "next <weekday>" always lands in the following calendar week.
 */
export function parseWhen(input: string, now: DateTime): WhenParse {
  if (!now.isValid) return { ok: false, error: 'The household clock is misconfigured.' }

  const normalized = normalizeWhenInput(input)
  if (normalized === '') return { ok: false, error: `I need a time for that reminder. ${WHEN_HELP}` }

  const relative = parseRelative(normalized, now)
  if (relative) return finish(relative, now)

  const absolute = parseAbsolute(normalized, now)
  if (absolute) return finish(absolute, now)

  const extracted = extractTime(normalized)
  const dayText = extracted.rest
  const time = extracted.time

  const resolved = resolveDay(dayText, now, time?.pinToToday === true)
  if (!resolved) {
    // Repetition wording lands here often ("every day at 8am"), because it
    // belongs in `recurrence`, not `when`. Say so instead of just refusing.
    const hint = /^(every|each|daily|weekly|monthly|weekdays?|weekends?)\b/.test(normalized)
      ? ' Put the repetition in `recurrence` and the first firing time in `when`.'
      : ''
    return { ok: false, error: `I could not work out when "${input.trim()}" is.${hint} ${WHEN_HELP}` }
  }

  const hour = time?.hour ?? DEFAULT_HOUR
  const minute = time?.minute ?? DEFAULT_MINUTE
  let candidate = resolved.day.set({ hour, minute, second: 0, millisecond: 0 })

  // Only a bare time ("8am", with no day named) may quietly mean tomorrow.
  if (!resolved.explicit && candidate <= now) candidate = candidate.plus({ days: 1 })
  // A weekday name means the next one that has not happened. Said on a Saturday
  // afternoon, "saturday" is a week away — refusing it as "in the past" would be
  // technically true and useless.
  else if (resolved.weekdayName === true && candidate <= now) candidate = candidate.plus({ weeks: 1 })

  return finish(candidate, now)
}

function finish(candidate: DateTime, now: DateTime): WhenParse {
  if (!candidate.isValid) return { ok: false, error: `That is not a real date or time. ${WHEN_HELP}` }
  if (candidate <= now) {
    return {
      ok: false,
      error: `${formatWhen(candidate)} is in the past (it is ${formatWhen(now)} now). Give me a future time.`,
    }
  }
  return { ok: true, dt: candidate, label: formatWhen(candidate) }
}

/** Lowercases, collapses whitespace, and strips the polite scaffolding. */
function normalizeWhenInput(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(remind (me|us)( to)?|please|set (a )?reminder( for| to)?)\s+/, '')
    .replace(/^(on|for|by)\s+/, '')
    .trim()
}

/** "in 2 hours", "in 30 mins", "in a week", "in half an hour". */
function parseRelative(input: string, now: DateTime): DateTime | null {
  if (/^(right )?now$/.test(input)) return null

  const half = /^in half an hour$/.exec(input)
  if (half) return now.plus({ minutes: 30 })

  const match =
    /^in (?:about |around |roughly )?(a|an|one|two|three|a few|a couple(?: of)?|\d{1,4}) ?(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks|month|months)$/.exec(
      input,
    )
  if (!match) return null

  const rawAmount = match[1] ?? '1'
  const unit = match[2] ?? 'minutes'
  const amount = wordToNumber(rawAmount)
  if (amount === null || amount <= 0) return null

  // Seconds/minutes/hours are exact durations, so they cross a DST boundary the
  // way a stopwatch does. Days and longer are calendar arithmetic, so "in 1 day"
  // keeps the same wall-clock time even when the clocks move.
  if (unit.startsWith('sec')) return now.plus({ seconds: amount })
  if (unit.startsWith('min')) return now.plus({ minutes: amount })
  if (unit.startsWith('h')) return now.plus({ hours: amount })
  if (unit.startsWith('day')) return now.plus({ days: amount })
  if (unit.startsWith('week')) return now.plus({ weeks: amount })
  return now.plus({ months: amount })
}

function wordToNumber(word: string): number | null {
  if (/^\d+$/.test(word)) return Number(word)
  switch (word) {
    case 'a':
    case 'an':
    case 'one':
      return 1
    case 'two':
    case 'a couple':
    case 'a couple of':
      return 2
    case 'three':
    case 'a few':
      return 3
    default:
      return null
  }
}

/** ISO-ish absolute stamps: "2026-09-04T18:30", "2026-09-04 18:30", "2026-09-04". */
function parseAbsolute(input: string, now: DateTime): DateTime | null {
  const withTime = /^(\d{4}-\d{2}-\d{2})[t ](\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/.exec(input)
  if (withTime) {
    // An explicit stamp is 24-hour notation unless it carries am/pm: "06:30"
    // means half past six in the morning. The casual 1–6-means-evening
    // heuristic in `resolveHour` is for sentences, not timestamps — applying
    // it here would silently move a computed "06:30" twelve hours late.
    const hourRaw = Number(withTime[2])
    const meridiem = withTime[4]
    const hour =
      meridiem === undefined
        ? Number.isInteger(hourRaw) && hourRaw >= 0 && hourRaw <= 23
          ? hourRaw
          : null
        : resolveHour(hourRaw, meridiem)
    const minute = Number(withTime[3])
    if (hour === null || minute > 59) return null
    const day = DateTime.fromISO(withTime[1] ?? '', { zone: now.zone })
    if (!day.isValid) return null
    return day.set({ hour, minute, second: 0, millisecond: 0 })
  }

  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(input)
  if (dateOnly) {
    const day = DateTime.fromISO(dateOnly[1] ?? '', { zone: now.zone })
    if (!day.isValid) return null
    return day.set({ hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE, second: 0, millisecond: 0 })
  }

  return null
}

/**
 * Pulls a clock time out of the wording and returns it with the remaining text.
 * A bare number only counts as a time when it carries `am`/`pm`, a colon, or an
 * "at" in front of it — otherwise "sep 4" would become 4 o'clock.
 */
function extractTime(input: string): { time: TimeOfDay | null; rest: string } {
  let rest = input
  let pinToToday = false
  let hint: 'am' | 'pm' | undefined
  let named: TimeOfDay | null = null

  // Strip the daypart word first, whether or not it ends up supplying the time:
  // "tomorrow morning at 7" needs "morning" out of the way before the day is read.
  const namedMatch = /\b(noon|midday|midnight|morning|afternoon|evening|tonight|night)\b/.exec(rest)
  if (namedMatch) {
    const preset = NAMED_TIMES[namedMatch[1] ?? '']
    if (preset) {
      rest = rest.replace(namedMatch[0], ' ')
      named = { hour: preset.hour, minute: preset.minute }
      pinToToday = preset.today === true
      hint = preset.hint
    }
  }

  const atForm = /\bat (\d{1,2})(?::(\d{2}))? ?(am|pm)?\b/.exec(rest)
  const colonForm = atForm ? null : /\b(\d{1,2}):(\d{2}) ?(am|pm)?\b/.exec(rest)
  const meridiemForm = atForm || colonForm ? null : /\b(\d{1,2}) ?(am|pm)\b/.exec(rest)

  const numeric = atForm ?? colonForm ?? meridiemForm
  if (numeric) {
    const hourRaw = Number(numeric[1])
    const minuteRaw = meridiemForm ? 0 : Number(numeric[2] ?? '0')
    const meridiem = meridiemForm ? numeric[2] : numeric[3]
    const hour = resolveHour(hourRaw, meridiem ?? hint)
    if (hour !== null && Number.isInteger(minuteRaw) && minuteRaw >= 0 && minuteRaw <= 59) {
      rest = rest.replace(numeric[0], ' ')
      const time: TimeOfDay = { hour, minute: minuteRaw }
      if (pinToToday) time.pinToToday = true
      return { time, rest: stripAt(rest) }
    }
  }

  if (named) {
    if (pinToToday) named.pinToToday = true
    return { time: named, rest: stripAt(rest) }
  }

  return { time: null, rest: stripAt(rest) }
}

function stripAt(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\bat\b/g, ' ')
    .replace(/[,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 24-hour hour number, or null when the input cannot be a clock hour. */
function resolveHour(hour: number, meridiem: string | undefined): number | null {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null
  if (meridiem === 'am') return hour === 12 ? 0 : hour
  if (meridiem === 'pm') return hour >= 12 ? hour : hour + 12
  if (hour >= 13) return hour
  // No am/pm: 1–6 o'clock is overwhelmingly the evening one.
  if (hour >= 1 && hour <= 6) return hour + 12
  return hour
}

/** Resolves the day half of the wording to the start of a calendar day. */
function resolveDay(text: string, now: DateTime, pinnedToToday: boolean): DayResolution | null {
  const today = now.startOf('day')
  const input = text
    .replace(/^(on|the|this coming|coming)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (input === '') {
    return pinnedToToday ? { day: today, explicit: true } : { day: today, explicit: false }
  }
  if (input === 'today') return { day: today, explicit: true }
  if (input === 'tomorrow' || input === 'tmrw' || input === 'tomorow') {
    return { day: today.plus({ days: 1 }), explicit: true }
  }
  if (input === 'day after tomorrow') return { day: today.plus({ days: 2 }), explicit: true }
  if (input === 'next week') return { day: today.plus({ weeks: 1 }), explicit: true }
  if (input === 'next month') return { day: today.plus({ months: 1 }), explicit: true }
  // "this evening", "this morning" — the daypart word is already stripped.
  if (input === 'this') return { day: today, explicit: true }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(input)
  if (iso) {
    const day = DateTime.fromObject(
      { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) },
      { zone: now.zone },
    )
    return day.isValid ? { day: day.startOf('day'), explicit: true } : null
  }

  const slash = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(input)
  if (slash) {
    const rawYear = slash[3]
    const year = rawYear === undefined ? today.year : rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear)
    let day = DateTime.fromObject(
      { year, month: Number(slash[1]), day: Number(slash[2]) },
      { zone: now.zone },
    )
    if (!day.isValid) return null
    if (rawYear === undefined && day < today) day = day.plus({ years: 1 })
    return { day: day.startOf('day'), explicit: true }
  }

  const monthFirst = /^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/.exec(input)
  if (monthFirst) {
    const month = MONTH_NUMBERS[monthFirst[1] ?? '']
    if (month !== undefined) {
      const parsed = buildMonthDay(month, Number(monthFirst[2]), monthFirst[3], today, now)
      if (parsed) return { day: parsed, explicit: true }
    }
  }

  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)(?:,? (\d{4}))?$/.exec(input)
  if (dayFirst) {
    const month = MONTH_NUMBERS[dayFirst[2] ?? '']
    if (month !== undefined) {
      const parsed = buildMonthDay(month, Number(dayFirst[1]), dayFirst[3], today, now)
      if (parsed) return { day: parsed, explicit: true }
    }
  }

  const weekday = /^(next |this )?([a-z]+)$/.exec(input)
  if (weekday) {
    const target = WEEKDAY_NUMBERS[weekday[2] ?? '']
    if (target !== undefined) {
      const forceNextWeek = (weekday[1] ?? '').trim() === 'next'
      return { day: resolveWeekday(today, target, forceNextWeek), explicit: true, weekdayName: true }
    }
  }

  return null
}

function buildMonthDay(
  month: number,
  day: number,
  yearText: string | undefined,
  today: DateTime,
  now: DateTime,
): DateTime | null {
  const year = yearText === undefined ? today.year : Number(yearText)
  let parsed = DateTime.fromObject({ year, month, day }, { zone: now.zone })
  if (!parsed.isValid) return null
  if (yearText === undefined && parsed < today) parsed = parsed.plus({ years: 1 })
  return parsed.startOf('day')
}

/**
 * First date with `weekday` on or after `today`. `forceNextWeek` pushes the
 * result past the end of the current Monday-start week, which is what people
 * mean by "next Tuesday" when today is already Monday.
 */
function resolveWeekday(today: DateTime, weekday: number, forceNextWeek: boolean): DateTime {
  const delta = (weekday - today.weekday + 7) % 7
  let candidate = today.plus({ days: delta })
  if (forceNextWeek) {
    const endOfThisWeek = today.endOf('week')
    while (candidate <= endOfThisWeek) candidate = candidate.plus({ days: 7 })
  }
  return candidate
}

/** "Tue Sep 8 at 6:00 PM" — the phrasing used in every reminder confirmation. */
export function formatWhen(dt: DateTime): string {
  return dt.toFormat("ccc MMM d 'at' h:mm a")
}

/* ─────────────────────────────── recurrence ──────────────────────────────── */

export type RecurrenceParse =
  | { ok: true; rrule: string | null; label: string }
  | { ok: false; error: string }

const RECURRENCE_HELP =
  "Use 'daily', 'weekdays', 'weekly', 'every other week', 'monthly', 'every monday and thursday', or a raw RRULE like 'FREQ=WEEKLY;BYDAY=MO'."

/**
 * Turns everyday repetition wording into a stored RRULE string, or validates
 * one the caller already wrote. Returns `rrule: null` for a one-off reminder.
 */
export function normalizeRecurrence(raw: string | undefined, at: DateTime): RecurrenceParse {
  const input = (raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (input === '' || input === 'none' || input === 'once' || input === 'one-off' || input === 'never') {
    return { ok: true, rrule: null, label: 'once' }
  }

  const dayCode = RRULE_DAYS[at.weekday - 1] ?? 'MO'

  if (/^(daily|every ?day|each day)$/.test(input)) {
    return { ok: true, rrule: 'FREQ=DAILY', label: 'every day' }
  }
  if (/^(weekdays?|every weekday|weekdays only|mon-fri|monday to friday)$/.test(input)) {
    return { ok: true, rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', label: 'every weekday' }
  }
  if (/^(weekends?|every weekend)$/.test(input)) {
    return { ok: true, rrule: 'FREQ=WEEKLY;BYDAY=SA,SU', label: 'every weekend' }
  }
  if (/^(weekly|every ?week|each week)$/.test(input)) {
    return { ok: true, rrule: `FREQ=WEEKLY;BYDAY=${dayCode}`, label: `every ${at.toFormat('cccc')}` }
  }
  if (/^(biweekly|fortnightly|every other week|every 2 weeks|every two weeks)$/.test(input)) {
    return {
      ok: true,
      rrule: `FREQ=WEEKLY;INTERVAL=2;BYDAY=${dayCode}`,
      label: `every other ${at.toFormat('cccc')}`,
    }
  }
  if (/^(monthly|every ?month|each month)$/.test(input)) {
    return { ok: true, rrule: `FREQ=MONTHLY;BYMONTHDAY=${at.day}`, label: `on the ${at.day}${ordinal(at.day)} of each month` }
  }
  if (/^(yearly|annually|every ?year|each year)$/.test(input)) {
    return { ok: true, rrule: `FREQ=YEARLY;BYMONTH=${at.month};BYMONTHDAY=${at.day}`, label: 'every year' }
  }

  const everyN = /^every (\d{1,3}) (day|days|week|weeks|month|months)$/.exec(input)
  if (everyN) {
    const interval = Number(everyN[1])
    const unit = everyN[2] ?? 'days'
    if (interval < 1) return { ok: false, error: `An interval has to be at least 1. ${RECURRENCE_HELP}` }
    if (unit.startsWith('day')) {
      return { ok: true, rrule: `FREQ=DAILY;INTERVAL=${interval}`, label: `every ${interval} days` }
    }
    if (unit.startsWith('week')) {
      return {
        ok: true,
        rrule: `FREQ=WEEKLY;INTERVAL=${interval};BYDAY=${dayCode}`,
        label: `every ${interval} weeks`,
      }
    }
    return {
      ok: true,
      rrule: `FREQ=MONTHLY;INTERVAL=${interval};BYMONTHDAY=${at.day}`,
      label: `every ${interval} months`,
    }
  }

  const everyDays = /^(?:every|each) ([a-z, ]+?)s?$/.exec(input)
  if (everyDays) {
    const names = (everyDays[1] ?? '').split(/,| and /).map((part) => part.trim()).filter(Boolean)
    const codes: string[] = []
    for (const name of names) {
      const weekday = WEEKDAY_NUMBERS[name] ?? WEEKDAY_NUMBERS[name.replace(/s$/, '')]
      if (weekday === undefined) {
        codes.length = 0
        break
      }
      const code = RRULE_DAYS[weekday - 1]
      if (code && !codes.includes(code)) codes.push(code)
    }
    if (codes.length > 0) {
      return {
        ok: true,
        rrule: `FREQ=WEEKLY;BYDAY=${codes.join(',')}`,
        label: `every ${names.join(' and ')}`,
      }
    }
  }

  if (/freq=/i.test(input)) {
    const canonical = raw?.trim().replace(/^rrule:/i, '') ?? ''
    try {
      const rule = RRule.fromString(canonical)
      if (typeof rule.options.freq !== 'number') {
        return { ok: false, error: `That RRULE has no FREQ. ${RECURRENCE_HELP}` }
      }
      return { ok: true, rrule: canonical.toUpperCase(), label: canonical.toUpperCase() }
    } catch (err) {
      log.debug({ err, canonical }, 'invalid rrule rejected')
      return { ok: false, error: `I could not read "${raw ?? ''}" as an RRULE. ${RECURRENCE_HELP}` }
    }
  }

  return { ok: false, error: `I could not read "${raw ?? ''}" as a repeat rule. ${RECURRENCE_HELP}` }
}

function ordinal(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return 'th'
  if (day % 10 === 1) return 'st'
  if (day % 10 === 2) return 'nd'
  if (day % 10 === 3) return 'rd'
  return 'th'
}

/* ────────────────────────────── shared plumbing ──────────────────────────── */

function zone(): string {
  return getConfig().HOUSEHOLD_TIMEZONE
}

function nowLocal(): DateTime {
  return DateTime.now().setZone(zone())
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function issueText(error: z.ZodError): string {
  const first = error.issues[0]
  if (!first) return 'the arguments were not valid'
  const path = first.path.join('.')
  return path === '' ? first.message : `${path}: ${first.message}`
}

function toStructured(row: ReminderRow): Record<string, unknown> {
  return {
    id: row.id,
    text: row.text,
    fireAt: row.fireAt.toISOString(),
    fireAtLocal: DateTime.fromJSDate(row.fireAt).setZone(zone()).toISO(),
    recurrence: row.recurrence,
    status: row.status,
    createdBy: row.createdBy,
    telegramChatId: row.telegramChatId,
  }
}

/** Which chat the ping goes to. Falls back to the household's primary chat. */
async function resolveChatId(ctx: ToolContext): Promise<string | null> {
  const fromCtx = ctx.chatId?.trim()
  if (fromCtx) return fromCtx
  try {
    const { primaryChatId } = await import('../telegram/send.js')
    return await primaryChatId()
  } catch (err) {
    log.error({ err }, 'could not resolve a chat id for the reminder')
    return null
  }
}

/**
 * Books the delivery job (a `boss.sendAfter` on the `fire-reminder` queue) and
 * returns the pg-boss job id to store on the row. The queue module is imported
 * lazily so that loading a tool never spins up a database-backed job runner —
 * tests and one-shot scripts import this file for the parser alone.
 */
async function scheduleDelivery(reminderId: number, fireAt: Date): Promise<string | null> {
  try {
    const { enqueueReminder } = await import('../jobs/queue.js')
    return await enqueueReminder(reminderId, fireAt)
  } catch (err) {
    log.error({ err, reminderId }, 'failed to schedule reminder delivery')
    return null
  }
}

async function cancelDelivery(jobId: string | null): Promise<void> {
  if (!jobId) return
  try {
    const { getBoss, QUEUES } = await import('../jobs/queue.js')
    const boss = await getBoss()
    await boss.cancel(QUEUES.fireReminder, jobId)
  } catch (err) {
    // A job that already ran or was purged cannot be cancelled; the row status
    // is what the firing worker checks, so this is not fatal.
    log.warn({ err, jobId }, 'could not cancel reminder job')
  }
}

/* ────────────────────────────── reminder_set ─────────────────────────────── */

const setShape = {
  text: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe('What to say when it fires, written as the message the household will read.'),
  when: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("When to fire: 'tomorrow 8am', 'in 2 hours', 'next Tuesday 6pm', 'Friday', '2026-09-04 18:30'."),
  recurrence: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("Optional repeat: 'daily', 'weekdays', 'weekly', 'every other week', 'monthly', or an RRULE string."),
}
const setSchema = z.object(setShape)

const reminderSet: ToolDef = {
  name: 'reminder_set',
  description:
    'Schedule a Telegram ping at a specific time, optionally repeating. Use this when the household wants to be ' +
    'told something at a moment in time. Use todo_add instead for work that has no clock attached.',
  schema: setShape,
  category: 'reminder_write',
  consequential: false,
  summarize: (args) => {
    const text = readString(args['text']) ?? 'something'
    const when = readString(args['when']) ?? 'an unspecified time'
    const recurrence = readString(args['recurrence'])
    return `Set a reminder for ${when}: "${text}"${recurrence ? `, repeating ${recurrence}` : ''}.`
  },
  handler: async (args, ctx) => {
    const parsed = setSchema.safeParse(args)
    if (!parsed.success) return fail(`I could not set that reminder: ${issueText(parsed.error)}`)
    const { text } = parsed.data

    const now = nowLocal()
    const when = parseWhen(parsed.data.when, now)
    if (!when.ok) return fail(when.error)

    const recurrence = normalizeRecurrence(parsed.data.recurrence, when.dt)
    if (!recurrence.ok) return fail(recurrence.error)

    const chatId = await resolveChatId(ctx)
    if (!chatId) return fail('I do not know which chat to send that reminder to.')

    let row: ReminderRow | undefined
    try {
      const inserted = await getDb()
        .insert(schema.reminders)
        .values({
          text,
          fireAt: when.dt.toJSDate(),
          recurrence: recurrence.rrule,
          telegramChatId: chatId,
          status: 'scheduled',
          createdBy: ctx.actor,
        })
        .returning()
      row = inserted[0]
    } catch (err) {
      log.error({ err }, 'reminder insert failed')
      return fail('I could not save that reminder — the database rejected the write.')
    }
    if (!row) return fail('The reminder could not be saved. Nothing was scheduled.')

    const jobId = await scheduleDelivery(row.id, row.fireAt)
    if (!jobId) {
      // The row is marked cancelled rather than left `scheduled`: a scheduled
      // row with no job behind it is a promise nothing will keep, and the
      // housekeeping cron only ever prunes `fired` and `cancelled`.
      try {
        await getDb()
          .update(schema.reminders)
          .set({ status: 'cancelled' })
          .where(eq(schema.reminders.id, row.id))
      } catch (err) {
        log.error({ err, reminderId: row.id }, 'could not mark the unscheduled reminder cancelled')
      }
      log.error({ reminderId: row.id }, 'reminder could not be scheduled; row cancelled')
      return fail('I could not put that reminder on the schedule, so I have not set it. Try again in a moment.')
    }

    // The job is already booked, so a failure here costs only the stored job id:
    // the reminder still fires, and reminder_cancel still stops it by flipping
    // the row's status, which the worker checks before it sends.
    let finalRow = row
    try {
      const stored = await getDb()
        .update(schema.reminders)
        .set({ bossJobId: jobId })
        .where(eq(schema.reminders.id, row.id))
        .returning()
      finalRow = stored[0] ?? row
    } catch (err) {
      log.error({ err, reminderId: row.id, jobId }, 'could not store the reminder job id')
    }

    await audit({
      actor: ctx.actor,
      event: 'reminder.set',
      category: 'reminder_write',
      toolName: 'reminder_set',
      args: { text, fireAt: when.dt.toISO(), recurrence: recurrence.rrule },
      resultSummary: `reminder #${finalRow.id} at ${when.label}`,
      ok: true,
    })
    log.info({ reminderId: finalRow.id, fireAt: when.dt.toISO(), jobId }, 'reminder scheduled')

    const repeatPart = recurrence.rrule ? `, repeating ${recurrence.label}` : ''
    return ok(`Reminder #${finalRow.id} set for ${when.label}${repeatPart}: "${text}".`, {
      reminder: toStructured(finalRow),
      repeat: recurrence.label,
    })
  },
}

/* ────────────────────────────── reminder_list ────────────────────────────── */

const listShape = {
  status: z
    .enum(['scheduled', 'firing', 'fired', 'cancelled', 'all'])
    .default('scheduled')
    .describe('Which reminders to return. Defaults to the ones still waiting to fire.'),
  limit: z.coerce.number().int().min(1).default(20).describe('Maximum reminders to return (capped at 50).'),
}
const listSchema = z.object(listShape)

const reminderList: ToolDef = {
  name: 'reminder_list',
  description:
    'List reminders, soonest first. Call this before cancelling one so you have the right id.',
  schema: listShape,
  category: 'read',
  consequential: false,
  readOnly: true,
  summarize: (args) => `List ${readString(args['status']) ?? 'scheduled'} reminders.`,
  handler: async (args) => {
    const parsed = listSchema.safeParse(args)
    if (!parsed.success) return fail(`I could not read that reminder filter: ${issueText(parsed.error)}`)
    const { status } = parsed.data
    const limit = Math.min(parsed.data.limit, MAX_LIST)

    try {
      const conditions: SQL[] = []
      if (status === 'scheduled') {
        conditions.push(eq(schema.reminders.status, 'scheduled'))
        // A scheduled row in the past is a delivery that has not landed yet;
        // still worth showing, so only filter on status here.
      } else if (status !== 'all') {
        conditions.push(eq(schema.reminders.status, status))
      }
      const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions)

      const rows = await getDb()
        .select()
        .from(schema.reminders)
        .where(where)
        .orderBy(status === 'scheduled' ? asc(schema.reminders.fireAt) : desc(schema.reminders.fireAt))
        .limit(limit)

      if (rows.length === 0) {
        return ok(status === 'scheduled' ? 'No reminders are scheduled.' : 'No reminders match that filter.', {
          reminders: [],
          count: 0,
        })
      }

      const tz = zone()
      const lines = rows.slice(0, MAX_TEXT_LINES).map((row) => {
        const at = formatWhen(DateTime.fromJSDate(row.fireAt).setZone(tz))
        const repeat = row.recurrence ? ` · repeats (${row.recurrence})` : ''
        const state = row.status === 'scheduled' ? '' : ` · ${row.status}`
        return `#${row.id} ${at} — ${row.text}${repeat}${state}`
      })
      if (rows.length > MAX_TEXT_LINES) lines.push(`…and ${rows.length - MAX_TEXT_LINES} more.`)

      return ok(`${rows.length} reminder${rows.length === 1 ? '' : 's'}:\n${lines.join('\n')}`, {
        reminders: rows.map(toStructured),
        count: rows.length,
      })
    } catch (err) {
      log.error({ err }, 'reminder_list failed')
      return fail('I could not read the reminder list right now.')
    }
  },
}

/* ───────────────────────────── reminder_cancel ───────────────────────────── */

const cancelShape = {
  id: z.coerce.number().int().positive().describe('The reminder id, as shown by reminder_list.'),
}
const cancelSchema = z.object(cancelShape)

const reminderCancel: ToolDef = {
  name: 'reminder_cancel',
  description: 'Cancel a scheduled reminder so it never fires. Get the id from reminder_list first.',
  schema: cancelShape,
  category: 'reminder_write',
  consequential: false,
  summarize: (args) => `Cancel reminder #${String(args['id'] ?? '?')}.`,
  handler: async (args, ctx) => {
    const parsed = cancelSchema.safeParse(args)
    if (!parsed.success) return fail(`I need a numeric reminder id: ${issueText(parsed.error)}`)
    const { id } = parsed.data

    try {
      const updated = await getDb()
        .update(schema.reminders)
        .set({ status: 'cancelled' })
        .where(and(eq(schema.reminders.id, id), eq(schema.reminders.status, 'scheduled')))
        .returning()

      const row = updated[0]
      if (!row) {
        const existing = await getDb()
          .select()
          .from(schema.reminders)
          .where(eq(schema.reminders.id, id))
          .limit(1)
        const found = existing[0]
        if (!found) return fail(`There is no reminder #${id}.`)
        const state = found.status === 'fired' ? 'already fired' : `already ${found.status}`
        return ok(`Reminder #${id} has ${state}; nothing to cancel.`, {
          reminder: toStructured(found),
          changed: false,
        })
      }

      await cancelDelivery(row.bossJobId)
      await audit({
        actor: ctx.actor,
        event: 'reminder.cancel',
        category: 'reminder_write',
        toolName: 'reminder_cancel',
        args: { id },
        resultSummary: row.text,
        ok: true,
      })
      log.info({ reminderId: id, actor: ctx.actor }, 'reminder cancelled')

      const at = formatWhen(DateTime.fromJSDate(row.fireAt).setZone(zone()))
      return ok(`Cancelled reminder #${id} ("${row.text}", was set for ${at}).`, {
        reminder: toStructured(row),
        changed: true,
      })
    } catch (err) {
      log.error({ err, reminderId: id }, 'reminder_cancel failed')
      return fail(`I could not cancel reminder #${id}.`)
    }
  },
}

/* ───────────────────────────────── exports ───────────────────────────────── */

export const reminderTools: ToolDef[] = [reminderSet, reminderList, reminderCancel]

export const tools: ToolDef[] = reminderTools

export type { ReminderStatus }
