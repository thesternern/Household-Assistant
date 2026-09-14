/**
 * A tiny in-memory stand-in for the Drizzle/Postgres handle used by
 * `src/policy/pending.ts`.
 *
 * It is deliberately *not* a rubber stamp: every `where` clause the production
 * code builds is rendered to real SQL with drizzle's own PgDialect and then
 * evaluated against the stored rows. Drop the `status = 'pending'` guard or the
 * `expires_at > now()` guard from the implementation and the tests fail, which
 * is the whole point of the double-tap and expiry cases.
 *
 * jsonb columns round-trip through JSON on write and on read, the way Postgres
 * would, so nothing survives by shared reference.
 */
import { getTableColumns } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import * as schema from '../../src/db/schema.js'

const dialect = new PgDialect()

export type FakeRow = Record<string, unknown>

const columns = getTableColumns(schema.pendingActions)
/** 'expires_at' -> 'expiresAt' */
const dbNameToKey: Record<string, string> = Object.fromEntries(
  Object.entries(columns).map(([key, col]) => [col.name, key]),
)
const JSONB_KEYS = new Set(['argsJson', 'executionResult', 'telegramMessageIds'])

function jsonClone(value: unknown): unknown {
  if (value === undefined) return null
  const encoded = JSON.stringify(value)
  return encoded === undefined ? null : (JSON.parse(encoded) as unknown)
}

/** Copy a row the way a driver would: fresh object, jsonb re-parsed. */
function readRow(row: FakeRow): FakeRow {
  const out: FakeRow = {}
  for (const [key, value] of Object.entries(row)) {
    out[key] = JSONB_KEYS.has(key) ? jsonClone(value) : value
  }
  return out
}

function writeValue(key: string, value: unknown): unknown {
  return JSONB_KEYS.has(key) ? jsonClone(value) : value
}

/* ─────────────────────────── where-clause evaluation ─────────────────────── */

