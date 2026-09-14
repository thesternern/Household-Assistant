/**
 * Phone number validation.
 *
 * The expensive failure mode for this system is a hallucinated number: the
 * model produces something that looks exactly like a phone number, the call is
 * approved on the strength of how plausible it reads, and a stranger's phone
 * rings — or worse, a premium-rate line answers and starts billing.
 *
 * These tests pin the three defences:
 *   1. anything that is not structurally a phone number is refused outright;
 *   2. premium-rate and international numbers are refused *by default*;
 *   3. the one thing that unlocks them is a number the household already saved
 *      in the contact book, which no amount of model confidence can fabricate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../src/tools/types.js'

const H = vi.hoisted(() => ({
  /** Rows the fake `contacts` select hands back. */
  contactRows: [] as Array<{ phone: string | null; household?: boolean }>,
  approved: true,
  audits: [] as Array<Record<string, unknown>>,
  inserted: [] as Array<Record<string, unknown>>,
  placeCall: vi.fn(async (_input: Record<string, unknown>) => ({
    vapiCallId: 'vapi-call-1',
    dryRun: true,
  })),
  config: {
    DRY_RUN_CALLS: true,
    HOUSEHOLD_TIMEZONE: 'America/Los_Angeles',
  } as Record<string, unknown>,
}))

vi.mock('../src/config.js', () => ({ getConfig: () => H.config }))

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

vi.mock('../src/policy/pending.js', () => ({
  hasApprovedAction: async () => H.approved,
}))

vi.mock('../src/integrations/vapi.js', () => ({ placeCall: H.placeCall }))

vi.mock('../src/db/client.js', async () => {
  const realSchema = await vi.importActual<typeof import('../src/db/schema.js')>(
    '../src/db/schema.js',
  )
  // Only two shapes are exercised here: the contact-book scan and the
  // call_records insert. Everything else in this test is pure.
  const selectBuilder = () => {
    let limited = false
    const builder: Record<string, unknown> = {}
    const api = Object.assign(builder, {
      from: () => api,
      where: () => api,
      orderBy: () => api,
      limit: () => {
        limited = true
        return api
      },
      // Two reads now, told apart by the cap: the capped scan is every saved
      // number, the uncapped read is the household's own. This fake cannot
      // evaluate a where clause, so it applies the rule that query is making.
      then: (resolve: (v: unknown) => unknown, rejectFn?: (e: unknown) => unknown) =>
        Promise.resolve(
          limited ? H.contactRows : H.contactRows.filter((row) => row.household === true),
        ).then(resolve, rejectFn),
    })
    return api
  }
  const db = {
    select: () => selectBuilder(),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: () => {
          H.inserted.push(values)
          return Promise.resolve([{ id: 900 + H.inserted.length }])
        },
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
  }
  return { getDb: () => db, getPool: () => ({}), closeDb: async () => {}, schema: realSchema }
})

const {
  classifyNumber,
  formatE164,
  normalizeE164,
  phonePlaceCall,
  validateCalleeNumber,
} = await import('../src/tools/phone.js')

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  chatId: '4242',
  actor: 'Alex',
  origin: 'agent',
  pendingActionId: 7,
  ...over,
})

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((part) => part.text).join('\n')
}

/** Narrowing helper: assert the parse succeeded and hand back the value. */
function accepted(raw: string, contactNumbers: string[] = []) {
  const check = validateCalleeNumber(raw, { contactNumbers })
  if (!check.ok) throw new Error(`expected "${raw}" to be accepted, got: ${check.reason}`)
  return check
}

beforeEach(() => {
  H.contactRows.length = 0
  H.audits.length = 0
  H.inserted.length = 0
  H.approved = true
  H.placeCall.mockClear()
  H.config = { DRY_RUN_CALLS: true, HOUSEHOLD_TIMEZONE: 'America/Los_Angeles' }
})

/* ───────────────────────────── E.164 normalisation ───────────────────────── */

describe('normalizeE164', () => {
  it('normalises every way a household writes a local number', () => {
    const forms = [
      '(415) 555-2671',
      '415-555-2671',
      '415.555.2671',
      '4155552671',
      ' 415 555 2671 ',
      '14155552671',
      '1 (415) 555-2671',
      '+1 415 555 2671',
      '+1 (415) 555-2671',
    ]
    for (const form of forms) {
      const parsed = normalizeE164(form)
      expect(parsed.ok, `${form} should parse`).toBe(true)
      if (parsed.ok) expect(parsed.e164, form).toBe('+14155552671')
    }
  })

  it('keeps a genuine country code instead of assuming North America', () => {
    const parsed = normalizeE164('+44 20 7946 0018')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.e164).toBe('+442079460018')
      expect(parsed.countryCode).toBe('44')
    }
  })

  it('splits a trailing extension off the dialable number', () => {
    for (const [raw, ext] of [
      ['+1 (415) 555-2671 x12', '12'],
      ['415-555-2671 ext. 401', '401'],
      ['415 555 2671 extension 7', '7'],
      ['4155552671 #250', '250'],
    ] as const) {
      const parsed = normalizeE164(raw)
      expect(parsed.ok, raw).toBe(true)
      if (parsed.ok) {
        expect(parsed.e164, raw).toBe('+14155552671')
        expect(parsed.extension, raw).toBe(ext)
      }
    }
  })

  it('reports no extension when there is none', () => {
    const parsed = normalizeE164('4155552671')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.extension).toBeUndefined()
  })

  it('formats a North American number for a human, and leaves the rest alone', () => {
    expect(formatE164('+14155552671')).toBe('+1 (415) 555-2671')
    expect(formatE164('+442079460018')).toBe('+442079460018')
  })
})

