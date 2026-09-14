import { describe, expect, it } from 'vitest'
import {
  MAX_THREAD_MESSAGES,
  THREAD_WINDOW_HOURS,
  autonomyVerdict,
} from '../src/sms/threads.js'
import type { ThreadRow } from '../src/sms/threads.js'

/**
 * The safety boundary of the texting feature.
 *
 * An approved errand may converse for itself inside a message cap and a time
 * window, the way the voice agent converses inside one approved call. A call
 * ends when someone hangs up; a text thread does not, which is the whole reason
 * these bounds exist. An errand approved on Tuesday must not still be answering
 * on Friday.
 *
 * `autonomyVerdict` is pure so this can be exhaustive. Every path that decides
 * whether to reply — the inbound job and the send tool — goes through it, so
 * the rule cannot drift between them.
 */

const OPENED = new Date('2026-09-02T10:00:00Z')

function thread(over: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: 1,
    contactId: 3,
    phone: '+16045551234',
    goal: 'Ask the sitter if she is free Friday at 6',
    status: 'open',
    closedReason: null,
    pendingActionId: 9,
    telegramChatId: 'chat-1',
    messageCount: 2,
    openedAt: OPENED,
    expiresAt: new Date(OPENED.getTime() + THREAD_WINDOW_HOURS * 3600_000),
    lastMessageAt: OPENED,
    closedAt: null,
    ...over,
  } as ThreadRow
}

const justInside = new Date(OPENED.getTime() + 23 * 3600_000)
const justOutside = new Date(OPENED.getTime() + THREAD_WINDOW_HOURS * 3600_000 + 1000)

describe('inside the bounds', () => {
  it('answers for itself with messages and time to spare', () => {
    const v = autonomyVerdict(thread(), justInside)
    expect(v.autonomous).toBe(true)
    if (v.autonomous) expect(v.remaining).toBe(MAX_THREAD_MESSAGES - 2)
  })

  it('still answers on the last message it is allowed', () => {
    const v = autonomyVerdict(thread({ messageCount: MAX_THREAD_MESSAGES - 1 }), justInside)
    expect(v.autonomous).toBe(true)
    if (v.autonomous) expect(v.remaining).toBe(1)
  })
})

describe('the message cap', () => {
  it('stops exactly at the cap, not one past it', () => {
    const v = autonomyVerdict(thread({ messageCount: MAX_THREAD_MESSAGES }), justInside)
    expect(v.autonomous).toBe(false)
    if (!v.autonomous) {
      expect(v.reason).toBe('message_cap')
      expect(v.detail).toContain(String(MAX_THREAD_MESSAGES))
    }
  })

  it('stays closed once past the cap', () => {
    const v = autonomyVerdict(thread({ messageCount: MAX_THREAD_MESSAGES + 5 }), justInside)
    expect(v.autonomous).toBe(false)
  })
})

describe('the time window', () => {
  it('closes the moment the window expires, however few messages were used', () => {
    const v = autonomyVerdict(thread({ messageCount: 1 }), justOutside)
    expect(v.autonomous).toBe(false)
    if (!v.autonomous) expect(v.reason).toBe('window_expired')
  })

  it('treats the expiry instant itself as expired', () => {
    const exactly = new Date(OPENED.getTime() + THREAD_WINDOW_HOURS * 3600_000)
    const v = autonomyVerdict(thread({ messageCount: 1 }), exactly)
    expect(v.autonomous).toBe(false)
  })

  it('checks the window before the cap, so an old quiet thread is not called chatty', () => {
    const v = autonomyVerdict(thread({ messageCount: MAX_THREAD_MESSAGES }), justOutside)
    expect(v.autonomous).toBe(false)
    if (!v.autonomous) expect(v.reason).toBe('window_expired')
  })
})

describe('a closed thread', () => {
  it('never answers again, whatever its counters say', () => {
    const v = autonomyVerdict(
      thread({ status: 'closed', closedReason: 'they replied STOP to this number', messageCount: 0 }),
      justInside,
    )
    expect(v.autonomous).toBe(false)
    if (!v.autonomous) {
      expect(v.reason).toBe('closed')
      expect(v.detail).toMatch(/STOP/)
    }
  })

  it('cannot be reopened by the clock running backwards', () => {
    const before = new Date(OPENED.getTime() - 3600_000)
    expect(autonomyVerdict(thread({ status: 'closed' }), before).autonomous).toBe(false)
  })
})

describe('the bounds themselves', () => {
  it('are the ones the design committed to', () => {
    expect(MAX_THREAD_MESSAGES).toBe(10)
    expect(THREAD_WINDOW_HOURS).toBe(24)
  })
})
