import { describe, expect, it } from 'vitest'
import { DateTime } from 'luxon'
import { formatWhen, normalizeRecurrence, parseWhen } from '../src/tools/reminders.js'

const ZONE = 'America/Los_Angeles'

/**
 * Saturday 5 September 2026, 2:30 pm PDT (UTC-7). Fixed so every expectation is
 * an exact instant rather than a relative assertion that drifts with the clock.
 * That week runs Mon 31 Aug – Sun 6 Sep, which is what "next Tuesday" turns on.
 */
const REF = DateTime.fromISO('2026-09-05T14:30:00', { zone: ZONE })

/**
 * Saturday 7 March 2026, 11:00 pm PST (UTC-8) — three hours before US clocks
 * jump forward at 2:00 am on Sunday 8 March. Anything resolved from here has to
 * cross the gap.
 */
const DST_REF = DateTime.fromISO('2026-03-07T23:00:00', { zone: ZONE })

function resolved(input: string, now: DateTime = REF): DateTime {
  const parsed = parseWhen(input, now)
  if (!parsed.ok) throw new Error(`expected "${input}" to parse, got: ${parsed.error}`)
  return parsed.dt
}

describe('parseWhen — the reference instants', () => {
  it('anchors the suite on a Saturday afternoon in PDT', () => {
    expect(REF.isValid).toBe(true)
    expect(REF.toFormat('cccc')).toBe('Saturday')
    expect(REF.toISO()).toBe('2026-09-05T14:30:00.000-07:00')
  })
})

describe('parseWhen — relative phrasing', () => {
  it('resolves "tomorrow 8am" to 8:00 the next calendar day', () => {
    expect(resolved('tomorrow 8am').toISO()).toBe('2026-09-06T08:00:00.000-07:00')
  })

  it('resolves "in 2 hours" as an exact duration from now', () => {
    expect(resolved('in 2 hours').toISO()).toBe('2026-09-05T16:30:00.000-07:00')
  })

  it('resolves "next Tuesday 6pm" to the Tuesday in the following week', () => {
    const dt = resolved('next Tuesday 6pm')
    expect(dt.toFormat('cccc')).toBe('Tuesday')
    expect(dt.toISO()).toBe('2026-09-08T18:00:00.000-07:00')
  })

  it('resolves a bare "Friday" to the next Friday at the 9am default', () => {
    const dt = resolved('Friday')
    expect(dt.toFormat('cccc')).toBe('Friday')
    expect(dt.toISO()).toBe('2026-09-11T09:00:00.000-07:00')
  })

  it('reads a bare weekday as this coming one, and "next <weekday>" as the week after', () => {
    expect(resolved('tuesday 6pm').toISODate()).toBe('2026-09-08')
    // From Monday 7 Sep, "next Tuesday" must skip tomorrow and land on 15 Sep.
    const monday = DateTime.fromISO('2026-09-07T09:00:00', { zone: ZONE })
    expect(monday.toFormat('cccc')).toBe('Monday')
    expect(resolved('tuesday 6pm', monday).toISODate()).toBe('2026-09-08')
    expect(resolved('next tuesday 6pm', monday).toISODate()).toBe('2026-09-15')
  })

  it('rolls a weekday whose time has already gone to the following week', () => {
    // It is Saturday afternoon. "Saturday" is the next one, not nine hours ago —
    // the rule is "the next one that has not happened", and today's 9am has.
    expect(resolved('saturday').toISODate()).toBe('2026-09-12')
    expect(resolved('saturday 9am').toISODate()).toBe('2026-09-12')
    // A time still to come today stays today.
    expect(resolved('saturday 6pm').toISO()).toBe('2026-09-05T18:00:00.000-07:00')
    // The roll is weekday-only: "today" stays today and is refused if it passed.
    expect(parseWhen('today 9am', REF).ok).toBe(false)
  })

  it('handles minute-scale and week-scale offsets', () => {
    expect(resolved('in 30 minutes').toISO()).toBe('2026-09-05T15:00:00.000-07:00')
    expect(resolved('in an hour').toISO()).toBe('2026-09-05T15:30:00.000-07:00')
    expect(resolved('in 3 days').toISO()).toBe('2026-09-08T14:30:00.000-07:00')
    expect(resolved('in 2 weeks').toISO()).toBe('2026-09-19T14:30:00.000-07:00')
  })

  it('rolls a bare clock time forward when today’s has already gone', () => {
    // 8am has passed at 14:30, so a bare "8am" means tomorrow…
    expect(resolved('8am').toISODate()).toBe('2026-09-06')
    // …while a time still to come today stays today.
    expect(resolved('6pm').toISO()).toBe('2026-09-05T18:00:00.000-07:00')
  })

  it('reads a bare 1–6 o’clock as the evening one, and daypart words as themselves', () => {
    expect(resolved('at 6').toISO()).toBe('2026-09-05T18:00:00.000-07:00')
    expect(resolved('tonight').toISO()).toBe('2026-09-05T20:00:00.000-07:00')
    expect(resolved('tomorrow morning').toISO()).toBe('2026-09-06T09:00:00.000-07:00')
    expect(resolved('tomorrow morning at 7').toISO()).toBe('2026-09-06T07:00:00.000-07:00')
    expect(resolved('tomorrow evening at 7').toISO()).toBe('2026-09-06T19:00:00.000-07:00')
  })

  it('accepts explicit stamps and calendar dates', () => {
    expect(resolved('2026-12-24 18:30').toISO()).toBe('2026-12-24T18:30:00.000-08:00')
    expect(resolved('2026-12-24').toISO()).toBe('2026-12-24T09:00:00.000-08:00')
    expect(resolved('december 24 at 5pm').toISO()).toBe('2026-12-24T17:00:00.000-08:00')
  })

  it('reads an explicit stamp as 24-hour time unless it carries am/pm', () => {
    // The 1–6-means-evening heuristic is for sentences. A timestamp the model
    // computed as "06:30" must not silently become 6:30 PM.
    expect(resolved('2026-12-24 06:30').toISO()).toBe('2026-12-24T06:30:00.000-08:00')
    expect(resolved('2026-12-24 6:30').toISO()).toBe('2026-12-24T06:30:00.000-08:00')
    expect(resolved('2026-12-24T06:30').toISO()).toBe('2026-12-24T06:30:00.000-08:00')
    expect(resolved('2026-12-24 00:30').toISO()).toBe('2026-12-24T00:30:00.000-08:00')
    // …while am/pm on a stamp still means what it says.
    expect(resolved('2026-12-24 6:30pm').toISO()).toBe('2026-12-24T18:30:00.000-08:00')
    expect(resolved('2026-12-24 12:00am').toISO()).toBe('2026-12-24T00:00:00.000-08:00')
  })
})

