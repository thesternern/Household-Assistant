import { DateTime } from 'luxon'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The tools. The behaviour worth pinning: adding says it will batch rather
 * than producing a list, ordering consumes what it showed, and an order that
 * shows nothing consumes nothing.
 */

const H = vi.hoisted(() => ({
  pending: [] as Array<Record<string, unknown>>,
  sent: [] as Array<Record<string, unknown>>,
  added: [] as Array<Record<string, unknown>>,
  sentIds: [] as number[],
  statusCalls: [] as Array<{ id: number; status: string }>,
  /** Every message shopping_order sent to the chat itself. */
  chatSends: [] as Array<{ chatId: string; text: string; markdown: boolean }>,
  /** When false, sendToChat reports nothing delivered, as it does with no bot. */
  chatSendWorks: true,
  /** Active standing instructions, as shoppingPreamble() would find them. */
  preamble: '' as string,
}))

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const l: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop }
  l.child = () => l
  return { logger: l, child: () => l }
})

vi.mock('../src/audit/log.js', () => ({ audit: async () => {} }))

// `shopping_order` now reads the week through `resolveWeekStart`, which asks
// the household clock what "this week" means. Pin the zone so it does not.
vi.mock('../src/config.js', () => ({
  getConfig: () => ({ HOUSEHOLD_TIMEZONE: 'America/Vancouver' }),
}))

vi.mock('../src/shopping/standing-list.js', async () => {
  const actual = await vi.importActual<typeof import('../src/shopping/standing-list.js')>(
    '../src/shopping/standing-list.js',
  )
  return {
    standingToLines: actual.standingToLines,
    addItems: async (input: {
      items: Array<string | { name: string; quantity?: string }>
      urgent?: boolean
    }) => {
      const rows = input.items
        .map((entry) => (typeof entry === 'string' ? { name: entry } : entry))
        .map((entry) => ({ ...entry, name: entry.name.trim() }))
        .filter((entry) => entry.name !== '')
        .map((entry, i) => ({
          id: 100 + i,
          name: entry.name,
          quantityText: entry.quantity ?? null,
          note: null,
          status: 'pending',
          urgent: input.urgent === true,
        }))
      H.added.push(...rows)
      return rows
    },
    pendingItems: async () => H.pending.map((p) => ({ ...p })),
    recentlySent: async () => H.sent.map((p) => ({ ...p })),
    markSent: async (ids: number[]) => {
      H.sentIds.push(...ids)
      return ids.length
    },
    setStatus: async (id: number, status: string) => {
      H.statusCalls.push({ id, status })
      return { id, name: 'dish soap', status }
    },
  }
})

vi.mock('../src/telegram/send.js', async () => {
  // `md` stays real: the escaping and the fence are what the household reads,
  // and a fake one would let a formatting regression through.
  const actual = await vi.importActual<typeof import('../src/telegram/send.js')>(
    '../src/telegram/send.js',
  )
  return {
    md: actual.md,
    sendToChat: async (chatId: string, text: string, opts?: { markdown?: boolean }) => {
      if (!H.chatSendWorks) return []
      H.chatSends.push({ chatId, text, markdown: opts?.markdown === true })
      return [1]
    },
  }
})

vi.mock('../src/shopping/preferences.js', async () => {
  // renderPreamble stays real — its wording is what the grocery assistant obeys.
  const actual = await vi.importActual<typeof import('../src/shopping/preferences.js')>(
    '../src/shopping/preferences.js',
  )
  return {
    ...actual,
    shoppingPreamble: async () => H.preamble,
  }
})

vi.mock('../src/recipes/store.js', () => ({
  getPlanByWeek: async () => undefined,
  generateGroceryList: async () => ({
    weekendItems: {},
    midweekItems: {},
    hasMidweek: false,
    checkedItems: [],
  }),
}))

const { shoppingTools } = await import('../src/tools/shopping.js')

