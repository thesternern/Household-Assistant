import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Phase 2 of the texting design: outbound SMS, send-only, behind the approval
 * deadbolt.
 *
 * The tests that carry weight here are the refusals. A text is worse than a
 * call when it goes wrong — a misdialled number gets an apology and a hang-up,
 * a mistexted one leaves a written record of the household's business on a
 * stranger's phone, and a text to a family member defeats the whole point of
 * having their numbers in the address book at all.
 */

const H = vi.hoisted(() => {
  const store = {
    approved: true,
    dryRunSms: true,
    twilioConfigured: true,
    contacts: [] as Array<{ phone: string | null; household: boolean }>,
    householdRow: { assistantName: 'Chessy', name: 'Smith' } as Record<string, unknown> | undefined,
    contactsThrow: false,
    openThread: null as Record<string, unknown> | null,
    contactRow: { id: 3, smsOptedOutAt: null } as Record<string, unknown> | undefined,
  }
  return {
    store,
    audits: [] as Array<Record<string, unknown>>,
    opened: [] as Array<Record<string, unknown>>,
    appended: [] as Array<Record<string, unknown>>,
    optedOut: [] as string[],
    fetches: [] as Array<{ url: string; body: string }>,
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

vi.mock('../src/sms/threads.js', async () => {
  const actual = await vi.importActual<typeof import('../src/sms/threads.js')>(
    '../src/sms/threads.js',
  )
  return {
    // The autonomy rule itself is real — it is the safety boundary and must not
    // be stubbed. Only the storage around it is faked.
    autonomyVerdict: actual.autonomyVerdict,
    MAX_THREAD_MESSAGES: actual.MAX_THREAD_MESSAGES,
    THREAD_WINDOW_HOURS: actual.THREAD_WINDOW_HOURS,
    openThreadFor: async () => H.store.openThread ?? undefined,
    openThread: async (input: Record<string, unknown>) => {
      H.opened.push(input)
      return { id: 42, ...input }
    },
    appendMessage: async (input: Record<string, unknown>) => {
      H.appended.push(input)
      return { id: 1, ...input }
    },
    markOptedOut: async (phone: string) => {
      H.optedOut.push(phone)
    },
  }
})

vi.mock('../src/policy/pending.js', () => ({
  hasApprovedAction: async () => H.store.approved,
}))

vi.mock('../src/config.js', () => ({
  getConfig: () => ({
    DRY_RUN_SMS: H.store.dryRunSms,
    twilioConfigured: H.store.twilioConfigured,
    TWILIO_ACCOUNT_SID: 'AC0123456789abcdef0123456789abcdef',
    TWILIO_AUTH_TOKEN: '0123456789abcdef0123456789abcdef',
    TWILIO_FROM_NUMBER: '+16045550100',
    HOUSEHOLD_TIMEZONE: 'America/Vancouver',
  }),
}))

vi.mock('../src/db/client.js', async () => {
  const schema = await import('../src/db/schema.js')
  const db = {
    select: (fields: Record<string, unknown>) => ({
      from: (table: unknown) => {
        const isHousehold = table === schema.households
        const rows = async () => {
          if (isHousehold) return H.store.householdRow ? [H.store.householdRow] : []
          if (H.store.contactsThrow) throw new Error('contacts unavailable')
          // The single-contact lookup asks for id; the number scans ask for phone.
          if ('id' in fields) return H.store.contactRow ? [H.store.contactRow] : []
          // The household scan asks for phone only and filters on household = true.
          if (!('household' in fields)) return H.store.contacts.filter((c) => c.household).map((c) => ({ ...c }))
          return H.store.contacts.map((c) => ({ ...c }))
        }
        // `.where()` is awaited directly by the uncapped household scan and
        // chained with `.limit()` by the others; the fake answers both shapes.
        const builder = {
          where: () => ({
            limit: rows,
            then: (res: (v: unknown) => void, rej: (e: unknown) => void) => rows().then(res, rej),
          }),
          limit: rows,
          then: undefined,
        }
        return builder
      },
    }),
  }
  return { getDb: () => db as unknown as never, schema }
})

const { smsSend, composeSms, identification } = await import('../src/tools/sms.ts')

const CTX = { chatId: 'chat-1', actor: 'Alex', origin: 'executor' as const, pendingActionId: 5 }

const SITTER = { phone: '+16045551234', household: false }
const SAM = { phone: '+14155552671', household: true }

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((c) => c.text).join('\n')
}

beforeEach(() => {
  H.store.approved = true
  H.store.dryRunSms = true
  H.store.twilioConfigured = true
  H.store.contacts = [SITTER, SAM]
  H.store.householdRow = { assistantName: 'Chessy', name: 'Smith' }
  H.store.contactsThrow = false
  H.store.openThread = null
  H.store.contactRow = { id: 3, smsOptedOutAt: null }
  H.opened.length = 0
  H.appended.length = 0
  H.optedOut.length = 0
  H.audits.length = 0
  H.fetches.length = 0
  vi.unstubAllGlobals()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      H.fetches.push({ url: String(url), body: String(init?.body ?? '') })
      return {
        ok: true,
        status: 201,
        json: async () => ({ sid: 'SM123', status: 'queued' }),
      } as unknown as Response
    }),
  )
})

