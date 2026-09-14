/**
 * The `/setup` state machine, driven through a full scripted conversation.
 *
 * Postgres is replaced by an in-memory stand-in that renders every `where`
 * clause the wizard builds with drizzle's own `PgDialect` and evaluates the
 * rendered SQL against the stored rows. That matters: if the wizard stopped
 * scoping a lookup to the right subject, or stopped keying `setup_state` by
 * chat, these tests would see it rather than quietly passing.
 */
import { getTableColumns, getTableName } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../src/db/schema.js'

process.env.NODE_ENV = 'test'
process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.DATABASE_URL = 'postgres://localhost/test'
process.env.APP_URL = 'https://example.test'
process.env.APP_SECRET = 'x'.repeat(48)
process.env.TELEGRAM_BOT_TOKEN = 'test:token'
process.env.TELEGRAM_WEBHOOK_SECRET = 'webhook-secret'
process.env.TELEGRAM_USER_ID_1 = '1001'
process.env.TELEGRAM_USER_ID_2 = '1002'
process.env.HOUSEHOLD_TIMEZONE = 'America/Los_Angeles'

/* ─────────────────────────── in-memory drizzle fake ──────────────────────── */

const dialect = new PgDialect()

type Row = Record<string, unknown>
// The tables are drizzle objects; the fake only ever reads their metadata.
type AnyTable = Parameters<typeof getTableColumns>[0]

function columnKeys(table: AnyTable): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, col] of Object.entries(getTableColumns(table))) {
    out.set((col as { name: string }).name, key)
  }
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function ilikeMatch(value: unknown, pattern: unknown): boolean {
  if (typeof value !== 'string' || typeof pattern !== 'string') return false
  let re = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '\\') {
      i += 1
      re += escapeRe(pattern[i] ?? '')
      continue
    }
    if (char === '%') {
      re += '.*'
      continue
    }
    if (char === '_') {
      re += '.'
      continue
    }
    re += escapeRe(char ?? '')
  }
  return new RegExp(`^${re}$`, 'is').test(value)
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

function splitTop(expr: string, op: string): string[] {
  const parts: string[] = []
  const lower = expr.toLowerCase()
  let depth = 0
  let quoted = false
  let last = 0
  for (let i = 0; i < expr.length; i += 1) {
    const char = expr[i]
    if (char === "'") {
      quoted = !quoted
      continue
    }
    if (quoted) continue
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (depth === 0 && lower.startsWith(op, i)) {
      parts.push(expr.slice(last, i))
      i += op.length - 1
      last = i + 1
    }
  }
  parts.push(expr.slice(last))
  return parts.map((p) => p.trim()).filter((p) => p !== '')
}

function literalOf(token: string, params: unknown[]): unknown {
  const t = token.trim()
  if (/^\$\d+$/.test(t)) return params[Number(t.slice(1)) - 1]
  if (t === 'now()') return new Date()
  if (t === 'null') return null
  if (t === 'true') return true
  if (t === 'false') return false
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'")
  const asNumber = Number(t)
  return Number.isNaN(asNumber) ? t : asNumber
}

function comparable(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value
}

function evalExpr(expr: string, params: unknown[], row: Row, keys: Map<string, string>): boolean {
  const s = stripOuterParens(expr)

  const orParts = splitTop(s, ' or ')
  if (orParts.length > 1) return orParts.some((p) => evalExpr(p, params, row, keys))
  const andParts = splitTop(s, ' and ')
  if (andParts.length > 1) return andParts.every((p) => evalExpr(p, params, row, keys))

  const read = (dbName: string): unknown => {
    const key = keys.get(dbName)
    return key === undefined ? undefined : row[key]
  }

  let m = /^"\w+"\."(\w+)"\s+is\s+not\s+null$/i.exec(s)
  if (m) return read(m[1] ?? '') !== null && read(m[1] ?? '') !== undefined

  m = /^"\w+"\."(\w+)"\s+is\s+null$/i.exec(s)
  if (m) return read(m[1] ?? '') === null || read(m[1] ?? '') === undefined

  m = /^"\w+"\."(\w+)"\s+(i?like)\s+(.+)$/i.exec(s)
  if (m) return ilikeMatch(read(m[1] ?? ''), literalOf(m[3] ?? '', params))

  m = /^"\w+"\."(\w+)"\s*(<>|!=|<=|>=|=|<|>)\s*(.+)$/i.exec(s)
  if (m) {
    const left = comparable(read(m[1] ?? ''))
    const right = comparable(literalOf(m[3] ?? '', params))
    switch (m[2]) {
      case '=':
        return left === right
      case '<>':
      case '!=':
        return left !== right
      case '<':
        return (left as number) < (right as number)
      case '>':
        return (left as number) > (right as number)
      case '<=':
        return (left as number) <= (right as number)
      case '>=':
        return (left as number) >= (right as number)
      default:
        return false
    }
  }

  throw new Error(`the fake database cannot evaluate: ${s}`)
}

