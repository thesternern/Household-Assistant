/**
 * Handler-level tests for the chef tools in `src/tools/recipes.ts`, with the
 * store mocked out. Three properties, each of which failed silently if broken:
 *
 *  1. `mealplan_create` tells the model, in the tool result itself, that
 *     autofill never reads allergy or dietary facts — autofill seats recipes
 *     without the model choosing them, so the post-create review is the only
 *     enforcement point, and the reminder has to land at that exact moment.
 *  2. `grocery_list_generate` sanitises `checkedItems` like every other
 *     imported string before it reaches structuredContent.
 *  3. `grocery_list_to_todos` replaces its own open rows instead of stacking
 *     duplicates when it runs twice for the same plan, while a ticked-off
 *     (done) shop survives as history.
 *
 * Pure logic only: the store, database, audit log, and config are all mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroceryListResponse, MealPlan, MealPlanItem } from '../src/recipes/types.js'
import type { ToolContext, ToolDef } from '../src/tools/types.js'

/* ─────────────────────────────────── mocks ───────────────────────────────── */

const H = vi.hoisted(() => ({
  todos: [] as Array<Record<string, unknown>>,
  nextTodoId: 1,
  audits: [] as Array<Record<string, unknown>>,
  /** What the grocery tools sent to the chat directly. */
  sent: [] as Array<{ chatId: string; text: string }>,
  sendFails: false,
}))

vi.mock('../src/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
  return { logger: { ...logger, child: () => logger }, child: () => logger }
})

vi.mock('../src/config.js', () => ({
  getConfig: () => ({ HOUSEHOLD_TIMEZONE: 'America/Los_Angeles' }),
}))

vi.mock('../src/audit/log.js', () => ({
  audit: async (entry: Record<string, unknown>) => {
    H.audits.push(entry)
  },
}))

vi.mock('../src/telegram/send.js', () => ({
  escapeMd: (text: string) => text,
  sendToChat: async (chatId: string, text: string) => {
    if (H.sendFails) return []
    H.sent.push({ chatId, text })
    return [H.sent.length]
  },
}))

vi.mock('../src/recipes/store.js', () => ({
  addPlanItem: vi.fn(),
  autofillPlan: vi.fn(),
  createPlan: vi.fn(),
  generateGroceryList: vi.fn(),
  getPlan: vi.fn(),
  getPlanByWeek: vi.fn(),
  getRecipe: vi.fn(),
  rateRecipe: vi.fn(),
  removePlanItem: vi.fn(),
  saveParsedRecipe: vi.fn(),
  searchRecipes: vi.fn(),
  upsertRecipeFromUrl: vi.fn(),
}))

