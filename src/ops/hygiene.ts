import { spawn } from 'node:child_process'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq, lt, ne, sql } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { audit } from '../audit/log.js'
import { getConfig } from '../config.js'
import { getDb, getPool, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { expireStale } from '../policy/pending.js'

/**
 * The nightly tidy-up.
 *
 * Everything here is about the database staying small, honest, and restorable
 * without anyone thinking about it. Three rules shape the file:
 *
 *  1. **Never lose the shape of history.** Audit rows are deleted on a
 *     retention clock, but not before a per-month aggregate row takes their
 *     place, so "how many emails did it send last April" still has an answer.
 *  2. **Every step is independent.** A lock on one table, a missing binary, a
 *     full disk — each costs its own step and nothing else. The sweep always
 *     runs to the end.
 *  3. **A backup that only exists in the database is not a backup.** A weekly
 *     logical dump lands on the Railway volume, and the last four are kept.
 */

const log = logger.child({ mod: 'ops/hygiene' })

const DAY_MS = 86_400_000
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY_MS)

/** Event of the aggregate row that outlives the detail it summarises. */
export const AUDIT_SUMMARY_EVENT = 'audit.monthly_summary'
/** Title an `extracted_events` row carries once its detail has been dropped. */
export const COMPACTED_TITLE = '(compacted)'
/** Extracted events older than this keep only their dedupe identity. */
export const EXTRACTED_EVENT_COMPACT_DAYS = 365
/** Where the weekly dumps live. On Railway this is the mounted volume. */
export const BACKUP_DIR = '/data/backups'
/** A new dump is written when the newest on disk is older than this. */
export const BACKUP_INTERVAL_DAYS = 6
/** How many dumps survive. */
export const BACKUP_KEEP = 4
/** A dump that has not finished by now is not going to. */
const PG_DUMP_TIMEOUT_MS = 300_000

/**
 * Tables worth reclaiming and re-analysing every night: the ones this app
 * writes to and deletes from constantly, where the planner's statistics go
 * stale and dead tuples accumulate between autovacuum runs.
 *
 * Hardcoded, never interpolated from input — these strings are concatenated
 * into SQL because `VACUUM` takes an identifier, not a parameter.
 */
export const BUSY_TABLES: readonly string[] = [
  'audit_log',
  'turn_metrics',
  'pending_actions',
  'extracted_events',
  'reminders',
  'todos',
  'followups',
  'memory_facts',
  'conversations',
]

function describe(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err) ?? 'unknown error'
  } catch {
    return 'unknown error'
  }
}

/**
 * Rows affected by a `delete`/`update` that did not ask for `returning()`.
 * Deliberately not `returning({ id })`: a retention pass can touch millions of
 * rows, and materialising every id just to count them is how a tidy-up turns
 * into an out-of-memory restart.
 */
function rowCountOf(result: unknown): number {
  const r = result as { rowCount?: number | null } | null
  return r && typeof r.rowCount === 'number' ? r.rowCount : 0
}

/** Runs one step, converting any throw into a logged, recorded failure. */
async function step(name: string, run: () => Promise<string>): Promise<string> {
  const started = Date.now()
  try {
    const summary = await run()
    log.info({ step: name, durationMs: Date.now() - started }, summary)
    return `${name}: ${summary}`
  } catch (err) {
    const detail = describe(err)
    log.error({ err, step: name, durationMs: Date.now() - started }, 'hygiene step failed')
    return `${name}: FAILED — ${detail}`
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   1. Audit log — summarise, then prune
   ══════════════════════════════════════════════════════════════════════════ */

interface MonthlyAggregate {
  month: string
  events: number
  failures: number
  byEvent: Record<string, number>
  byActor: Record<string, number>
}

/** Adds `next` into `prev`, so re-running the sweep on the same month is additive, not lossy. */
export function mergeAggregate(prev: MonthlyAggregate | null, next: MonthlyAggregate): MonthlyAggregate {
  if (!prev) return next
  const byEvent: Record<string, number> = { ...prev.byEvent }
  for (const [key, count] of Object.entries(next.byEvent)) byEvent[key] = (byEvent[key] ?? 0) + count
  const byActor: Record<string, number> = { ...prev.byActor }
  for (const [key, count] of Object.entries(next.byActor)) byActor[key] = (byActor[key] ?? 0) + count
  return {
    month: next.month,
    events: prev.events + next.events,
    failures: prev.failures + next.failures,
    byEvent,
    byActor,
  }
}

/** Reads an aggregate back out of a stored `args_json`, tolerating anything odd in there. */
function readAggregate(value: unknown): MonthlyAggregate | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<MonthlyAggregate>
  if (typeof v.month !== 'string') return null
  const counts = (source: unknown): Record<string, number> => {
    if (!source || typeof source !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [key, raw] of Object.entries(source as Record<string, unknown>)) {
      const n = Number(raw)
      if (Number.isFinite(n)) out[key] = n
    }
    return out
  }
  return {
    month: v.month,
    events: Number(v.events) || 0,
    failures: Number(v.failures) || 0,
    byEvent: counts(v.byEvent),
    byActor: counts(v.byActor),
  }
}

function topPairs(counts: Record<string, number>, limit: number): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, n]) => `${key} ×${n}`)
    .join(', ')
}