const CTX = { chatId: 'chat-1', actor: 'Alex', origin: 'agent' as const }
const tool = (name: string) => {
  const found = shoppingTools.find((t) => t.name === name)
  if (!found) throw new Error(`no tool named ${name}`)
  return found
}
const textOf = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join('\n')
/** What the household actually received as pasteable messages. */
const delivered = () => H.chatSends.map((m) => m.text).join('\n')

beforeEach(() => {
  H.pending.length = 0
  H.sent.length = 0
  H.added.length = 0
  H.sentIds.length = 0
  H.statusCalls.length = 0
  H.chatSends.length = 0
  H.chatSendWorks = true
  H.preamble = ''
})

// Several tests spy on the mocked modules (markSent, getPlanByWeek,
// generateGroceryList). Without a restore, a rejection or override from one
// test leaks into the next.
afterEach(() => {
  vi.restoreAllMocks()
})

describe('shopping_add', () => {
  it('says the item will go with the next shop, and produces no list', async () => {
    const out = await tool('shopping_add').handler({ items: ['hand soap'] }, CTX)

    expect(out.isError).toBeUndefined()
    expect(H.added.map((a) => a.name)).toEqual(['hand soap'])
    expect(textOf(out)).toMatch(/next shop|with the/i)
    // Batching is the point: adding must not hand back something to paste.
    expect(textOf(out)).not.toContain('```')
  })

  it('takes several items at once', async () => {
    await tool('shopping_add').handler({ items: ['coffee', 'bin bags'] }, CTX)
    expect(H.added.map((a) => a.name)).toEqual(['coffee', 'bin bags'])
  })

  it('refuses an empty request rather than storing nothing quietly', async () => {
    const out = await tool('shopping_add').handler({ items: [] }, CTX)
    expect(out.isError).toBe(true)
  })
})

describe('shopping_order', () => {
  it('produces a paste block and consumes exactly what it showed', async () => {
    H.pending.push(
      { id: 1, name: 'dish soap', quantityText: null, note: null },
      { id: 2, name: 'chicken thighs', quantityText: '2 lb', note: null },
    )

    await tool('shopping_order').handler({}, CTX)

    // The items reach the household in the pasteable message, not in the
    // model's reply — see the "delivering the paste block" tests.
    expect(delivered()).toContain('dish soap')
    expect(delivered()).toContain('2 lb chicken thighs')
    expect(H.sentIds).toEqual([1, 2])
  })

  it('still shows the list when ticking items off fails, and says so', async () => {
    H.pending.push(
      { id: 1, name: 'dish soap', quantityText: null, note: null },
      { id: 2, name: 'coffee', quantityText: null, note: null },
    )
    const storage = await import('../src/shopping/standing-list.js')
    // Record the attempt, then fail. A spy that only rejects cannot record, so
    // asserting H.sentIds is empty afterwards would pass no matter what the
    // tool did — the recorder is the thing that was replaced.
    const attempts: number[][] = []
    vi.spyOn(storage, 'markSent').mockImplementation(async (ids: number[]) => {
      attempts.push([...ids])
      throw new Error('db down')
    })

    const out = await tool('shopping_order').handler({}, CTX)

    expect(out.isError).toBeUndefined()
    expect(delivered()).toContain('dish soap')
    expect(textOf(out)).toMatch(/may be offered again/i)
    // It tried to consume exactly what it showed, and nothing more.
    expect(attempts).toEqual([[1, 2]])
    // And the failure is reported as data, not only prose, so the ids stay
    // usable for shopping_remove(restore).
    expect(out.structuredContent?.consumed).toBe(false)
    expect(out.structuredContent?.included).toEqual([
      { id: 1, name: 'dish soap' },
      { id: 2, name: 'coffee' },
    ])
  })

  it('hands back the ids it consumed, which is the only way one comes back', async () => {
    H.pending.push(
      { id: 4, name: 'dish soap', quantityText: null, note: null },
      { id: 5, name: 'bin bags', quantityText: null, note: null },
    )

    const out = await tool('shopping_order').handler({}, CTX)

    expect(out.structuredContent?.consumed).toBe(true)
    expect(out.structuredContent?.included).toEqual([
      { id: 4, name: 'dish soap' },
      { id: 5, name: 'bin bags' },
    ])
  })

  it('refuses a request it cannot read rather than emitting the whole list', async () => {
    H.pending.push(
      { id: 1, name: 'dish soap', quantityText: null, note: null, urgent: false },
      { id: 2, name: 'infant paracetamol', quantityText: null, note: null, urgent: true },
    )

    // A malformed urgent request used to fall through to the defaults, which
    // is the widest action there is: the whole standing list, emitted and
    // eaten. This is the one tool that consumes state, so it fails instead.
    const out = await tool('shopping_order').handler({ urgent_only: 'yes please' }, CTX)

    expect(out.isError).toBe(true)
    expect(H.sentIds).toEqual([])
    expect(textOf(out)).not.toContain('dish soap')
  })

  it('consumes nothing when there is nothing pending', async () => {
    const out = await tool('shopping_order').handler({}, CTX)

    expect(textOf(out)).toMatch(/nothing on the list/i)
    expect(H.sentIds).toEqual([])
  })
})

