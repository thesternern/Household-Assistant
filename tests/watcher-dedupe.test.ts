/**
 * Dedupe is the property that decides whether the watcher pipeline is usable at
 * all. The email cron runs every fifteen minutes and the ICS cron runs daily
 * over a feed that mostly does not change, so almost every poll re-reads things
 * it has already seen. Get this wrong and the family calendar fills with
 * duplicate picture days.
 *
 * Two claims are tested here:
 *
 *  1. `contentHash` is stable across re-polls of the same message, and moves
 *     when the date moves.
 *  2. `ingestItems` writes one `extracted_events` row per distinct item, no
 *     matter how many times it is handed the same one — enforced by the unique
 *     index on `content_hash`, which the fake database below actually applies.
 *
 * The fake database is deliberately strict about that index and about one other
 * thing: inserting into `pending_actions` throws. A watcher that raises an
 * approval card is an attacker asking the household for permission, so the test
 * harness treats it as a hard failure rather than an assertion at the end.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtractedItem } from '../src/watchers/extract.js'

/* ─────────────────────────────────── mocks ───────────────────────────────── */

const H = vi.hoisted(() => ({
  extracted: [] as Array<Record<string, unknown>>,
  nextRowId: 1,
  nextEventId: 1,
  nextChildId: 1,
  policies: [] as Array<Record<string, unknown>>,
  pendingInserts: [] as unknown[],
  toolCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  digests: [] as Array<{ text: string; opts?: unknown }>,
  config: {
    HOUSEHOLD_TIMEZONE: 'America/Los_Angeles',
    ANTHROPIC_API_KEY: 'test-key',
    EXTRACTION_MODEL: 'test-model',
    PURCHASE_MONTHLY_CAP: 200,
  } as Record<string, unknown>,
}))

vi.mock('../src/config.js', () => ({ getConfig: () => H.config }))

vi.mock('../src/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
  return { logger: { ...logger, child: () => logger }, child: () => logger }
})

vi.mock('../src/audit/log.js', () => ({ audit: async () => undefined }))

vi.mock('../src/telegram/send.js', () => ({
  md: {
    escape: (s: string) => s,
    bold: (s: string) => s,
    italic: (s: string) => s,
    code: (s: string) => s,
  },
  escapeMd: (s: string) => s,
  chunk: (s: string) => [s],
  primaryChatId: async () => '99',
  sendToChat: async () => [],
  sendToAll: async (text: string, opts?: unknown) => {
    H.digests.push({ text, opts })
  },
  editMessage: async () => undefined,
  getBot: () => ({}),
}))

/**
 * A tool registry with just the tools the watcher pipeline may reach. Each
 * handler records the call so a test can assert on what actually ran.
 */
vi.mock('../src/tools/registry.js', () => {
  const record = (name: string, structured: () => Record<string, unknown>) => ({
    name,
    description: name,
    schema: {},
    consequential: false,
    summarize: () => name,
    handler: async (args: Record<string, unknown>) => {
      H.toolCalls.push({ name, args })
      return { content: [{ type: 'text' as const, text: 'ok' }], structuredContent: structured() }
    },
  })

  const tools = new Map<string, unknown>([
    [
      'calendar_create_event_from_watcher',
      {
        ...record('calendar_create_event_from_watcher', () => ({
          eventId: `gcal-${H.nextEventId++}`,
        })),
        category: 'calendar_write_from_watcher',
      },
    ],
    [
      'todo_add',
      {
        ...record('todo_add', () => ({ todo: { id: H.nextChildId++ } })),
        category: 'todo_write',
      },
    ],
    [
      'reminder_set',
      {
        ...record('reminder_set', () => ({ reminder: { id: H.nextChildId++ } })),
        category: 'reminder_write',
      },
    ],
    [
      'reminder_cancel',
      { ...record('reminder_cancel', () => ({ changed: true })), category: 'reminder_write' },
    ],
  ])

  return {
    getTool: (name: string) => tools.get(name),
    allTools: () => [...tools.values()],
    toolNamesForCategories: () => [],
    buildHouseholdMcpServer: () => ({}),
  }
})

