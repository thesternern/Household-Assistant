import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeShoppingDb } from './helpers/shopping-fake-db.js'

/**
 * The standing list's storage. The behaviour that matters is that items batch
 * until asked for, that marking them sent is what consumes them, and that a
 * sent item can be put back — because nothing reads back from the store, so
 * "sent" is a guess the household must be able to correct.
 *
 * The fake honours the actual `where` clause each function builds (rendered
 * to real SQL via drizzle's PgDialect, see helpers/shopping-fake-db.ts), so a
 * `markSent`/`setStatus` that updated the wrong rows — or all of them — would
 * fail a test here, not just one that happens to match its own staged ids.
 */

const { dbRef } = vi.hoisted(() => ({ dbRef: { current: null as unknown } }))

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const l: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop }
  l.child = () => l
  return { logger: l, child: () => l }
})

vi.mock('../src/db/client.js', async () => {
  const schema = await import('../src/db/schema.js')
  return { getDb: () => dbRef.current, schema }
})

const { addItems, markSent, pendingItems, recentlySent, setStatus, standingToLines } = await import(
  '../src/shopping/standing-list.js'
)

let fake: FakeShoppingDb

beforeEach(() => {
  fake = new FakeShoppingDb()
  dbRef.current = fake
})

describe('addItems', () => {
  it('adds each name as its own pending item', async () => {
    const added = await addItems({ items: ['dish soap', 'coffee'], addedBy: 'Alex' })

    expect(added).toHaveLength(2)
    expect(added.map((i) => i.name)).toEqual(['dish soap', 'coffee'])
    expect(added.every((i) => i.status === 'pending')).toBe(true)
    expect(added.every((i) => i.urgent === false)).toBe(true)
  })

  it('marks urgent only when asked', async () => {
    const added = await addItems({ items: ['infant paracetamol'], urgent: true, addedBy: 'Sam' })
    expect(added[0]?.urgent).toBe(true)
  })

  it('ignores blank names', async () => {
    const added = await addItems({ items: ['  ', 'salt'], addedBy: 'Alex' })
    expect(added.map((i) => i.name)).toEqual(['salt'])
  })

  it('adds nothing when every name is blank', async () => {
    expect(await addItems({ items: ['', '   '], addedBy: 'Alex' })).toEqual([])
  })

  it('writes the amount the household said through to the row', async () => {
    const added = await addItems({
      items: [{ name: 'chicken thighs', quantity: '2 lb' }, 'salt'],
      addedBy: 'Alex',
    })

    expect(added.map((i) => [i.name, i.quantityText])).toEqual([
      ['chicken thighs', '2 lb'],
      // A bare name stays null rather than becoming '', so the tools' truthiness
      // checks read the same against every row.
      ['salt', null],
    ])
    // And the quantity survives the round trip out to a paste line.
    expect(standingToLines(await pendingItems())[0]).toMatchObject({
      name: 'chicken thighs',
      quantity: 2,
      unit: 'lb',
    })
  })

  it('strips a newline out of a name rather than storing a second row in one', async () => {
    const added = await addItems({ items: ['dish soap\nfoie gras'], addedBy: 'Alex' })
    expect(added.map((i) => i.name)).toEqual(['dish soap foie gras'])
  })
})

describe('recentlySent', () => {
  it('shows what went into the last shop, newest first, so an id can be found again', async () => {
    const older = fake.seed({ name: 'coffee', status: 'sent', sentAt: new Date('2026-08-30') })
    const newer = fake.seed({ name: 'dish soap', status: 'sent', sentAt: new Date('2026-09-01') })
    fake.seed({ name: 'bin bags', status: 'pending' })
    fake.seed({ name: 'nutmeg', status: 'dropped' })

    const sent = await recentlySent()

    expect(sent.map((i) => i.name)).toEqual(['dish soap', 'coffee'])
    expect(sent.map((i) => i.id)).toEqual([newer.id, older.id])
  })

  it('takes no more than the limit it is given', async () => {
    for (let i = 0; i < 5; i++) {
      fake.seed({ name: `item ${i}`, status: 'sent', sentAt: new Date(2026, 8, i + 1) })
    }
    expect(await recentlySent(2)).toHaveLength(2)
  })
})

describe('pendingItems', () => {
  it('returns what is waiting', async () => {
    await addItems({ items: ['dish soap', 'coffee'], addedBy: 'Alex' })
    const pending = await pendingItems()
    expect(pending.map((i) => i.name)).toEqual(['dish soap', 'coffee'])
  })
})

describe('markSent', () => {
  it('consumes the items it is given', async () => {
    const added = await addItems({ items: ['dish soap', 'coffee'], addedBy: 'Alex' })

    const count = await markSent(added.map((i) => i.id))

    expect(count).toBe(2)
    expect(fake.rows.every((r) => r.status === 'sent')).toBe(true)
    expect(fake.rows.every((r) => r.sentAt instanceof Date)).toBe(true)
    expect(await pendingItems()).toEqual([])
  })

  it('does nothing when given no ids', async () => {
    expect(await markSent([])).toBe(0)
  })

  it('touches only the ids it is given, leaving the rest pending', async () => {
    const added = await addItems({ items: ['dish soap', 'coffee', 'salt'], addedBy: 'Alex' })
    const [soap, coffee, salt] = added

    const count = await markSent([soap!.id, coffee!.id])

    expect(count).toBe(2)
    const stillPending = await pendingItems()
    expect(stillPending.map((i) => i.name)).toEqual(['salt'])
    expect(stillPending[0]?.id).toBe(salt!.id)
  })
})

describe('setStatus', () => {
  it('puts a sent item back, because nothing reads back from the store', async () => {
    const added = await addItems({ items: ['dish soap'], addedBy: 'Alex' })
    const id = added[0]!.id

    await markSent([id])
    expect(await pendingItems()).toEqual([])

    const restored = await setStatus(id, 'pending')
    expect(restored?.status).toBe('pending')
    expect((await pendingItems()).map((i) => i.name)).toEqual(['dish soap'])
  })

  it('changes only the one id it is given, among several pending items', async () => {
    const added = await addItems({ items: ['dish soap', 'coffee', 'salt'], addedBy: 'Alex' })
    const [soap, coffee, salt] = added

    const dropped = await setStatus(coffee!.id, 'dropped')

    expect(dropped?.status).toBe('dropped')
    const stillPending = await pendingItems()
    expect(stillPending.map((i) => i.name)).toEqual(['dish soap', 'salt'])
    expect(stillPending.map((i) => i.id)).toEqual([soap!.id, salt!.id])
  })
})

describe('standingToLines', () => {
  it('carries a parseable quantity through and degrades the rest', () => {
    const lines = standingToLines([
      { name: 'chicken thighs', quantityText: '2 lb' },
      { name: 'olive oil', quantityText: 'a big one' },
      { name: 'salt', quantityText: null },
    ] as never)

    expect(lines[0]).toMatchObject({ name: 'chicken thighs', quantity: 2, unit: 'lb' })
    expect(lines[1]).toMatchObject({ name: 'olive oil', displayText: 'a big one' })
    expect(lines[1]?.quantity).toBeUndefined()
    expect(lines[2]).toMatchObject({ name: 'salt' })
    expect(lines[2]?.displayText).toBeUndefined()
  })
})
