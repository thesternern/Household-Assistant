import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { birthdaysDue } from '../src/contacts/birthdays.js'

const ZONE = 'America/Vancouver'
const on = (iso: string) => DateTime.fromISO(iso, { zone: ZONE })

const rows = [
  { name: 'Maya', birthday: '2018-09-08' }, // seven days out
  { name: 'Theo', birthday: '2020-09-01' }, // today
  { name: 'Alex', birthday: '1983-09-04' }, // three days out — too soon to mention
  { name: 'Sam', birthday: '1987-12-14' }, // months away
  { name: 'Dentist', birthday: null }, // no birthday at all
]

/**
 * Two notices per birthday and no others: a week out, which is enough time to
 * buy something, and the day itself. Anything in between is noise the household
 * did not ask for.
 */
describe('birthdaysDue', () => {
  it('picks up a birthday exactly seven days away', () => {
    const due = birthdaysDue(rows, on('2026-09-01'))
    expect(due.map((d) => d.name)).toContain('Maya')
    expect(due.find((d) => d.name === 'Maya')?.daysAway).toBe(7)
  })

  it('picks up a birthday today, with the age they are turning', () => {
    const due = birthdaysDue(rows, on('2026-09-01'))
    const theo = due.find((d) => d.name === 'Theo')
    expect(theo?.daysAway).toBe(0)
    expect(theo?.age).toBe(6)
  })

  it('ignores birthdays that are neither today nor a week away', () => {
    const due = birthdaysDue(rows, on('2026-09-01'))
    expect(due.map((d) => d.name)).not.toContain('Alex')
    expect(due.map((d) => d.name)).not.toContain('Sam')
  })

  it('ignores contacts with no birthday', () => {
    const due = birthdaysDue(rows, on('2026-09-01'))
    expect(due.map((d) => d.name)).not.toContain('Dentist')
  })

  it('returns nothing on an ordinary day', () => {
    expect(birthdaysDue(rows, on('2026-06-15'))).toEqual([])
  })

  it('reports the age they will turn, not the age they are, for a notice', () => {
    // Maya is 7 until the 8th. The notice is about her turning 8.
    const due = birthdaysDue(rows, on('2026-09-01'))
    expect(due.find((d) => d.name === 'Maya')?.age).toBe(8)
  })
})
