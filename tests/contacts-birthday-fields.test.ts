import { describe, expect, it } from 'vitest'
import { isBirthdayString } from '../src/tools/contacts.js'

/**
 * A birthday reaches the database as whatever the model typed. `familyCalendarId`
 * taught this codebase what happens when an unvalidated string is handed to a
 * consumer four modules away: the failure surfaces nowhere near its cause. The
 * column is a Postgres `date`, so anything that is not an ISO calendar day is
 * rejected at the tool boundary.
 */
describe('isBirthdayString', () => {
  it('accepts an ISO calendar day', () => {
    expect(isBirthdayString('2018-03-04')).toBe(true)
  })

  it('rejects a day that does not exist', () => {
    expect(isBirthdayString('2026-02-30')).toBe(false)
    expect(isBirthdayString('2026-13-01')).toBe(false)
  })

  it('accepts 29 February in a leap year and rejects it otherwise', () => {
    expect(isBirthdayString('2000-02-29')).toBe(true)
    expect(isBirthdayString('2001-02-29')).toBe(false)
  })

  it('rejects prose, timestamps, and empty strings', () => {
    expect(isBirthdayString('March 4th')).toBe(false)
    expect(isBirthdayString('2018-03-04T00:00:00Z')).toBe(false)
    expect(isBirthdayString('')).toBe(false)
  })
})
