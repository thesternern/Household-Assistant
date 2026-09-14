import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../src/tools/types.js'

/**
 * The contact scan is capped and unordered, so Postgres decides which rows come
 * back. That cap has opposite meanings for the two lists it used to fill:
 *
 *  - `all` *grants* permission. A premium-rate or international number is only
 *    dialable because the book already holds it, so truncation fails closed.
 *  - `household` *denies* it. Truncation there fails open — a household member
 *    outside the returned rows silently becomes dialable.
 *
 * So the household numbers are read by their own unlimited query. This suite
 * pins that: the fake database hands the capped read a scan that does not
 * contain Sam, and the unlimited read the row that does.
 */

const H = vi.hoisted(() => ({
  audits: [] as Array<Record<string, unknown>>,
}))

vi.mock('../src/config.js', () => ({ getConfig: () => ({}) }))

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const l: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop }
  l.child = () => l
  return { logger: l, child: () => l }
})

vi.mock('../src/audit/log.js', () => ({
  audit: async (entry: Record<string, unknown>) => {
    H.audits.push(entry)
  },
}))

vi.mock('../src/policy/pending.js', () => ({ hasApprovedAction: async () => true }))

const SAM = '+16045550243'

/** 500 saved numbers, none of them Sam's — a full scan with her outside it. */
const SCAN_ROWS = Array.from({ length: 500 }, (_, i) => ({ phone: `+1604555${1000 + i}` }))
const HOUSEHOLD_ROWS = [{ phone: SAM }]

type PhoneRows = Array<{ phone: string | null }>

vi.mock('../src/db/client.js', async () => {
  const realSchema = await vi.importActual<typeof import('../src/db/schema.js')>('../src/db/schema.js')
  return {
    getDb: () => ({
      select: () => ({
        from: () => ({
          // Awaited as it stands, this is the unlimited household read. Asked
          // for a `.limit()`, it is the capped contact scan. The distinction is
          // exactly the one the fix introduces.
          where: () => {
            const query = Promise.resolve(HOUSEHOLD_ROWS as PhoneRows) as Promise<PhoneRows> & {
              limit: (n: number) => Promise<PhoneRows>
            }
            query.limit = () => Promise.resolve(SCAN_ROWS as PhoneRows)
            return query
          },
        }),
      }),
    }),
    getPool: () => ({}),
    closeDb: async () => {},
    schema: realSchema,
  }
})

vi.mock('../src/jobs/queue.js', () => ({
  QUEUES: {
    tgUpdate: 'tg-update',
    vapiEvent: 'vapi-event',
    executeAction: 'execute-action',
    fireReminder: 'fire-reminder',
    agentTask: 'agent-task',
    watcherPoll: 'watcher-poll',
    browserTask: 'browser-task',
  },
  getBoss: async () => ({
    send: async () => 'job-immediate',
    sendAfter: async () => 'job-delayed',
  }),
  enqueueAgentTask: async () => 'job-agent',
}))

const { phonePlaceCall } = await import('../src/tools/phone.js')

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  chatId: '4242',
  actor: 'Alex',
  origin: 'executor',
  pendingActionId: 11,
  ...over,
})

describe('the household list survives a truncated contact scan', () => {
  it('refuses a household number the capped scan never returned', async () => {
    H.audits.length = 0

    const result = await phonePlaceCall.handler(
      {
        goal: 'Ask whether she wants anything picked up on the way home tonight.',
        callee_number: SAM,
        callee_name: 'Sam',
      },
      ctx(),
    )

    expect(result.isError).toBe(true)
    const text = result.content.map((p) => p.text).join('\n')
    expect(text).toMatch(/household/i)
    expect(H.audits.map((a) => a.event)).toEqual(['call.refused'])
  })
})
