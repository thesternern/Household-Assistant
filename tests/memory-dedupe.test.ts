/**
 * memory_save's near-duplicate detection, tested at both layers.
 *
 * The nightmare this file guards against: a family with two kids and two
 * allergies saves both, and the second save silently overwrites the first.
 * A false merge destroys something the household told us; a false split just
 * leaves two facts the model can reconcile later. So every "must not merge"
 * case here is load-bearing.
 *
 * The handler tests run against a small in-memory Drizzle stand-in that renders
 * the real `where` clauses to SQL and honours LIKE semantics, so the
 * subject-scoping of the dedupe lookup is exercised, not assumed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { ToolContext, ToolDef } from '../src/tools/types.js'

const { dbRef, auditMock } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  auditMock: vi.fn(async () => {}),
}))

vi.mock('../src/db/client.js', async () => {
  const schema = await import('../src/db/schema.js')
  return { getDb: () => dbRef.current, schema }
})
vi.mock('../src/audit/log.js', () => ({ audit: auditMock }))
vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const l: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop }
  l.child = () => l
  return { logger: l }
})

const { factSimilarity, memoryTools } = await import('../src/tools/memory.js')

/* ───────────────────────── in-memory memory_facts table ──────────────────── */

const dialect = new PgDialect()

interface FactRow {
  id: number
  subject: string
  category: string
  fact: string
  active: boolean
  source: string
  createdAt: Date
  updatedAt: Date
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Faithful ILIKE: `%`/`_` are wildcards unless backslash-escaped. */
function likeToRegex(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] ?? ''
    if (ch === '\\' && i + 1 < pattern.length) {
      out += escapeRegex(pattern[i + 1] ?? '')
      i += 1
    } else if (ch === '%') out += '[\\s\\S]*'
    else if (ch === '_') out += '[\\s\\S]'
    else out += escapeRegex(ch)
  }
  return new RegExp(`^${out}$`, 'i')
}

class FakeMemoryDb {
  rows: FactRow[] = []
  private nextId = 1

  private render(where: SQL | undefined): { sql: string; params: unknown[] } {
    if (!where) return { sql: '', params: [] }
    const q = dialect.sqlToQuery(where)
    return { sql: q.sql, params: q.params as unknown[] }
  }

  private filter(where: SQL | undefined): FactRow[] {
    const { sql, params } = this.render(where)
    let rows = [...this.rows]
    const active = /"active" = \$(\d+)/.exec(sql)
    if (active) {
      const want = params[Number(active[1]) - 1]
      rows = rows.filter((row) => row.active === want)
    }
    const subject = /"subject" ilike \$(\d+)/.exec(sql)
    if (subject) {
      const regex = likeToRegex(String(params[Number(subject[1]) - 1]))
      rows = rows.filter((row) => regex.test(row.subject))
    }
    const id = /"id" = \$(\d+)/.exec(sql)
    if (id) {
      const want = Number(params[Number(id[1]) - 1])
      rows = rows.filter((row) => row.id === want)
    }
    return rows
  }

  select() {
    return {
      from: () => ({
        where: (where: SQL | undefined) => {
          const matched = this.filter(where)
          const limit = async (n: number) => matched.slice(0, n).map((row) => ({ ...row }))
          return { orderBy: () => ({ limit }), limit }
        },
      }),
    }
  }

  insert() {
    return {
      values: (v: Partial<FactRow>) => ({
        returning: async () => {
          const row: FactRow = {
            id: this.nextId++,
            subject: v.subject ?? '',
            category: v.category ?? 'general',
            fact: v.fact ?? '',
            active: v.active ?? true,
            source: v.source ?? 'chat',
            createdAt: new Date(),
            updatedAt: new Date(),
          }
          this.rows.push(row)
          return [{ ...row }]
        },
      }),
    }
  }

  update() {
    return {
      set: (patch: Partial<FactRow>) => ({
        where: (where: SQL | undefined) => ({
          returning: async () => {
            const matched = this.filter(where)
            for (const row of matched) Object.assign(row, patch)
            return matched.map((row) => ({ ...row }))
          },
        }),
      }),
    }
  }
}

/* ──────────────────────────────── the tests ──────────────────────────────── */

const memorySave = memoryTools.find((t: ToolDef) => t.name === 'memory_save')
if (!memorySave) throw new Error('memory_save is not registered')

const ctx: ToolContext = { chatId: '42', actor: 'Alex', origin: 'agent' }

let fake: FakeMemoryDb

