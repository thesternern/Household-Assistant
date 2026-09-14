import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { renderBirthdayFact } from '../src/workflows/morning-brief.js'

const ZONE = 'America/Vancouver'
const on = (iso: string) => DateTime.fromISO(iso, { zone: ZONE })

/**
 * The brief is read on a phone before coffee, so a birthday has to survive as
 * one short line. It is handed to the model as settled fact rather than left
 * to a tool call, because a SELECT can answer it and the brief's whole design
 * is to spend tool calls only on what a SELECT cannot.
 */
describe('renderBirthdayFact', () => {
  it('names today with the age being turned', () => {
    const line = renderBirthdayFact([{ name: 'Theo', birthday: '2020-09-01' }], on('2026-09-01'))
    expect(line).toHaveLength(1)
    expect(line[0]).toContain('Theo')
    expect(line[0]).toContain('6')
  })

  it('flags a birthday a week out', () => {
    const line = renderBirthdayFact([{ name: 'Maya', birthday: '2018-09-08' }], on('2026-09-01'))
    expect(line[0]).toMatch(/week|7/i)
  })

  it('says nothing on an ordinary day', () => {
    expect(renderBirthdayFact([{ name: 'Maya', birthday: '2018-09-08' }], on('2026-06-15'))).toEqual([])
  })
})