function matches(table: AnyTable, row: Row, where: SQL | undefined): boolean {
  if (where === undefined) return true
  const query = dialect.sqlToQuery(where)
  return evalExpr(query.sql, query.params, row, columnKeys(table))
}

function cloneValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return new Date(value.getTime())
  return JSON.parse(JSON.stringify(value)) as unknown
}

function cloneRow(row: Row): Row {
  const out: Row = {}
  for (const [key, value] of Object.entries(row)) out[key] = cloneValue(value)
  return out
}

class FakeDb {
  private readonly store = new Map<string, Row[]>()
  private readonly counters = new Map<string, number>()

  rowsOf(table: AnyTable): Row[] {
    const name = getTableName(table)
    let rows = this.store.get(name)
    if (!rows) {
      rows = []
      this.store.set(name, rows)
    }
    return rows
  }

  nextId(table: AnyTable): number {
    const name = getTableName(table)
    const next = (this.counters.get(name) ?? 0) + 1
    this.counters.set(name, next)
    return next
  }

  withDefaults(table: AnyTable, values: Row): Row {
    const out: Row = {}
    for (const [key, raw] of Object.entries(getTableColumns(table))) {
      const col = raw as { primary?: boolean; hasDefault?: boolean; default?: unknown }
      const given = values[key]
      if (given !== undefined) {
        out[key] = cloneValue(given)
        continue
      }
      if (col.primary === true) {
        out[key] = this.nextId(table)
        continue
      }
      if (col.hasDefault === true) {
        const fallback = col.default
        if (fallback !== undefined && typeof fallback === 'object' && fallback !== null && 'queryChunks' in fallback) {
          out[key] = new Date() // defaultNow()
        } else if (fallback !== undefined) {
          out[key] = cloneValue(fallback)
        } else {
          out[key] = null
        }
        continue
      }
      out[key] = null
    }
    return out
  }

  select(fields?: Record<string, unknown>) {
    return new FakeSelect(this, fields)
  }

  insert(table: AnyTable) {
    return new FakeInsert(this, table)
  }

  update(table: AnyTable) {
    return new FakeUpdate(this, table)
  }

  delete(table: AnyTable) {
    return new FakeDelete(this, table)
  }

  /** Test-side reader: every row of a table, cloned. */
  all(table: AnyTable): Row[] {
    return this.rowsOf(table).map(cloneRow)
  }
}

function project(table: AnyTable, row: Row, fields?: Record<string, unknown>): Row {
  if (fields === undefined) return cloneRow(row)
  const keys = columnKeys(table)
  const out: Row = {}
  for (const [alias, col] of Object.entries(fields)) {
    const dbName = (col as { name?: string }).name
    const key = dbName === undefined ? undefined : keys.get(dbName)
    out[alias] = key === undefined ? null : cloneValue(row[key])
  }
  return out
}

class FakeSelect {
  private table: AnyTable | undefined
  private whereSql: SQL | undefined
  private lim: number | undefined

  constructor(
    private readonly db: FakeDb,
    private readonly fields?: Record<string, unknown>,
  ) {}

  from(table: AnyTable): this {
    this.table = table
    return this
  }

  where(where: SQL): this {
    this.whereSql = where
    return this
  }

  /** Rows come back in insertion order, which is serial-id order. */
  orderBy(): this {
    return this
  }

  limit(n: number): this {
    this.lim = n
    return this
  }

  private run(): Row[] {
    const table = this.table
    if (table === undefined) throw new Error('select without from')
    let rows = this.db.rowsOf(table).filter((row) => matches(table, row, this.whereSql))
    if (this.lim !== undefined) rows = rows.slice(0, this.lim)
    return rows.map((row) => project(table, row, this.fields))
  }

  then<T>(resolve: (rows: Row[]) => T, reject?: (err: unknown) => T): Promise<T> {
    try {
      return Promise.resolve(this.run()).then(resolve, reject)
    } catch (err) {
      return Promise.reject(err).then(resolve, reject)
    }
  }
}

type Conflict = { kind: 'update' | 'nothing'; target: unknown; set?: Row }

class FakeInsert {
  private vals: Row[] = []
  private conflict: Conflict | undefined
  private returnFields: Record<string, unknown> | undefined
  private wantsReturn = false

  constructor(
    private readonly db: FakeDb,
    private readonly table: AnyTable,
  ) {}

  values(input: Row | Row[]): this {
    this.vals = Array.isArray(input) ? input : [input]
    return this
  }

  onConflictDoUpdate(cfg: { target: unknown; set: Row }): this {
    this.conflict = { kind: 'update', target: cfg.target, set: cfg.set }
    return this
  }

  onConflictDoNothing(cfg?: { target?: unknown }): this {
    this.conflict = { kind: 'nothing', target: cfg?.target }
    return this
  }

  returning(fields?: Record<string, unknown>): this {
    this.wantsReturn = true
    this.returnFields = fields
    return this
  }

