/**
 * Spend reporting and the daily budget alert.
 *
 * Two halves, deliberately:
 *
 *  - `rollupCosts` / `formatCostReport` are pure, so the aggregation is checked
 *    against a fixed fixture with a fixed `now`. No mocks, no clock, no drift.
 *  - `checkDailyBudget` is checked against a small in-memory Postgres stand-in
 *    that evaluates the real where-clauses through drizzle's own dialect. The
 *    audit module is NOT mocked: the cooldown row the first alert writes is the
 *    same row the second call reads back, which is the only honest way to prove
 *    "exactly once".
 */
import { getTableColumns, getTableName } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { DateTime } from 'luxon'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as dbSchema from '../src/db/schema.js'

/* ────────────────────────────── the fake database ────────────────────────── */

const dialect = new PgDialect()
type Row = Record<string, unknown>

interface TableInfo {
  name: string
  /** `created_at` -> `createdAt` */
  nameToKey: Record<string, string>
}

const tableInfoCache = new Map<unknown, TableInfo>()

function tableInfo(table: unknown): TableInfo {
  const cached = tableInfoCache.get(table)
  if (cached) return cached
  const columns = getTableColumns(table as any)
  const nameToKey: Record<string, string> = {}
  for (const [key, column] of Object.entries(columns)) {
    nameToKey[(column as { name: string }).name] = key
  }
  const built: TableInfo = { name: getTableName(table as any), nameToKey }
  tableInfoCache.set(table, built)
  return built
}

/**
 * Line up the two sides of a comparison.
 *
 * Drizzle renders a `Date` parameter through the column's `mapToDriverValue`,
 * which for a `timestamp` column hands back an ISO string. Comparing that
 * against the stored `Date` without coercion silently yields NaN, and every
 * time-windowed query quietly returns nothing — so both sides become epoch
 * milliseconds whenever either one is a date.
 */
function align(rawLeft: unknown, rawRight: unknown): [unknown, unknown] {
  const dateish = (v: unknown): boolean =>
    v instanceof Date || (typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /\d{4}-\d{2}-\d{2}/.test(v))
  if (!dateish(rawLeft) && !dateish(rawRight)) return [rawLeft, rawRight]
  const toMs = (v: unknown): unknown => {
    if (v instanceof Date) return v.getTime()
    if (typeof v === 'string') {
      const t = Date.parse(v)
      return Number.isNaN(t) ? v : t
    }
    return v
  }
  return [toMs(rawLeft), toMs(rawRight)]
}

function stripOuterParens(text: string): string {
  let s = text.trim()
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0
    let wraps = true
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] === '(') depth += 1
      else if (s[i] === ')') depth -= 1
      if (depth === 0 && i < s.length - 1) {
        wraps = false
        break
      }
    }
    if (!wraps) break
    s = s.slice(1, -1).trim()
  }
  return s
}

function literal(token: string, params: unknown[]): unknown {
  const t = token.trim()
  if (/^\$\d+$/.test(t)) return params[Number(t.slice(1)) - 1]
  if (t === 'null') return null
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  const quoted = /^'(.*)'$/.exec(t)
  if (quoted) return quoted[1]
  throw new Error(`fake db: unsupported SQL literal ${token}`)
}

const CLAUSE = /^"(\w+)"\."(\w+)"\s+(=|<>|!=|>=|<=|>|<)\s+(.+)$/

function matches(where: SQL | undefined, row: Row, info: TableInfo): boolean {
  if (!where) return true
  const query = dialect.sqlToQuery(where)
  const params = query.params as unknown[]
  return stripOuterParens(query.sql)
    .split(/\s+and\s+/i)
    .every((raw) => {
      const m = CLAUSE.exec(raw.trim())
      if (!m) throw new Error(`fake db: unsupported clause "${raw}"`)
      const [, table, column, op, rhs] = m
      if (table !== info.name) throw new Error(`fake db: unexpected table ${table}`)
      const key = info.nameToKey[column ?? '']
      if (!key) throw new Error(`fake db: unknown column ${column}`)
      const [left, right] = align(row[key], literal(rhs ?? '', params))
      switch (op) {
        case '=':
          return left === right
        case '<>':
        case '!=':
          return left !== right
        case '>':
          return Number(left) > Number(right)
        case '<':
          return Number(left) < Number(right)
        case '>=':
          return Number(left) >= Number(right)
        case '<=':
          return Number(left) <= Number(right)
        default:
          throw new Error(`fake db: unsupported operator ${op}`)
      }
    })
}