beforeEach(() => {
  fake = new FakeMemoryDb()
  dbRef.current = fake
  auditMock.mockClear()
})

async function save(subject: string, fact: string, category = 'general') {
  const result = await memorySave.handler({ subject, fact, category }, ctx)
  expect(result.isError).not.toBe(true)
  return result.structuredContent as { action: string; fact: { id: number; fact: string } }
}

describe('factSimilarity — the merge bar', () => {
  it('scores restatements at or above the 0.9 merge bar', () => {
    expect(factSimilarity('Wears size 10 shoes', 'Wears size 10 shoes')).toBe(1)
    // Same sentence around a different number: the number is the update.
    expect(factSimilarity('Wears size 10 shoes', 'Wears size 11 shoes')).toBeGreaterThanOrEqual(0.9)
    expect(factSimilarity('Dinner is at 6pm', 'Dinner is at 6:30pm')).toBeGreaterThanOrEqual(0.9)
    // One fact extending the other is a restatement, not a second fact.
    expect(
      factSimilarity('Allergic to peanuts', 'Allergic to peanuts and tree nuts'),
    ).toBeGreaterThanOrEqual(0.9)
  })

  it('scores genuinely different facts below the merge bar', () => {
    // Two allergies for the same child are two facts.
    expect(factSimilarity('Allergic to peanuts', 'Allergic to penicillin')).toBeLessThan(0.9)
    expect(factSimilarity('Allergic to peanuts', 'Allergic to dairy')).toBeLessThan(0.9)
    // Two kids under a shared subject must both survive.
    expect(
      factSimilarity('Maya is allergic to peanuts', 'Leo is allergic to eggs'),
    ).toBeLessThan(0.9)
    expect(
      factSimilarity('Maya goes to bed at 8pm', 'Leo goes to bed at 7pm'),
    ).toBeLessThan(0.9)
    // One changed content word is a different fact, not a restatement.
    expect(
      factSimilarity('Trash goes out on Tuesday', 'Recycling goes out on Tuesday'),
    ).toBeLessThan(0.9)
    expect(factSimilarity('Maya likes skiing', 'Maya likes swimming')).toBeLessThan(0.9)
  })
})

describe('memory_save — two kids, two allergies', () => {
  it("keeps a second child's allergy instead of overwriting the first", async () => {
    const first = await save('Maya', 'Allergic to peanuts', 'medical')
    expect(first.action).toBe('created')

    const second = await save('Leo', 'Allergic to eggs', 'medical')
    expect(second.action).toBe('created')

    expect(fake.rows).toHaveLength(2)
    expect(fake.rows.map((row) => `${row.subject}: ${row.fact}`)).toEqual([
      'Maya: Allergic to peanuts',
      'Leo: Allergic to eggs',
    ])
  })

  it('keeps two different allergies for the same child', async () => {
    await save('Maya', 'Allergic to peanuts', 'medical')
    const second = await save('Maya', 'Allergic to penicillin', 'medical')
    expect(second.action).toBe('created')
    expect(fake.rows).toHaveLength(2)
    expect(fake.rows.every((row) => row.active)).toBe(true)
  })

  it('never merges across subjects, even when the wording is identical', async () => {
    await save('Maya', 'Bedtime is 8pm')
    const second = await save('Leo', 'Bedtime is 8pm')
    // factSimilarity scores this pair 1.0 — only the subject scoping of the
    // dedupe lookup keeps Leo's bedtime from overwriting Maya's row.
    expect(second.action).toBe('created')
    expect(fake.rows).toHaveLength(2)
  })

  it('updates in place when the same fact is restated with a new number', async () => {
    await save('Maya', 'Wears size 10 shoes')
    const second = await save('Maya', 'Wears size 11 shoes')
    expect(second.action).toBe('updated')
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0]?.fact).toBe('Wears size 11 shoes')
  })

  it('matches the subject case-insensitively when deduplicating', async () => {
    await save('maya', 'Wears size 10 shoes')
    const second = await save('Maya', 'Wears size 11 shoes')
    expect(second.action).toBe('updated')
    expect(fake.rows).toHaveLength(1)
  })

  it('does not resurrect or compare against forgotten facts', async () => {
    await save('Maya', 'Wears size 10 shoes')
    const row = fake.rows[0]
    if (!row) throw new Error('expected a stored row')
    row.active = false
    const second = await save('Maya', 'Wears size 11 shoes')
    expect(second.action).toBe('created')
    expect(fake.rows).toHaveLength(2)
    expect(fake.rows[0]?.active).toBe(false)
  })
})