describe('the identification line', () => {
  it('names the assistant and the household, and never claims to be a person', () => {
    const line = identification('Chessy', 'Smith')
    expect(line).toBe('This is Chessy, a family assistant working for Smith.')
    expect(line).toMatch(/assistant/i)
  })

  it('is part of the text that is actually sent', () => {
    const composed = composeSms({
      message: 'Are you free Friday at 6?',
      assistantName: 'Chessy',
      householdName: 'Smith',
      includeIdentification: true,
    })
    expect(composed).toBe(
      'This is Chessy, a family assistant working for Smith. Are you free Friday at 6? ' +
        'Reply STOP to opt out.',
    )
  })

  it('carries the opt-out line the campaign was registered with', () => {
    const composed = composeSms({
      message: 'Are you free Friday at 6?',
      assistantName: 'Chessy',
      householdName: 'Smith',
      includeIdentification: true,
    })
    expect(composed).toMatch(/Reply STOP to opt out\.$/)
  })

  it('says neither thing again once the thread is underway', () => {
    // A reply inside an approved thread is the recipient's second message or
    // later. She knows who is writing and how to stop it; saying so every time
    // is what makes an assistant read as a machine.
    const composed = composeSms({
      message: 'That works, see you then.',
      assistantName: 'Chessy',
      householdName: 'Smith',
      includeIdentification: false,
    })
    expect(composed).toBe('That works, see you then.')
    expect(composed).not.toMatch(/STOP/)
  })
})

describe('twilioConfigured', () => {
  // Imported from the real module, not the mock above: this is the one thing
  // in this file that must test the actual predicate.
  const REAL = { TWILIO_ACCOUNT_SID: 'AC0123456789abcdef0123456789abcdef', TWILIO_AUTH_TOKEN: '0123456789abcdef0123456789abcdef', TWILIO_FROM_NUMBER: '+16045550100' }

  it('accepts a real-shaped account SID, token and number', async () => {
    const { isTwilioConfigured } = await vi.importActual<typeof import('../src/config.js')>(
      '../src/config.js',
    )
    expect(isTwilioConfigured(REAL)).toBe(true)
  })

  it('rejects the REPLACE_ME placeholders the Railway slots are seeded with', async () => {
    const { isTwilioConfigured } = await vi.importActual<typeof import('../src/config.js')>(
      '../src/config.js',
    )
    // The Railway CLI will not store an empty value, so the slots hold a
    // non-empty placeholder. Testing for non-empty would call this configured.
    expect(
      isTwilioConfigured({
        TWILIO_ACCOUNT_SID: 'REPLACE_ME',
        TWILIO_AUTH_TOKEN: 'REPLACE_ME',
        TWILIO_FROM_NUMBER: 'REPLACE_ME',
      }),
    ).toBe(false)
    expect(isTwilioConfigured({ ...REAL, TWILIO_ACCOUNT_SID: 'REPLACE_ME' })).toBe(false)
    expect(isTwilioConfigured({ ...REAL, TWILIO_AUTH_TOKEN: 'short' })).toBe(false)
    expect(isTwilioConfigured({ ...REAL, TWILIO_FROM_NUMBER: '604-555-2671' })).toBe(false)
  })
})

describe('the approval deadbolt', () => {
  it('sends nothing when there is no approved action', async () => {
    H.store.approved = false

    const out = await smsSend.handler(
      { to_number: '+16045551234', to_name: 'Sitter', message: 'Are you free Friday?' },
      CTX,
    )

    expect(out.isError).toBe(true)
    expect(textOf(out)).toMatch(/was not approved/i)
    expect(H.fetches).toEqual([])
  })

  it('texts a saved international contact rather than refusing it as unknown', async () => {
    // The book was being read through the callee check, which refuses any
    // non-North-American number that is not already in the book — so no +44
    // ever made it into the book, and every saved one was "not a contact".
    H.store.contacts = [{ phone: '+442079460958', household: false }, SAM]

    const out = await smsSend.handler(
      { to_number: '+44 20 7946 0958', to_name: 'Aunt Bea', message: 'Landed safely, call you Sunday.' },
      CTX,
    )

    expect(out.isError ?? false).toBe(false)
    expect(textOf(out)).not.toMatch(/contact book/i)
  })

  it('is consequential and requires approval by default', async () => {
    const { CATEGORY_META } = await import('../src/policy/categories.js')
    expect(smsSend.consequential).toBe(true)
    expect(smsSend.category).toBe('sms_send')
    expect(CATEGORY_META.sms_send.defaultMode).toBe('require_approval')
  })
})

