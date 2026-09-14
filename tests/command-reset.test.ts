import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The property under test: `/reset` drops the resumed agent session for one
 * chat and nothing else.
 *
 * This exists because of a real failure. After a spell of genuine tool denials
 * the model concluded "the tool layer is down", and kept saying so — to a
 * search request, then to a phone call — long after the cause was fixed and
 * deployed. Every one of those turns logged `numTurns=1`: it never called a
 * tool to find out. The conclusion lived in the resumed transcript and nothing
 * could dislodge it, because there was no way to start a fresh session.
 */

const H = vi.hoisted(() => {
  const store = {
    /** telegramChatId values that have a conversation row. */
    conversations: new Set<string>(['chat-1']),
  }
  return {
    store,
    updates: [] as Array<{ set: Record<string, unknown>; chatId: string }>,
    sent: [] as Array<{ chatId: string; text: string }>,
    audits: [] as Array<Record<string, unknown>>,
  }
})

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const l: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop }
  l.child = () => l
  return { logger: l, child: () => l }
})

vi.mock('../src/audit/log.js', () => ({
  audit: async (row: Record<string, unknown>) => {
    H.audits.push(row)
  },
}))

vi.mock('../src/telegram/send.js', () => ({
  sendToChat: async (chatId: string, text: string) => {
    H.sent.push({ chatId, text })
    return [1]
  },
  md: { escape: (t: string) => t, code: (t: string) => t, bold: (t: string) => t },
}))

vi.mock('../src/db/client.js', async () => {
  const schema = await import('../src/db/schema.js')
  const { PgDialect } = await import('drizzle-orm/pg-core')

  const db = {
    update: (_table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (clause: unknown) => {
          const q = new PgDialect().sqlToQuery(clause as never)
          const chatId = String((q.params as unknown[])[0])
          return {
            returning: async () => {
              if (!H.store.conversations.has(chatId)) return []
              H.updates.push({ set: values, chatId })
              return [{ id: 1 }]
            },
          }
        },
      }),
    }),
  }
  return { getDb: () => db as unknown as never, schema }
})

const { handleCommand, COMMAND_NAMES, COMMAND_MENU } = await import('../src/telegram/commands.js')

beforeEach(() => {
  H.store.conversations = new Set(['chat-1'])
  H.updates.length = 0
  H.sent.length = 0
  H.audits.length = 0
})

describe('/reset', () => {
  it('is a command the bot answers to, and is offered in the menu', () => {
    expect(COMMAND_NAMES).toContain('reset')
    expect(COMMAND_MENU.map((c) => c.command)).toContain('reset')
  })

  it('clears the agent session for this chat and nothing else', async () => {
    const handled = await handleCommand('reset', '', { chatId: 'chat-1', actor: 'Alex' })

    expect(handled).toBe(true)
    expect(H.updates).toHaveLength(1)
    expect(H.updates[0]?.chatId).toBe('chat-1')
    // Exactly one column, set to null. Anything else here would be throwing
    // away household state the conversation is not allowed to own.
    expect(H.updates[0]?.set).toEqual({ agentSessionId: null })
  })

  it('tells the household their real state survived', async () => {
    await handleCommand('reset', '', { chatId: 'chat-1', actor: 'Alex' })

    const text = H.sent[0]?.text ?? ''
    expect(text).toMatch(/fresh start/i)
    expect(text).toMatch(/to-dos|reminders|contacts|memories|rules/i)
    expect(text).toMatch(/untouched/i)
  })

  it('audits who reset what', async () => {
    await handleCommand('reset', '', { chatId: 'chat-1', actor: 'Sam' })

    expect(H.audits[0]?.event).toBe('conversation.reset')
    expect(H.audits[0]?.actor).toBe('Sam')
    expect(H.audits[0]?.ok).toBe(true)
  })

  it('says so plainly when there is no conversation yet, and writes nothing', async () => {
    const handled = await handleCommand('reset', '', { chatId: 'unknown-chat', actor: 'Alex' })

    expect(handled).toBe(true)
    expect(H.updates).toEqual([])
    expect(H.audits).toEqual([])
    expect(H.sent[0]?.text).toMatch(/nothing to reset/i)
  })

  it('only ever touches the chat it was sent from', async () => {
    H.store.conversations = new Set(['chat-1', 'chat-2'])

    await handleCommand('reset', '', { chatId: 'chat-2', actor: 'Alex' })

    expect(H.updates.map((u) => u.chatId)).toEqual(['chat-2'])
  })
})
