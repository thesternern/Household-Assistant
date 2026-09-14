import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The property under test: retiring a watcher undoes what it put on the
 * calendar, and does so without ever leaving a half-cleaned row behind.
 *
 * The interesting cases are the failure ones. Google answering 404 means the
 * entry is already gone, which is success. Google answering 500 means we do
 * not know, so the `calendar_event_id` must survive for a retry and the
 * watcher must not be deleted — losing the handle would strand the residue.
 */

interface FakeRow {
  id: number
  watcherId: number
  title: string
  calendarEventId: string | null
  reminderId: number | null
  todoId: number | null
}

const H = vi.hoisted(() => {
  const store = {
    rows: [] as FakeRow[],
    watcher: null as { id: number; name: string; type: string; active: boolean } | null,
    /** eventId -> what Google should do when asked to delete it. */
    googleBehaviour: new Map<string, 'ok' | 'missing' | 'boom'>(),
    connected: true,
  }

  const updates: Array<{ table: string; set: Record<string, unknown>; id: number }> = []
  const deletes: string[] = []

  return {
    store,
    updates,
    deletes,
    audit: vi.fn(async () => {}),
    getWatcher: vi.fn(async (id: number) =>
      store.watcher && store.watcher.id === id ? { ...store.watcher } : undefined,
    ),
    setWatcherActive: vi.fn(async (id: number, active: boolean) => {
      if (store.watcher && store.watcher.id === id) store.watcher.active = active
      return store.watcher ? { ...store.watcher } : null
    }),
    deleteWatcher: vi.fn(async (id: number) => {
      if (!store.watcher || store.watcher.id !== id) return null
      const gone = { ...store.watcher }
      store.watcher = null
      return gone
    }),
    familyCalendarId: vi.fn(async () => 'family-cal'),
    calendar: vi.fn(async () =>
      store.connected
        ? {
            events: {
              delete: vi.fn(async ({ eventId }: { calendarId: string; eventId: string }) => {
                const behaviour = store.googleBehaviour.get(eventId) ?? 'ok'
                if (behaviour === 'missing') throw Object.assign(new Error('gone'), { code: 410 })
                if (behaviour === 'boom') throw Object.assign(new Error('nope'), { code: 500 })
                deletes.push(eventId)
                return {}
              }),
            },
          }
        : null,
    ),
  }
})

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const l: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop }
  l.child = () => l
  return { logger: l, child: () => l }
})

vi.mock('../src/audit/log.js', () => ({ audit: H.audit }))

vi.mock('../src/watchers/index.js', () => ({
  getWatcher: H.getWatcher,
  setWatcherActive: H.setWatcherActive,
  deleteWatcher: H.deleteWatcher,
}))

vi.mock('../src/integrations/google.js', () => ({
  calendar: H.calendar,
  familyCalendarId: H.familyCalendarId,
  isMissingOnGoogle: (err: unknown) => {
    const code = (err as { code?: unknown } | null)?.code ?? null
    return code === 404 || code === 410
  },
}))

/**
 * A fake just wide enough for the two statements this module issues: read the
 * extracted events for one watcher, then update rows by id. Every update is
 * recorded so the tests can assert on what was written rather than on how.
 */
vi.mock('../src/db/client.js', async () => {
  const schema = await import('../src/db/schema.js')
  const tableName = (table: unknown): string =>
    table === schema.reminders ? 'reminders' : 'extracted_events'

  const db = {
    select: () => ({
      from: () => ({
        where: async () => H.store.rows.map((r) => ({ ...r })),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async (clause: unknown) => {
          // The id is the only bound parameter in every where this module builds.
          const { PgDialect } = await import('drizzle-orm/pg-core')
          const q = new PgDialect().sqlToQuery(clause as never)
          H.updates.push({
            table: tableName(table),
            set: values,
            id: Number((q.params as unknown[])[0]),
          })
          return []
        },
      }),
    }),
  }
  return { getDb: () => db as unknown as never, schema }
})

const { retireWatcher } = await import('../src/ops/retire-watcher.js')

function seed(rows: Array<Partial<FakeRow>>): void {
  H.store.rows = rows.map((r, i) => ({
    id: r.id ?? i + 1,
    watcherId: 7,
    title: r.title ?? `event ${i + 1}`,
    calendarEventId: r.calendarEventId ?? null,
    reminderId: r.reminderId ?? null,
    todoId: r.todoId ?? null,
  }))
}

beforeEach(() => {
  H.store.watcher = { id: 7, name: 'Garbage day', type: 'ics', active: true }
  H.store.googleBehaviour = new Map()
  H.store.connected = true
  H.store.rows = []
  H.updates.length = 0
  H.deletes.length = 0
  vi.clearAllMocks()
})