/**
 * Rolls every audit row older than the retention window into one row per month,
 * then deletes the detail.
 *
 * Order matters: aggregate, write the summaries, and only then delete — all in
 * one transaction. The summary row must exist before the detail it replaces is
 * gone, and a crash mid-pass must neither lose a month of history nor count it
 * twice on the next run. The delete explicitly excludes summary rows, so the
 * aggregates survive every later pass.
 *
 * Exported for tests, which prove the write-before-delete ordering.
 */
export async function pruneAuditLog(retentionDays: number): Promise<string> {
  const db = getDb()
  const cutoff = daysAgo(retentionDays)

  let monthCount = 0
  let deleted = 0

  await db.transaction(async (tx) => {
    const grouped = await tx.execute<{
      month: string
      event: string
      actor: string
      n: number
      failures: number
    }>(sql`
      select
        to_char(date_trunc('month', ${schema.auditLog.ts}), 'YYYY-MM') as month,
        ${schema.auditLog.event} as event,
        ${schema.auditLog.actor} as actor,
        count(*)::int as n,
        count(*) filter (where not ${schema.auditLog.ok})::int as failures
      from ${schema.auditLog}
      where ${schema.auditLog.ts} < ${cutoff}
        and ${schema.auditLog.event} <> ${AUDIT_SUMMARY_EVENT}
      group by 1, 2, 3
    `)

    if (grouped.rows.length === 0) return

    const months = new Map<string, MonthlyAggregate>()
    for (const row of grouped.rows) {
      const month = String(row.month)
      const acc =
        months.get(month) ?? { month, events: 0, failures: 0, byEvent: {}, byActor: {} }
      const n = Number(row.n) || 0
      acc.events += n
      acc.failures += Number(row.failures) || 0
      const event = String(row.event)
      const actor = String(row.actor)
      acc.byEvent[event] = (acc.byEvent[event] ?? 0) + n
      acc.byActor[actor] = (acc.byActor[actor] ?? 0) + n
      months.set(month, acc)
    }

    // Existing summaries are merged rather than duplicated, so a month straddling
    // the cutoff gets one row that grows, not a row per sweep.
    const existing = await tx
      .select({
        id: schema.auditLog.id,
        toolName: schema.auditLog.toolName,
        argsJson: schema.auditLog.argsJson,
      })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.event, AUDIT_SUMMARY_EVENT))

    const byMonth = new Map<string, { id: number; aggregate: MonthlyAggregate | null }>()
    for (const row of existing) {
      if (typeof row.toolName === 'string') {
        byMonth.set(row.toolName, { id: row.id, aggregate: readAggregate(row.argsJson) })
      }
    }

    for (const [month, aggregate] of months) {
      const merged = mergeAggregate(byMonth.get(month)?.aggregate ?? null, aggregate)
      const summary =
        `${merged.events} audit ${merged.events === 1 ? 'entry' : 'entries'} in ${month}` +
        `${merged.failures > 0 ? `, ${merged.failures} failed` : ''}` +
        `${Object.keys(merged.byEvent).length > 0 ? `. Top: ${topPairs(merged.byEvent, 6)}` : ''}`

      const prior = byMonth.get(month)
      if (prior) {
        await tx
          .update(schema.auditLog)
          .set({ argsJson: merged, resultSummary: summary.slice(0, 1000) })
          .where(eq(schema.auditLog.id, prior.id))
        continue
      }

      // Timestamped at the end of the month it describes, so history still reads
      // in order once the detail is gone.
      const ts = DateTime.fromISO(`${month}-01`, { zone: 'utc' }).endOf('month').toJSDate()
      await tx.insert(schema.auditLog).values({
        ts: Number.isNaN(ts.getTime()) ? new Date() : ts,
        actor: 'system',
        event: AUDIT_SUMMARY_EVENT,
        toolName: month,
        argsJson: merged,
        resultSummary: summary.slice(0, 1000),
        ok: true,
      })
    }

    // The summaries are on disk in this transaction; now the detail can go.
    deleted = rowCountOf(
      await tx
        .delete(schema.auditLog)
        .where(and(lt(schema.auditLog.ts, cutoff), ne(schema.auditLog.event, AUDIT_SUMMARY_EVENT))),
    )
    monthCount = months.size
  })

  if (monthCount === 0) return 'nothing older than the retention window'

  return `summarised ${monthCount} ${monthCount === 1 ? 'month' : 'months'}, deleted ${deleted} rows older than ${retentionDays} days`
}