  private targetKeys(): string[] {
    const target = this.conflict?.target
    if (target === undefined) return []
    const cols = Array.isArray(target) ? target : [target]
    const keys = columnKeys(this.table)
    return cols
      .map((col) => keys.get((col as { name?: string }).name ?? ''))
      .filter((k): k is string => k !== undefined)
  }

  private run(): Row[] {
    const rows = this.db.rowsOf(this.table)
    const keys = this.targetKeys()
    const touched: Row[] = []

    for (const value of this.vals) {
      const existing =
        keys.length === 0
          ? undefined
          : rows.find((row) => keys.every((key) => row[key] === value[key]))

      if (existing !== undefined) {
        if (this.conflict?.kind === 'update' && this.conflict.set !== undefined) {
          for (const [key, patch] of Object.entries(this.conflict.set)) {
            existing[key] = cloneValue(patch)
          }
        }
        touched.push(existing)
        continue
      }

      const row = this.db.withDefaults(this.table, value)
      rows.push(row)
      touched.push(row)
    }

    if (!this.wantsReturn) return []
    return touched.map((row) => project(this.table, row, this.returnFields))
  }

  then<T>(resolve: (rows: Row[]) => T, reject?: (err: unknown) => T): Promise<T> {
    try {
      return Promise.resolve(this.run()).then(resolve, reject)
    } catch (err) {
      return Promise.reject(err).then(resolve, reject)
    }
  }
}

class FakeUpdate {
  private patch: Row = {}
  private whereSql: SQL | undefined
  private wantsReturn = false
  private returnFields: Record<string, unknown> | undefined

  constructor(
    private readonly db: FakeDb,
    private readonly table: AnyTable,
  ) {}

  set(patch: Row): this {
    this.patch = patch
    return this
  }

  where(where: SQL): this {
    this.whereSql = where
    return this
  }

  returning(fields?: Record<string, unknown>): this {
    this.wantsReturn = true
    this.returnFields = fields
    return this
  }

  private run(): Row[] {
    const hits = this.db.rowsOf(this.table).filter((row) => matches(this.table, row, this.whereSql))
    for (const row of hits) {
      for (const [key, value] of Object.entries(this.patch)) row[key] = cloneValue(value)
    }
    if (!this.wantsReturn) return []
    return hits.map((row) => project(this.table, row, this.returnFields))
  }

  then<T>(resolve: (rows: Row[]) => T, reject?: (err: unknown) => T): Promise<T> {
    try {
      return Promise.resolve(this.run()).then(resolve, reject)
    } catch (err) {
      return Promise.reject(err).then(resolve, reject)
    }
  }
}

class FakeDelete {
  private whereSql: SQL | undefined

  constructor(
    private readonly db: FakeDb,
    private readonly table: AnyTable,
  ) {}

  where(where: SQL): this {
    this.whereSql = where
    return this
  }

  private run(): Row[] {
    const rows = this.db.rowsOf(this.table)
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i]
      if (row !== undefined && matches(this.table, row, this.whereSql)) rows.splice(i, 1)
    }
    return []
  }

  then<T>(resolve: (rows: Row[]) => T, reject?: (err: unknown) => T): Promise<T> {
    try {
      return Promise.resolve(this.run()).then(resolve, reject)
    } catch (err) {
      return Promise.reject(err).then(resolve, reject)
    }
  }
}

/* ─────────────────────────────────── mocks ───────────────────────────────── */

const { dbRef, sends, auditMock, runTurnMock } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  sends: [] as Array<{ chatId: string; text: string; replyMarkup: unknown }>,
  auditMock: vi.fn(async () => {}),
  runTurnMock: vi.fn(async (_input: unknown) => ({
    text: 'saved',
    sessionId: null as string | null,
    costUsd: 0,
    ok: true,
  })),
}))

vi.mock('../src/db/client.js', async () => {
  const real = await import('../src/db/schema.js')
  return { getDb: () => dbRef.current, schema: real }
})

vi.mock('../src/audit/log.js', () => ({ audit: auditMock }))

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

vi.mock('../src/telegram/send.js', () => ({
  sendToChat: vi.fn(async (chatId: string, text: string, opts?: { replyMarkup?: unknown }) => {
    sends.push({ chatId, text, replyMarkup: opts?.replyMarkup })
    return [sends.length]
  }),
}))

vi.mock('../src/agent/run-turn.js', () => ({ runTurn: runTurnMock }))

const {
  startSetup,
  handleSetupReply,
  isSetupActive,
  cancelSetup,
  setupSummary,
  parseQuietHours,
  parseNames,
  parseSenders,
  parseHour,
  splitMedical,
} = await import('../src/setup/wizard.js')

/* ─────────────────────────────── test harness ────────────────────────────── */

const CHAT = '1001'
const ACTOR = 'Alex'

let db: FakeDb

beforeEach(() => {
  db = new FakeDb()
  dbRef.current = db
  sends.length = 0
  auditMock.mockClear()
  runTurnMock.mockClear()
})

function state(): Row | undefined {
  return db.all(schema.setupState)[0]
}

