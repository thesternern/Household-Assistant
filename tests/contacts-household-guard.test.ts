import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../src/tools/types.js'

/**
 * Three properties of the household flag, all of which failed quietly.
 *
 *  1. `contact_update` is `memory_write`, which seeds to `allow` — a model turn
 *     can reach it unattended. Setting the flag only ever removes a number from
 *     what can be dialled, so it is allowed. Clearing it dissolves the phone
 *     guardrail, so it is refused: a person edits that row directly.
 *  2. The audit summary named neither the birthday nor the flag, so the two
 *     edits most worth recording logged as a bare "Update contact #3."
 *  3. The rendered contact line is what the model reads. Without the flag on
 *     it, the model proposes a call to someone who lives here and burns an
 *     approval card finding out it cannot.
 */

const H = vi.hoisted(() => ({
  patches: [] as Array<Record<string, unknown>>,
  inserted: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  /** What the name lookup and the search find. Empty means an unknown name. */
  lookup: [] as Array<Record<string, unknown>>,
}))

vi.mock('../src/config.js', () => ({
  getConfig: () => ({ HOUSEHOLD_TIMEZONE: 'America/Vancouver' }),
}))

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

const SAM = {
  id: 3,
  name: 'Sam',
  role: null,
  phone: '+16045550243',
  email: null,
  address: null,
  notes: null,
  birthday: '1987-12-14',
  household: true,
}

vi.mock('../src/db/client.js', async () => {
  const realSchema = await vi.importActual<typeof import('../src/db/schema.js')>('../src/db/schema.js')
  return {
    getDb: () => ({
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => Promise.resolve(H.lookup) }),
          }),
        }),
      }),
      update: () => ({
        set: (patch: Record<string, unknown>) => ({
          where: () => ({
            returning: () => {
              H.patches.push(patch)
              return Promise.resolve([{ ...(H.lookup[0] ?? SAM), ...patch }])
            },
          }),
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          returning: () => {
            H.inserted.push(values)
            return Promise.resolve([{ id: 41, ...values }])
          },
        }),
      }),
    }),
    getPool: () => ({}),
    closeDb: async () => {},
    schema: realSchema,
  }
})

const { contactTools } = await import('../src/tools/contacts.js')

const tool = (name: string) => {
  const found = contactTools.find((t) => t.name === name)
  if (!found) throw new Error(`${name} is not registered`)
  return found
}
const contactAdd = tool('contact_add')
const contactUpdate = tool('contact_update')
const contactSearch = tool('contact_search')

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  chatId: '4242',
  actor: 'Alex',
  origin: 'agent',
  ...over,
})

const textOf = (r: { content: Array<{ text: string }> }) => r.content.map((p) => p.text).join('\n')

beforeEach(() => {
  H.patches.length = 0
  H.inserted.length = 0
  H.audits.length = 0
  H.lookup = [SAM]
})

describe('contact_update and the household flag', () => {
  it('refuses to clear it, and writes nothing', async () => {
    const result = await contactUpdate.handler({ id: 3, household: false }, ctx())

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/household/i)
    expect(textOf(result)).toMatch(/person/i)
    expect(H.patches).toHaveLength(0)
  })

  it('refuses to clear it even alongside an edit it would otherwise make', async () => {
    const result = await contactUpdate.handler(
      { id: 3, notes: 'answers after six', household: false },
      ctx(),
    )

    expect(result.isError).toBe(true)
    expect(H.patches).toHaveLength(0)
  })

  it('still allows a contact to be marked as household', async () => {
    const result = await contactUpdate.handler({ id: 3, household: true }, ctx())

    expect(result.isError).toBeFalsy()
    expect(H.patches[0]).toMatchObject({ household: true })
  })
})

/**
 * `contact_add` on a name already in the book edits that row, so it is the same
 * door under a different handle: "add Sam, household false" would clear the
 * flag through a tool that also runs unattended. The insert branch is not that
 * door — a brand-new contact without the flag is an ordinary contact.
 */
describe('contact_add and the household flag', () => {
  it('refuses to clear it on someone already in the household', async () => {
    const result = await contactAdd.handler({ name: 'Sam', household: false }, ctx())

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/household/i)
    expect(textOf(result)).toMatch(/person/i)
    expect(H.patches).toHaveLength(0)
    expect(H.inserted).toHaveLength(0)
  })

  it('still marks an existing contact as household', async () => {
    const result = await contactAdd.handler({ name: 'Sam', household: true }, ctx())

    expect(result.isError).toBeFalsy()
    expect(H.patches[0]).toMatchObject({ household: true })
  })

  it('still saves a new contact that is not in the household', async () => {
    H.lookup = []
    const result = await contactAdd.handler(
      { name: 'Dr Moreau', role: 'dentist', phone: '604 555 0211', household: false },
      ctx(),
    )

    expect(result.isError).toBeFalsy()
    expect(H.inserted[0]).toMatchObject({ name: 'Dr Moreau', household: false })
  })

  it('still updates an ordinary contact that was never household', async () => {
    H.lookup = [{ ...SAM, name: 'Dr Moreau', household: false }]
    const result = await contactAdd.handler({ name: 'Dr Moreau', household: false }, ctx())

    expect(result.isError).toBeFalsy()
  })
})

describe('the update summary names what changed', () => {
  it('names a birthday edit', () => {
    expect(contactUpdate.summarize?.({ id: 3, birthday: '2020-09-01' })).toContain('birthday')
  })

  it('names a household edit, which reads as a boolean and not a string', () => {
    expect(contactUpdate.summarize?.({ id: 3, household: true })).toContain('household')
  })

  it('still says nothing when nothing was named', () => {
    expect(contactUpdate.summarize?.({ id: 3 })).toBe('Update contact #3.')
  })
})

describe('the rendered contact line', () => {
  it('says a contact is household, not just their age and number', async () => {
    const result = await contactSearch.handler({ query: 'Sam' }, ctx())
    const text = textOf(result)

    expect(text).toMatch(/household/i)
    expect(text).toMatch(/never call or text/i)
  })
})
