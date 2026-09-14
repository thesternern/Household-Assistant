import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../src/tools/types.js'

/* ══════════════════════ mocks for the fail-closed handler test ═══════════════ */
//
// `phone_place_call`'s handler pulls in `../integrations/vapi.js`, which pulls
// in `../jobs/queue.js`, which pulls in most of the app (the agent loop, the
// executor, Telegram). None of that runs on the path this suite exercises —
// the household read throws before any of it is reached — so it is cut off at
// the same seam `tests/vapi-dry-run.test.ts` uses, rather than allowed to
// load for real.

const H = vi.hoisted(() => ({
  approved: true,
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

vi.mock('../src/policy/pending.js', () => ({ hasApprovedAction: async () => H.approved }))

// The contact-book read throws no matter what it is asked for.
vi.mock('../src/db/client.js', async () => {
  const realSchema = await vi.importActual<typeof import('../src/db/schema.js')>(
    '../src/db/schema.js',
  )
  return {
    getDb: () => {
      throw new Error('connection refused')
    },
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

const { validateCalleeNumber, phonePlaceCall } = await import('../src/tools/phone.js')

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  chatId: '4242',
  actor: 'Alex',
  origin: 'executor',
  pendingActionId: 11,
  ...over,
})

/**
 * Sam's number is in the address book so Chessy can give it to a doctor's
 * office. It is not there so she can dial it.
 *
 * The check sits inside `validateCalleeNumber` rather than beside it, because
 * that function is the one gate every call already passes through. A second
 * check somewhere else is a second thing to forget.
 */
// Not `555-01xx`: that block is reserved for fiction and `normalizeE164`
// refuses it outright, which would fail these tests for the wrong reason.
const SAM = '+16045550243'
const DENTIST = '+16045550211'

describe('household numbers are not dialable', () => {
  it('refuses a household number', () => {
    const check = validateCalleeNumber(SAM, {
      contactNumbers: [SAM, DENTIST],
      householdNumbers: [SAM],
    })
    expect(check.ok).toBe(false)
  })

  it('says who it is and what to do instead', () => {
    const check = validateCalleeNumber(SAM, {
      contactNumbers: [SAM],
      householdNumbers: [SAM],
    })
    if (check.ok) throw new Error('expected a refusal')
    expect(check.reason).toMatch(/household/i)
    expect(check.reason).toMatch(/telegram/i)
  })

  it('still allows an ordinary contact', () => {
    const check = validateCalleeNumber(DENTIST, {
      contactNumbers: [SAM, DENTIST],
      householdNumbers: [SAM],
    })
    expect(check.ok).toBe(true)
  })

  it('refuses a household number even though it is a saved contact that would otherwise be unlocked', () => {
    // A domestic household number proves nothing about ordering: being an
    // ordinary contact does not require the book's permission in the first
    // place, so this would pass even if the household check ran after the
    // contact lookup. A premium-rate number does require that permission —
    // it is only dialable because it is a saved contact. Listing it in both
    // `contactNumbers` and `householdNumbers` means this case only passes if
    // the household refusal is checked before the contact lookup can grant
    // that permission, which is the one ordering this task exists to protect.
    const HOUSEHOLD_PREMIUM = '+19005551234'
    const check = validateCalleeNumber(HOUSEHOLD_PREMIUM, {
      contactNumbers: [HOUSEHOLD_PREMIUM],
      householdNumbers: [HOUSEHOLD_PREMIUM],
    })
    expect(check.ok).toBe(false)
  })

  it('behaves as before when no household numbers are supplied', () => {
    const check = validateCalleeNumber(DENTIST, { contactNumbers: [DENTIST] })
    expect(check.ok).toBe(true)
  })
})

describe('an unreadable contact book fails closed', () => {
  beforeEach(() => {
    H.approved = true
    H.audits.length = 0
  })

  it('places no call when the household read throws', async () => {
    // An empty `household` list here would be indistinguishable from "nobody
    // in the book is household", which would let a household member's plain
    // domestic number through. The read failing must refuse the call outright
    // instead — the same call that "still allows an ordinary contact" above
    // proves goes through when the book is merely silent about a number, not
    // when it cannot be consulted at all.
    const result = await phonePlaceCall.handler(
      {
        goal: 'Book a table for four this Friday at seven under the name Smith.',
        callee_number: DENTIST,
        callee_name: 'Some Dentist',
      },
      ctx(),
    )

    expect(result.isError).toBe(true)
    const text = result.content.map((p) => p.text).join('\n')
    expect(text).toMatch(/address book/i)
    expect(H.audits.map((a) => a.event)).toEqual(['call.refused'])
  })
})