function stepId(): string {
  return String(state()?.stepId ?? '')
}

function answers(): Record<string, unknown> {
  const raw = state()?.answers
  return raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
}

function lastText(): string {
  return sends[sends.length - 1]?.text ?? ''
}

function facts(): Row[] {
  return db.all(schema.memoryFacts)
}

/** Reply, and assert the wizard consumed it. */
async function reply(text: string): Promise<void> {
  const consumed = await handleSetupReply(CHAT, ACTOR, text)
  expect(consumed).toBe(true)
}

/** The scripted conversation used by the completion tests. */
const SCRIPT: Array<[reply: string, nextStep: string]> = [
  ['Alex, goes by Al; Samantha, goes by Sam', 'assistant_name'],
  ['Chessy', 'address'],
  ['12 Elm Street, Portland OR 97201', 'timezone'],
  ['yes', 'quiet_hours'],
  ['no nags before 7am or after 9pm', 'brief_hour'],
  ['7am', 'kid_name'],
  ['Maya', 'kid_age'],
  ['7', 'kid_allergies'],
  ['Peanuts and tree nuts', 'kid_notes'],
  ['nothing', 'kid_more'],
  ['Add another child', 'kid_name'],
  ['Theo', 'kid_age'],
  ['4', 'kid_allergies'],
  ['none', 'kid_notes'],
  ['Asthma, inhaler kept at school', 'kid_more'],
  ['Done with kids', 'schedules'],
  ['School 08:15-15:00 Mon-Fri\nMaya swimming Tue 16:30', 'contact_pediatrician'],
  ['Dr Moreau, 415-555-0134', 'contact_dentist'],
  ['skip', 'contact_doctor'],
  ['skip', 'contact_plumber'],
  ['skip', 'contact_school'],
  ['skip', 'contact_vet'],
  ['skip', 'contact_restaurants'],
  ['skip', 'contact_sitters'],
  ['skip', 'contact_extra'],
  ['Aunt Bea, emergency contact, 415-555-0999', 'contact_extra'],
  ['done', 'food_defaults'],
  ['yes', 'food_staples'],
  ['pasta, chicken traybake, tacos', 'food_dislikes'],
  ['mushrooms', 'food_allergies'],
  ['none', 'food_stores'],
  ['Trader Joes, Costco', 'food_shopping_days'],
  ['Saturday', 'pref_reservations'],
  ['four of us, 18:00 on weeknights', 'pref_chores'],
  ['Al does bins, Sam does laundry', 'watch_email'],
  ['@brightwheel.com', 'watch_ics'],
  ['skip', 'anything_else'],
  ['We have a dog named Biscuit and the spare key is with the Patels next door.', 'done'],
]

async function runScript(): Promise<void> {
  await startSetup(CHAT, ACTOR)
  for (const [text, expected] of SCRIPT) {
    await reply(text)
    expect(stepId()).toBe(expected)
  }
}

/* ──────────────────────────────── the tests ──────────────────────────────── */

describe('startSetup', () => {
  it('opens on the first question and parks the cursor in setup_state', async () => {
    await startSetup(CHAT, ACTOR)

    expect(stepId()).toBe('names')
    expect(state()?.active).toBe(true)
    expect(state()?.telegramChatId).toBe(CHAT)
    expect(lastText()).toContain('how does each of you like to be addressed')
    expect(await isSetupActive(CHAT)).toBe(true)
  })

  it('creates the household row when seeding never ran', async () => {
    await startSetup(CHAT, ACTOR)
    expect(db.all(schema.households)).toHaveLength(1)
  })
})

describe('one step per reply', () => {
  it('walks the whole interview, advancing exactly one question at a time', async () => {
    await runScript()
    expect(state()?.active).toBe(false)
  })

  it('does not advance when the answer cannot be parsed', async () => {
    await startSetup(CHAT, ACTOR)
    await reply('Alex and Sam')
    expect(stepId()).toBe('assistant_name')
    await reply('Chessy')
    expect(stepId()).toBe('address')

    await reply('nyc') // too short to be an address
    expect(stepId()).toBe('address')
    expect(lastText()).toContain('too short')

    await reply('12 Elm Street, Portland OR 97201')
    expect(stepId()).toBe('timezone')
  })

  it('lets a confirmation question keep "no" for itself instead of skipping', async () => {
    await startSetup(CHAT, ACTOR)
    await reply('Alex and Sam')
    await reply('Chessy')
    await reply('12 Elm Street, Portland OR 97201')
    expect(stepId()).toBe('timezone')

    await reply('no')

    expect(stepId()).toBe('timezone')
    expect(lastText()).toContain('Which timezone, then?')
    expect(answers()['skipped'] ?? []).not.toContain('timezone')

    await reply('Eastern')
    expect(stepId()).toBe('quiet_hours')
    expect(db.all(schema.households)[0]?.['timezone']).toBe('America/New_York')
  })

  it('declines messages that are not for it', async () => {
    expect(await handleSetupReply(CHAT, ACTOR, 'what is on today?')).toBe(false)

    await startSetup(CHAT, ACTOR)
    expect(await handleSetupReply(CHAT, ACTOR, '/status')).toBe(false)
    expect(await handleSetupReply('9999', 'Someone', 'hello')).toBe(false)
  })
})