/* ──────────────────────────── obvious non-numbers ────────────────────────── */

describe('normalizeE164 refusals', () => {
  const cases: Array<[string, RegExp]> = [
    ['', /no phone number/i],
    ['   ', /no phone number/i],
    ['the dentist', /letters/i],
    ['1-800-FLOWERS', /letters/i],
    ['call them back', /letters/i],
    ['555-2671', /area code/i],
    ['12345', /too short/i],
    ['+1234', /between 8 and 15/i],
    ['+1234567890123456', /between 8 and 15/i],
    ['442079460018', /international form/i],
    ['1111111111', /placeholder/i],
    ['1234567890', /placeholder/i],
    ['+1 (155) 555-2671', /area code/i],
    ['+1 (415) 155-0132', /exchange code/i],
    ['+1 (415) 555-0100', /fictional/i],
    ['+1 (415) 555-0199', /fictional/i],
    ['+0 20 7946 0018', /country code/i],
  ]

  for (const [raw, pattern] of cases) {
    it(`refuses ${JSON.stringify(raw)}`, () => {
      const parsed = normalizeE164(raw)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.reason).toMatch(pattern)
    })
  }

  it('refuses emergency and service codes outright', () => {
    for (const code of ['911', '112', '999', '411', '211', '611', '811']) {
      const parsed = normalizeE164(code)
      expect(parsed.ok, code).toBe(false)
      if (!parsed.ok) expect(parsed.reason, code).toMatch(/emergency or service/i)
    }
  })

  it('refuses a non-string argument rather than throwing', () => {
    for (const value of [undefined, null, 4155552671, {}, []]) {
      const parsed = normalizeE164(value)
      expect(parsed.ok).toBe(false)
    }
  })
})

/* ───────────────────────────── classification ────────────────────────────── */

describe('classifyNumber', () => {
  it('treats ordinary and toll-free numbers as dialable without a contact', () => {
    expect(classifyNumber('+14155552671')).toMatchObject({
      kind: 'domestic',
      requiresContact: false,
    })
    expect(classifyNumber('+18005552671')).toMatchObject({
      kind: 'toll_free',
      requiresContact: false,
    })
  })

  it('flags premium-rate area codes and the 976 exchange', () => {
    expect(classifyNumber('+19002345678')).toMatchObject({ kind: 'premium', requiresContact: true })
    expect(classifyNumber('+19762345678')).toMatchObject({ kind: 'premium', requiresContact: true })
    expect(classifyNumber('+15002345678')).toMatchObject({ kind: 'premium', requiresContact: true })
    expect(classifyNumber('+17002345678')).toMatchObject({ kind: 'premium', requiresContact: true })
    // 976 as the exchange, not the area code — the historic pay-per-call prefix.
    expect(classifyNumber('+14159761234')).toMatchObject({ kind: 'premium', requiresContact: true })
  })

  it('flags +1 area codes that are not the US or Canada', () => {
    for (const number of ['+18092345678', '+18762345678', '+12842345678', '+14412345678']) {
      expect(classifyNumber(number), number).toMatchObject({
        kind: 'international',
        requiresContact: true,
      })
    }
  })

  it('does not treat US territories as international', () => {
    expect(classifyNumber('+17872345678')).toMatchObject({ requiresContact: false })
    expect(classifyNumber('+16712345678')).toMatchObject({ requiresContact: false })
  })

  it('flags anything outside +1 as international', () => {
    expect(classifyNumber('+442079460018')).toMatchObject({
      kind: 'international',
      requiresContact: true,
    })
  })
})

/* ──────────────────────── the premium / contact-book gate ────────────────── */