describe('urgent_only — the escape hatch', () => {
  beforeEach(() => {
    H.pending.push(
      { id: 1, name: 'dish soap', quantityText: null, note: null, urgent: false },
      { id: 2, name: 'infant paracetamol', quantityText: null, note: null, urgent: true },
      { id: 3, name: 'coffee', quantityText: null, note: null, urgent: false },
    )
  })

  it('shows only the urgent item, and consumes only that one', async () => {
    await tool('shopping_order').handler({ urgent_only: true }, CTX)

    expect(delivered()).toContain('infant paracetamol')
    expect(delivered()).not.toContain('dish soap')
    expect(delivered()).not.toContain('coffee')
    // Batching survives the escape hatch: the ordinary items are still waiting.
    expect(H.sentIds).toEqual([2])
  })

  it('ignores a week, because an urgent errand is not the big shop', async () => {
    const store = await import('../src/recipes/store.js')
    const byWeek = vi.spyOn(store, 'getPlanByWeek')

    const out = await tool('shopping_order').handler({ urgent_only: true, week: 'this week' }, CTX)

    expect(byWeek).not.toHaveBeenCalled()
    expect(delivered()).not.toMatch(/onions/i)
    expect(textOf(out)).not.toMatch(/onions/i)
    expect(H.sentIds).toEqual([2])
  })

  it('says so and consumes nothing when nothing is marked urgent', async () => {
    H.pending.length = 0
    H.pending.push({ id: 1, name: 'dish soap', quantityText: null, note: null, urgent: false })

    const out = await tool('shopping_order').handler({ urgent_only: true }, CTX)

    expect(textOf(out)).toMatch(/nothing on the list is marked urgent/i)
    expect(H.sentIds).toEqual([])
  })

  it('names the urgent list for what it is', async () => {
    // The pasteable message carries only items, so the framing has to survive
    // in the line the model is told to say.
    expect(textOf(await tool('shopping_order').handler({ urgent_only: true }, CTX))).toMatch(
      /urgent items/i,
    )
  })
})

describe('shopping_remove', () => {
  it('drops an item', async () => {
    await tool('shopping_remove').handler({ id: 7 }, CTX)
    expect(H.statusCalls).toEqual([{ id: 7, status: 'dropped' }])
  })

  it('puts a sent item back', async () => {
    await tool('shopping_remove').handler({ id: 7, restore: true }, CTX)
    expect(H.statusCalls).toEqual([{ id: 7, status: 'pending' }])
  })
})