function stripOuterParens(text: string): string {
  let s = text.trim()
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0
    let wraps = true
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++
      else if (s[i] === ')') depth--
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

function normalize(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value
}

function literal(token: string, params: unknown[]): unknown {
  const t = token.trim()
  if (/^\$\d+$/.test(t)) return params[Number(t.slice(1)) - 1]
  if (t === 'now()') return new Date()
  if (t === 'null') return null
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  const quoted = /^'(.*)'$/.exec(t)
  if (quoted) return quoted[1]
  throw new Error(`fake db: unsupported SQL literal ${token}`)
}

const CLAUSE = /^"(\w+)"\."(\w+)"\s+(=|<>|!=|>=|<=|>|<|is not|is|in)\s+(.+)$/i

function evalClause(clause: string, params: unknown[], row: FakeRow): boolean {
  const m = CLAUSE.exec(clause.trim())
  if (!m) throw new Error(`fake db: unsupported SQL clause "${clause}"`)
  const [, table, colName, rawOp, rhs] = m
  if (table !== 'pending_actions') throw new Error(`fake db: unexpected table ${table}`)
  const key = dbNameToKey[colName ?? '']
  if (!key) throw new Error(`fake db: unknown column ${colName}`)
  const op = (rawOp ?? '').toLowerCase()
  const left = normalize(row[key])
  const right = rhs ?? ''

  switch (op) {
    case '=':
      return left === normalize(literal(right, params))
    case '<>':
    case '!=':
      return left !== normalize(literal(right, params))
    case '>':
      return Number(left) > Number(normalize(literal(right, params)))
    case '<':
      return Number(left) < Number(normalize(literal(right, params)))
    case '>=':
      return Number(left) >= Number(normalize(literal(right, params)))
    case '<=':
      return Number(left) <= Number(normalize(literal(right, params)))
    case 'is':
      return right.trim() === 'null' ? row[key] === null || row[key] === undefined : false
    case 'is not':
      return right.trim() === 'null' ? row[key] !== null && row[key] !== undefined : false
    case 'in': {
      const list = stripOuterParens(right)
        .split(',')
        .map((tok) => normalize(literal(tok, params)))
      return list.includes(left)
    }
    default:
      throw new Error(`fake db: unsupported operator ${op}`)
  }
}

function matches(where: SQL | undefined, row: FakeRow): boolean {
  if (!where) return true
  const query = dialect.sqlToQuery(where)
  const body = stripOuterParens(query.sql)
  return body
    .split(/\s+and\s+/i)
    .every((clause) => evalClause(clause, query.params as unknown[], row))
}

function selectionKeys(selection: Record<string, unknown> | undefined): string[] | null {
  if (!selection) return null
  return Object.entries(selection).map(([alias, col]) => {
    const name = (col as { name?: string }).name
    const key = name ? dbNameToKey[name] : undefined
    if (!key) throw new Error(`fake db: cannot map returning() field ${alias}`)
    return key
  })
}

function project(row: FakeRow, selection: Record<string, unknown> | undefined): FakeRow {
  const keys = selectionKeys(selection)
  const copy = readRow(row)
  if (!keys) return copy
  const out: FakeRow = {}
  const aliases = Object.keys(selection ?? {})
  aliases.forEach((alias, i) => {
    const key = keys[i]
    if (key) out[alias] = copy[key]
  })
  return out
}

/* ────────────────────────────── thenable builders ────────────────────────── */

type Runner = () => FakeRow[]

function thenable<T extends object>(run: Runner, extra: T): T & PromiseLike<FakeRow[]> {
  return Object.assign(extra, {
    then<A, B>(
      onOk?: ((rows: FakeRow[]) => A | PromiseLike<A>) | null,
      onErr?: ((reason: unknown) => B | PromiseLike<B>) | null,
    ) {
      return Promise.resolve()
        .then(run)
        .then(onOk ?? undefined, onErr ?? undefined)
    },
  }) as T & PromiseLike<FakeRow[]>
}

export interface Statement {
  kind: 'insert' | 'update' | 'select'
  sql: string
  params: unknown[]
}

const COLUMN_DEFAULTS: FakeRow = {
  status: 'pending',
  requestedBy: null,
  resolvedBy: null,
  resolvedAt: null,
  executionResult: null,
  telegramChatId: null,
  telegramMessageIds: null,
  conversationId: null,
  agentSessionId: null,
  origin: 'agent',
}

export class FakePendingDb {
  rows: FakeRow[] = []
  /** Every rendered where clause, in order — assert on these to prove the guards exist. */
  statements: Statement[] = []
  private nextId = 1

  /** Insert a row directly, bypassing the production code path. */
  seed(row: Partial<FakeRow>): FakeRow {
    const stored: FakeRow = {
      ...COLUMN_DEFAULTS,
      id: this.nextId++,
      toolName: 'noop',
      argsJson: {},
      category: 'read',
      humanSummary: 'seeded',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    }
    for (const [key, value] of Object.entries(row)) stored[key] = writeValue(key, value)
    this.rows.push(stored)
    return stored
  }

  find(id: number): FakeRow | undefined {
    return this.rows.find((r) => r.id === id)
  }

  private record(kind: Statement['kind'], where: SQL | undefined): void {
    if (!where) {
      this.statements.push({ kind, sql: '', params: [] })
      return
    }
    const q = dialect.sqlToQuery(where)
    this.statements.push({ kind, sql: q.sql, params: q.params as unknown[] })
  }

  insert(_table: unknown) {
    return {
      values: (values: FakeRow) => {
        const doInsert = (selection?: Record<string, unknown>): FakeRow[] => {
          const stored: FakeRow = { ...COLUMN_DEFAULTS, id: this.nextId++, createdAt: new Date() }
          for (const [key, value] of Object.entries(values)) {
            if (value !== undefined) stored[key] = writeValue(key, value)
          }
          this.rows.push(stored)
          this.statements.push({ kind: 'insert', sql: 'insert into pending_actions', params: [] })
          return [project(stored, selection)]
        }
        return thenable(() => doInsert(undefined), {
          returning: (selection?: Record<string, unknown>) =>
            thenable(() => doInsert(selection), {}),
        })
      },
    }
  }

  update(_table: unknown) {
    return {
      set: (values: FakeRow) => ({
        where: (where?: SQL) => {
          const doUpdate = (selection?: Record<string, unknown>): FakeRow[] => {
            this.record('update', where)
            const hit = this.rows.filter((row) => matches(where, row))
            for (const row of hit) {
              for (const [key, value] of Object.entries(values)) {
                row[key] = writeValue(key, value)
              }
            }
            return hit.map((row) => project(row, selection))
          }
          return thenable(() => doUpdate(undefined), {
            returning: (selection?: Record<string, unknown>) =>
              thenable(() => doUpdate(selection), {}),
          })
        },
      }),
    }
  }

  select(_fields?: unknown) {
    return {
      from: (_table: unknown) => {
        let where: SQL | undefined
        let limit: number | undefined
        let order: SQL | undefined
        const run = (): FakeRow[] => {
          this.record('select', where)
          let hit = this.rows.filter((row) => matches(where, row))
          if (order) {
            const text = dialect.sqlToQuery(order).sql
            const m = /^"pending_actions"\."(\w+)"(?:\s+(asc|desc))?$/i.exec(text.trim())
            if (!m) throw new Error(`fake db: unsupported order by "${text}"`)
            const key = dbNameToKey[m[1] ?? '']
            const dir = (m[2] ?? 'asc').toLowerCase() === 'desc' ? -1 : 1
            if (!key) throw new Error(`fake db: unknown order column ${m[1]}`)
            hit = [...hit].sort((a, b) => {
              const av = normalize(a[key]) as number | string
              const bv = normalize(b[key]) as number | string
              if (av === bv) return 0
              return (av < bv ? -1 : 1) * dir
            })
          }
          if (limit !== undefined) hit = hit.slice(0, limit)
          return hit.map((row) => readRow(row))
        }
        const builder: Record<string, unknown> = {}
        const api = thenable(run, builder)
        Object.assign(builder, {
          where: (w?: SQL) => {
            where = w
            return api
          },
          orderBy: (o?: SQL) => {
            order = o
            return api
          },
          limit: (n: number) => {
            limit = n
            return api
          },
        })
        return api as typeof api & {
          where: (w?: SQL) => unknown
          orderBy: (o?: SQL) => unknown
          limit: (n: number) => unknown
        }
      },
    }
  }
}

/** Convenience for `vi.mock('../../src/db/client.js', ...)`. */
export function makeDbClientMock(fake: FakePendingDb) {
  return { getDb: () => fake as unknown as never, schema }
}