vi.mock('../src/db/client.js', async () => {
  const schema = await vi.importActual<typeof import('../src/db/schema.js')>('../src/db/schema.js')

  // A fake `todos` table. Like the other fakes in this suite it cannot
  // evaluate a drizzle where clause, so delete applies the rule the handler is
  // contractually making: clear OPEN rows whose source is a grocery key. The
  // row shapes themselves (source, status, titles) come from the real handler
  // and are asserted on below.
  const tx = {
    delete: (_table: unknown) => ({
      where: (_cond: unknown) => ({
        returning: (_sel: unknown) => {
          const removed = H.todos.filter(
            (r) =>
              typeof r['source'] === 'string' &&
              (r['source'] as string).startsWith('grocery:') &&
              r['status'] === 'open',
          )
          for (const row of removed) H.todos.splice(H.todos.indexOf(row), 1)
          return Promise.resolve(removed.map((r) => ({ id: r['id'] })))
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: (rows: Array<Record<string, unknown>>) => ({
        returning: (_sel: unknown) => {
          const written = rows.map((row) => {
            const stored = { id: H.nextTodoId++, ...row }
            H.todos.push(stored)
            return { id: stored.id }
          })
          return Promise.resolve(written)
        },
      }),
    }),
  }

  const db = {
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  }

  return { getDb: () => db, getPool: () => ({}), closeDb: async () => undefined, schema }
})

/* ─────────────────────────── system under test ───────────────────────────── */

import { DateTime } from 'luxon'
import {
  autofillPlan,
  createPlan,
  generateGroceryList,
  getPlan,
  getPlanByWeek,
  getRecipe,
  addPlanItem,
} from '../src/recipes/store.js'
import { recipeTools, resolveWeekStart } from '../src/tools/recipes.js'

const ctx: ToolContext = { chatId: '1', actor: 'Alex', origin: 'agent' }

function tool(name: string): ToolDef {
  const def = recipeTools.find((t) => t.name === name)
  if (!def) throw new Error(`tool ${name} is not registered`)
  return def
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content[0]?.text ?? ''
}

/** 2099-08-31 is a real Monday, far enough out that due dates never clamp. */
const WEEK = '2099-08-31'

function makePlan(items: MealPlanItem[] = []): MealPlan {
  return {
    id: 5,
    weekStart: WEEK,
    notes: null,
    createdAt: new Date('2099-08-01T00:00:00Z'),
    items,
  }
}

function makeItem(id: number, dayOfWeek: number, recipeId: number): MealPlanItem {
  return {
    id,
    planId: 5,
    recipeId,
    dayOfWeek,
    mealType: 'dinner',
    servingsOverride: null,
    notes: null,
  }
}

function makeList(): GroceryListResponse {
  return {
    weekendItems: {
      produce: [{ item: 'yellow onion', quantity: '3', recipes: ['Sheet-pan chicken'] }],
      pantry_staples: [{ item: 'olive oil', quantity: 'as needed', recipes: ['Sheet-pan chicken'] }],
    },
    midweekItems: {
      meat_seafood: [
        { item: 'salmon fillet', quantity: '1.5 lb', recipes: ['Salmon traybake'], day: 'Thu' },
      ],
    },
    hasMidweek: true,
    checkedItems: [],
  }
}

beforeEach(() => {
  vi.mocked(autofillPlan).mockReset()
  vi.mocked(createPlan).mockReset()
  vi.mocked(generateGroceryList).mockReset()
  vi.mocked(getPlan).mockReset()
  H.todos.length = 0
  H.nextTodoId = 1
  H.audits.length = 0
  H.sent.length = 0
  H.sendFails = false
})

/* ───────────────────── mealplan_create — autofill honesty ────────────────── */

describe('mealplan_create — the allergy gap is named, not hidden', () => {
  it('tells the model autofill did not check allergy facts whenever it added dinners', async () => {
    vi.mocked(createPlan).mockResolvedValue(makePlan([]))
    vi.mocked(autofillPlan).mockResolvedValue([makeItem(1, 0, 11)])
    vi.mocked(getPlan).mockResolvedValue(makePlan([makeItem(1, 0, 11)]))

    const res = await tool('mealplan_create').handler({}, ctx)

    expect(res.isError).toBeUndefined()
    expect(textOf(res)).toContain('Added 1 dinner.')
    expect(textOf(res)).toContain('Autofill does not check allergy or dietary facts')
    expect(textOf(res)).toContain('memory_search')
  })

  it('does not nag about allergies when autofill was off and nothing was seated', async () => {
    vi.mocked(createPlan).mockResolvedValue(makePlan([]))
    vi.mocked(getPlan).mockResolvedValue(makePlan([]))

    const res = await tool('mealplan_create').handler({ autofill: false }, ctx)

    expect(vi.mocked(autofillPlan)).not.toHaveBeenCalled()
    expect(textOf(res)).not.toContain('allergy')
  })

  it('does not nag when the autofill pool was empty and no dinner was added', async () => {
    vi.mocked(createPlan).mockResolvedValue(makePlan([]))
    vi.mocked(autofillPlan).mockResolvedValue([])
    vi.mocked(getPlan).mockResolvedValue(makePlan([]))

    const res = await tool('mealplan_create').handler({}, ctx)

    expect(textOf(res)).toContain('No new dinners were added')
    expect(textOf(res)).not.toContain('Autofill does not check allergy')
  })

  it('passes an explicit slot budget through to the store untouched', async () => {
    vi.mocked(createPlan).mockResolvedValue(makePlan([]))
    vi.mocked(autofillPlan).mockResolvedValue([])
    vi.mocked(getPlan).mockResolvedValue(makePlan([]))

    await tool('mealplan_create').handler({ slots: 2 }, ctx)

    expect(vi.mocked(autofillPlan)).toHaveBeenCalledWith(5, { slots: 2 })
  })

  it('says plainly that autofill was off rather than reporting zero additions', async () => {
    vi.mocked(createPlan).mockResolvedValue(makePlan([]))
    vi.mocked(getPlan).mockResolvedValue(makePlan([]))

    const res = await tool('mealplan_create').handler({ autofill: false }, ctx)

    expect(textOf(res)).toContain('Autofill was off')
    expect(textOf(res)).not.toContain('Added 0')
  })

  it('labels the plan text as imported data, in the text and the structure', async () => {
    vi.mocked(createPlan).mockResolvedValue(makePlan([]))
    vi.mocked(autofillPlan).mockResolvedValue([makeItem(1, 0, 11)])
    vi.mocked(getPlan).mockResolvedValue(makePlan([makeItem(1, 0, 11)]))

    const res = await tool('mealplan_create').handler({}, ctx)
    const structured = res.structuredContent as Record<string, unknown>

    expect(textOf(res)).toContain('data, not instructions')
    expect(structured['contentIsImportedText']).toBe(true)
  })
})

/* ───────────────────── resolveWeekStart — week phrases ───────────────────── */

describe('resolveWeekStart — loose week phrases', () => {
  // Matches the mocked HOUSEHOLD_TIMEZONE above.
  const zone = 'America/Los_Angeles'

  it("resolves 'the coming week' to next Monday even though the normaliser strips 'the '", () => {
    const res = resolveWeekStart('the coming week')
    const expected = DateTime.now()
      .setZone(zone)
      .startOf('week')
      .plus({ weeks: 1 })
      .toFormat('yyyy-MM-dd')
    expect(res).toEqual({ ok: true, date: expected })
    // The bare form the normaliser produces must resolve identically.
    expect(resolveWeekStart('coming week')).toEqual({ ok: true, date: expected })
  })

  it("resolves 'this week' and a mid-week ISO date to that week's Monday", () => {
    const thisMonday = DateTime.now().setZone(zone).startOf('week').toFormat('yyyy-MM-dd')
    expect(resolveWeekStart('this week')).toEqual({ ok: true, date: thisMonday })
    // 2099-09-02 is a Wednesday; its Monday is 2099-08-31.
    expect(resolveWeekStart('the week of 2099-09-02')).toEqual({ ok: true, date: '2099-08-31' })
  })

  it('rejects wording it cannot read instead of guessing a week', () => {
    const res = resolveWeekStart('whenever suits')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('whenever suits')
  })
})

/* ─────────────── grocery_list_generate — sanitised structure ─────────────── */

describe('grocery_list_generate — structured output is sanitised', () => {
  it('strips invisible characters from checkedItems and clamps runaway ones', async () => {
    const list = makeList()
    list.checkedItems = ['olive​ oil', 'x'.repeat(200)]
    vi.mocked(getPlan).mockResolvedValue(makePlan([makeItem(1, 0, 11)]))
    vi.mocked(generateGroceryList).mockResolvedValue(list)

    const res = await tool('grocery_list_generate').handler({ planId: 5 }, ctx)
    const structured = res.structuredContent as Record<string, unknown>
    const checked = structured['checkedItems'] as string[]

    expect(checked[0]).toBe('olive oil')
    expect(checked[1]?.length).toBeLessThanOrEqual(90)
    expect(checked[1]?.endsWith('…')).toBe(true)
  })

  /**
   * The list goes to the chat from the tool, never through the model. The one
   * time the model was handed the text to forward, it forwarded a reflowed
   * copy — which is exactly what the button path was built to prevent.
   */
  it('sends the list to the chat itself and hands the model no list text', async () => {
    vi.mocked(getPlan).mockResolvedValue(makePlan([makeItem(1, 0, 11)]))
    vi.mocked(generateGroceryList).mockResolvedValue(makeList())

    const res = await tool('grocery_list_generate').handler({ planId: 5 }, ctx)
    const structured = res.structuredContent as Record<string, unknown>

    expect(H.sent).toHaveLength(1)
    expect(H.sent[0]?.chatId).toBe('1')
    expect(H.sent[0]?.text).toContain('yellow onion')
    expect(H.sent[0]?.text).toContain('salmon fillet')

    expect(res.isError).toBeFalsy()
    expect(textOf(res)).not.toContain('yellow onion')
    expect(textOf(res)).toMatch(/do not repeat/i)
    expect(structured['telegramText']).toBeUndefined()
    expect(structured['plainText']).toBeUndefined()
    expect(structured['deliveredDirectly']).toBe(true)
    expect(structured['hasMidweek']).toBe(true)
    expect(structured['weekendItemCount']).toBe(2)
    expect(structured['midweekItemCount']).toBe(1)
  })

  it('says the send failed rather than falling back to handing the model the list', async () => {
    vi.mocked(getPlan).mockResolvedValue(makePlan([makeItem(1, 0, 11)]))
    vi.mocked(generateGroceryList).mockResolvedValue(makeList())
    H.sendFails = true

    const res = await tool('grocery_list_generate').handler({ planId: 5 }, ctx)

    expect(res.isError).toBe(true)
    expect(textOf(res)).not.toContain('yellow onion')
    expect(textOf(res)).toMatch(/could not send/i)
  })
})

/* ──────────── grocery_list_to_todos — twice is not two lists ─────────────── */

describe('grocery_list_to_todos — running twice never duplicates', () => {
  function openGroceryRows(): Array<Record<string, unknown>> {
    return H.todos.filter(
      (r) => typeof r['source'] === 'string' && (r['source'] as string).startsWith('grocery:') && r['status'] === 'open',
    )
  }

  beforeEach(() => {
    vi.mocked(getPlan).mockResolvedValue(makePlan([makeItem(1, 0, 11)]))
    vi.mocked(generateGroceryList).mockResolvedValue(makeList())
    // An unrelated open to-do that must never be touched by the replace.
    H.todos.push({ id: H.nextTodoId++, title: 'Book the dentist', source: 'chat', status: 'open' })
  })

  it('creates one open to-do per trip, keyed to the plan, with fixed due dates', async () => {
    const res = await tool('grocery_list_to_todos').handler({ planId: 5 }, ctx)
    const structured = res.structuredContent as Record<string, unknown>

    expect(structured['added']).toBe(2)
    expect(structured['replaced']).toBe(0)
    expect(structured['weekendDue']).toBe('2099-08-29') // the Saturday before the week
    expect(structured['midweekDue']).toBe('2099-09-03') // the Thursday inside it

    const rows = openGroceryRows()
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row['source']).toBe('grocery:5')
      expect(row['createdBy']).toBe('Alex')
    }
  })

  it('replaces its own open rows on a second run instead of stacking duplicates', async () => {
    await tool('grocery_list_to_todos').handler({ planId: 5 }, ctx)
    const res = await tool('grocery_list_to_todos').handler({ planId: 5 }, ctx)
    const structured = res.structuredContent as Record<string, unknown>

    expect(structured['added']).toBe(2)
    expect(structured['replaced']).toBe(2)

    const rows = openGroceryRows()
    expect(rows).toHaveLength(2)
    const titles = rows.map((r) => r['title'])
    expect(new Set(titles).size).toBe(titles.length)

    // The unrelated to-do was never part of the replace.
    expect(H.todos.some((r) => r['title'] === 'Book the dentist' && r['status'] === 'open')).toBe(true)
  })

  it('keeps a completed shop as history and only replaces what is still open', async () => {
    await tool('grocery_list_to_todos').handler({ planId: 5 }, ctx)
    const done = H.todos.find(
      (r) => typeof r['title'] === 'string' && (r['title'] as string).startsWith('Weekend'),
    )
    expect(done).toBeDefined()
    if (done) done['status'] = 'done'

    const res = await tool('grocery_list_to_todos').handler({ planId: 5 }, ctx)
    const structured = res.structuredContent as Record<string, unknown>

    expect(structured['replaced']).toBe(1) // only the still-open midweek row
    expect(openGroceryRows()).toHaveLength(2) // a fresh pair
    // The ticked-off weekend shop is still there as history.
    expect(
      H.todos.filter((r) => r['source'] === 'grocery:5' && r['status'] === 'done'),
    ).toHaveLength(1)
  })
})

/**
 * A protein on every plate, enforced where recipes are actually placed.
 *
 * autofillPlan filters its candidates, but the model also seats meals by hand
 * with mealplan_add_item — and that is how "Arugula Salad With Lime
 * Vinaigrette" ended up as a Thursday lunch. A rule that only guards the
 * automatic path is not the rule the household asked for.
 */
describe('mealplan_add_item: protein guard', () => {
  const salad = {
    id: 90,
    title: 'Arugula Salad With Lime Vinaigrette',
    ingredients: [
      { item: 'arugula', quantity: '2 bunch', section: 'produce' },
      { item: 'lime', quantity: '2', section: 'produce' },
    ],
  }
  const chicken = {
    id: 91,
    title: 'Miso-Maple Sheet-Pan Chicken',
    ingredients: [{ item: 'chicken thighs', quantity: '4', section: 'meat_seafood' }],
  }

  beforeEach(() => {
    vi.mocked(getPlanByWeek).mockResolvedValue(makePlan([]))
    vi.mocked(getPlan).mockResolvedValue(makePlan([]))
    // Clear the call history, not just the resolved value: these assertions are
    // about whether the plan was written at all.
    vi.mocked(addPlanItem).mockClear()
    vi.mocked(addPlanItem).mockResolvedValue(undefined as never)
  })

  it('refuses to seat a recipe with no protein in it', async () => {
    vi.mocked(getRecipe).mockResolvedValue(salad as never)

    const out = await tool('mealplan_add_item').handler(
      { week: WEEK, day: 'thursday', recipeId: 90, mealType: 'lunch' },
      ctx,
    )

    expect(vi.mocked(addPlanItem)).not.toHaveBeenCalled()
    expect(out.isError).toBe(true)
    expect(textOf(out)).toMatch(/protein/i)
    expect(textOf(out)).toContain('Arugula Salad')
  })

  it('names the rule so the model can act on it rather than retrying', async () => {
    vi.mocked(getRecipe).mockResolvedValue(salad as never)
    const out = await tool('mealplan_add_item').handler(
      { week: WEEK, day: 'thursday', recipeId: 90, mealType: 'lunch' },
      ctx,
    )
    expect(textOf(out)).toMatch(/meat|fish|tofu|beans/i)
  })

  it('seats a recipe that does carry a protein', async () => {
    vi.mocked(getRecipe).mockResolvedValue(chicken as never)
    vi.mocked(getPlan).mockResolvedValue(makePlan([makeItem(1, 3, 91)]))

    const out = await tool('mealplan_add_item').handler(
      { week: WEEK, day: 'thursday', recipeId: 91, mealType: 'dinner' },
      ctx,
    )

    expect(vi.mocked(addPlanItem)).toHaveBeenCalled()
    expect(out.isError).toBeFalsy()
    // The result text is what the model reads right before it decides how to
    // get the shopping list; it must not point at the in-store tool.
    expect(textOf(out)).not.toContain('grocery_list_generate')
  })

  it('still reports a recipe id that does not exist', async () => {
    vi.mocked(getRecipe).mockResolvedValue(undefined as never)
    const out = await tool('mealplan_add_item').handler(
      { week: WEEK, day: 'thursday', recipeId: 999 },
      ctx,
    )
    expect(vi.mocked(addPlanItem)).not.toHaveBeenCalled()
    expect(out.isError).toBe(true)
  })
})
