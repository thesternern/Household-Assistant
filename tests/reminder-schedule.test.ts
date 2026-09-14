/**
 * The two writes behind a reminder must agree: the `reminders` row is the
 * record, the pg-boss job is the delivery. These tests pin the plumbing —
 * `reminder_set` books the job and stores its id on the row (and cancels the
 * row when booking fails), and `reminder_cancel` cancels that exact job on the
 * `fire-reminder` queue rather than only flipping the row's status.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { ToolContext, ToolDef } from '../src/tools/types.js'

const { dbRef, auditMock, enqueueMock, cancelMock } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  auditMock: vi.fn(async () => {}),
  enqueueMock: vi.fn(async (_reminderId: number, _fireAt: Date): Promise<string | null> => 'job-1'),
  cancelMock: vi.fn(async () => {}),
}))

vi.mock('../src/db/client.js', async () => {
  const schema = await import('../src/db/schema.js')
  return { getDb: () => dbRef.current, schema }
})
vi.mock('../src/audit/log.js', () => ({ audit: auditMock }))
vi.mock('../src/config.js', () => ({
  getConfig: () => ({ HOUSEHOLD_TIMEZONE: 'America/Los_Angeles' }),
}))
vi.mock('../src/jobs/queue.js', () => ({
  QUEUES: { fireReminder: 'fire-reminder' },
  enqueueReminder: enqueueMock,
  getBoss: async () => ({ cancel: cancelMock }),
}))
vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const l: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop }
  l.child = () => l
  return { logger: l }
})

const { reminderTools } = await import('../src/tools/reminders.js')

/* ─────────────────────────── in-memory reminders table ───────────────────── */

const dialect = new PgDialect()

interface ReminderRow {
  id: number
  text: string
  fireAt: Date
  recurrence: string | null
  bossJobId: string | null
  telegramChatId: string
  status: string
  createdBy: string | null
  createdAt: Date
}

class FakeReminderDb {
  rows: ReminderRow[] = []
  private nextId = 1

  private render(where: SQL | undefined): { sql: string; params: unknown[] } {
    if (!where) return { sql: '', params: [] }
    const q = dialect.sqlToQuery(where)
    return { sql: q.sql, params: q.params as unknown[] }
  }

  private filter(where: SQL | undefined): ReminderRow[] {
    const { sql, params } = this.render(where)
    let rows = [...this.rows]
    const id = /"id" = \$(\d+)/.exec(sql)
    if (id) {
      const want = Number(params[Number(id[1]) - 1])
      rows = rows.filter((row) => row.id === want)
    }
    const status = /"status" = \$(\d+)/.exec(sql)
    if (status) {
      const want = String(params[Number(status[1]) - 1])
      rows = rows.filter((row) => row.status === want)
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
      values: (v: Partial<ReminderRow>) => ({
        returning: async () => {
          const row: ReminderRow = {
            id: this.nextId++,
            text: v.text ?? '',
            fireAt: v.fireAt ?? new Date(),
            recurrence: v.recurrence ?? null,
            bossJobId: v.bossJobId ?? null,
            telegramChatId: v.telegramChatId ?? '',
            status: v.status ?? 'scheduled',
            createdBy: v.createdBy ?? null,
            createdAt: new Date(),
          }
          this.rows.push(row)
          return [{ ...row }]
        },
      }),
    }
  }

  update() {
    return {
      set: (patch: Partial<ReminderRow>) => ({
        // Like the real Drizzle builder, the result both is thenable (an
        // `await` with no `.returning()` still executes, as the failure path
        // in reminder_set relies on) and offers `.returning()`.
        where: (where: SQL | undefined) => {
          const run = () => {
            const matched = this.filter(where)
            for (const row of matched) Object.assign(row, patch)
            return matched.map((row) => ({ ...row }))
          }
          return {
            returning: async () => run(),
            then: (
              resolve: (rows: ReminderRow[]) => void,
              reject: (reason?: unknown) => void,
            ) => Promise.resolve().then(run).then(resolve, reject),
          }
        },
      }),
    }
  }
}

