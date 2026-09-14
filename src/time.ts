import { DateTime } from 'luxon'
import { getConfig } from './config.js'
import { logger } from './logger.js'
import { cleanText } from './sanitize.js'

/**
 * The household clock.
 *
 * `HOUSEHOLD_TIMEZONE` is a plain `z.string()` in the config schema, so a typo
 * in it reaches Luxon unchecked. Luxon does not throw on a bad zone — it
 * answers an invalid `DateTime`, whose `year` is `NaN`, and the throw happens
 * later and elsewhere: `DateTime.fromObject` rejects a `NaN` unit with an
 * `InvalidArgumentError`. That is how one character in an environment variable
 * takes down a cron four modules away.
 *
 * Every caller that needs the household's wall clock reads it through here, so
 * the guard is written once. A bad zone degrades to the process zone with a
 * loud log; nothing here throws.
 */

const log = logger.child({ mod: 'time' })

/** Used when the config cannot be read at all. Matches the schema default. */
const FALLBACK_ZONE = 'America/Los_Angeles'

/** The configured household timezone, unvalidated. Never throws. */
export function householdZone(): string {
  try {
    return getConfig().HOUSEHOLD_TIMEZONE || FALLBACK_ZONE
  } catch {
    return FALLBACK_ZONE
  }
}

/**
 * Now, in the household timezone — always a *valid* `DateTime`. An unusable
 * zone falls back to the process zone rather than handing `NaN` to arithmetic
 * that would throw on it.
 */
export function householdNow(): DateTime {
  const zone = householdZone()
  const now = DateTime.now().setZone(zone)
  if (now.isValid) return now
  log.error({ zone, reason: now.invalidReason }, 'invalid HOUSEHOLD_TIMEZONE, using the process zone')
  return DateTime.now()
}

/* ─────────────────────────── weeks, as people say them ───────────────────── */

export type WeekResolution = { ok: true; date: string } | { ok: false; error: string }

/** Phrases a person actually uses for a week, mapped to an offset from this Monday. */
const WEEK_WORDS: Record<string, number> = {
  'this week': 0,
  'current week': 0,
  current: 0,
  now: 0,
  'this coming week': 0,
  'next week': 1,
  next: 1,
  // Keyed on the stripped form: the normaliser removes a leading "the ", so
  // "the coming week" arrives here as "coming week".
  'coming week': 1,
  'week after next': 2,
  'last week': -1,
  'previous week': -1,
  last: -1,
}

const WEEK_HELP =
  "Use 'this week', 'next week', or an ISO date inside the week you mean, such as 2026-08-31."

/**
 * Turn loose week wording into the ISO Monday of that week, in the household
 * timezone. Deterministic on purpose — no model call inside a tool. The recipe
 * store snaps the key to a Monday again, so naming any day of the week works.
 *
 * Every tool that takes a week reads it through here. `normalizeWeekStart` in
 * `src/recipes/store.ts` throws on anything that is not an ISO date, so a tool
 * that hands it "this week" raw — the phrasing every other recipe tool
 * accepts — fails on the household's most natural wording.
 */
export function resolveWeekStart(raw: string | undefined): WeekResolution {
  const now = householdNow()
  const input = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^(?:the |for )?(?:week (?:of|starting|beginning) )?/, '')

  if (input === '') return { ok: true, date: now.startOf('week').toFormat('yyyy-MM-dd') }

  const offset = WEEK_WORDS[input]
  if (offset !== undefined) {
    return { ok: true, date: now.startOf('week').plus({ weeks: offset }).toFormat('yyyy-MM-dd') }
  }

  const parsed = DateTime.fromISO(input, { zone: now.zone })
  if (parsed.isValid) return { ok: true, date: parsed.startOf('week').toFormat('yyyy-MM-dd') }

  return { ok: false, error: `I could not read "${cleanText(raw, 60)}" as a week. ${WEEK_HELP}` }
}