function project(row: Row, selection: Record<string, unknown> | undefined, info: TableInfo): Row {
  if (!selection) return { ...row }
  const out: Row = {}
  for (const [alias, column] of Object.entries(selection)) {
    const name = (column as { name?: string }).name
    const key = name ? info.nameToKey[name] : undefined
    if (!key) throw new Error(`fake db: cannot map selected field ${alias}`)
    out[alias] = row[key]
  }
  return out
}

class FakeDb {
  rows = new Map<string, Row[]>()
  private nextId = 1

  all(table: unknown): Row[] {
    const info = tableInfo(table)
    return this.rows.get(info.name) ?? []
  }

  seed(table: unknown, values: Row): Row {
    const info = tableInfo(table)
    const stored: Row = { id: this.nextId++, ...values }
    const list = this.rows.get(info.name) ?? []
    list.push(stored)
    this.rows.set(info.name, list)
    return stored
  }

  insert(table: unknown) {
    return {
      values: (values: Row) => {
        const info = tableInfo(table)
        const stored: Row = { id: this.nextId++, ts: new Date(), ...values }
        // A column the caller left undefined stays undefined, not overwritten.
        for (const [key, value] of Object.entries(values)) {
          if (value === undefined) delete stored[key]
        }
        const list = this.rows.get(info.name) ?? []
        list.push(stored)
        this.rows.set(info.name, list)
        return Promise.resolve([stored])
      },
    }
  }

  select(fields?: Record<string, unknown>) {
    return {
      from: (table: unknown) => {
        const info = tableInfo(table)
        let where: SQL | undefined
        let limit: number | undefined

        const run = (): Row[] => {
          let hit = (this.rows.get(info.name) ?? []).filter((row) => matches(where, row, info))
          if (limit !== undefined) hit = hit.slice(0, limit)
          return hit.map((row) => project(row, fields, info))
        }

        const builder: Record<string, unknown> = {}
        const api = Object.assign(builder, {
          then<A, B>(
            onOk?: ((rows: Row[]) => A | PromiseLike<A>) | null,
            onErr?: ((reason: unknown) => B | PromiseLike<B>) | null,
          ) {
            return Promise.resolve().then(run).then(onOk ?? undefined, onErr ?? undefined)
          },
        })
        Object.assign(builder, {
          where: (w?: SQL) => {
            where = w
            return api
          },
          orderBy: () => api,
          limit: (n: number) => {
            limit = n
            return api
          },
        })
        return api as typeof api & Record<string, (...args: never[]) => unknown>
      },
    }
  }
}

/* ────────────────────────────────── mocks ────────────────────────────────── */

const { dbRef, cfgRef, sendToAll } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  cfgRef: {
    current: {
      HOUSEHOLD_TIMEZONE: 'America/Los_Angeles',
      DAILY_BUDGET_ALERT_USD: 5,
    } as Record<string, unknown>,
  },
  sendToAll: vi.fn(async () => {}),
}))

vi.mock('../src/db/client.js', async () => {
  const schema = await import('../src/db/schema.js')
  return { getDb: () => dbRef.current, schema }
})
vi.mock('../src/config.js', () => ({ getConfig: () => cfgRef.current }))
vi.mock('../src/telegram/send.js', () => ({ sendToAll }))
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

const {
  BUDGET_ALERT_KEY,
  WATCHDOG_ALERT_EVENT,
  checkDailyBudget,
  formatCostReport,
  rollupCosts,
} = await import('../src/ops/cost.js')

type TurnCostRow = Parameters<typeof rollupCosts>[0][number]

/* ──────────────────────────────── the fixture ────────────────────────────── */

const ZONE = 'America/Los_Angeles'

/** A local wall-clock time in the household zone, as a real Date. */
const at = (iso: string): Date => {
  const dt = DateTime.fromISO(iso, { zone: ZONE })
  if (!dt.isValid) throw new Error(`bad fixture time ${iso}`)
  return dt.toJSDate()
}