describe('parseWhen — past times are refused', () => {
  it('rejects a named day and time that has already gone', () => {
    const parsed = parseWhen('today 9am', REF)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('expected a rejection')
    expect(parsed.error).toContain('past')
    expect(parsed.error).toContain('Sep 5')
  })

  it('rejects a past explicit date', () => {
    const parsed = parseWhen('2026-09-04 18:30', REF)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('expected a rejection')
    expect(parsed.error).toContain('past')
  })

  it('refuses wording it cannot resolve rather than guessing', () => {
    const parsed = parseWhen('whenever you get a chance', REF)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('expected a rejection')
    expect(parsed.error).toContain('could not work out')
  })

  it('refuses an empty when', () => {
    const parsed = parseWhen('   ', REF)
    expect(parsed.ok).toBe(false)
  })
})

describe('parseWhen — across the spring-forward boundary', () => {
  it('treats "in 4 hours" as four real hours, so the wall clock moves five', () => {
    const dt = resolved('in 4 hours', DST_REF)
    // 23:00 PST + 4h of real time = 04:00 PDT: 2:00–3:00 never happens.
    expect(dt.toISO()).toBe('2026-03-08T04:00:00.000-07:00')
    expect(dt.offset).toBe(-420)
    expect(dt.diff(DST_REF, 'hours').hours).toBe(4)
    expect(dt.hour - DST_REF.hour + 24).toBe(5)
  })

  it('treats "tomorrow 8am" as a wall-clock time on the day the clocks change', () => {
    const dt = resolved('tomorrow 8am', DST_REF)
    expect(dt.toISO()).toBe('2026-03-08T08:00:00.000-07:00')
    expect(dt.offset).toBe(-420)
    // Nine hours on the wall clock, but only eight real ones: the day is short.
    expect(dt.hour - DST_REF.hour + 24).toBe(9)
    expect(dt.diff(DST_REF, 'hours').hours).toBe(8)
  })

  it('never lands inside the missing hour', () => {
    const dt = resolved('tomorrow 2:30am', DST_REF)
    // 02:30 does not exist on 8 March; luxon moves it forward rather than inventing it.
    expect(dt.offset).toBe(-420)
    expect(dt.toISODate()).toBe('2026-03-08')
    expect(dt.hour).toBe(3)
  })

  it('resolves a reminder set for 2am itself — a time that does not exist that night', () => {
    const dt = resolved('tomorrow 2am', DST_REF)
    // The clock jumps from 01:59:59 PST to 03:00:00 PDT, so "2am" lands on the
    // first instant that exists: 3:00 PDT. The parse stays valid, the instant
    // is real, and the confirmation label tells the household the actual time.
    expect(dt.isValid).toBe(true)
    expect(dt.toISO()).toBe('2026-03-08T03:00:00.000-07:00')
    expect(dt.offset).toBe(-420)
    expect(formatWhen(dt)).toBe('Sun Mar 8 at 3:00 AM')
    // Exactly three real hours after 23:00 PST — nothing fired an hour early.
    expect(dt.diff(DST_REF, 'hours').hours).toBe(3)
  })
})

