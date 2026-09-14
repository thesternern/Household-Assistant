import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import {
  MAX_NAGS,
  NAG_INTERVAL_DAYS,
  isQuietHour,
  isQuietHourAt,
  nagIntervalDays,
  nagsExhausted,
  nextNagAt,
  quietHoursEndAfter,
  shiftOutOfQuietHours,
} from '../src/jobs/schedule-math.js'

/**
 * The follow-up nag schedule: 1 day, then 2, then 3, never inside quiet hours,
 * and never more than five nags.
 */

const LA = 'America/Los_Angeles'
const QUIET_START = 21
const QUIET_END = 7

const at = (iso: string): Date => new Date(iso)
const local = (instant: Date): DateTime => DateTime.fromJSDate(instant, { zone: LA })

const nag = (from: string, nagCount: number, start = QUIET_START, end = QUIET_END): Date =>
  nextNagAt({
    from: at(from),
    nagCount,
    zone: LA,
    quietHoursStart: start,
    quietHoursEnd: end,
  })

describe('nag backoff intervals', () => {
  it('waits 1 day, then 2, then 3', () => {
    expect(NAG_INTERVAL_DAYS).toEqual([1, 2, 3])
    expect(nagIntervalDays(0)).toBe(1)
    expect(nagIntervalDays(1)).toBe(2)
    expect(nagIntervalDays(2)).toBe(3)
  })

  it('holds at 3 days rather than growing without bound', () => {
    expect(nagIntervalDays(3)).toBe(3)
    expect(nagIntervalDays(4)).toBe(3)
    expect(nagIntervalDays(99)).toBe(3)
  })

  it('treats nonsense counts as "nothing sent yet"', () => {
    expect(nagIntervalDays(-1)).toBe(1)
    expect(nagIntervalDays(Number.NaN)).toBe(1)
    expect(nagIntervalDays(0.7)).toBe(1)
  })

  it('applies each interval to a real timestamp', () => {
    // 10:00 PDT on 1 April — nowhere near quiet hours, so nothing is shifted.
    const from = '2026-04-01T17:00:00Z'
    expect(nag(from, 0).toISOString()).toBe('2026-04-02T17:00:00.000Z')
    expect(nag(from, 1).toISOString()).toBe('2026-04-03T17:00:00.000Z')
    expect(nag(from, 2).toISOString()).toBe('2026-04-04T17:00:00.000Z')
    expect(nag(from, 3).toISOString()).toBe('2026-04-04T17:00:00.000Z')
  })

  it('produces a strictly increasing 1/2/3-day chain when walked forward', () => {
    let cursor = at('2026-04-01T17:00:00Z')
    const gaps: number[] = []
    for (let sent = 0; sent < 4; sent += 1) {
      const next = nag(cursor.toISOString(), sent)
      gaps.push(Math.round((next.getTime() - cursor.getTime()) / 86_400_000))
      cursor = next
    }
    expect(gaps).toEqual([1, 2, 3, 3])
  })
})

describe('the nag limit', () => {
  it('gives up after five nags', () => {
    expect(MAX_NAGS).toBe(5)
    expect(nagsExhausted(0)).toBe(false)
    expect(nagsExhausted(4)).toBe(false)
    expect(nagsExhausted(5)).toBe(true)
    expect(nagsExhausted(6)).toBe(true)
  })
})

describe('quiet hours', () => {
  it('recognises a window that wraps midnight', () => {
    const hourAt = (hour: number): DateTime =>
      DateTime.fromObject({ year: 2026, month: 4, day: 1, hour }, { zone: LA })
    expect(isQuietHour(hourAt(21), QUIET_START, QUIET_END)).toBe(true)
    expect(isQuietHour(hourAt(23), QUIET_START, QUIET_END)).toBe(true)
    expect(isQuietHour(hourAt(3), QUIET_START, QUIET_END)).toBe(true)
    expect(isQuietHour(hourAt(6), QUIET_START, QUIET_END)).toBe(true)
    // The end hour itself is awake again, and so is the hour before the start.
    expect(isQuietHour(hourAt(7), QUIET_START, QUIET_END)).toBe(false)
    expect(isQuietHour(hourAt(20), QUIET_START, QUIET_END)).toBe(false)
  })

  it('reads a non-wrapping window literally', () => {
    const hourAt = (hour: number): DateTime =>
      DateTime.fromObject({ year: 2026, month: 4, day: 1, hour }, { zone: LA })
    expect(isQuietHour(hourAt(0), 1, 5)).toBe(false)
    expect(isQuietHour(hourAt(1), 1, 5)).toBe(true)
    expect(isQuietHour(hourAt(4), 1, 5)).toBe(true)
    expect(isQuietHour(hourAt(5), 1, 5)).toBe(false)
    expect(isQuietHour(hourAt(22), 1, 5)).toBe(false)
  })

  it('treats an empty window as no quiet hours at all', () => {
    const midnight = DateTime.fromObject({ year: 2026, month: 4, day: 1, hour: 0 }, { zone: LA })
    expect(isQuietHour(midnight, 0, 0)).toBe(false)
    expect(isQuietHour(midnight, 22, 22)).toBe(false)
  })

  it('answers against a plain instant in the household zone', () => {
    // 22:00 PDT on 31 March.
    expect(isQuietHourAt(at('2026-04-01T05:00:00Z'), LA, QUIET_START, QUIET_END)).toBe(true)
    // 12:00 PDT on 1 April.
    expect(isQuietHourAt(at('2026-04-01T19:00:00Z'), LA, QUIET_START, QUIET_END)).toBe(false)
  })
})