describe('retireWatcher', () => {
  it('deletes every calendar entry and cancels every reminder', async () => {
    seed([
      { id: 1, calendarEventId: 'g1', reminderId: 101 },
      { id: 2, calendarEventId: 'g2', reminderId: 102 },
      { id: 3, calendarEventId: 'g3', reminderId: null },
    ])

    const summary = await retireWatcher(7)

    expect(H.deletes).toEqual(['g1', 'g2', 'g3'])
    expect(summary.calendarRemoved).toBe(3)
    expect(summary.remindersCancelled).toBe(2)
    expect(summary.failures).toEqual([])

    const cancelled = H.updates.filter((u) => u.table === 'reminders')
    expect(cancelled.map((u) => u.id).sort()).toEqual([101, 102])
    expect(cancelled.every((u) => u.set.status === 'cancelled')).toBe(true)

    const cleared = H.updates.filter((u) => u.table === 'extracted_events')
    expect(cleared.map((u) => u.id).sort()).toEqual([1, 2, 3])
    expect(cleared.every((u) => u.set.calendarEventId === null)).toBe(true)
  })

  it('treats an entry Google no longer has as already removed', async () => {
    seed([{ id: 1, calendarEventId: 'g1', reminderId: 101 }])
    H.store.googleBehaviour.set('g1', 'missing')

    const summary = await retireWatcher(7)

    expect(summary.calendarRemoved).toBe(0)
    expect(summary.calendarAlreadyGone).toBe(1)
    expect(summary.failures).toEqual([])
    // The row is still cleaned up: the entry is gone either way.
    expect(H.updates.some((u) => u.table === 'extracted_events' && u.id === 1)).toBe(true)
    expect(summary.remindersCancelled).toBe(1)
  })

  it('keeps the calendar id and the watcher when Google fails for an unknown reason', async () => {
    seed([
      { id: 1, calendarEventId: 'g1', reminderId: 101 },
      { id: 2, calendarEventId: 'g2', reminderId: 102 },
    ])
    H.store.googleBehaviour.set('g1', 'boom')

    const summary = await retireWatcher(7, { remove: true })

    expect(summary.failures).toHaveLength(1)
    expect(summary.failures[0]?.extractedEventId).toBe(1)
    // The failed row keeps its id so the retry can find it.
    expect(H.updates.some((u) => u.table === 'extracted_events' && u.id === 1)).toBe(false)
    // Its reminder is left alone too — the entry is still on the calendar.
    expect(H.updates.some((u) => u.table === 'reminders' && u.id === 101)).toBe(false)
    // The healthy row is still cleaned.
    expect(summary.calendarRemoved).toBe(1)
    // A partial clean never deletes the watcher, even when asked to.
    expect(H.deleteWatcher).not.toHaveBeenCalled()
    expect(summary.watcherState).toBe('deactivated')
  })

  it('deactivates the watcher by default and deletes it only on request', async () => {
    seed([{ id: 1, calendarEventId: 'g1' }])
    const deactivated = await retireWatcher(7)
    expect(deactivated.watcherState).toBe('deactivated')
    expect(H.deleteWatcher).not.toHaveBeenCalled()

    H.store.watcher = { id: 7, name: 'Garbage day', type: 'ics', active: true }
    seed([{ id: 1, calendarEventId: 'g1' }])
    const removed = await retireWatcher(7, { remove: true })
    expect(removed.watcherState).toBe('deleted')
    expect(H.deleteWatcher).toHaveBeenCalledWith(7)
  })

  it('changes nothing on a dry run but still reports the work', async () => {
    seed([
      { id: 1, calendarEventId: 'g1', reminderId: 101 },
      { id: 2, calendarEventId: 'g2', reminderId: 102, todoId: 55 },
    ])

    const summary = await retireWatcher(7, { dryRun: true, remove: true })

    expect(summary.calendarRemoved).toBe(2)
    expect(summary.remindersCancelled).toBe(2)
    expect(summary.todosKept).toBe(1)
    expect(summary.watcherState).toBe('unchanged')
    expect(H.deletes).toEqual([])
    expect(H.updates).toEqual([])
    expect(H.deleteWatcher).not.toHaveBeenCalled()
    expect(H.setWatcherActive).not.toHaveBeenCalled()
    expect(H.audit).not.toHaveBeenCalled()
  })

  it('refuses to start when Google is not connected and there is calendar work', async () => {
    seed([{ id: 1, calendarEventId: 'g1' }])
    H.store.connected = false

    await expect(retireWatcher(7)).rejects.toThrow(/google/i)
    expect(H.updates).toEqual([])
    expect(H.setWatcherActive).not.toHaveBeenCalled()
  })

  it('still retires a watcher that never touched the calendar', async () => {
    seed([{ id: 1, calendarEventId: null, todoId: 9 }])
    H.store.connected = false

    const summary = await retireWatcher(7)

    expect(summary.calendarRemoved).toBe(0)
    expect(summary.todosKept).toBe(1)
    expect(summary.watcherState).toBe('deactivated')
  })

  it('rejects an unknown watcher', async () => {
    await expect(retireWatcher(99)).rejects.toThrow(/99/)
  })
})