/* ──────────────────────────────── the tests ──────────────────────────────── */

function tool(name: string): ToolDef {
  const found = reminderTools.find((t: ToolDef) => t.name === name)
  if (!found) throw new Error(`${name} is not registered`)
  return found
}

const reminderSet = tool('reminder_set')
const reminderCancel = tool('reminder_cancel')

const ctx: ToolContext = { chatId: '42', actor: 'Alex', origin: 'agent' }

let fake: FakeReminderDb

beforeEach(() => {
  fake = new FakeReminderDb()
  dbRef.current = fake
  auditMock.mockClear()
  enqueueMock.mockClear()
  enqueueMock.mockResolvedValue('job-1')
  cancelMock.mockClear()
})

describe('reminder_set — schedules the job and stores its id', () => {
  it('books a pg-boss job for the parsed instant and stores the job id on the row', async () => {
    enqueueMock.mockResolvedValue('job-123')
    const result = await reminderSet.handler({ text: 'Take out the trash', when: 'tomorrow 8am' }, ctx)

    expect(result.isError).not.toBe(true)
    expect(enqueueMock).toHaveBeenCalledTimes(1)
    const call = enqueueMock.mock.calls[0]
    if (!call) throw new Error('expected an enqueue call')
    const [reminderId, fireAt] = call
    expect(reminderId).toBe(1)
    expect(fireAt).toBeInstanceOf(Date)
    expect(fireAt.getTime()).toBeGreaterThan(Date.now())

    const row = fake.rows[0]
    if (!row) throw new Error('expected a stored row')
    expect(row.bossJobId).toBe('job-123')
    expect(row.status).toBe('scheduled')
    expect(row.fireAt.getTime()).toBe(fireAt.getTime())
    expect(row.telegramChatId).toBe('42')
  })

  it('cancels the row and reports failure when the job cannot be booked', async () => {
    enqueueMock.mockResolvedValue(null)
    const result = await reminderSet.handler({ text: 'Water the plants', when: 'in 2 hours' }, ctx)

    // No job, no promise: the caller must hear that nothing was scheduled…
    expect(result.isError).toBe(true)
    // …and the row must not be left `scheduled` for the worker to find.
    expect(fake.rows[0]?.status).toBe('cancelled')
    expect(fake.rows[0]?.bossJobId).toBeNull()
  })

  it('refuses a past time before touching the database or the queue', async () => {
    const result = await reminderSet.handler({ text: 'Too late', when: '2020-01-01 09:00' }, ctx)
    expect(result.isError).toBe(true)
    expect(fake.rows).toHaveLength(0)
    expect(enqueueMock).not.toHaveBeenCalled()
  })
})

describe('reminder_cancel — cancels the job, not just the row', () => {
  it('cancels the stored pg-boss job on the fire-reminder queue', async () => {
    enqueueMock.mockResolvedValue('job-9')
    await reminderSet.handler({ text: 'Call the dentist', when: 'tomorrow 3pm' }, ctx)

    const result = await reminderCancel.handler({ id: 1 }, ctx)
    expect(result.isError).not.toBe(true)
    expect(fake.rows[0]?.status).toBe('cancelled')
    expect(cancelMock).toHaveBeenCalledTimes(1)
    expect(cancelMock).toHaveBeenCalledWith('fire-reminder', 'job-9')
  })

  it('does not re-cancel a reminder that is already cancelled', async () => {
    enqueueMock.mockResolvedValue('job-9')
    await reminderSet.handler({ text: 'Call the dentist', when: 'tomorrow 3pm' }, ctx)
    await reminderCancel.handler({ id: 1 }, ctx)
    cancelMock.mockClear()

    const again = await reminderCancel.handler({ id: 1 }, ctx)
    expect(again.isError).not.toBe(true)
    expect((again.structuredContent as { changed: boolean }).changed).toBe(false)
    expect(cancelMock).not.toHaveBeenCalled()
  })

  it('reports a missing reminder id as an error', async () => {
    const result = await reminderCancel.handler({ id: 99 }, ctx)
    expect(result.isError).toBe(true)
  })
})