describe('what to call her', () => {
  it('stores the name on the household row', async () => {
    await startSetup(CHAT, ACTOR)
    await reply('Alex and Sam')

    expect(lastText()).toContain('What would you like to call me')

    await reply('Chessy')

    expect(db.all(schema.households)[0]?.assistantName).toBe('Chessy')
    expect(stepId()).toBe('address')
  })

  it('keeps the standing name when the question is skipped', async () => {
    await startSetup(CHAT, ACTOR)
    await reply('Alex and Sam')
    await reply('skip')

    expect(db.all(schema.households)[0]?.assistantName).toBe('Chessy')
    expect(stepId()).toBe('address')
  })

  it('refuses an answer with no name in it rather than storing a blank', async () => {
    await startSetup(CHAT, ACTOR)
    await reply('Alex and Sam')
    await reply('we have not decided yet, ask us again another time')

    expect(stepId()).toBe('assistant_name')
    expect(db.all(schema.households)[0]?.assistantName).toBe('Chessy')
  })

  it('takes one name out of a sentence, not the whole sentence', async () => {
    await startSetup(CHAT, ACTOR)
    await reply('Alex and Sam')
    await reply('I think we will call you Prentice')

    expect(db.all(schema.households)[0]?.assistantName).toBe('Prentice')
  })
})

describe('skip', () => {
  it('advances without writing anything', async () => {
    await startSetup(CHAT, ACTOR)
    await reply('Alex and Sam')
    await reply('skip')

    const before = facts().length
    expect(stepId()).toBe('address')

    await reply('skip')

    expect(stepId()).toBe('timezone')
    expect(facts()).toHaveLength(before)
    expect(facts().some((f) => String(f['fact']).startsWith('Home address'))).toBe(false)
    expect(answers()['address']).toBeUndefined()
    expect(answers()['skipped']).toContain('address')
  })

  it('leaves the household row untouched when the clock questions are skipped', async () => {
    await startSetup(CHAT, ACTOR)
    await reply('Alex and Sam')
    await reply('skip') // my name
    await reply('skip') // address

    const before = db.all(schema.households)[0]
    await reply('skip') // timezone
    await reply('skip') // quiet hours
    await reply('skip') // morning brief

    expect(stepId()).toBe('kid_name')
    const after = db.all(schema.households)[0]
    expect(after?.timezone).toBe(before?.timezone)
    expect(after?.quietHoursStart).toBe(before?.quietHoursStart)
    expect(after?.briefHour).toBe(before?.briefHour)
  })
})

describe('the kid loop quick replies', () => {
  /** Walk from a fresh start to the first kid_name question. */
  async function walkToKidName(): Promise<void> {
    await startSetup(CHAT, ACTOR)
    for (const text of ['Alex and Sam', 'skip', 'skip', 'skip', 'skip', 'skip'])
      await reply(text)
    expect(stepId()).toBe('kid_name')
  }

  /** Walk one child (Maya) through to the kid_more question. */
  async function walkToKidMore(): Promise<void> {
    await walkToKidName()
    for (const text of ['Maya', '7', 'none', 'nothing']) await reply(text)
    expect(stepId()).toBe('kid_more')
  }

  it('ends the loop on "No kids" instead of creating a child by that name', async () => {
    await walkToKidName()

    await reply('No kids')

    expect(stepId()).toBe('schedules')
    expect(answers()['kids']).toBeUndefined()
    expect(facts().some((f) => f['subject'] === 'No kids')).toBe(false)
  })

  it('ends the loop on "Done with kids" at the next-child question', async () => {
    await walkToKidMore()
    await reply('Add another child')
    expect(stepId()).toBe('kid_name')

    await reply('Done with kids')

    expect(stepId()).toBe('schedules')
    const kids = answers()['kids'] as Array<{ name: string }>
    expect(kids.map((k) => k.name)).toStrictEqual(['Maya'])
  })

  it('reads "no more kids" as done, not as a request for another child', async () => {
    await walkToKidMore()

    await reply('no more kids')

    expect(stepId()).toBe('schedules')
    expect((answers()['kids'] as unknown[]).length).toBe(1)
  })

  it('reads "yes" to "Another child?" as adding one', async () => {
    await walkToKidMore()

    await reply('yes')

    expect(stepId()).toBe('kid_name')
    expect(answers()['kidIndex']).toBe(1)
  })

  it('survives back-then-add-again without losing the next child or their allergies', async () => {
    await walkToKidMore()
    await reply('Add another child')
    expect(stepId()).toBe('kid_name')

    // Change of mind: back to the "another child?" question, then add again.
    await reply('back')
    expect(stepId()).toBe('kid_more')
    await reply('Add another child')
    expect(stepId()).toBe('kid_name')

    await reply('Theo')
    await reply('4')
    await reply('allergic to peanuts')
    await reply('nothing')
    await reply('Done with kids')

    expect(stepId()).toBe('schedules')
    const kids = answers()['kids'] as Array<{ name: string }>
    // No ghost child, no hole: exactly Maya then Theo.
    expect(kids.map((k) => k.name)).toStrictEqual(['Maya', 'Theo'])
    const theoAllergy = facts().find(
      (f) => f['subject'] === 'Theo' && String(f['fact']).startsWith('Allergies:'),
    )
    expect(theoAllergy).toBeDefined()
    expect(String(theoAllergy?.['fact'])).toContain('peanuts')
  })

  it('does not report the kid questions as skipped after a clean "no"', async () => {
    await walkToKidMore()
    await reply('no')

    expect(stepId()).toBe('schedules')
    expect(answers()['skipped'] ?? []).not.toContain('kid_more')
  })
})