describe('parseWhen — across the fall-back boundary', () => {
  /**
   * Saturday 31 October 2026, 11:00 pm PDT (UTC-7) — three hours before US
   * clocks fall back at 2:00 am on Sunday 1 November. The night is 25 hours
   * long; 1:00–1:59 am happens twice.
   */
  const FALL_REF = DateTime.fromISO('2026-10-31T23:00:00', { zone: ZONE })

  it('anchors on the evening before the clocks fall back', () => {
    expect(FALL_REF.isValid).toBe(true)
    expect(FALL_REF.offset).toBe(-420)
  })

  it('treats "tomorrow 8am" as a wall-clock time, not a fixed offset', () => {
    const dt = resolved('tomorrow 8am', FALL_REF)
    // 8am PST, not 7am or 9am: the reminder fires when the kitchen clock says 8.
    expect(dt.toISO()).toBe('2026-11-01T08:00:00.000-08:00')
    expect(dt.offset).toBe(-480)
    // Nine hours on the wall, ten real ones: the night gained an hour.
    expect(dt.hour - FALL_REF.hour + 24).toBe(9)
    expect(dt.diff(FALL_REF, 'hours').hours).toBe(10)
  })

  it('treats "in 4 hours" as four real hours, so the wall clock moves three', () => {
    const dt = resolved('in 4 hours', FALL_REF)
    // 23:00 PDT + 4h of real time = 02:00 PST — the repeated 1am hour has passed.
    expect(dt.toISO()).toBe('2026-11-01T02:00:00.000-08:00')
    expect(dt.offset).toBe(-480)
    expect(dt.diff(FALL_REF, 'hours').hours).toBe(4)
  })

  it('resolves the ambiguous 1:30am to the first occurrence, deterministically', () => {
    const dt = resolved('tomorrow 1:30am', FALL_REF)
    // 1:30 happens twice that night; luxon picks the earlier (PDT) instant.
    // What matters is that the choice is fixed, valid, and not an hour off.
    expect(dt.isValid).toBe(true)
    expect(dt.toISO()).toBe('2026-11-01T01:30:00.000-07:00')
    expect(dt.hour).toBe(1)
    expect(dt.minute).toBe(30)
  })
})

describe('formatWhen', () => {
  it('prints the sentence the confirmation quotes back', () => {
    expect(formatWhen(resolved('next Tuesday 6pm'))).toBe('Tue Sep 8 at 6:00 PM')
  })
})

describe('normalizeRecurrence', () => {
  const at = DateTime.fromISO('2026-09-08T18:00:00', { zone: ZONE }) // a Tuesday

  it('treats no recurrence as a one-off', () => {
    expect(normalizeRecurrence(undefined, at)).toEqual({ ok: true, rrule: null, label: 'once' })
    expect(normalizeRecurrence('none', at)).toEqual({ ok: true, rrule: null, label: 'once' })
  })

  it('maps everyday wording onto RRULEs', () => {
    expect(normalizeRecurrence('daily', at)).toMatchObject({ ok: true, rrule: 'FREQ=DAILY' })
    expect(normalizeRecurrence('weekdays', at)).toMatchObject({
      ok: true,
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    })
    expect(normalizeRecurrence('weekly', at)).toMatchObject({ ok: true, rrule: 'FREQ=WEEKLY;BYDAY=TU' })
    expect(normalizeRecurrence('every other week', at)).toMatchObject({
      ok: true,
      rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU',
    })
    expect(normalizeRecurrence('monthly', at)).toMatchObject({ ok: true, rrule: 'FREQ=MONTHLY;BYMONTHDAY=8' })
    expect(normalizeRecurrence('every monday and thursday', at)).toMatchObject({
      ok: true,
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TH',
    })
    expect(normalizeRecurrence('every 3 days', at)).toMatchObject({
      ok: true,
      rrule: 'FREQ=DAILY;INTERVAL=3',
    })
  })

  it('passes a valid RRULE through and rejects nonsense', () => {
    expect(normalizeRecurrence('FREQ=WEEKLY;BYDAY=MO,WE,FR', at)).toMatchObject({
      ok: true,
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    })
    const bad = normalizeRecurrence('sometimes maybe', at)
    expect(bad.ok).toBe(false)
  })
})