describe('validateCalleeNumber', () => {
  it('accepts an ordinary local number with an empty contact book', () => {
    expect(accepted('(415) 555-2671').e164).toBe('+14155552671')
    expect(accepted('(415) 555-2671').knownContact).toBe(false)
  })

  it('refuses a premium-rate number that nobody saved', () => {
    const check = validateCalleeNumber('+1 (900) 234-5678', { contactNumbers: [] })
    expect(check.ok).toBe(false)
    if (!check.ok) {
      expect(check.reason).toMatch(/premium-rate/i)
      expect(check.reason).toMatch(/contact book/i)
    }
  })

  it('refuses an international number that nobody saved', () => {
    const check = validateCalleeNumber('+44 20 7946 0018', { contactNumbers: ['+14155552671'] })
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toMatch(/international/i)
  })

  it('refuses a Caribbean +1 number that reads like a domestic one', () => {
    const check = validateCalleeNumber('(809) 234-5678', { contactNumbers: [] })
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toMatch(/international rates/i)
  })

  it('accepts an international number the household already has in contacts', () => {
    const check = accepted('+44 20 7946 0018', ['+442079460018'])
    expect(check.e164).toBe('+442079460018')
    expect(check.knownContact).toBe(true)
    expect(check.classification.kind).toBe('international')
  })

  it('accepts a saved contact number written in a different format', () => {
    // The book holds E.164; the model typed it the way a person says it.
    const check = accepted('(809) 234-5678', ['+18092345678'])
    expect(check.e164).toBe('+18092345678')
    expect(check.knownContact).toBe(true)
  })

  it('carries the extension through to the accepted result', () => {
    const check = accepted('415-555-2671 ext 12')
    expect(check.extension).toBe('12')
  })
})

/* ───────────────────────── the tool, end to end-ish ──────────────────────── */

describe('phone_place_call', () => {
  const args = {
    goal: 'Book a table for four on Friday at seven, under the name Smith.',
    callee_number: '(415) 555-2671',
    callee_name: 'Trattoria Esempio',
  }

  it('summarises who, the number, the goal, and the dry-run state for the approval card', () => {
    const line = phonePlaceCall.summarize(args)
    expect(line).toContain('Trattoria Esempio')
    expect(line).toContain('+1 (415) 555-2671')
    expect(line).toContain('Book a table for four')
    expect(line).toMatch(/DRY RUN/i)
  })

  it('says plainly on the card when a call is real', () => {
    H.config = { DRY_RUN_CALLS: false, HOUSEHOLD_TIMEZONE: 'America/Los_Angeles' }
    expect(phonePlaceCall.summarize(args)).toMatch(/real call/i)
  })

  it('warns on the card when the number will not survive validation', () => {
    const line = phonePlaceCall.summarize({ ...args, callee_number: '1-800-FLOWERS' })
    expect(line).toContain('⚠️')
    expect(line).toMatch(/letters/i)
  })

  it('warns on the card when the number is premium rate', () => {
    const line = phonePlaceCall.summarize({ ...args, callee_number: '+1 900 234 5678' })
    expect(line).toMatch(/premium-rate/i)
  })

  it('refuses to dial without an approved pending action', async () => {
    H.approved = false

    const result = await phonePlaceCall.handler(args, ctx())

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/not approved/i)
    expect(H.placeCall).not.toHaveBeenCalled()
    expect(H.inserted).toHaveLength(0)
  })

  it('refuses a premium-rate number even after approval, and writes no call record', async () => {
    const result = await phonePlaceCall.handler(
      { ...args, callee_number: '+1 (900) 234-5678' },
      ctx(),
    )

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/premium-rate/i)
    expect(H.placeCall).not.toHaveBeenCalled()
    expect(H.inserted).toHaveLength(0)
    expect(H.audits.map((a) => a.event)).toContain('call.refused')
  })

  it('dials a premium-rate number once it is in the contact book', async () => {
    H.contactRows.push({ phone: '(900) 234-5678' })

    const result = await phonePlaceCall.handler(
      { ...args, callee_number: '+1 (900) 234-5678' },
      ctx(),
    )

    expect(result.isError).toBeUndefined()
    expect(H.placeCall).toHaveBeenCalledTimes(1)
    expect(H.placeCall.mock.calls[0]?.[0]).toMatchObject({ calleeNumber: '+19002345678' })
  })

  it('normalises the number before it is written down or dialled', async () => {
    const result = await phonePlaceCall.handler(args, ctx())

    expect(result.isError).toBeUndefined()
    expect(H.inserted[0]).toMatchObject({ calleeNumber: '+14155552671' })
    expect(H.placeCall.mock.calls[0]?.[0]).toMatchObject({
      calleeNumber: '+14155552671',
      callRecordId: 901,
    })
  })

  it('folds an extension into the caller brief rather than dropping it', async () => {
    await phonePlaceCall.handler({ ...args, callee_number: '415-555-2671 ext 12' }, ctx())

    const passed = H.placeCall.mock.calls[0]?.[0] as { context?: string } | undefined
    expect(passed?.context).toMatch(/extension 12/i)
  })

  it('rejects a goal too short to be a real instruction', async () => {
    const result = await phonePlaceCall.handler({ ...args, goal: 'call' }, ctx())

    expect(result.isError).toBe(true)
    expect(H.placeCall).not.toHaveBeenCalled()
  })
})