describe('allergies', () => {
  it('turns a child allergy answer into a medical memory_fact', async () => {
    await startSetup(CHAT, ACTOR)
    await reply('Alex and Sam')
    await reply('Chessy')
    await reply('12 Elm Street, Portland OR 97201')
    await reply('yes')
    await reply('no nags before 7am or after 9pm')
    await reply('7am')
    await reply('Maya')
    await reply('7')

    expect(stepId()).toBe('kid_allergies')
    await reply('Peanuts and tree nuts')

    const allergy = facts().find(
      (f) => f['subject'] === 'Maya' && String(f['fact']).startsWith('Allergies:'),
    )
    expect(allergy).toBeDefined()
    expect(allergy?.['category']).toBe('medical')
    expect(String(allergy?.['fact'])).toContain('Peanuts and tree nuts')
    expect(String(allergy?.['fact'])).toContain('critical')
    expect(allergy?.['source']).toBe('setup')
    expect(allergy?.['active']).toBe(true)
  })

  it('records "none" as a skip rather than an allergy fact', async () => {
    await startSetup(CHAT, ACTOR)
    for (const text of ['Alex and Sam', 'skip', 'skip', 'skip', 'skip', 'skip', 'Maya', '7']) {
      await reply(text)
    }
    expect(stepId()).toBe('kid_allergies')

    await reply('none')

    expect(stepId()).toBe('kid_notes')
    expect(facts().some((f) => String(f['fact']).startsWith('Allergies:'))).toBe(false)
  })

  it('keeps a trailing comma list inside the allergy clause of a medical note', async () => {
    await startSetup(CHAT, ACTOR)
    for (const text of [
      'Alex and Sam',
      'skip',
      'skip',
      'skip',
      'skip',
      'skip',
      'Maya',
      '7',
      'none',
    ]) {
      await reply(text)
    }
    expect(stepId()).toBe('kid_notes')

    await reply('allergic to peanuts, tree nuts')

    const allergy = facts().find(
      (f) => f['subject'] === 'Maya' && String(f['fact']).startsWith('Allergies:'),
    )
    // "tree nuts" must not be sheared off into the general notes bucket.
    expect(String(allergy?.['fact'])).toContain('peanuts')
    expect(String(allergy?.['fact'])).toContain('tree nuts')
    expect(
      facts().some((f) => f['subject'] === 'Maya' && String(f['fact']).startsWith('Medical notes:')),
    ).toBe(false)
  })

  it('splits an allergy clause out of a general medical note', async () => {
    await runScript()

    const theoAllergy = facts().find(
      (f) => f['subject'] === 'Theo' && String(f['fact']).startsWith('Allergies:'),
    )
    const theoNotes = facts().find(
      (f) => f['subject'] === 'Theo' && String(f['fact']).startsWith('Medical notes:'),
    )
    // "Asthma, inhaler kept at school" carries no allergy wording.
    expect(theoAllergy).toBeUndefined()
    expect(String(theoNotes?.['fact'])).toContain('Asthma')
    expect(theoNotes?.['category']).toBe('medical')
  })
})

