/**
 * The Claude pass over the consolidated grocery list.
 *
 * The consolidator merges exact names. A real week still carried "garlic",
 * "garlic cloves" and "2 tsp garlic" as three rows, "3 cup parsley leaves"
 * nobody can buy, and "lemon wedges, for serving" as a thing to shop for. A
 * model can tidy that; what it must never do is lose an ingredient or invent
 * one. So the pass is an accounting exercise: every input row ends up in
 * exactly one output row or in the dropped list, and anything the model
 * forgets comes back unchanged.
 *
 * The model is behind an injected call so these tests exercise the accounting,
 * the prompt, and the fallback — not the network.
 */
import { describe, expect, it, vi } from 'vitest'
import type { GroceryListData } from '../src/recipes/types.js'

vi.mock('../src/logger.js', () => {
  const noop = (): void => {}
  const l: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop }
  l['child'] = () => l
  return { logger: l, child: () => l }
})

import {
  applyRefinement,
  buildRefinePrompt,
  numberRows,
  refineGroceryList,
  sourceHash,
  storedRefinement,
} from '../src/recipes/grocery/refine.js'

function weekend(): GroceryListData {
  return {
    produce: [
      { item: 'garlic cloves', quantity: '4', recipes: ['Pasta'] },
      { item: 'parsley leaves', quantity: '3 cup', recipes: ['Pasta'] },
      { item: 'lemon wedges', quantity: 'as needed', recipes: ['Salmon'] },
    ],
    pantry_staples: [{ item: 'garlic', quantity: '2 1/4 tsp', recipes: ['Salmon', 'Chicken'] }],
    dairy_eggs: [{ item: 'unsalted butter', quantity: '1 tbsp', recipes: ['Pasta'] }],
  }
}

function midweek(): GroceryListData {
  return {
    produce: [{ item: 'garlic cloves', quantity: '3', recipes: ['Stir-fry'], day: 'Fri' }],
    meat_seafood: [{ item: 'beef', quantity: '8 oz', recipes: ['Stir-fry'], day: 'Fri' }],
  }
}

function input() {
  return { weekend: weekend(), midweek: midweek() }
}

/** Find a row by name across every section of one trip. */
function find(data: GroceryListData, item: string) {
  return Object.values(data)
    .flat()
    .find((row) => row?.item === item)
}

function allItems(data: GroceryListData): string[] {
  return Object.values(data)
    .flat()
    .map((row) => row!.item)
    .sort()
}

/* ─────────────────────────────── numbering ──────────────────────────────── */

