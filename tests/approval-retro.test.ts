/**
 * The approval retrospective — the thing that notices "you keep saying no to
 * the same kind of proposal" and says so in a sentence a person would say.
 *
 * `rollupRejections` and `describeRejections` are pure, so almost everything
 * here is a fixture in, a sentence out. One test drives `approvalRetro` through
 * a stub handle to prove the query wiring, not the SQL.
 */
import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as dbSchema from '../src/db/schema.js'

/* ────────────────────────────────── mocks ────────────────────────────────── */

const { dbRef, cfgRef } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  cfgRef: {
    current: { HOUSEHOLD_TIMEZONE: 'America/Los_Angeles', DAILY_BUDGET_ALERT_USD: 5 } as Record<
      string,
      unknown
    >,
  },
}))

vi.mock('../src/db/client.js', async () => {
  const schema = await import('../src/db/schema.js')
  return { getDb: () => dbRef.current, schema }
})
vi.mock('../src/config.js', () => ({ getConfig: () => cfgRef.current }))
vi.mock('../src/telegram/send.js', () => ({ sendToAll: vi.fn(async () => {}) }))
vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const l: Record<string, unknown> = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  }
  l.child = () => l
  return { logger: l, child: () => l }
})

const { approvalRetro, describeRejections, rollupRejections, traitsOf } = await import(
  '../src/ops/cost.js'
)

type RetroInputRow = Parameters<typeof rollupRejections>[0][number]

/* ──────────────────────────── a table-aware stub ─────────────────────────── */

type Row = Record<string, unknown>

function query(rows: Row[]): Record<string, unknown> {
  const api: Record<string, unknown> = {}
  Object.assign(api, {
    where: () => api,
    orderBy: () => api,
    limit: (n: number) => query(rows.slice(0, n)),
    then<A, B>(
      onOk?: ((value: Row[]) => A | PromiseLike<A>) | null,
      onErr?: ((reason: unknown) => B | PromiseLike<B>) | null,
    ) {
      return Promise.resolve(rows).then(onOk ?? undefined, onErr ?? undefined)
    },
  })
  return api
}

/** Answers each table with whatever the test put there. Filtering is not the subject here. */
class StubDb {
  constructor(private readonly data: Record<string, Row[]>) {}
  select(_fields?: unknown) {
    return {
      from: (table: unknown) => query(this.data[getTableName(table as never)] ?? []),
    }
  }
}

/* ─────────────────────────────── the fixture ─────────────────────────────── */

const ZONE = 'America/Los_Angeles'

/**
 * September 2026: the 5th and the 12th are Saturdays, the 6th is a Sunday, the
 * 9th is a Wednesday. Three early-weekend calendar proposals were rejected; the
 * midweek afternoon one was approved.
 */
function row(over: Partial<RetroInputRow>): RetroInputRow {
  return {
    toolName: 'calendar_create_event',
    category: 'calendar_write',
    status: 'rejected',
    humanSummary: 'Add an event',
    argsJson: {},
    requestedBy: 'Alex',
    origin: 'agent',
    createdAt: new Date('2026-09-01T12:00:00Z'),
    ...over,
  }
}

const CALENDAR_AND_EMAIL: RetroInputRow[] = [
  row({
    humanSummary: 'Add "Soccer practice" Sat 5 Sep, 7:30am',
    argsJson: {
      title: 'Soccer practice',
      start: '2026-09-05T07:30:00-07:00',
      end: '2026-09-05T09:00:00-07:00',
    },
  }),
  row({
    humanSummary: 'Add "Swim lesson" Sun 6 Sep, 8:00am',
    argsJson: { title: 'Swim lesson', start: '2026-09-06T08:00:00-07:00' },
  }),
  row({
    humanSummary: 'Add "Early run" Sat 12 Sep, 6:45am',
    argsJson: { title: 'Early run', start: '2026-09-12T06:45:00-07:00' },
  }),
  row({
    status: 'approved',
    humanSummary: 'Add "Dentist" Wed 9 Sep, 2:00pm',
    argsJson: { title: 'Dentist', start: '2026-09-09T14:00:00-07:00' },
  }),
  row({
    toolName: 'gmail_send',
    category: 'email_send',
    status: 'rejected',
    requestedBy: 'Sam',
    humanSummary: 'Reply to the PTA about the bake sale',
    argsJson: { to: 'office@maplewood-pta.org', subject: 'Re: bake sale' },
  }),
  row({
    toolName: 'gmail_send',
    category: 'email_send',
    status: 'approved',
    requestedBy: 'Sam',
    humanSummary: 'Email Nan about Sunday',
    argsJson: { to: 'gran@example.com', subject: 'Sunday' },
  }),
]