describe('rerun', () => {
  it('pre-fills every answered question and keeps the stored value on "keep"', async () => {
    await startSetup(CHAT, ACTOR)
    await reply('Alex, goes by Al; Samantha, goes by Sam')
    await reply('Chessy')
    await reply('12 Elm Street, Portland OR 97201')
    await cancelSetup(CHAT)
    expect(await isSetupActive(CHAT)).toBe(false)

    sends.length = 0
    await startSetup(CHAT, ACTOR)

    expect(stepId()).toBe('names')
    expect(lastText()).toContain('Currently: Alex (Al) and Samantha (Sam)')
    expect(lastText()).toContain('Reply "keep"')

    await reply('keep')
    expect(stepId()).toBe('assistant_name')
    expect(lastText()).toContain('Currently: Chessy')

    await reply('keep')
    expect(stepId()).toBe('address')
    expect(lastText()).toContain('Currently: 12 Elm Street, Portland OR 97201')

    // A keep leaves the stored answer exactly as it was.
    expect(answers()['address']).toBe('12 Elm Street, Portland OR 97201')
    await reply('keep')
    expect(stepId()).toBe('timezone')
    expect(answers()['address']).toBe('12 Elm Street, Portland OR 97201')
  })

  it('rewrites a fact in place instead of stacking a contradictory one', async () => {
    await startSetup(CHAT, ACTOR)
    await reply('Alex and Sam')
    await reply('Chessy')
    await reply('12 Elm Street, Portland OR 97201')

    const addressFacts = () => facts().filter((f) => String(f['fact']).startsWith('Home address:'))
    expect(addressFacts()).toHaveLength(1)

    await startSetup(CHAT, ACTOR)
    await reply('keep') // names
    await reply('keep') // my name
    await reply('9 Alder Court, Portland OR 97210')

    expect(addressFacts()).toHaveLength(1)
    expect(String(addressFacts()[0]?.['fact'])).toContain('9 Alder Court')
  })

  it('confirming the timezone on a rerun keeps the stored zone, not the env default', async () => {
    await startSetup(CHAT, ACTOR)
    await reply('Alex and Sam')
    await reply('Chessy')
    await reply('12 Elm Street, Portland OR 97201')
    await reply('Eastern')
    expect(db.all(schema.households)[0]?.['timezone']).toBe('America/New_York')
    await cancelSetup(CHAT)

    await startSetup(CHAT, ACTOR)
    await reply('keep') // names
    await reply('keep') // my name
    await reply('keep') // address
    expect(stepId()).toBe('timezone')
    // The question must quote the zone on file, not HOUSEHOLD_TIMEZONE.
    expect(lastText()).toContain('I have you in America/New_York')

    await reply('yes')

    expect(stepId()).toBe('quiet_hours')
    expect(db.all(schema.households)[0]?.['timezone']).toBe('America/New_York')
    expect(answers()['timezone']).toBe('America/New_York')
  })

  it('running the whole interview twice duplicates no contact, watcher, or allergy fact', async () => {
    await runScript()
    await runScript()

    const contacts = db.all(schema.contacts)
    expect(contacts.filter((c) => c['role'] === 'pediatrician')).toHaveLength(1)
    expect(contacts.filter((c) => c['name'] === 'Aunt Bea')).toHaveLength(1)
    expect(db.all(schema.watchers)).toHaveLength(1)
    expect(
      facts().filter((f) => f['subject'] === 'Maya' && String(f['fact']).startsWith('Allergies:')),
    ).toHaveLength(1)
    expect(db.all(schema.users)).toHaveLength(2)
    expect(db.all(schema.households)).toHaveLength(1)
  })

  it('carries the previous answers forward into a fresh run', async () => {
    await runScript()
    const before = answers()

    await startSetup(CHAT, ACTOR)

    expect(stepId()).toBe('names')
    expect(state()?.active).toBe(true)
    expect(answers()['address']).toBe(before['address'])
    expect(answers()['kids']).toStrictEqual(before['kids'])
    // Loop cursors reset so the first child is offered back first.
    expect(answers()['kidIndex']).toBe(0)
  })
})

describe('back and cancel', () => {
  it('steps back to the previous question', async () => {
    await startSetup(CHAT, ACTOR)
    await reply('Alex and Sam')
    await reply('Chessy')
    await reply('12 Elm Street, Portland OR 97201')
    expect(stepId()).toBe('timezone')

    await reply('back')
    expect(stepId()).toBe('address')
    expect(lastText()).toContain('Back one.')
  })

  it('stops without discarding what was already answered', async () => {
    await startSetup(CHAT, ACTOR)
    await reply('Alex and Sam')
    await reply('cancel')

    expect(await isSetupActive(CHAT)).toBe(false)
    expect(lastText()).toContain('Everything you already answered is saved')
    expect(answers()['names']).toBeDefined()
    expect(await handleSetupReply(CHAT, ACTOR, 'anything')).toBe(false)
  })
})

