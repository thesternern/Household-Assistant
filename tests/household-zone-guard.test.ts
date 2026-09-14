import { DateTime } from 'luxon'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `HOUSEHOLD_TIMEZONE` is an unvalidated `z.string()`, and a typo in it is not
 * a quiet degradation — Luxon answers an invalid `DateTime` whose `year` is
 * `NaN`, and `DateTime.fromObject` then *throws* `Invalid unit value NaN`.
 * Thrown from the birthday code, that reaches the household as "I couldn't
 * finish the morning brief" every single morning, and as an error from every
 * `contact_search`.
 *
 * Two independent guards have to hold, so both are pinned here:
 *
 *  1. The arithmetic in `src/contacts/birthdays.ts` returns `null` rather than
 *     throwing, whatever it is handed.
 *  2. Every caller reads the clock through `householdNow()`, which falls back
 *     to the process zone when the configured one is unusable.
 */

const BAD_ZONE = 'Mars/Olympus_Mons'

const H = vi.hoisted(() => ({
  zone: 'Mars/Olympus_Mons',
  sent: [] as string[],
}))

vi.mock('../src/config.js', () => ({
  getConfig: () => ({ HOUSEHOLD_TIMEZONE: H.zone }),
}))

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const l: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop }
  l.child = () => l
  return { logger: l, child: () => l }
})

vi.mock('../src/audit/log.js', () => ({ audit: async () => {} }))

vi.mock('../src/telegram/send.js', () => ({
  sendToAll: async (text: string) => {
    H.sent.push(text)
  },
  sendToChat: async () => {},
  primaryChatId: async () => '4242',
}))

const CONTACTS = [
  {
    id: 3,
    name: 'Theo',
    role: null,
    phone: '+16045550243',
    email: null,
    address: null,
    notes: null,
    birthday: '2020-09-01',
    household: true,
  },
]

vi.mock('../src/db/client.js', async () => {
  const realSchema = await vi.importActual<typeof import('../src/db/schema.js')>('../src/db/schema.js')
  return {
    getDb: () => ({
      select: () => ({
        from: () => ({
          where: () => {
            // Awaited as it stands for the sweep's read; chained for the
            // ranked contact search.
            const query = Promise.resolve(CONTACTS) as Promise<typeof CONTACTS> & {
              orderBy: (o: unknown) => { limit: (n: number) => Promise<typeof CONTACTS> }
            }
            query.orderBy = () => ({ limit: () => Promise.resolve(CONTACTS) })
            return query
          },
        }),
      }),
    }),
    getPool: () => ({}),
    closeDb: async () => {},
    schema: realSchema,
  }
})

const { ageOn, birthdaysDue, daysUntilBirthday, observedBirthday } = await import(
  '../src/contacts/birthdays.js'
)
const { householdNow, householdZone } = await import('../src/time.js')
const { contactTools } = await import('../src/tools/contacts.js')
const { birthdaySweep } = await import('../src/contacts/birthday-sweep.js')

const contactSearch = contactTools.find((t) => t.name === 'contact_search')
if (!contactSearch) throw new Error('contact_search is not registered')

/** What a caller reading a bad zone actually holds: invalid, with a NaN year. */
const poisoned = DateTime.now().setZone(BAD_ZONE)

beforeEach(() => {
  H.zone = BAD_ZONE
  H.sent.length = 0
})

describe('the birthday arithmetic never throws', () => {
  it('sees a NaN year for an unusable zone', () => {
    expect(poisoned.isValid).toBe(false)
    expect(Number.isNaN(poisoned.year)).toBe(true)
  })

  it('returns null for a year that is not a whole number', () => {
    expect(observedBirthday('2020-09-01', Number.NaN, 'utc')).toBeNull()
    expect(observedBirthday('2020-09-01', Number.POSITIVE_INFINITY, 'utc')).toBeNull()
  })

  it('returns null rather than an invalid DateTime for an unusable zone', () => {
    expect(observedBirthday('2020-09-01', 2026, BAD_ZONE)).toBeNull()
    // 29 February in a non-leap year takes the 28th fallback, which used to be
    // returned without ever being checked for validity.
    expect(observedBirthday('2020-02-29', 2027, BAD_ZONE)).toBeNull()
  })

  it('still observes 29 February on the 28th in a usable zone', () => {
    const observed = observedBirthday('2020-02-29', 2027, 'America/Vancouver')
    expect(observed?.isValid).toBe(true)
    expect(observed?.toFormat('yyyy-MM-dd')).toBe('2027-02-28')
  })

  it('degrades to null instead of throwing, all the way up', () => {
    expect(() => ageOn('2020-09-01', poisoned)).not.toThrow()
    expect(ageOn('2020-09-01', poisoned)).toBeNull()
    expect(() => daysUntilBirthday('2020-09-01', poisoned)).not.toThrow()
    expect(daysUntilBirthday('2020-09-01', poisoned)).toBeNull()
    expect(birthdaysDue([{ name: 'Theo', birthday: '2020-09-01' }], poisoned)).toEqual([])
  })
})

describe('householdNow', () => {
  it('hands back a valid clock when the configured zone is a typo', () => {
    expect(householdZone()).toBe(BAD_ZONE)
    expect(householdNow().isValid).toBe(true)
  })

  it('uses the configured zone when it is a real one', () => {
    H.zone = 'America/Vancouver'
    expect(householdNow().zoneName).toBe('America/Vancouver')
  })
})

describe('the callers degrade rather than throw', () => {
  it('contact_search still answers under a bad zone', async () => {
    const result = await contactSearch.handler({ query: 'Theo' }, {
      chatId: '4242',
      actor: 'Alex',
      origin: 'chat',
    })

    expect(result.isError).toBeFalsy()
    expect(result.content.map((p) => p.text).join('\n')).toContain('Theo')
  })

  it('the birthday sweep still runs under a bad zone', async () => {
    await expect(birthdaySweep()).resolves.toBeUndefined()
  })
})