describe('the household refusal', () => {
  it('refuses to text a family member and says why', async () => {
    const out = await smsSend.handler(
      { to_number: '+14155552671', to_name: 'Sam', message: 'On my way' },
      CTX,
    )

    expect(out.isError).toBe(true)
    expect(textOf(out)).toMatch(/household/i)
    expect(textOf(out)).toMatch(/telegram/i)
    expect(H.fetches).toEqual([])
    expect(H.audits.some((a) => a.event === 'sms.refused')).toBe(true)
  })
})

describe('the contact-book requirement', () => {
  it('refuses a number nobody has saved, even a plain domestic one', async () => {
    const out = await smsSend.handler(
      { to_number: '+16045559999', to_name: 'Someone', message: 'Hello there' },
      CTX,
    )

    expect(out.isError).toBe(true)
    expect(textOf(out)).toMatch(/not in the household address book/i)
    expect(H.fetches).toEqual([])
  })

  it('refuses everything when the address book cannot be read', async () => {
    H.store.contactsThrow = true

    const out = await smsSend.handler(
      { to_number: '+16045551234', to_name: 'Sitter', message: 'Are you free Friday?' },
      CTX,
    )

    expect(out.isError).toBe(true)
    expect(textOf(out)).toMatch(/could not be read/i)
    expect(H.fetches).toEqual([])
  })
})

describe('the dry run', () => {
  it('sends nothing over the network but reports the exact text', async () => {
    const out = await smsSend.handler(
      { to_number: '+16045551234', to_name: 'Sitter', message: 'Are you free Friday at 6?' },
      CTX,
    )

    expect(out.isError).toBeUndefined()
    expect(H.fetches).toEqual([])
    expect(textOf(out)).toMatch(/DRY RUN/)
    expect(textOf(out)).toContain(
      'This is Chessy, a family assistant working for Smith. Are you free Friday at 6?',
    )
    const sent = H.audits.find((a) => a.event === 'sms.sent')
    expect(sent).toBeDefined()
    expect(String(sent?.resultSummary)).toMatch(/^DRY RUN/)
  })
})

describe('a real send', () => {
  it('posts to Twilio with the composed body and the household number', async () => {
    H.store.dryRunSms = false

    const out = await smsSend.handler(
      { to_number: '+16045551234', to_name: 'Sitter', message: 'Are you free Friday at 6?' },
      CTX,
    )

    expect(out.isError).toBeUndefined()
    expect(H.fetches).toHaveLength(1)
    const body = new URLSearchParams(H.fetches[0]?.body ?? '')
    expect(body.get('To')).toBe('+16045551234')
    expect(body.get('From')).toBe('+16045550100')
    expect(body.get('Body')).toBe(
      'This is Chessy, a family assistant working for Smith. Are you free Friday at 6? ' +
        'Reply STOP to opt out.',
    )
    expect(H.fetches[0]?.url).toContain('/Messages.json')
  })

  it('names the opt-out plainly rather than retrying it', async () => {
    H.store.dryRunSms = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ code: 21610, message: 'Attempt to send to unsubscribed recipient' }),
      })) as unknown as typeof fetch,
    )

    const out = await smsSend.handler(
      { to_number: '+16045551234', to_name: 'Sitter', message: 'Are you free Friday?' },
      CTX,
    )

    expect(out.isError).toBe(true)
    expect(textOf(out)).toMatch(/replied STOP/i)
    expect(H.audits.some((a) => a.event === 'sms.failed')).toBe(true)
  })

  it('explains an unregistered-sender rejection as the 10DLC rule, not a bad number', async () => {
    H.store.dryRunSms = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ code: 30034, message: 'Message from an unregistered number' }),
      })) as unknown as typeof fetch,
    )

    const out = await smsSend.handler(
      { to_number: '+16045551234', to_name: 'Sitter', message: 'Are you free Friday?' },
      CTX,
    )

    expect(out.isError).toBe(true)
    expect(textOf(out)).toMatch(/A2P 10DLC/i)
    expect(textOf(out)).toMatch(/nothing was delivered/i)
  })
})

describe('the approval card', () => {
  it('shows the recipient, the number, and the message that will go out', () => {
    const card = smsSend.summarize({
      to_number: '+16045551234',
      to_name: 'Sitter',
      message: 'Are you free Friday at 6?',
    })

    expect(card).toContain('Sitter')
    expect(card).toContain('+1 (604) 555-1234')
    expect(card).toContain('Are you free Friday at 6?')
  })

  it('warns on the card when the number will not dial', () => {
    const card = smsSend.summarize({
      to_number: 'CALL-ME-NOW',
      to_name: 'Sitter',
      message: 'Are you free Friday?',
    })
    expect(card).toMatch(/⚠️/)
  })
})