describe('folding the week into the shop', () => {
  it('puts the weekend groceries and the standing list in one block', async () => {
    H.pending.push({ id: 1, name: 'dish soap', quantityText: null, note: null })

    const store = await import('../src/recipes/store.js')
    vi.spyOn(store, 'getPlanByWeek').mockResolvedValue({ id: 9 } as never)
    vi.spyOn(store, 'generateGroceryList').mockResolvedValue({
      weekendItems: { Produce: [{ item: 'onions', quantity: '3', recipes: [] }] },
      midweekItems: { Produce: [{ item: 'basil', quantity: '1 bunch', recipes: [] }] },
      hasMidweek: true,
      checkedItems: [],
    } as never)

    await tool('shopping_order').handler({ week: '2026-09-07' }, CTX)

    expect(delivered()).toContain('dish soap')
    expect(delivered()).toContain('3 onions')
    // Midweek is the freshness top-up and stays its own trip.
    expect(delivered()).not.toContain('basil')
    // The standing items were consumed; the recipe items were never ours to consume.
    expect(H.sentIds).toEqual([1])
  })

  it('still works when there is no plan for that week', async () => {
    H.pending.push({ id: 1, name: 'dish soap', quantityText: null, note: null })

    const store = await import('../src/recipes/store.js')
    vi.spyOn(store, 'getPlanByWeek').mockResolvedValue(undefined as never)

    await tool('shopping_order').handler({ week: '2026-09-07' }, CTX)
    // A missing plan costs the fold-in only; the standing list still ships.
    expect(delivered()).toContain('dish soap')
    expect(H.sentIds).toEqual([1])
  })
})