/** Monday 31 August 2026, 18:00 in the household zone. */
const NOW = at('2026-08-31T18:00:00')

function turn(over: Partial<TurnCostRow> & { ts: Date }): TurnCostRow {
  return {
    model: 'claude-sonnet-5',
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    durationMs: 1000,
    numTurns: 1,
    trigger: 'chat',
    ok: true,
    ...over,
  }
}

/**
 * Three days: Sat 29th, Sun 30th, Mon 31st. One row deliberately sits a day
 * before the window opens, and must not be counted anywhere.
 */
const FIXTURE: TurnCostRow[] = [
  turn({ ts: at('2026-08-28T12:00:00'), trigger: 'chat', costUsd: 9.99 }), // outside
  turn({ ts: at('2026-08-29T09:00:00'), trigger: 'chat', costUsd: 0.1, inputTokens: 2000 }),
  turn({ ts: at('2026-08-29T20:00:00'), trigger: 'cron', costUsd: 0.2, outputTokens: 400 }),
  turn({ ts: at('2026-08-30T07:00:00'), trigger: 'chat', costUsd: 0.3, cacheReadTokens: 5000 }),
  turn({ ts: at('2026-08-31T07:00:00'), trigger: 'cron', costUsd: 0.05 }),
  turn({
    ts: at('2026-08-31T12:00:00'),
    trigger: 'watcher',
    costUsd: 0.45,
    ok: false,
    model: 'claude-haiku-4-5',
    numTurns: 4,
    durationMs: 21_500,
  }),
]

const near = (value: number, expected: number): void => {
  expect(Math.abs(value - expected)).toBeLessThan(1e-6)
}

/* ═══════════════════════════════ aggregation ══════════════════════════════ */

describe('rollupCosts', () => {
  it('totals only the turns inside the window', () => {
    const rollup = rollupCosts(FIXTURE, { days: 3, zone: ZONE, now: NOW })

    near(rollup.totalUsd, 1.1)
    expect(rollup.turns).toBe(5)
    expect(rollup.failed).toBe(1)
    expect(rollup.from).toBe('2026-08-29')
    expect(rollup.to).toBe('2026-08-31')
    // 9.99 belongs to the 28th and must not leak into the average.
    near(rollup.dailyAverageUsd, 1.1 / 3)
  })

  it('groups spend by day, including the days nothing happened', () => {
    const rollup = rollupCosts(FIXTURE, { days: 5, zone: ZONE, now: NOW })

    expect(rollup.byDay.map((d) => d.day)).toEqual([
      '2026-08-27',
      '2026-08-28',
      '2026-08-29',
      '2026-08-30',
      '2026-08-31',
    ])
    const byDay = new Map(rollup.byDay.map((d) => [d.day, d]))
    expect(byDay.get('2026-08-27')).toMatchObject({ usd: 0, turns: 0 })
    near(byDay.get('2026-08-28')?.usd ?? -1, 9.99)
    near(byDay.get('2026-08-29')?.usd ?? -1, 0.3)
    expect(byDay.get('2026-08-29')?.turns).toBe(2)
    near(byDay.get('2026-08-30')?.usd ?? -1, 0.3)
    near(byDay.get('2026-08-31')?.usd ?? -1, 0.5)
    expect(byDay.get('2026-08-31')?.failed).toBe(1)
  })

  it('groups spend by trigger, most expensive first, with a share of the total', () => {
    const rollup = rollupCosts(FIXTURE, { days: 3, zone: ZONE, now: NOW })

    expect(rollup.byTrigger.map((t) => t.trigger)).toEqual(['watcher', 'chat', 'cron'])
    const byTrigger = new Map(rollup.byTrigger.map((t) => [t.trigger, t]))
    near(byTrigger.get('chat')?.usd ?? -1, 0.4)
    expect(byTrigger.get('chat')?.turns).toBe(2)
    near(byTrigger.get('cron')?.usd ?? -1, 0.25)
    near(byTrigger.get('watcher')?.usd ?? -1, 0.45)
    expect(byTrigger.get('watcher')?.failed).toBe(1)
    near(byTrigger.get('watcher')?.share ?? -1, 0.45 / 1.1)

    const shares = rollup.byTrigger.reduce((sum, t) => sum + t.share, 0)
    near(shares, 1)
  })

  it('names the priciest turns and the busiest day', () => {
    const rollup = rollupCosts(FIXTURE, { days: 3, zone: ZONE, now: NOW })

    expect(rollup.topTurns[0]).toMatchObject({
      day: '2026-08-31',
      time: '12:00',
      trigger: 'watcher',
      model: 'claude-haiku-4-5',
      ok: false,
    })
    near(rollup.topTurns[0]?.usd ?? -1, 0.45)
    expect(rollup.busiestDay?.day).toBe('2026-08-31')
  })

  it('reports an empty window without inventing turns', () => {
    const rollup = rollupCosts([], { days: 7, zone: ZONE, now: NOW })
    expect(rollup.turns).toBe(0)
    expect(rollup.totalUsd).toBe(0)
    expect(rollup.byTrigger).toEqual([])
    expect(rollup.busiestDay).toBeNull()
    expect(formatCostReport(rollup)).toContain('No model turns in that window')
  })
})