/* ══════════════════════════════════════════════════════════════════════════
   2. Stale approvals
   ══════════════════════════════════════════════════════════════════════════ */

async function expireApprovals(): Promise<string> {
  const count = await expireStale()
  return count === 0 ? 'no approvals had gone stale' : `expired ${count} stale ${count === 1 ? 'approval' : 'approvals'}`
}

/* ══════════════════════════════════════════════════════════════════════════
   3. Extracted events — compact, do not delete
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Strips a year-old extracted event down to its identity.
 *
 * The row is not deleted, and that is the point: `content_hash` carries a
 * unique index and is the only thing stopping a watcher from re-extracting the
 * same old newsletter item on its next poll. What goes is the payload — the
 * title, the source reference, the links back to whatever it created — none of
 * which anyone reads a year later.
 */
async function compactExtractedEvents(): Promise<string> {
  const cutoff = daysAgo(EXTRACTED_EVENT_COMPACT_DAYS)
  const compacted = rowCountOf(
    await getDb()
      .update(schema.extractedEvents)
      .set({
        title: COMPACTED_TITLE,
        sourceRef: '',
        eventDate: null,
        eventTime: null,
        calendarEventId: null,
        todoId: null,
        reminderId: null,
      })
      .where(
        and(
          lt(schema.extractedEvents.createdAt, cutoff),
          ne(schema.extractedEvents.title, COMPACTED_TITLE),
        ),
      ),
  )

  return compacted === 0
    ? 'no extracted events older than a year'
    : `compacted ${compacted} extracted ${compacted === 1 ? 'event' : 'events'}, keeping their dedupe hashes`
}

/* ══════════════════════════════════════════════════════════════════════════
   4. Vacuum and analyze
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * `VACUUM` cannot run inside a transaction block, and the extended query
 * protocol node-postgres uses for parameterised queries wraps every statement
 * in one. So these go through the pool's simple-query path with a literal
 * statement — which is why {@link BUSY_TABLES} is a hardcoded allowlist and
 * nothing user-supplied ever reaches this string.
 */
async function vacuumBusyTables(): Promise<string> {
  const pool = getPool()
  const done: string[] = []
  const analysed: string[] = []
  const failed: string[] = []

  for (const table of BUSY_TABLES) {
    try {
      await pool.query(`vacuum (analyze) ${table}`)
      done.push(table)
    } catch (err) {
      // A shared or non-owned table refuses VACUUM but still allows ANALYZE,
      // which is the half that keeps the planner honest.
      log.warn({ err, table }, 'vacuum refused; falling back to analyze')
      try {
        await pool.query(`analyze ${table}`)
        analysed.push(table)
      } catch (analyzeErr) {
        log.error({ err: analyzeErr, table }, 'analyze failed too')
        failed.push(table)
      }
    }
  }

  const parts = [`vacuumed ${done.length}`]
  if (analysed.length > 0) parts.push(`analyze-only ${analysed.length}`)
  if (failed.length > 0) parts.push(`failed ${failed.join(', ')}`)
  return parts.join(', ')
}