describe('the quiet-hours skip', () => {
  it('pushes an evening nag to the following morning', () => {
    // 22:00 PDT on 31 March + 1 day = 22:00 PDT on 1 April, inside quiet hours.
    const next = nag('2026-04-01T05:00:00Z', 0)
    expect(local(next).hour).toBe(QUIET_END)
    expect(local(next).toISODate()).toBe('2026-04-02')
    expect(next.toISOString()).toBe('2026-04-02T14:00:00.000Z')
  })

  it('pushes a pre-dawn nag to the same morning, not the next one', () => {
    // 03:00 PDT on 1 April + 1 day = 03:00 PDT on 2 April.
    const next = nag('2026-04-01T10:00:00Z', 0)
    expect(local(next).toISODate()).toBe('2026-04-02')
    expect(local(next).hour).toBe(QUIET_END)
  })

  it('leaves a daytime nag exactly where the backoff put it', () => {
    const next = nag('2026-04-01T17:00:00Z', 0)
    expect(local(next).hour).toBe(10)
    expect(isQuietHourAt(next, LA, QUIET_START, QUIET_END)).toBe(false)
  })

  it('never returns an instant inside quiet hours, at any interval', () => {
    // Walk one nag per hour of the day through a full cycle of intervals.
    for (let hour = 0; hour < 24; hour += 1) {
      const from = DateTime.fromObject({ year: 2026, month: 4, day: 1, hour }, { zone: LA })
      for (let sent = 0; sent <= 5; sent += 1) {
        const next = nag(from.toJSDate().toISOString(), sent)
        expect(isQuietHourAt(next, LA, QUIET_START, QUIET_END)).toBe(false)
        expect(next.getTime()).toBeGreaterThan(from.toMillis())
      }
    }
  })

  it('shifts by wall clock, so the skip survives a DST change', () => {
    // 22:00 PST on 7 March + 1 day = 22:00 PDT on 8 March (the clocks moved at
    // 02:00 that morning), which is quiet, so it lands at 07:00 PDT on 9 March.
    const next = nag('2026-03-08T06:00:00Z', 0)
    expect(local(next).toISODate()).toBe('2026-03-09')
    expect(local(next).hour).toBe(QUIET_END)
    expect(next.toISOString()).toBe('2026-03-09T14:00:00.000Z')
  })

  it('defers a sweep that wakes inside quiet hours to the end of the window', () => {
    // 23:30 PDT -> 07:00 PDT the next morning.
    const resume = quietHoursEndAfter(at('2026-04-02T06:30:00Z'), LA, QUIET_START, QUIET_END)
    expect(local(resume).toISODate()).toBe('2026-04-02')
    expect(local(resume).hour).toBe(QUIET_END)

    // 06:00 PDT -> 07:00 PDT the same morning.
    const soon = quietHoursEndAfter(at('2026-04-02T13:00:00Z'), LA, QUIET_START, QUIET_END)
    expect(local(soon).hour).toBe(QUIET_END)
    expect(soon.getTime() - at('2026-04-02T13:00:00Z').getTime()).toBe(3_600_000)
  })

  it('leaves a sweep outside quiet hours untouched', () => {
    const noon = at('2026-04-02T19:00:00Z')
    expect(quietHoursEndAfter(noon, LA, QUIET_START, QUIET_END).toISOString()).toBe(
      noon.toISOString(),
    )
  })

  it('is a no-op on an instant that is already awake', () => {
    const awake = DateTime.fromObject({ year: 2026, month: 4, day: 1, hour: 12 }, { zone: LA })
    expect(shiftOutOfQuietHours(awake, QUIET_START, QUIET_END).toMillis()).toBe(awake.toMillis())
  })
})