describe('formatCostReport', () => {
  it('renders the day and trigger breakdowns as readable plain text', () => {
    const text = formatCostReport(rollupCosts(FIXTURE, { days: 3, zone: ZONE, now: NOW }))

    expect(text).toContain('$1.10 over 5 turns, 1 failed.')
    expect(text).toContain('By day')
    expect(text).toContain('Sat 29 Aug')
    expect(text).toContain('Mon 31 Aug')
    expect(text).toContain('By trigger')
    expect(text).toMatch(/watcher\s+\$0\.45\s+41%/)
    expect(text).toContain('Top spenders')
    // Never MarkdownV2: the caller sends this with markdown off.
    expect(text).not.toContain('\\')
  })
})

/* ══════════════════════════════ daily budget ══════════════════════════════ */

function auditAlerts(fake: FakeDb): Row[] {
  return fake
    .all(dbSchema.auditLog)
    .filter((r) => r.event === WATCHDOG_ALERT_EVENT && r.toolName === BUDGET_ALERT_KEY)
}

describe('checkDailyBudget', () => {
  let fake: FakeDb

  beforeEach(() => {
    fake = new FakeDb()
    dbRef.current = fake
    cfgRef.current = { HOUSEHOLD_TIMEZONE: ZONE, DAILY_BUDGET_ALERT_USD: 5 }
    sendToAll.mockClear()
    fake.seed(dbSchema.households, { timezone: ZONE })
  })

  const spendToday = (usd: number, trigger = 'chat'): void => {
    fake.seed(dbSchema.turnMetrics, {
      ts: new Date(),
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: usd,
      durationMs: 500,
      numTurns: 1,
      trigger,
      ok: true,
    })
  }

  it('stays quiet below the alert line', async () => {
    spendToday(2)
    spendToday(1.5)

    await checkDailyBudget()

    expect(sendToAll).not.toHaveBeenCalled()
    expect(auditAlerts(fake)).toHaveLength(0)
  })

  it('alerts exactly once per day, however often it is called', async () => {
    spendToday(4, 'chat')
    spendToday(2.2, 'cron')

    await checkDailyBudget()
    await checkDailyBudget()
    await checkDailyBudget()

    expect(sendToAll).toHaveBeenCalledTimes(1)
    // The cooldown row is what makes the second and third calls no-ops.
    expect(auditAlerts(fake)).toHaveLength(1)

    const [text] = sendToAll.mock.calls[0] as unknown as [string]
    expect(text).toContain('$6.20')
    expect(text).toContain('$5.00')
    expect(text).toContain('chat')
  })

  it('records the cooldown before it speaks, so a failed send does not re-alert', async () => {
    sendToAll.mockRejectedValueOnce(new Error('telegram is down'))
    spendToday(9)

    await checkDailyBudget()
    await checkDailyBudget()

    expect(sendToAll).toHaveBeenCalledTimes(1)
    expect(auditAlerts(fake)).toHaveLength(1)
  })

  it('does nothing when the alert line is switched off', async () => {
    cfgRef.current = { HOUSEHOLD_TIMEZONE: ZONE, DAILY_BUDGET_ALERT_USD: 0 }
    spendToday(50)

    await checkDailyBudget()

    expect(sendToAll).not.toHaveBeenCalled()
    expect(auditAlerts(fake)).toHaveLength(0)
  })
})