vi.mock('../src/db/client.js', async () => {
  const schema = await vi.importActual<typeof import('../src/db/schema.js')>('../src/db/schema.js')

  const nameOf = new Map<unknown, string>([
    [schema.extractedEvents, 'extractedEvents'],
    [schema.watchers, 'watchers'],
    [schema.policies, 'policies'],
    [schema.pendingActions, 'pendingActions'],
    [schema.auditLog, 'auditLog'],
    [schema.reminders, 'reminders'],
    [schema.todos, 'todos'],
  ])

  const rowsFor = (key: string): Array<Record<string, unknown>> => {
    if (key === 'extractedEvents') return H.extracted
    if (key === 'policies') return H.policies
    return []
  }

  type Any = Record<string, unknown>

  const makeSelect = () => {
    let key = 'unknown'
    const builder: Any = {
      from(table: unknown) {
        key = nameOf.get(table) ?? 'unknown'
        return builder
      },
      where: () => builder,
      limit: () => builder,
      orderBy: () => builder,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(rowsFor(key)).then(resolve, reject),
    }
    return builder
  }

  /**
   * The real `extracted_events_hash_uq` index, applied for real. Without
   * `onConflictDoNothing` a repeat insert throws, exactly as Postgres would.
   */
  const doInsert = (key: string, values: Any, tolerateConflict: boolean): Any[] => {
    if (key === 'pendingActions') {
      H.pendingInserts.push(values)
      throw new Error('a watcher must never create a pending action')
    }
    if (key !== 'extractedEvents') return []

    const hash = values.contentHash
    const clash = H.extracted.some((row) => row.contentHash === hash)
    if (clash) {
      if (tolerateConflict) return []
      throw new Error('duplicate key value violates unique constraint "extracted_events_hash_uq"')
    }
    const row = { id: H.nextRowId++, ...values }
    H.extracted.push(row)
    return [row]
  }

  const db = {
    select: () => makeSelect(),
    insert(table: unknown) {
      const key = nameOf.get(table) ?? 'unknown'
      return {
        values(values: Any) {
          const run = (tolerate: boolean) => Promise.resolve().then(() => doInsert(key, values, tolerate))
          const conflictBuilder = {
            returning: () => run(true),
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              run(true).then(resolve, reject),
          }
          return {
            onConflictDoNothing: () => conflictBuilder,
            onConflictDoUpdate: () => conflictBuilder,
            returning: () => run(false),
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              run(false).then(resolve, reject),
          }
        },
      }
    },
    update(table: unknown) {
      const key = nameOf.get(table) ?? 'unknown'
      return {
        set(values: Any) {
          // The fake cannot evaluate a where clause, so an update to
          // extracted_events patches the most recent row, which is the one the
          // pipeline is always linking up.
          const apply = (): Any[] => {
            if (key !== 'extractedEvents') return []
            const row = H.extracted[H.extracted.length - 1]
            if (row === undefined) return []
            Object.assign(row, values)
            return [row]
          }
          const builder: Any = {
            where: () => builder,
            returning: () => Promise.resolve().then(apply),
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              Promise.resolve().then(apply).then(resolve, reject),
          }
          return builder
        },
      }
    },
    delete: () => ({
      where: () => ({ returning: () => Promise.resolve([]) }),
    }),
  }

  return { getDb: () => db, getPool: () => ({}), closeDb: async () => undefined, schema }
})

/* ─────────────────────────────── system under test ───────────────────────── */

const { contentHash } = await import('../src/watchers/extract.js')
const { ingestItems, CANONICAL_TYPE, TYPES_BY_KIND, kindOfType } = await import(
  '../src/watchers/pipeline.js'
)

/** Far enough out that the reminders are always in the future. */
const FUTURE = '2099-09-12'
const LATER = '2099-09-19'

const pictureDay: ExtractedItem = {
  kind: 'event',
  title: 'Picture day',
  date: FUTURE,
  time: '09:00',
  notes: 'Wear school colours.',
}

beforeEach(() => {
  H.extracted.length = 0
  H.pendingInserts.length = 0
  H.toolCalls.length = 0
  H.digests.length = 0
  H.policies.length = 0
  H.nextRowId = 1
  H.nextEventId = 1
  H.nextChildId = 1
})

/* ──────────────────────────────── the hash ───────────────────────────────── */

describe('contentHash', () => {
  it('is stable across re-polls of the same message', () => {
    expect(contentHash(4, 'msg-1', pictureDay)).toBe(contentHash(4, 'msg-1', { ...pictureDay }))
  })

  it('ignores the cosmetic differences between a newsletter and its resend', () => {
    const resend: ExtractedItem = { ...pictureDay, title: '  PICTURE  DAY!  ' }
    expect(contentHash(4, 'msg-1', resend)).toBe(contentHash(4, 'msg-1', pictureDay))
  })

  it('changes when the date moves', () => {
    const moved: ExtractedItem = { ...pictureDay, date: LATER }
    expect(contentHash(4, 'msg-1', moved)).not.toBe(contentHash(4, 'msg-1', pictureDay))
  })

  it('changes when the title, the message, or the watcher changes', () => {
    const base = contentHash(4, 'msg-1', pictureDay)
    expect(contentHash(4, 'msg-1', { ...pictureDay, title: 'Sports day' })).not.toBe(base)
    expect(contentHash(4, 'msg-2', pictureDay)).not.toBe(base)
    expect(contentHash(5, 'msg-1', pictureDay)).not.toBe(base)
  })

  it('does not let an invisible character forge a second copy of one event', () => {
    // Both of these render as "Picture day". A zero-width space inside a word
    // must not buy a second calendar entry that looks identical to the first.
    const smuggled: ExtractedItem = { ...pictureDay, title: 'Pic\u200Bture day' }
    const plain: ExtractedItem = { ...pictureDay, title: 'Picture day' }
    expect(contentHash(4, 'msg-1', smuggled)).toBe(contentHash(4, 'msg-1', plain))
  })
})