/* ══════════════════════════════════════════════════════════════════════════
   5. Weekly logical dump
   ══════════════════════════════════════════════════════════════════════════ */

const BACKUP_FILE_RE = /^household-\d{4}-\d{2}-\d{2}T\d{4}\.(sql|json)$/

interface BackupFile {
  name: string
  path: string
  mtimeMs: number
  size: number
}

async function listBackups(dir: string): Promise<BackupFile[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: BackupFile[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !BACKUP_FILE_RE.test(entry.name)) continue
    const path = join(dir, entry.name)
    try {
      const info = await stat(path)
      out.push({ name: entry.name, path, mtimeMs: info.mtimeMs, size: info.size })
    } catch {
      // Raced with a delete. Nothing to do.
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * libpq environment for `pg_dump`, derived from `DATABASE_URL`.
 *
 * The connection string is deliberately *not* passed on the command line: argv
 * is world-readable through `ps`, and it carries the database password.
 */
export function pgEnvFromUrl(databaseUrl: string, isProd: boolean): NodeJS.ProcessEnv | null {
  let url: URL
  try {
    url = new URL(databaseUrl)
  } catch {
    return null
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) return null

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!database) return null

  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  const env: NodeJS.ProcessEnv = {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: database,
    // Railway terminates TLS with a self-signed chain, so `require` (encrypt,
    // do not verify) is the mode that actually connects.
    PGSSLMODE: url.searchParams.get('sslmode') ?? (isProd && !local ? 'require' : 'prefer'),
    PGCONNECT_TIMEOUT: '15',
  }
  if (url.username) env.PGUSER = decodeURIComponent(url.username)
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password)
  return env
}

interface SpawnResult {
  ok: boolean
  code: number | null
  stderr: string
  error?: string
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: SpawnResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        // A clean environment plus libpq's variables: nothing else leaks in.
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin', ...env },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
    } catch (err) {
      finish({ ok: false, code: null, stderr: '', error: describe(err) })
      return
    }

    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8')
    })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, code: null, stderr, error: `timed out after ${Math.round(timeoutMs / 1000)}s` })
    }, timeoutMs)
    timer.unref?.()

    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ ok: false, code: null, stderr, error: describe(err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ ok: code === 0, code, stderr: stderr.trim() })
    })
  })
}

/** JSON export of the tables that encode the household, used when `pg_dump` is absent. */
async function jsonExport(): Promise<string> {
  const db = getDb()
  const payload: Record<string, unknown> = {
    _format: 'home-assistant-json-export/1',
    _writtenAt: new Date().toISOString(),
    _note:
      'Fallback export written because pg_dump is not on PATH. Covers the slow-changing tables ' +
      'that define the household; audit_log, turn_metrics, extracted_events, call_records and ' +
      'conversations are deliberately omitted. Secrets in here are ciphertext and are useless ' +
      'without APP_SECRET.',
  }

  const tables = {
    households: schema.households,
    users: schema.users,
    policies: schema.policies,
    rules: schema.rules,
    memory_facts: schema.memoryFacts,
    contacts: schema.contacts,
    watchers: schema.watchers,
    todos: schema.todos,
    followups: schema.followups,
    reminders: schema.reminders,
    recipes: schema.recipes,
    meal_plans: schema.mealPlans,
    meal_plan_items: schema.mealPlanItems,
    grocery_lists: schema.groceryLists,
    site_credentials: schema.siteCredentials,
    google_tokens: schema.googleTokens,
  } as const

  for (const [name, table] of Object.entries(tables)) {
    try {
      payload[name] = await db.select().from(table)
    } catch (err) {
      log.error({ err, table: name }, 'could not export a table')
      payload[name] = { _error: describe(err) }
    }
  }

  return JSON.stringify(payload, null, 2)
}

/**
 * Writes one dump a week and keeps the last four.
 *
 * `pg_dump` when the binary is on PATH — that is the only artefact that
 * restores the whole database. When it is not (the Node runtime image usually
 * ships without the Postgres client tools), a JSON export of the small tables
 * is written instead. That will not restore a database on its own, but it is
 * the difference between "we lost the volume" and "we lost the volume and every
 * fact the assistant knew about us".
 */
