import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { ageOn, daysUntilBirthday, observedBirthday } from '../src/contacts/birthdays.js'

const ZONE = 'America/Vancouver'
const on = (iso: string) => DateTime.fromISO(iso, { zone: ZONE })

describe('ageOn', () => {
  it('counts a birthday that has already passed this year', () => {
    expect(ageOn('2018-03-04', on('2026-09-01'))).toBe(8)
  })

  it('does not count a birthday still to come this year', () => {
    expect(ageOn('2018-12-04', on('2026-09-01'))).toBe(7)
  })

  it('increments on the birthday itself', () => {
    expect(ageOn('2018-09-01', on('2026-09-01'))).toBe(8)
  })

  it('treats 29 February as 28 February in a non-leap year', () => {
    // 2026 is not a leap year. The observed day is the 28th, so the 28th is
    // the day the age ticks over.
    expect(ageOn('2000-02-29', on('2026-02-27'))).toBe(25)
    expect(ageOn('2000-02-29', on('2026-02-28'))).toBe(26)
  })

  it('uses the real day in a leap year', () => {
    expect(ageOn('2000-02-29', on('2028-02-28'))).toBe(27)
    expect(ageOn('2000-02-29', on('2028-02-29'))).toBe(28)
  })

  it('returns null for an unparseable birthday', () => {
    expect(ageOn('not-a-date', on('2026-09-01'))).toBeNull()
    expect(ageOn('', on('2026-09-01'))).toBeNull()
  })
})

describe('daysUntilBirthday', () => {
  it('is 0 on the day', () => {
    expect(daysUntilBirthday('2018-09-01', on('2026-09-01'))).toBe(0)
  })

  it('counts forward within the year', () => {
    expect(daysUntilBirthday('2018-09-08', on('2026-09-01'))).toBe(7)
  })

  it('rolls into next year once the birthday has passed', () => {
    expect(daysUntilBirthday('2018-08-30', on('2026-09-01'))).toBe(363)
  })

  it('crosses the year boundary', () => {
    expect(daysUntilBirthday('2018-01-01', on('2026-12-28'))).toBe(4)
  })

  it('is measured in local days, not elapsed hours', () => {
    // Late in the evening, local time. A naive hour-difference would round
    // this to 6 days and the seven-day notice would never fire.
    expect(daysUntilBirthday('2018-09-08', on('2026-09-01T23:30'))).toBe(7)
  })
})

describe('observedBirthday', () => {
  it('returns null for a malformed value', () => {
    expect(observedBirthday('13-13-13', 2026, ZONE)).toBeNull()
  })
})
