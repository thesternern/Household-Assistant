/**
 * The grocery choice card: its buttons, and what a tap does.
 *
 * The properties worth pinning are the asymmetric ones. The in-store list is a
 * pure render and stays tappable; the Instacart list spends the standing
 * shopping items, so its button is offered once and then retired. Getting that
 * backwards would either double-consume the household's list or leave "hand
 * soap" on it forever.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const H = vi.hoisted(() => ({
  sent: [] as Array<{ chatId: string; text: string; opts?: Record<string, unknown> }>,
  audits: [] as Array<Record<string, unknown>>,
  editedMarkup: [] as unknown[],
}))

vi.mock('../src/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
  return { logger: { ...logger, child: () => logger }, child: () => logger }
})

vi.mock('../src/audit/log.js', () => ({
  audit: async (entry: Record<string, unknown>) => {
    H.audits.push(entry)
  },
}))

vi.mock('../src/telegram/send.js', async () => {
  const actual = await vi.importActual<typeof import('../src/telegram/send.js')>(
    '../src/telegram/send.js',
  )
  return {
    ...actual,
    sendToChat: vi.fn(async (chatId: string, text: string, opts?: Record<string, unknown>) => {
      H.sent.push({ chatId, text, ...(opts ? { opts } : {}) })
      return [1]
    }),
    resolveActorName: vi.fn(async () => 'Alex'),
  }
})

vi.mock('../src/recipes/store.js', () => ({
  generateGroceryList: vi.fn(),
  getPlan: vi.fn(),
  getPlanByWeek: vi.fn(),
}))

vi.mock('../src/shopping/order.js', () => ({ buildShopList: vi.fn() }))

import { generateGroceryList, getPlan } from '../src/recipes/store.js'
import { buildShopList } from '../src/shopping/order.js'
import { GROCERY_CB, groceryKeyboard } from '../src/telegram/grocery-keyboard.js'
import { onGroceryChoice } from '../src/telegram/grocery-card.js'

/** A callback context shaped like the parts the handler actually reads. */
function tap(data: string) {
  const match = GROCERY_CB.pattern.exec(data)
  return {
    match,
    chat: { id: 55 },
    from: { id: 99, first_name: 'Alex' },
    editMessageReplyMarkup: vi.fn(async (arg: unknown) => {
      H.editedMarkup.push(arg)
    }),
  } as never
}

const PLAN = { id: 7, weekStart: '2026-09-14', notes: null, createdAt: new Date(), items: [] }

beforeEach(() => {
  H.sent.length = 0
  H.audits.length = 0
  H.editedMarkup.length = 0
  vi.mocked(getPlan).mockReset()
  vi.mocked(generateGroceryList).mockReset()
  vi.mocked(buildShopList).mockReset()
})

describe('groceryKeyboard', () => {
  it('offers both lists before either has been taken', () => {
    const rows = groceryKeyboard(7).inline_keyboard
    const labels = rows.flat().map((b) => b.text)
    expect(labels.some((t) => /instacart/i.test(t))).toBe(true)
    expect(labels.some((t) => /in-store/i.test(t))).toBe(true)
  })

  it('carries the plan id in its callback data', () => {
    const buttons = groceryKeyboard(42).inline_keyboard.flat() as Array<{ callback_data: string }>
    expect(buttons.map((b) => b.callback_data)).toContain('gl:42:cart')
    expect(buttons.map((b) => b.callback_data)).toContain('gl:42:aisle')
  })

  it('drops only the Instacart button once it has been spent', () => {
    const labels = groceryKeyboard(7, { cartSpent: true })
      .inline_keyboard.flat()
      .map((b) => b.text)
    expect(labels.some((t) => /instacart/i.test(t))).toBe(false)
    expect(labels.some((t) => /in-store/i.test(t))).toBe(true)
  })
})

describe('onGroceryChoice', () => {
  it('sends the aisle list and leaves both buttons alone', async () => {
    vi.mocked(getPlan).mockResolvedValue(PLAN as never)
    vi.mocked(generateGroceryList).mockResolvedValue({
      weekendItems: { produce: [{ item: 'dill', quantity: '3/4 cup', recipes: ['Salmon'] }] },
      midweekItems: {},
      hasMidweek: false,
      checkedItems: [],
    } as never)

    const answer = await onGroceryChoice(tap('gl:7:aisle'))

    expect(H.sent).toHaveLength(1)
    expect(H.sent[0]?.text).toContain('dill')
    expect(answer).toMatch(/in-store/i)
    // A pure render must stay tappable.
    expect(H.editedMarkup).toHaveLength(0)
  })

  it('sends the paste block and retires the Instacart button', async () => {
    vi.mocked(getPlan).mockResolvedValue(PLAN as never)
    vi.mocked(buildShopList).mockResolvedValue({
      ok: true,
      build: {
        blocks: ['STOP. Rules.\n2 lb chicken\n1 dill'],
        pasted: 2,
        standingItems: [{ id: 1, name: 'hand soap' }],
        foldedCount: 1,
        foldNote: '',
        consumed: true,
      },
    } as never)

    const answer = await onGroceryChoice(tap('gl:7:cart'))

    expect(H.sent).toHaveLength(1)
    expect(H.sent[0]?.text).toContain('2 lb chicken')
    expect(answer).toMatch(/instacart list sent/i)
    expect(H.editedMarkup).toHaveLength(1)
  })

  it('says so when the standing items could not be ticked off', async () => {
    vi.mocked(getPlan).mockResolvedValue(PLAN as never)
    vi.mocked(buildShopList).mockResolvedValue({
      ok: true,
      build: {
        blocks: ['x'],
        pasted: 1,
        standingItems: [{ id: 1, name: 'soap' }],
        foldedCount: 0,
        foldNote: '',
        consumed: false,
      },
    } as never)

    expect(await onGroceryChoice(tap('gl:7:cart'))).toMatch(/could not tick/i)
  })

  it('reports why there is nothing to shop for rather than sending an empty block', async () => {
    vi.mocked(getPlan).mockResolvedValue(PLAN as never)
    vi.mocked(buildShopList).mockResolvedValue({
      ok: false,
      reason: 'Nothing on the list right now.',
      foldNote: '',
    } as never)

    expect(await onGroceryChoice(tap('gl:7:cart'))).toMatch(/nothing on the list/i)
    expect(H.sent).toHaveLength(0)
  })

  it('does not consume anything when the plan is gone', async () => {
    vi.mocked(getPlan).mockResolvedValue(undefined as never)

    expect(await onGroceryChoice(tap('gl:7:cart'))).toMatch(/gone/i)
    expect(vi.mocked(buildShopList)).not.toHaveBeenCalled()
    expect(H.sent).toHaveLength(0)
  })

  it('refuses callback data that did not come from one of its buttons', async () => {
    const ctx = { match: null, chat: { id: 55 }, from: { id: 99 } } as never
    expect(await onGroceryChoice(ctx)).toMatch(/malformed/i)
  })
})
