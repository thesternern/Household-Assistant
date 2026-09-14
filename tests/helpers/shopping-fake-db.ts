/**
 * A tiny in-memory stand-in for the Drizzle/Postgres handle used by
 * `src/shopping/standing-list.ts`.
 *
 * Same discipline as `tests/helpers/pending-fake-db.ts`: every `where` clause
 * the production code builds is rendered to real SQL with drizzle's own
 * PgDialect and evaluated against the stored rows. Drop the `inArray(...ids)`
 * guard from `markSent`, or the `eq(id, ...)` guard from `setStatus`, and a
 * test that stages several rows and touches only some of them will fail.
 */
import { getTableColumns } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import * as schema from '../../src/db/schema.js'

const dialect = new PgDialect()
const TABLE = 'shopping_list_items'

export type FakeRow = Record<string, unknown>

const columns = getTableColumns(schema.shoppingListItems)
/** 'quantity_text' -> 'quantityText' */
const dbNameToKey: Record<string, string> = Object.fromEntries(
  Object.entries(columns).map(([key, col]) => [col.name, key]),
)

function normalize(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value
}

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
  if (table !== TABLE) throw new Error(`fake db: unexpected table ${table}`)
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

/**
 * `.orderBy(schema.table.col)` passes a bare column, not an SQL fragment —
 * only `asc()`/`desc()` wrap it into one. Handle both: match the column by
 * identity first, and only fall back to rendering SQL for the wrapped form.
 */
function resolveOrder(order: unknown): { key: string; dir: 1 | -1 } | null {
  for (const [key, col] of Object.entries(columns)) {
    if (col === order) return { key, dir: 1 }
  }
  const text = dialect.sqlToQuery(order as SQL).sql
  const m = /^"shopping_list_items"\."(\w+)"(?:\s+(asc|desc))?$/i.exec(text.trim())
  if (!m) return null
  const key = dbNameToKey[m[1] ?? '']
  if (!key) return null
  return { key, dir: (m[2] ?? 'asc').toLowerCase() === 'desc' ? -1 : 1 }
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

const COLUMN_DEFAULTS: FakeRow = {
  status: 'pending',
  urgent: false,
  quantityText: null,
  note: null,
  addedBy: null,
  sentAt: null,
}

export class FakeShoppingDb {
  rows: FakeRow[] = []
  private nextId = 1

  /** Insert a row directly, bypassing the production code path. */
  seed(row: Partial<FakeRow>): FakeRow {
    const stored: FakeRow = {
      ...COLUMN_DEFAULTS,
      id: this.nextId++,
      name: 'seeded',
      addedAt: new Date(),
      ...row,
    }
    this.rows.push(stored)
    return stored
  }

  insert(_table: unknown) {
    return {
      values: (values: FakeRow | FakeRow[]) => {
        const inputs = Array.isArray(values) ? values : [values]
        const doInsert = (): FakeRow[] =>
          inputs.map((v) => {
            const stored: FakeRow = {
              ...COLUMN_DEFAULTS,
              id: this.nextId++,
              addedAt: new Date(),
              ...v,
            }
            this.rows.push(stored)
            return { ...stored }
          })
        return { returning: () => thenable(doInsert, {}) }
      },
    }
  }

  update(_table: unknown) {
    return {
      set: (values: FakeRow) => ({
        where: (where?: SQL) => {
          const doUpdate = (): FakeRow[] => {
            const hit = this.rows.filter((row) => matches(where, row))
            for (const row of hit) Object.assign(row, values)
            return hit.map((row) => ({ ...row }))
          }
          return { returning: () => thenable(doUpdate, {}) }
        },
      }),
    }
  }

  select(_fields?: unknown) {
    return {
      from: (_table: unknown) => {
        let where: SQL | undefined
        let order: unknown
        let max: number | undefined
        const run = (): FakeRow[] => {
          let hit = this.rows.filter((row) => matches(where, row))
          const resolved = order ? resolveOrder(order) : null
          if (resolved) {
            const { key, dir } = resolved
            hit = [...hit].sort((a, b) => {
              const av = normalize(a[key]) as number | string
              const bv = normalize(b[key]) as number | string
              if (av === bv) return 0
              return (av < bv ? -1 : 1) * dir
            })
          }
          // `.limit()` after `.orderBy()`, the way Postgres applies it — a
          // limit that sliced before the sort would hide the ordering bug it
          // exists to catch.
          if (max !== undefined) hit = hit.slice(0, max)
          return hit.map((row) => ({ ...row }))
        }
        const builder: Record<string, unknown> = {}
        const api = thenable(run, builder)
        Object.assign(builder, {
          where: (w?: SQL) => {
            where = w
            return api
          },
          orderBy: (o?: unknown) => {
            order = o
            return api
          },
          limit: (n: number) => {
            max = n
            return api
          },
        })
        return api as typeof api & {
          where: (w?: SQL) => unknown
          orderBy: (o?: unknown) => unknown
          limit: (n: number) => unknown
        }
      },
    }
  }
}

/** Convenience for `vi.mock('../../src/db/client.js', ...)`. */
export function makeDbClientMock(fake: FakeShoppingDb) {
  return { getDb: () => fake as unknown as never, schema }
}