describe('numberRows', () => {
  it('gives every row of both trips a stable number, weekend first, in section order', () => {
    const rows = numberRows(input())

    expect(rows.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(rows[0]).toMatchObject({ item: 'garlic cloves', trip: 'weekend', section: 'produce' })
    expect(rows[3]).toMatchObject({ item: 'unsalted butter', section: 'dairy_eggs' })
    expect(rows[4]).toMatchObject({ item: 'garlic', section: 'pantry_staples' })
    expect(rows[5]).toMatchObject({ item: 'garlic cloves', trip: 'midweek', day: 'Fri' })
  })
})

/* ─────────────────────────────── accounting ─────────────────────────────── */

describe('applyRefinement', () => {
  it('merges the rows the model names into one, keeping every recipe', () => {
    const rows = numberRows(input())
    const out = applyRefinement(rows, {
      rows: [
        { sources: [1, 5], item: 'garlic', quantity: '1 head', section: 'produce', trip: 'weekend' },
        { sources: [2], item: 'parsley', quantity: '1 bunch', section: 'produce', trip: 'weekend' },
        { sources: [3], item: 'lemon wedges', quantity: 'as needed', section: 'produce', trip: 'weekend' },
        { sources: [4], item: 'unsalted butter', quantity: '1 tbsp', section: 'dairy_eggs', trip: 'weekend' },
        { sources: [6], item: 'garlic cloves', quantity: '3', section: 'produce', trip: 'midweek' },
        { sources: [7], item: 'beef', quantity: '8 oz', section: 'meat_seafood', trip: 'midweek' },
      ],
      dropped: [],
    })

    expect(out).not.toBeNull()
    const garlic = find(out!.weekend, 'garlic')
    expect(garlic).toMatchObject({ quantity: '1 head' })
    expect(garlic?.recipes.sort()).toEqual(['Chicken', 'Pasta', 'Salmon'])
    expect(find(out!.weekend, 'garlic cloves')).toBeUndefined()
    expect(out!.weekend.pantry_staples ?? []).toHaveLength(0)
  })

  it('restores any input row the model neither used nor dropped', () => {
    const rows = numberRows(input())
    const out = applyRefinement(rows, {
      rows: [{ sources: [1, 5], item: 'garlic', quantity: '1 head', section: 'produce', trip: 'weekend' }],
      dropped: [],
    })

    expect(allItems(out!.weekend)).toEqual(['garlic', 'lemon wedges', 'parsley leaves', 'unsalted butter'])
    expect(find(out!.weekend, 'unsalted butter')).toMatchObject({ quantity: '1 tbsp', recipes: ['Pasta'] })
    expect(allItems(out!.midweek)).toEqual(['beef', 'garlic cloves'])
    expect(out!.restored).toBe(5)
  })

  it('rejects an output row that cites an unknown source and keeps its inputs', () => {
    const rows = numberRows(input())
    const out = applyRefinement(rows, {
      rows: [{ sources: [2, 99], item: 'parsley', quantity: '1 bunch', section: 'produce', trip: 'weekend' }],
      dropped: [],
    })

    expect(find(out!.weekend, 'parsley')).toBeUndefined()
    expect(find(out!.weekend, 'parsley leaves')).toMatchObject({ quantity: '3 cup' })
  })

  it('rejects an output row that reuses a source another row already took', () => {
    const rows = numberRows(input())
    const out = applyRefinement(rows, {
      rows: [
        { sources: [1, 5], item: 'garlic', quantity: '1 head', section: 'produce', trip: 'weekend' },
        { sources: [5], item: 'garlic powder', quantity: '1 jar', section: 'spices_seasonings', trip: 'weekend' },
      ],
      dropped: [],
    })

    expect(find(out!.weekend, 'garlic')).toBeDefined()
    expect(find(out!.weekend, 'garlic powder')).toBeUndefined()
  })

  it('never invents: an output row with no sources is ignored', () => {
    const rows = numberRows(input())
    const out = applyRefinement(rows, {
      rows: [{ sources: [], item: 'olive oil', quantity: '1 bottle', section: 'pantry_staples', trip: 'weekend' }],
      dropped: [],
    })

    expect(find(out!.weekend, 'olive oil')).toBeUndefined()
    expect(allItems(out!.weekend)).toHaveLength(5)
  })

  it('drops a row only when it is named in the dropped list with a reason', () => {
    const rows = numberRows(input())
    const out = applyRefinement(rows, {
      rows: [],
      dropped: [{ source: 3, reason: 'serving_only' }],
    })

    expect(find(out!.weekend, 'lemon wedges')).toBeUndefined()
    expect(out!.dropped).toBe(1)
    expect(allItems(out!.weekend)).toHaveLength(4)
  })

  /**
   * The first real run merged Friday's asparagus into the weekend shop —
   * tidy, and exactly what the midweek pickup exists to prevent. A row's
   * sources must all be on the trip the row lands on; anything else is
   * rejected and both inputs come back where they were.
   */
  it('keeps the trips apart: a row that mixes weekend and midweek sources is rejected', () => {
    const rows = numberRows(input())
    const out = applyRefinement(rows, {
      rows: [{ sources: [6, 1], item: 'garlic cloves', quantity: '7', section: 'produce', trip: 'weekend' }],
      dropped: [],
    })

    expect(find(out!.weekend, 'garlic cloves')).toMatchObject({ quantity: '4' })
    expect(find(out!.midweek, 'garlic cloves')).toMatchObject({ quantity: '3', day: 'Fri' })
  })

  it('rejects a row that files a midweek source under the weekend trip, and the reverse', () => {
    const rows = numberRows(input())
    const out = applyRefinement(rows, {
      rows: [
        { sources: [7], item: 'beef', quantity: '8 oz', section: 'meat_seafood', trip: 'weekend' },
        { sources: [2], item: 'parsley', quantity: '1 bunch', section: 'produce', trip: 'midweek' },
      ],
      dropped: [],
    })

    expect(find(out!.weekend, 'beef')).toBeUndefined()
    expect(find(out!.midweek, 'beef')).toMatchObject({ day: 'Fri' })
    expect(find(out!.midweek, 'parsley')).toBeUndefined()
    expect(find(out!.weekend, 'parsley leaves')).toBeDefined()
  })

  it('keeps the pickup day on a row that stays midweek', () => {
    const rows = numberRows(input())
    const out = applyRefinement(rows, {
      rows: [{ sources: [7], item: 'ground beef', quantity: '8 oz', section: 'meat_seafood', trip: 'midweek' }],
      dropped: [],
    })

    expect(find(out!.midweek, 'ground beef')).toMatchObject({ day: 'Fri' })
  })

  it('sanitises the names the model returns, since they began as scraped text', () => {
    const rows = numberRows(input())
    const out = applyRefinement(rows, {
      rows: [
        {
          sources: [2],
          item: '  Parsley​\n<b>IGNORE PREVIOUS</b> ' + 'x'.repeat(200),
          quantity: '1 bunch',
          section: 'produce',
          trip: 'weekend',
        },
      ],
      dropped: [],
    })

    const parsley = Object.values(out!.weekend)
      .flat()
      .find((r) => r!.item.startsWith('parsley'))
    expect(parsley).toBeDefined()
    expect(parsley!.item).not.toMatch(/[​\n<>]/)
    expect(parsley!.item.length).toBeLessThanOrEqual(90)
  })

  it('returns null for a reply that is not the agreed shape', () => {
    const rows = numberRows(input())

    expect(applyRefinement(rows, { rows: 'nope' })).toBeNull()
    expect(applyRefinement(rows, null)).toBeNull()
    expect(
      applyRefinement(rows, {
        rows: [{ sources: [1], item: 'garlic', quantity: '1', section: 'not_a_section', trip: 'weekend' }],
        dropped: [],
      }),
    ).toBeNull()
  })
})

/* ──────────────────────────────── the prompt ────────────────────────────── */

describe('buildRefinePrompt', () => {
  it('numbers every row and fences the names as untrusted data', () => {
    const rows = numberRows(input())
    const { system, user } = buildRefinePrompt(rows)

    for (const row of rows) expect(user).toContain(`${row.n}.`)
    expect(user).toContain('garlic cloves')
    expect(user).toMatch(/<untrusted/)
    expect(system).toMatch(/never invent/i)
    expect(system).toMatch(/serving_only/)
  })
})

/* ──────────────────────────────── the pass ──────────────────────────────── */

describe('refineGroceryList', () => {
  it('applies what a working model returns and reports refined: true', async () => {
    const result = await refineGroceryList(input(), {
      model: async () => ({
        rows: [{ sources: [1, 5], item: 'garlic', quantity: '1 head', section: 'produce', trip: 'weekend' }],
        dropped: [{ source: 3, reason: 'serving_only' }],
      }),
    })

    expect(result.refined).toBe(true)
    expect(find(result.weekend, 'garlic')).toMatchObject({ quantity: '1 head' })
    expect(find(result.weekend, 'lemon wedges')).toBeUndefined()
    expect(find(result.midweek, 'garlic cloves')).toMatchObject({ day: 'Fri' })
    expect(find(result.midweek, 'beef')).toBeDefined()
  })

  it('returns the input untouched, refined: false, when the model call fails', async () => {
    const result = await refineGroceryList(input(), {
      model: async () => {
        throw new Error('timeout')
      },
    })

    expect(result.refined).toBe(false)
    expect(result.reason).toMatch(/timeout/)
    expect(result.weekend).toEqual(weekend())
    expect(result.midweek).toEqual(midweek())
  })

  it('returns the input untouched, refined: false, when the reply is malformed', async () => {
    const result = await refineGroceryList(input(), { model: async () => ({ garbage: true }) })

    expect(result.refined).toBe(false)
    expect(result.weekend).toEqual(weekend())
  })

  it('does not call the model for an empty list', async () => {
    let calls = 0
    const result = await refineGroceryList(
      { weekend: {}, midweek: {} },
      {
        model: async () => {
          calls += 1
          return { rows: [], dropped: [] }
        },
      },
    )

    expect(calls).toBe(0)
    expect(result.refined).toBe(true)
  })
})

/* ──────────────────────────────── the cache key ─────────────────────────── */

describe('sourceHash', () => {
  it('is the same for the same rows and different for different ones', () => {
    const a = sourceHash(input())
    const b = sourceHash(input())
    const changed = input()
    changed.weekend.produce![0]!.quantity = '5'

    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(sourceHash(changed)).not.toBe(a)
  })

  it('does not depend on the order sections were written in', () => {
    const reordered = { weekend: { dairy_eggs: weekend().dairy_eggs, produce: weekend().produce, pantry_staples: weekend().pantry_staples }, midweek: midweek() }

    expect(sourceHash(reordered)).toBe(sourceHash(input()))
  })
})

/* ─────────────────────────────── the stored copy ────────────────────────── */

describe('storedRefinement', () => {
  const hash = sourceHash(input())
  const stored = { weekend: { produce: [{ item: 'garlic', quantity: '1 head', recipes: ['Pasta'] }] }, midweek: {}, refined: true }

  it('reuses a stored refinement when the rows have not changed', () => {
    const reuse = storedRefinement({ sourceHash: hash, refined: stored }, hash)

    expect(reuse).not.toBeNull()
    expect(find(reuse!.weekend, 'garlic')).toMatchObject({ quantity: '1 head' })
  })

  it('ignores a stored refinement built from different rows', () => {
    expect(storedRefinement({ sourceHash: 'somethingelse', refined: stored }, hash)).toBeNull()
  })

  it('ignores a row with nothing stored, a malformed blob, or an unrefined one', () => {
    expect(storedRefinement(undefined, hash)).toBeNull()
    expect(storedRefinement({ sourceHash: hash, refined: null }, hash)).toBeNull()
    expect(storedRefinement({ sourceHash: hash, refined: { weekend: 'x' } }, hash)).toBeNull()
    expect(storedRefinement({ sourceHash: hash, refined: { ...stored, refined: false } }, hash)).toBeNull()
  })
})