async function weeklyDump(): Promise<string> {
  const cfg = getConfig()

  try {
    await mkdir(BACKUP_DIR, { recursive: true })
  } catch (err) {
    return `skipped — ${BACKUP_DIR} is not writable (${describe(err)})`
  }

  const existing = await listBackups(BACKUP_DIR)
  const newest = existing[0]
  if (newest && Date.now() - newest.mtimeMs < BACKUP_INTERVAL_DAYS * DAY_MS) {
    const ageDays = Math.floor((Date.now() - newest.mtimeMs) / DAY_MS)
    return `not due — newest dump ${newest.name} is ${ageDays} ${ageDays === 1 ? 'day' : 'days'} old`
  }

  const stamp = DateTime.now().toUTC().toFormat("yyyy-LL-dd'T'HHmm")
  const env = pgEnvFromUrl(cfg.DATABASE_URL, cfg.isProd)

  let written: string | null = null
  let how = ''

  if (env) {
    const sqlPath = join(BACKUP_DIR, `household-${stamp}.sql`)
    const probe = await runCommand('pg_dump', ['--version'], env, 10_000)
    if (probe.ok) {
      const dump = await runCommand(
        'pg_dump',
        ['--no-owner', '--no-privileges', '--format=plain', '--file', sqlPath],
        env,
        PG_DUMP_TIMEOUT_MS,
      )
      if (dump.ok) {
        written = sqlPath
        how = 'pg_dump'
      } else {
        log.error({ code: dump.code, stderr: dump.stderr, error: dump.error }, 'pg_dump failed')
        await rm(sqlPath, { force: true }).catch(() => {})
      }
    } else {
      log.info({ error: probe.error }, 'pg_dump is not available; writing a JSON export instead')
    }
  } else {
    log.warn('DATABASE_URL could not be parsed for pg_dump; writing a JSON export instead')
  }

  if (!written) {
    const jsonPath = join(BACKUP_DIR, `household-${stamp}.json`)
    await writeFile(jsonPath, await jsonExport(), 'utf8')
    written = jsonPath
    how = 'JSON export'
  }

  let size = 0
  try {
    size = (await stat(written)).size
  } catch {
    // The dump exists; we just could not measure it.
  }

  // Retention runs against a fresh listing so the file just written is counted.
  const all = await listBackups(BACKUP_DIR)
  const stale = all.slice(BACKUP_KEEP)
  for (const old of stale) {
    try {
      await rm(old.path, { force: true })
    } catch (err) {
      log.warn({ err, file: old.name }, 'could not remove an old dump')
    }
  }

  const kb = Math.max(1, Math.round(size / 1024))
  return `wrote ${how} to ${written} (${kb} KB), keeping ${Math.min(all.length, BACKUP_KEEP)}, removed ${stale.length}`
}

/* ══════════════════════════════════════════════════════════════════════════
   The sweep
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Nightly maintenance. Runs every step even when earlier ones fail, then writes
 * one audit row describing the whole pass.
 */
export async function runHygiene(): Promise<void> {
  const started = Date.now()

  let retentionDays = 90
  try {
    retentionDays = getConfig().AUDIT_RETENTION_DAYS
  } catch (err) {
    log.error({ err }, 'config unavailable; using a 90-day audit retention')
  }
  if (!Number.isFinite(retentionDays) || retentionDays < 1) retentionDays = 90

  const results: string[] = []
  results.push(await step('audit-log', () => pruneAuditLog(retentionDays)))
  results.push(await step('pending-actions', expireApprovals))
  results.push(await step('extracted-events', compactExtractedEvents))
  results.push(await step('vacuum', vacuumBusyTables))
  results.push(await step('backup', weeklyDump))

  const durationMs = Date.now() - started
  const failures = results.filter((r) => r.includes('FAILED')).length

  log.info({ durationMs, failures }, 'hygiene sweep finished')
  await audit({
    actor: 'system',
    event: 'hygiene.run',
    resultSummary: results.join(' · ').slice(0, 1000),
    args: { durationMs, retentionDays, steps: results },
    ok: failures === 0,
  })
}
