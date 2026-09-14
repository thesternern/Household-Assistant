import { DateTime } from 'luxon'

/**
 * Birthday arithmetic, as pure functions.
 *
 * This module imports nothing but Luxon on purpose. The sweep cron and the
 * morning brief both need these answers, and a leaf module is what lets them
 * share without one importing the other.
 *
 * Age is computed here and stored nowhere. A stored age is wrong within a year
 * of being written and nothing in the system would notice.
 */

/** How much notice the household gets before a birthday. Enough to buy something. */
export const LEAD_DAYS = 7

/**
 * The day a birthday is observed in a given year.
 *
 * A 29 February birthday is observed on the 28th in non-leap years. That is one
 * rule used by both the age and the reminder, which is the point: two rules
 * would eventually disagree about whether someone had had their birthday.
 */
export function observedBirthday(
  birthday: string,
  year: number,
  zone: string,
): DateTime | null {
  // `year` arrives from a caller's `DateTime.year`, which is `NaN` whenever the
  // household timezone is a typo. Luxon's `fromObject` *throws* on a non-integer
  // unit rather than answering an invalid DateTime, and these functions are
  // read inside a cron and inside the morning brief's facts block, where a
  // throw is a daily apology instead of a missing line. `null` is the only
  // failure this module reports.
  if (!Number.isInteger(year)) return null

  const born = DateTime.fromISO(birthday, { zone })
  if (!born.isValid) return null

  const candidate = DateTime.fromObject(
    { year, month: born.month, day: born.day },
    { zone },
  )
  if (candidate.isValid) return candidate.startOf('day')

  // The only way a real month/day fails to exist is 29 February in a non-leap
  // year. Observe it on the 28th — and check that too, because the signature
  // promises a valid DateTime or nothing.
  const fallback = DateTime.fromObject({ year, month: born.month, day: 28 }, { zone })
  return fallback.isValid ? fallback.startOf('day') : null
}

/** Whole years old on `today`, or `null` if the birthday cannot be read. */
export function ageOn(birthday: string, today: DateTime): number | null {
  const born = DateTime.fromISO(birthday, { zone: today.zoneName ?? 'utc' })
  if (!born.isValid) return null

  const observed = observedBirthday(birthday, today.year, today.zoneName ?? 'utc')
  if (!observed) return null

  const had = today.startOf('day') >= observed
  return today.year - born.year - (had ? 0 : 1)
}

/**
 * Whole local days until the next observed birthday. `0` on the day itself.
 *
 * Measured between start-of-day values so an evening run still reports seven
 * days rather than six-and-a-bit, which is what would silently swallow the
 * week's notice.
 */
export function daysUntilBirthday(birthday: string, today: DateTime): number | null {
  const zone = today.zoneName ?? 'utc'
  const start = today.startOf('day')

  const thisYear = observedBirthday(birthday, today.year, zone)
  if (!thisYear) return null

  const target = thisYear >= start ? thisYear : observedBirthday(birthday, today.year + 1, zone)
  if (!target) return null

  return Math.round(target.diff(start, 'days').days)
}

export interface BirthdayRow {
  name: string
  birthday: string | null
}

export interface BirthdayNotice {
  name: string
  /** The age they are turning, not the age they are today. */
  age: number | null
  /** 0 on the day, otherwise LEAD_DAYS. */
  daysAway: number
}

/**
 * The birthdays worth mentioning on `today`: the ones happening now, and the
 * ones a week out. Nothing in between — a household that is told every day for
 * a week stops reading the notice.
 */
export function birthdaysDue(
  rows: readonly BirthdayRow[],
  today: DateTime,
): BirthdayNotice[] {
  const out: BirthdayNotice[] = []
  for (const row of rows) {
    if (!row.birthday) continue
    const daysAway = daysUntilBirthday(row.birthday, today)
    if (daysAway === null) continue
    if (daysAway !== 0 && daysAway !== LEAD_DAYS) continue

    // The notice is about the birthday, so it names the age being reached.
    const current = ageOn(row.birthday, today)
    const age = current === null ? null : daysAway === 0 ? current : current + 1
    out.push({ name: row.name, age, daysAway })
  }
  return out
}
