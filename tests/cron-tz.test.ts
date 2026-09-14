import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import {
  WEEKDAY,
  dailyCronUtc,
  fromFloatingUtc,
  nextLocalOccurrence,
  nextLocalWeekdayOccurrence,
  toFloatingUtc,
  weeklyCronUtc,
} from '../src/jobs/schedule-math.js'

/**
 * pg-boss evaluates our schedules against UTC, so every household-local hour
 * has to be converted before it is stored — and the conversion is only valid
 * for the offset in force at the next occurrence.
 *
 * These tests pin both sides of both 2026 DST boundaries for
 * America/Los_Angeles. If the conversion ever silently reverts to a fixed
 * offset, the pair of expectations either side of a boundary stops agreeing.
 *
 * 2026 US boundaries: DST starts Sunday 8 March at 02:00, ends Sunday
 * 1 November at 02:00.
 */

const LA = 'America/Los_Angeles'
const BRIEF_HOUR = 7
const REVIEW_HOUR = 17

/** A fixed reference instant, so nothing here depends on the wall clock. */
const at = (iso: string): Date => new Date(iso)

describe('dailyCronUtc across a DST boundary', () => {
  it('uses UTC-8 while the zone is on standard time', () => {
    // Thursday 15 January, 12:00 PST. The next 07:00 local is 15:00 UTC.
    expect(dailyCronUtc(LA, BRIEF_HOUR, 0, at('2026-01-15T20:00:00Z'))).toBe('0 15 * * *')
  })

  it('uses UTC-7 while the zone is on daylight time', () => {
    // Wednesday 15 July, 12:00 PDT. The next 07:00 local is 14:00 UTC.
    expect(dailyCronUtc(LA, BRIEF_HOUR, 0, at('2026-07-15T19:00:00Z'))).toBe('0 14 * * *')
  })

  it('flips an hour earlier in UTC the day the clocks spring forward', () => {
    // Friday 6 March, 12:00 PST: the next brief is Saturday, still PST.
    expect(dailyCronUtc(LA, BRIEF_HOUR, 0, at('2026-03-06T20:00:00Z'))).toBe('0 15 * * *')
    // Saturday 7 March, 12:00 PST: the next brief is Sunday 8 March, already
    // PDT because the change happens at 02:00, five hours before the brief.
    expect(dailyCronUtc(LA, BRIEF_HOUR, 0, at('2026-03-07T20:00:00Z'))).toBe('0 14 * * *')
  })

  it('flips an hour later in UTC the day the clocks fall back', () => {
    // Friday 30 October, 12:00 PDT: the next brief is Saturday, still PDT.
    expect(dailyCronUtc(LA, BRIEF_HOUR, 0, at('2026-10-30T19:00:00Z'))).toBe('0 14 * * *')
    // Saturday 31 October, 12:00 PDT: the next brief is Sunday 1 November,
    // by which time the zone is back on PST.
    expect(dailyCronUtc(LA, BRIEF_HOUR, 0, at('2026-10-31T19:00:00Z'))).toBe('0 15 * * *')
  })

  it('is a fixed point in a zone that never changes offset', () => {
    expect(dailyCronUtc('UTC', BRIEF_HOUR, 0, at('2026-01-15T00:00:00Z'))).toBe('0 7 * * *')
    expect(dailyCronUtc('UTC', BRIEF_HOUR, 0, at('2026-07-15T00:00:00Z'))).toBe('0 7 * * *')
  })

  it('carries a half-hour offset into the minute field', () => {
    // Kolkata is UTC+5:30 all year; 07:00 local is 01:30 UTC.
    expect(dailyCronUtc('Asia/Kolkata', BRIEF_HOUR, 0, at('2026-01-15T00:00:00Z'))).toBe(
      '30 1 * * *',
    )
  })
})