const summarise = (rows: RetroInputRow[], days = 30) =>
  rollupRejections(rows, { days, zone: ZONE })

/* ═══════════════════════════════ trait reading ════════════════════════════ */

describe('traitsOf', () => {
  const keys = (r: RetroInputRow): string[] => traitsOf(r, ZONE).map((t) => t.key).sort()

  it('reads the hour and the day out of a datetime argument', () => {
    expect(keys(row({ argsJson: { start: '2026-09-05T07:30:00-07:00' } }))).toEqual([
      'actor:Alex',
      'day:weekend',
      'hour:early',
      'tool:calendar_create_event',
    ])
  })

  it('claims no hour from a date-only argument', () => {
    const found = keys(row({ argsJson: { date: '2026-09-05' } }))
    expect(found).toContain('day:weekend')
    expect(found.some((k) => k.startsWith('hour:'))).toBe(false)
  })

  it('reads camelCase and snake_case time keys alike', () => {
    expect(keys(row({ argsJson: { startTime: '2026-09-09T22:15:00-07:00' } }))).toContain('hour:late')
    expect(keys(row({ argsJson: { due_date: '2026-09-09T18:00:00-07:00' } }))).toContain('hour:evening')
  })

  it('reduces a recipient to its domain and flags watcher-proposed work', () => {
    const found = keys(row({ origin: 'watcher', argsJson: { to: 'Office@Maplewood-PTA.org' } }))
    expect(found).toContain('to:maplewood-pta.org')
    expect(found).toContain('origin:watcher')
  })

  it('survives a hostile or cyclic payload without throwing', () => {
    const cyclic: Record<string, unknown> = { title: 'loop' }
    cyclic.self = cyclic
    expect(() => traitsOf(row({ argsJson: cyclic }), ZONE)).not.toThrow()
  })
})

/* ═════════════════════════════════ grouping ═══════════════════════════════ */

describe('rollupRejections', () => {
  it('groups by category and counts against everything proposed', () => {
    const summary = summarise(CALENDAR_AND_EMAIL)

    expect(summary.proposed).toBe(6)
    expect(summary.rejected).toBe(4)
    expect(summary.groups.map((g) => g.category)).toEqual(['calendar_write', 'email_send'])

    const calendar = summary.groups[0]
    expect(calendar?.rejected).toBe(3)
    expect(calendar?.proposed).toBe(4)
    expect(calendar?.noun).toBe('calendar')
    expect(calendar?.tools).toEqual([{ tool: 'calendar_create_event', rejected: 3 }])
  })

  it('finds the trait every rejection shares', () => {
    const calendar = summarise(CALENDAR_AND_EMAIL).groups[0]
    const shared = (calendar?.sharedTraits ?? []).map((t) => t.key)

    expect(shared).toContain('hour:early')
    expect(shared).toContain('day:weekend')
    // The approved midweek afternoon event must not dilute the pattern.
    expect(shared).not.toContain('day:weekday')
    expect(calendar?.commonTraits).toEqual([])
  })

  it('separates a majority trait from a universal one', () => {
    const mixed = summarise([
      row({ argsJson: { start: '2026-09-05T07:30:00-07:00' } }),
      row({ argsJson: { start: '2026-09-06T08:00:00-07:00' } }),
      // Same weekend pattern, but a reasonable hour.
      row({ argsJson: { start: '2026-09-12T11:00:00-07:00' } }),
    ])
    const calendar = mixed.groups[0]
    expect((calendar?.sharedTraits ?? []).map((t) => t.key)).toContain('day:weekend')
    expect((calendar?.commonTraits ?? []).map((t) => t.key)).toContain('hour:early')
  })

  it('keeps a couple of examples so the household recognises what is meant', () => {
    const calendar = summarise(CALENDAR_AND_EMAIL).groups[0]
    expect(calendar?.examples).toEqual([
      'Add "Soccer practice" Sat 5 Sep, 7:30am',
      'Add "Swim lesson" Sun 6 Sep, 8:00am',
    ])
  })
})