describe('what the household is told about the fold-in', () => {
  it('counts the block, not the standing list, when a week is folded in', async () => {
    const store = await import('../src/recipes/store.js')
    vi.spyOn(store, 'getPlanByWeek').mockResolvedValue({ id: 9 } as never)
    vi.spyOn(store, 'generateGroceryList').mockResolvedValue({
      weekendItems: {
        Produce: [
          { item: 'onions', quantity: '3', recipes: [] },
          { item: 'kale', quantity: '1 bunch', recipes: [] },
        ],
      },
      midweekItems: {},
      hasMidweek: false,
      checkedItems: [],
    } as never)

    // The standing list is empty; everything in the block came from the plan.
    const out = await tool('shopping_order').handler({ week: '2026-09-07' }, CTX)

    expect(textOf(out)).not.toMatch(/included 0 items/i)
    expect(textOf(out)).toMatch(/included 2 items/i)
    expect(textOf(out)).toMatch(/all from the week's plan/i)
    // Nothing of the household's was consumed, so nothing is offered back.
    expect(textOf(out)).not.toMatch(/put them back/i)
    expect(out.structuredContent).toMatchObject({ count: 0, folded: 2, pasted: 2 })
  })

  it("says the week did not fold in, rather than eating the standing list in silence", async () => {
    H.pending.push({ id: 1, name: 'dish soap', quantityText: null, note: null })
    const store = await import('../src/recipes/store.js')
    vi.spyOn(store, 'getPlanByWeek').mockResolvedValue(undefined as never)

    const out = await tool('shopping_order').handler({ week: '2026-09-07' }, CTX)
    const text = textOf(out)

    expect(delivered()).toContain('dish soap')
    expect(text).toMatch(/could not fold the week in/i)
    expect(text).toMatch(/no meal plan/i)
    expect(H.sentIds).toEqual([1])
  })

  it("accepts 'this week', the phrasing every other recipe tool takes", async () => {
    H.pending.push({ id: 1, name: 'dish soap', quantityText: null, note: null })
    const store = await import('../src/recipes/store.js')
    const byWeek = vi.spyOn(store, 'getPlanByWeek').mockResolvedValue(undefined as never)

    // `normalizeWeekStart` in the recipe store throws on anything that is not
    // an ISO date, so the raw phrase used to cost the fold-in silently.
    const out = await tool('shopping_order').handler({ week: 'this week' }, CTX)

    const monday = DateTime.now().setZone('America/Vancouver').startOf('week').toFormat('yyyy-MM-dd')
    expect(byWeek).toHaveBeenCalledWith(monday)
    expect(textOf(out)).not.toMatch(/could not read/i)
  })

  it('reports both numbers when the standing list and the plan are both in the block', async () => {
    H.pending.push({ id: 1, name: 'dish soap', quantityText: null, note: null })
    const store = await import('../src/recipes/store.js')
    vi.spyOn(store, 'getPlanByWeek').mockResolvedValue({ id: 9 } as never)
    vi.spyOn(store, 'generateGroceryList').mockResolvedValue({
      weekendItems: { Produce: [{ item: 'onions', quantity: '3', recipes: [] }] },
      midweekItems: {},
      hasMidweek: false,
      checkedItems: [],
    } as never)

    const text = textOf(await tool('shopping_order').handler({ week: '2026-09-07' }, CTX))

    expect(text).toMatch(/included 2 items/i)
    expect(text).toMatch(/1 from the standing list/i)
    expect(text).toMatch(/1 from the week's plan/i)
  })
})

describe('a sent item can be found again', () => {
  it('shows recently sent items, with ids, when asked', async () => {
    H.pending.push({ id: 1, name: 'coffee', quantityText: null, note: null })
    H.sent.push({ id: 7, name: 'dish soap', quantityText: null, note: null, urgent: false })

    const out = await tool('shopping_list').handler({ include_sent: true }, CTX)
    const text = textOf(out)

    // The whole restore path hangs off this id being reachable a day later.
    expect(text).toContain('#7 dish soap')
    expect(text).toMatch(/recently sent/i)
    expect(out.structuredContent?.sent).toEqual([{ id: 7, name: 'dish soap' }])

    // And that id is what shopping_remove takes.
    await tool('shopping_remove').handler({ id: 7, restore: true }, CTX)
    expect(H.statusCalls).toEqual([{ id: 7, status: 'pending' }])
  })

  it('does not read sent items unless asked', async () => {
    H.sent.push({ id: 7, name: 'dish soap', quantityText: null, note: null })

    const out = await tool('shopping_list').handler({}, CTX)

    expect(textOf(out)).not.toContain('dish soap')
    expect(out.structuredContent?.sent).toBeUndefined()
  })

  it('says plainly when nothing has gone into a shop yet', async () => {
    const out = await tool('shopping_list').handler({ include_sent: true }, CTX)
    expect(textOf(out)).toMatch(/nothing on the shopping list/i)
    expect(textOf(out)).toMatch(/nothing has gone into a shop/i)
  })
})

describe('shopping_add — quantities', () => {
  it('writes the amount through instead of dropping it', async () => {
    const out = await tool('shopping_add').handler(
      { items: [{ name: 'chicken thighs', quantity: '2 lb' }] },
      CTX,
    )

    expect(H.added.map((a) => [a.name, a.quantityText])).toEqual([['chicken thighs', '2 lb']])
    expect(textOf(out)).toContain('2 lb chicken thighs')
  })

  it('still takes a plain list of names', async () => {
    await tool('shopping_add').handler({ items: ['coffee', { name: 'bin bags' }] }, CTX)
    expect(H.added.map((a) => a.name)).toEqual(['coffee', 'bin bags'])
  })
})

describe('categories', () => {
  it('never reaches purchase — nothing here can spend money', () => {
    for (const t of shoppingTools) {
      expect(t.category).not.toBe('purchase')
    }
    expect(tool('shopping_order').category).toBe('read')
    expect(tool('shopping_list').category).toBe('read')
  })

  it('does not claim shopping_order is read-only, because it marks rows sent', () => {
    // `read` is the policy call and it stands — it spends nothing and contacts
    // nobody. `readOnly` is a factual claim about writes, and `read` is
    // watcher-allowed, so a false one here is worth catching.
    expect(tool('shopping_order').readOnly).toBe(false)
    expect(tool('shopping_list').readOnly).toBe(true)
  })

  it('warns the model that a week is ignored for an urgent order', () => {
    const week = tool('shopping_order').schema.week
    expect(week?.description).toMatch(/ignored when urgent_only is true/i)
  })
})


describe('delivering the paste block', () => {
  it('sends each block as its own message, carrying nothing but the block', async () => {
    H.pending.push(
      { id: 1, name: 'dish soap', quantityText: null, note: null },
      { id: 2, name: 'chicken thighs', quantityText: '2 lb', note: null },
    )

    await tool('shopping_order').handler({}, CTX)

    expect(H.chatSends).toHaveLength(1)
    const sent = H.chatSends[0]!
    expect(sent.chatId).toBe(CTX.chatId)
    expect(sent.markdown).toBe(true)

    // Only the fenced block: no bold header, no "Included 2 items" tail. This
    // is what makes the message safe to paste straight into a list importer.
    expect(sent.text).toBe('```\ndish soap\n2 lb chicken thighs\n```')
    expect(sent.text).not.toMatch(/Shopping list/)
    expect(sent.text).not.toMatch(/Included/)
  })

  it('does not hand the items back to the model once they are delivered', async () => {
    H.pending.push({ id: 1, name: 'dish soap', quantityText: null, note: null })

    const out = await tool('shopping_order').handler({}, CTX)
    const text = textOf(out)

    // The model must not be able to repeat a list the household already has,
    // and must not be given the text to paraphrase.
    expect(text).not.toContain('dish soap')
    expect(text).not.toContain('```')
    expect(text).toMatch(/do NOT repeat/i)
    expect(text).toMatch(/already sent/i)
  })

  it('splits into one message per block, so a long shop pastes in parts', async () => {
    for (let i = 0; i < 205; i += 1) {
      H.pending.push({ id: i + 1, name: `item ${i}`, quantityText: null, note: null })
    }

    await tool('shopping_order').handler({}, CTX)

    expect(H.chatSends).toHaveLength(2)
    expect(H.chatSends[0]?.text.split('\n')).toHaveLength(202) // 200 items + 2 fences
    expect(H.chatSends[1]?.text.split('\n')).toHaveLength(7) // 5 items + 2 fences
  })

  it('falls back to handing the model the block when the send fails', async () => {
    H.chatSendWorks = false
    H.pending.push({ id: 1, name: 'dish soap', quantityText: null, note: null })

    const out = await tool('shopping_order').handler({}, CTX)
    const text = textOf(out)

    // Worse formatting beats no list at all.
    expect(H.chatSends).toEqual([])
    expect(text).toContain('dish soap')
    expect(text).toContain('```')
    // And the items are still consumed, because the household will still get them.
    expect(H.sentIds).toEqual([1])
  })

  it('still consumes the items it delivered', async () => {
    H.pending.push({ id: 1, name: 'dish soap', quantityText: null, note: null })

    await tool('shopping_order').handler({}, CTX)

    expect(H.sentIds).toEqual([1])
  })
})


describe('the standing instructions on a list', () => {
  const PREAMBLE = 'STOP. Read these rules first.\n\n1. No store brands.\n\nItems:'

  it('sends them above the items, in the same message the household pastes', async () => {
    H.preamble = PREAMBLE
    H.pending.push({ id: 1, name: 'oat milk', quantityText: null, note: null })

    await tool('shopping_order').handler({}, CTX)

    // One message: the rules and the list travel together, because the app on
    // the other side reads the whole paste.
    expect(H.chatSends).toHaveLength(1)
    expect(H.chatSends[0]?.text).toContain('No store brands')
    expect(H.chatSends[0]?.text).toContain('oat milk')
    expect(H.chatSends[0]?.text.indexOf('No store brands')).toBeLessThan(
      H.chatSends[0]!.text.indexOf('oat milk'),
    )
  })

  it('counts the items, not the rules', async () => {
    H.preamble = PREAMBLE
    H.pending.push(
      { id: 1, name: 'oat milk', quantityText: null, note: null },
      { id: 2, name: 'paper towels', quantityText: null, note: null },
    )

    const out = await tool('shopping_order').handler({}, CTX)

    // "Included 6 items" under a two-item shop is a lie read every week.
    expect(textOf(out)).toMatch(/\b2 items\b/)
    expect(textOf(out)).not.toMatch(/\b[5-9] items\b/)
  })

  it('ships the list unadorned when the household has set no rules', async () => {
    H.preamble = ''
    H.pending.push({ id: 1, name: 'oat milk', quantityText: null, note: null })

    await tool('shopping_order').handler({}, CTX)

    expect(H.chatSends[0]?.text).toBe('```\noat milk\n```')
  })
})