/* ────────────────────────────── the ingest path ──────────────────────────── */

describe('ingestItems dedupe', () => {
  const poll = () =>
    ingestItems({
      watcherId: 4,
      watcherName: 'Daycare',
      sourceRef: 'msg-1',
      sourceLabel: 'Daycare email, 2026-09-01',
      items: [pictureDay],
    })

  it('writes one row when the same message is polled twice', async () => {
    const first = await poll()
    expect(first.added).toHaveLength(1)
    expect(first.duplicates).toBe(0)
    expect(H.extracted).toHaveLength(1)

    const second = await poll()
    expect(second.added).toHaveLength(0)
    expect(second.duplicates).toBe(1)
    expect(H.extracted).toHaveLength(1)
  })

  it('creates the calendar event only once across those two polls', async () => {
    await poll()
    await poll()
    const calendarCalls = H.toolCalls.filter(
      (call) => call.name === 'calendar_create_event_from_watcher',
    )
    expect(calendarCalls).toHaveLength(1)
  })

  it('books the evening-before and morning-of reminders for the one event', async () => {
    await poll()
    const reminders = H.toolCalls.filter((call) => call.name === 'reminder_set')
    expect(reminders).toHaveLength(2)
    expect(reminders[0]?.args.when).toBe('2099-09-11 18:00')
    expect(reminders[1]?.args.when).toBe('2099-09-12 07:30')
  })

  it('writes a second row when the date moves', async () => {
    await poll()

    const moved = await ingestItems({
      watcherId: 4,
      watcherName: 'Daycare',
      sourceRef: 'msg-1',
      sourceLabel: 'Daycare email, 2026-09-05',
      items: [{ ...pictureDay, date: LATER }],
    })

    expect(moved.added).toHaveLength(1)
    expect(moved.duplicates).toBe(0)
    expect(H.extracted).toHaveLength(2)
    expect(H.extracted.map((row) => row.eventDate)).toEqual([FUTURE, LATER])
  })

  it('links the calendar event id and a reminder id onto the row', async () => {
    await poll()
    const row = H.extracted[0]
    expect(row?.calendarEventId).toBe('gcal-1')
    expect(typeof row?.reminderId).toBe('number')
  })

  it('routes an undated action item to the to-do list, not the calendar', async () => {
    const outcome = await ingestItems({
      watcherId: 4,
      watcherName: 'Daycare',
      sourceRef: 'msg-2',
      sourceLabel: 'Daycare email',
      items: [{ kind: 'todo', title: 'Sign the photo consent form' }],
    })

    expect(outcome.added).toHaveLength(1)
    expect(H.toolCalls.map((call) => call.name)).toEqual(['todo_add'])
    expect(H.extracted[0]?.kind).toBe('todo')
  })

  it('never creates a pending action', async () => {
    await poll()
    await poll()
    expect(H.pendingInserts).toEqual([])
  })
})

/* ─────────────────────────── canonical type routing ──────────────────────── */

describe('canonical watcher types', () => {
  it('keeps every canonical stored type inside its own poll list', () => {
    // The cron sweep in src/jobs/crons.ts selects rows by TYPES_BY_KIND, and
    // createWatcher stores CANONICAL_TYPE. If a canonical type ever fell out of
    // its list, every watcher created through watcher_add would silently stop
    // being polled — which is exactly what happened when the sweep kept its own
    // copy of the email list without 'email_sender'.
    for (const kind of ['email', 'ics', 'portal', 'reply'] as const) {
      expect(TYPES_BY_KIND[kind]).toContain(CANONICAL_TYPE[kind])
      expect(kindOfType(CANONICAL_TYPE[kind])).toBe(kind)
    }
  })

  it('routes the canonical email type to the email poller', () => {
    expect(kindOfType('email_sender')).toBe('email')
    expect(TYPES_BY_KIND.email).toContain('email_sender')
  })
})