describe('weeklyCronUtc across a DST boundary', () => {
  it('lands on Monday 01:00 UTC while the zone is on standard time', () => {
    // Sunday 17:00 PST is Monday 01:00 UTC. Cron numbers Monday as 1.
    expect(weeklyCronUtc(LA, WEEKDAY.sunday, REVIEW_HOUR, 0, at('2026-01-15T20:00:00Z'))).toBe(
      '0 1 * * 1',
    )
  })

  it('lands on Monday 00:00 UTC while the zone is on daylight time', () => {
    expect(weeklyCronUtc(LA, WEEKDAY.sunday, REVIEW_HOUR, 0, at('2026-07-15T19:00:00Z'))).toBe(
      '0 0 * * 1',
    )
  })

  it('picks up the new offset on the changeover weekend itself', () => {
    // Saturday 7 March: the review is tomorrow, 17:00 PDT -> Monday 00:00 UTC.
    expect(weeklyCronUtc(LA, WEEKDAY.sunday, REVIEW_HOUR, 0, at('2026-03-07T20:00:00Z'))).toBe(
      '0 0 * * 1',
    )
    // Saturday 31 October: the review is tomorrow, 17:00 PST -> Monday 01:00 UTC.
    expect(weeklyCronUtc(LA, WEEKDAY.sunday, REVIEW_HOUR, 0, at('2026-10-31T19:00:00Z'))).toBe(
      '0 1 * * 1',
    )
  })

  it('rolls the UTC day of week when the local evening crosses midnight UTC', () => {
    // Sunday local, Monday UTC, in both halves of the year.
    for (const reference of ['2026-01-15T20:00:00Z', '2026-07-15T19:00:00Z']) {
      const cron = weeklyCronUtc(LA, WEEKDAY.sunday, REVIEW_HOUR, 0, at(reference))
      expect(cron.split(' ')[4]).toBe('1')
    }
  })
})

describe('nextLocalOccurrence', () => {
  it('always resolves to the requested wall-clock hour, whatever the offset', () => {
    for (const reference of [
      '2026-01-15T20:00:00Z',
      '2026-03-07T20:00:00Z',
      '2026-03-09T20:00:00Z',
      '2026-07-15T19:00:00Z',
      '2026-10-31T19:00:00Z',
      '2026-11-02T20:00:00Z',
    ]) {
      const occurrence = nextLocalOccurrence(LA, BRIEF_HOUR, 0, at(reference))
      expect(occurrence.hour).toBe(BRIEF_HOUR)
      expect(occurrence.minute).toBe(0)
      expect(occurrence.toMillis()).toBeGreaterThan(at(reference).getTime())
    }
  })

  it('rolls to tomorrow once today has passed', () => {
    // 12:00 PST on 15 January; 07:00 has already gone.
    const occurrence = nextLocalOccurrence(LA, BRIEF_HOUR, 0, at('2026-01-15T20:00:00Z'))
    expect(occurrence.toISODate()).toBe('2026-01-16')
  })

  it('stays on today when the hour is still ahead', () => {
    // 03:00 PST on 15 January.
    const occurrence = nextLocalOccurrence(LA, BRIEF_HOUR, 0, at('2026-01-15T11:00:00Z'))
    expect(occurrence.toISODate()).toBe('2026-01-15')
  })

  it('rejects hours and weekdays outside their range', () => {
    expect(() => nextLocalOccurrence(LA, 24, 0, at('2026-01-15T20:00:00Z'))).toThrow(RangeError)
    expect(() => nextLocalOccurrence(LA, 7, 60, at('2026-01-15T20:00:00Z'))).toThrow(RangeError)
    expect(() => nextLocalWeekdayOccurrence(LA, 0, 7, 0, at('2026-01-15T20:00:00Z'))).toThrow(
      RangeError,
    )
    expect(() => nextLocalOccurrence('Mars/Olympus', 7, 0, at('2026-01-15T20:00:00Z'))).toThrow(
      RangeError,
    )
  })
})

describe('floating wall-clock conversion', () => {
  it('round-trips an instant through wall-clock fields on both sides of a boundary', () => {
    for (const iso of ['2026-01-15T15:00:00Z', '2026-07-15T14:00:00Z', '2026-03-08T14:00:00Z']) {
      const instant = at(iso)
      expect(fromFloatingUtc(toFloatingUtc(instant, LA), LA).toISOString()).toBe(
        instant.toISOString(),
      )
    }
  })

  it('reads a floating date as the same wall-clock time in the household zone', () => {
    // 07:00 "floating" is 07:00 local, whichever offset applies that day.
    const winter = fromFloatingUtc(new Date(Date.UTC(2026, 0, 16, 7, 0, 0)), LA)
    const summer = fromFloatingUtc(new Date(Date.UTC(2026, 6, 16, 7, 0, 0)), LA)
    expect(DateTime.fromJSDate(winter, { zone: LA }).hour).toBe(7)
    expect(DateTime.fromJSDate(summer, { zone: LA }).hour).toBe(7)
    // …which is a different UTC hour in each case. That difference is exactly
    // what the cron resync exists to track.
    expect(winter.getUTCHours()).toBe(15)
    expect(summer.getUTCHours()).toBe(14)
  })
})