describe('what the interview writes', () => {
  it('stores contacts, watchers, users, and the household clock', async () => {
    await runScript()

    const contacts = db.all(schema.contacts)
    const pediatrician = contacts.find((c) => c['role'] === 'pediatrician')
    expect(pediatrician?.['name']).toBe('Dr Moreau')
    expect(pediatrician?.['phone']).toBe('+14155550134')

    const jo = contacts.find((c) => c['name'] === 'Aunt Bea')
    expect(jo?.['role']).toBe('emergency contact')
    expect(jo?.['phone']).toBe('+14155550999')

    const watchers = db.all(schema.watchers)
    expect(watchers).toHaveLength(1)
    expect(watchers[0]?.['type']).toBe('email')
    expect((watchers[0]?.['config'] as { senders?: string[] })?.senders).toStrictEqual([
      '@brightwheel.com',
    ])

    const household = db.all(schema.households)[0]
    expect(household?.['quietHoursStart']).toBe(21)
    expect(household?.['quietHoursEnd']).toBe(7)
    expect(household?.['briefHour']).toBe(7)
    expect(household?.['timezone']).toBe('America/Los_Angeles')
    expect(household?.['setupCompletedAt']).toBeInstanceOf(Date)

    const users = db.all(schema.users)
    expect(users.map((u) => u['displayName'])).toStrictEqual(['Al', 'Sam'])
    expect(users[0]?.['isPrimary']).toBe(true)
  })

  it('spends exactly one model call, on the final free-text question', async () => {
    await runScript()

    expect(runTurnMock).toHaveBeenCalledTimes(1)
    const call = runTurnMock.mock.calls[0]?.[0] as unknown as {
      trigger?: string
      origin?: string
      prompt?: string
    }
    expect(call?.trigger).toBe('workflow')
    expect(call?.origin).toBe('workflow')
    expect(call?.prompt).toContain('Biscuit')
    expect(call?.prompt).toContain('memory_save')
    // The typed answer reaches the model fenced as data, never as bare text.
    expect(call?.prompt).toContain('<untrusted source="setup:anything-else answer">')
    expect(call?.prompt).toContain('</untrusted>')
  })

  it('keeps the free-text answer verbatim when the model call fails', async () => {
    runTurnMock.mockResolvedValueOnce({ text: '', sessionId: null, costUsd: 0, ok: false })
    await runScript()

    const fallback = facts().find((f) => String(f['fact']).startsWith('Setup notes:'))
    expect(String(fallback?.['fact'])).toContain('Biscuit')
  })

  it('closes with a summary that names what is still missing', async () => {
    await runScript()

    const summary = lastText()
    expect(summary).toContain('Setup complete.')
    expect(summary).toContain('Maya')
    expect(summary).toContain('Still missing')
    expect(summary).toContain('Google is not connected')
    expect(summary).toContain('Vapi')
    expect(sends[sends.length - 1]?.replyMarkup).toStrictEqual({ remove_keyboard: true })
  })
})

describe('setupSummary', () => {
  it('reports an unfinished setup', async () => {
    const summary = await setupSummary()
    expect(summary).toContain('Setup has not been completed')
  })

  it('reports what is known once the interview has run', async () => {
    await runScript()

    const summary = await setupSummary()
    expect(summary).toContain('Setup finished')
    expect(summary).toContain('Al and Sam')
    expect(summary).toContain('Quiet hours: 21:00 to 07:00')
    expect(summary).toContain('Morning brief: 07:00')
    expect(summary).toContain('Contacts: 2')
    expect(summary).toContain('Watchers: 1')
  })
})

describe('parsers', () => {
  it('reads quiet hours out of the ways people write them', () => {
    expect(parseQuietHours('no nags before 7am or after 9pm')).toStrictEqual({ start: 21, end: 7 })
    expect(parseQuietHours('9pm to 7am')).toStrictEqual({ start: 21, end: 7 })
    expect(parseQuietHours('21:00-07:00')).toStrictEqual({ start: 21, end: 7 })
    expect(parseQuietHours('9 to 7')).toStrictEqual({ start: 21, end: 7 })
    expect(parseQuietHours('whenever')).toBeNull()
  })

  it('reads clock hours', () => {
    expect(parseHour('7am')).toBe(7)
    expect(parseHour('7:30 am')).toBe(7)
    expect(parseHour('19:00')).toBe(19)
    expect(parseHour('midnight')).toBe(0)
    expect(parseHour('12pm')).toBe(12)
    expect(parseHour('teatime')).toBeNull()
  })

  it('reads names and the form each person answers to', () => {
    expect(parseNames('Alex, goes by Al; Samantha, goes by Sam')).toStrictEqual([
      { name: 'Alex', called: 'Al' },
      { name: 'Samantha', called: 'Sam' },
    ])
    expect(parseNames('Alex and Sam')).toStrictEqual([{ name: 'Alex' }, { name: 'Sam' }])
    expect(parseNames('Alex (Al)')).toStrictEqual([{ name: 'Alex', called: 'Al' }])
  })

  it('splits medical notes on newlines and semicolons, never on commas', () => {
    expect(splitMedical('allergic to peanuts, tree nuts')).toStrictEqual({
      allergies: ['allergic to peanuts, tree nuts'],
      notes: [],
    })
    expect(splitMedical('Asthma, inhaler kept at school')).toStrictEqual({
      allergies: [],
      notes: ['Asthma, inhaler kept at school'],
    })
    expect(splitMedical('Asthma; allergic to penicillin')).toStrictEqual({
      allergies: ['allergic to penicillin'],
      notes: ['Asthma'],
    })
  })

  it('reads senders as addresses or whole domains', () => {
    expect(parseSenders('@brightwheel.com, office@birchwood.org')).toStrictEqual([
      'office@birchwood.org',
      '@brightwheel.com',
    ])
    expect(parseSenders('nothing useful here')).toStrictEqual([])
  })
})
