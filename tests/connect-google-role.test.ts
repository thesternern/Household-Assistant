/**
 * `/connect_google <role>` has to honour the role it was given.
 *
 * The two-account split is the whole point of the Google integration: the
 * personal account is what gets read, the assistant account is what sends. The
 * grant is stored under the role carried in the signed start link, so a command
 * that drops the role hands you a link that files the assistant's mailbox as
 * the family's own — silently, and with the household's real Gmail grant
 * overwritten. That is the one mistake the split exists to prevent, so it gets
 * a test rather than a comment.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sends: Array<{ chatId: string; text: string }> = []

const config = {
  APP_URL: 'https://your-app.up.railway.app',
  APP_SECRET: 'x'.repeat(48),
  HOUSEHOLD_TIMEZONE: 'America/Los_Angeles',
  BROWSER_ENABLED: false,
  BROWSER_ALLOWED_DOMAINS: ['amazon.com'],
  googleConfigured: true,
  isProd: true,
}

vi.mock('../src/config.js', () => ({ getConfig: () => config }))

vi.mock('../src/telegram/send.js', async () => {
  const real = await vi.importActual<typeof import('../src/telegram/send.js')>(
    '../src/telegram/send.js',
  )
  return {
    md: real.md,
    sendToChat: async (chatId: string, text: string) => {
      sends.push({ chatId, text })
      return [sends.length]
    },
  }
})

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const l: Record<string, unknown> = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  }
  l.child = () => l
  return { logger: l, child: () => l }
})

const { handleCommand } = await import('../src/telegram/commands.js')

const CTX = { chatId: '1001', actor: 'Alex' }

function lastText(): string {
  return sends[sends.length - 1]?.text ?? ''
}

/** The `role=` parameter of the start link the command just sent. */
function linkRole(): string | null {
  const match = /https:\/\/\S+/.exec(lastText())
  if (!match) return null
  return new URL(match[0]).searchParams.get('role')
}

beforeEach(() => {
  sends.length = 0
  config.googleConfigured = true
})

describe('/connect_google honours the account it was given', () => {
  it('builds an assistant link when asked for the assistant', async () => {
    await handleCommand('connect_google', 'assistant', CTX)

    expect(linkRole()).toBe('assistant')
  })

  it('builds a personal link when asked for the personal account', async () => {
    await handleCommand('connect_google', 'personal', CTX)

    expect(linkRole()).toBe('personal')
  })

  it('defaults to the personal account when no role is given', async () => {
    await handleCommand('connect_google', '', CTX)

    expect(linkRole()).toBe('personal')
  })

  it('names the account in the message, so you cannot sign in as the wrong one', async () => {
    await handleCommand('connect_google', 'assistant', CTX)
    // Not a bare 'assistant' — the Railway hostname carries that word already.
    expect(lastText()).toContain('link the assistant account')

    await handleCommand('connect_google', 'personal', CTX)
    expect(lastText()).toContain('link the personal account')
  })

  it('refuses an unknown role instead of quietly linking the personal account', async () => {
    await handleCommand('connect_google', 'work', CTX)

    expect(linkRole()).toBeNull()
    expect(lastText()).toContain('personal')
    expect(lastText()).toContain('assistant')
  })

  it('signs each role differently, so a link cannot be edited into the other one', async () => {
    await handleCommand('connect_google', 'personal', CTX)
    const personal = new URL(/https:\/\/\S+/.exec(lastText())?.[0] ?? '')
    await handleCommand('connect_google', 'assistant', CTX)
    const assistant = new URL(/https:\/\/\S+/.exec(lastText())?.[0] ?? '')

    expect(personal.searchParams.get('sig')).not.toBe(assistant.searchParams.get('sig'))
  })
})