/* ═════════════════════════════════ the words ══════════════════════════════ */

describe('describeRejections', () => {
  it('describes the pattern in a sentence a person would say', () => {
    const text = describeRejections(summarise(CALENDAR_AND_EMAIL, 7))

    expect(text).toContain('the last 7 days')
    expect(text).toContain('You rejected 4 of 6 proposals.')
    expect(text).toContain('3 of 4 calendar proposals were rejected (calendar_create_event).')
    expect(text).toContain('Every one was before 9am, on a weekend')
    expect(text).toContain('1 of 2 email proposals was rejected (gmail_send).')
    expect(text).toContain('It was addressed to maplewood-pta.org')
    expect(text).toContain('Add "Soccer practice" Sat 5 Sep, 7:30am')
    // The whole point: it ends by offering the two ways to stop being asked.
    expect(text).toContain('/rules add')
    expect(text).toContain('/improve')
  })

  it('says so plainly when the rejections have nothing in common', () => {
    const text = describeRejections(
      summarise([
        row({
          toolName: 'browser_buy',
          category: 'purchase',
          requestedBy: 'Alex',
          humanSummary: 'Buy batteries',
          argsJson: { item: 'batteries', amountUsd: 12 },
        }),
        row({
          toolName: 'shop_order',
          category: 'purchase',
          requestedBy: 'Sam',
          humanSummary: 'Buy a lamp',
          argsJson: { item: 'a lamp', amountUsd: 40 },
        }),
      ]),
    )

    expect(text).toContain('2 of 2 purchase proposals were rejected')
    expect(text).toContain('No pattern I can see')
    // No pattern means no suggestion to write a rule about it.
    expect(text).not.toContain('/rules add')
  })

  it('reports an unblemished week without inventing a lesson', () => {
    const text = describeRejections(
      summarise([row({ status: 'approved' }), row({ status: 'executed' })]),
    )
    expect(text).toContain('You approved everything I asked about — 2 proposals.')
    expect(text).not.toContain('rejected')
  })

  it('says nothing happened when nothing was proposed', () => {
    const text = describeRejections(summarise([]))
    expect(text).toContain('I did not put a single approval in front of you')
  })
})

/* ═══════════════════════════════ the wiring ═══════════════════════════════ */

describe('approvalRetro', () => {
  beforeEach(() => {
    cfgRef.current = { HOUSEHOLD_TIMEZONE: ZONE, DAILY_BUDGET_ALERT_USD: 5 }
  })

  it('reads pending_actions and returns the description', async () => {
    dbRef.current = new StubDb({
      households: [{ timezone: ZONE }],
      pending_actions: CALENDAR_AND_EMAIL as unknown as Row[],
    })

    const text = await approvalRetro(14)

    expect(text).toContain('the last 14 days')
    expect(text).toContain('3 of 4 calendar proposals were rejected')
  })

  it('says so rather than throwing when the database is unavailable', async () => {
    dbRef.current = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => Promise.reject(new Error('connection refused')),
          }),
        }),
      }),
    }

    await expect(approvalRetro(7)).resolves.toContain('could not read the approval history')
  })
})
