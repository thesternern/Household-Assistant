import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addPlanItem,
  createPlan,
  getPlanByWeek,
  rateRecipe,
  selectVarietyRecipes,
  upsertRecipeFromUrl,
} from '../src/recipes/store.js'
import type { VarietyCandidate } from '../src/recipes/store.js'
import { fetchAndParseRecipe } from '../src/recipes/scraper.js'

// The guard tests below all reject before `getDb()` is ever called, so nothing
// here needs a database or env. The scraper is mocked to prove the SSRF guard
// short-circuits before the network.
vi.mock('../src/recipes/scraper.js', () => ({
  fetchAndParseRecipe: vi.fn(async () => {
    throw new Error('scraper should not have been called')
  }),
}))

/**
 * `selectVarietyRecipes` is the pure core of `autofillPlan`: it takes the
 * pre-ranked candidate list (fewest times planned, least recently planned,
 * best rated) and returns the week's picks, freshness-ordered. No database.
 */

function candidate(
  id: number,
  title: string,
  tags: string[],
  extra: Partial<VarietyCandidate> = {},
): VarietyCandidate {
  return {
    id,
    title,
    tags,
    totalTimeMinutes: 30,
    freshnessCategory: 'moderate',
    freezerFriendly: false,
    ...extra,
  }
}

/** Eight candidates spanning six proteins, six styles and five cuisines. */
function varied(): VarietyCandidate[] {
  return [
    candidate(1, 'Sheet-pan chicken thighs', ['sheet-pan', 'american']),
    candidate(2, 'Chicken stir-fry', ['stir-fry', 'asian']),
    candidate(3, 'Beef tacos', ['one-pot', 'mexican']),
    candidate(4, 'Pork ragu', ['pasta', 'italian']),
    candidate(5, 'Salmon traybake', ['soup-stew', 'mediterranean']),
    candidate(6, 'Lentil curry', ['slow-cooker', 'asian']),
    candidate(7, 'Shrimp scampi', ['pasta', 'italian']),
    candidate(8, 'Turkey chili', ['one-pot', 'american']),
  ]
}

const ids = (picks: VarietyCandidate[]): number[] => picks.map((p) => p.id)

describe('selectVarietyRecipes', () => {
  it('does not pick the same protein twice when alternatives exist', () => {
    // Ranked order puts two chicken recipes at the top. The scorer takes the
    // first, skips the second, and reaches past it for beef and pork.
    const picks = selectVarietyRecipes(varied().slice(0, 5), 3)

    expect(ids(picks)).toEqual([1, 3, 4])
    expect(ids(picks)).not.toContain(2)
  })

  it('keeps proteins distinct across a full five-night week', () => {
    const picks = selectVarietyRecipes(varied(), 5)

    // chicken, beef, pork, seafood, vegetarian — the second chicken is skipped.
    expect(ids(picks)).toEqual([1, 3, 4, 5, 6])
    expect(ids(picks)).not.toContain(2)
  })

  it('fills exactly slotsNeeded when enough candidates exist', () => {
    expect(selectVarietyRecipes(varied(), 5)).toHaveLength(5)
    expect(selectVarietyRecipes(varied(), 3)).toHaveLength(3)
    expect(selectVarietyRecipes(varied(), 1)).toHaveLength(1)
  })

  it('relaxes the diversity caps rather than leaving the week short', () => {
    // Every candidate is chicken, so no rung of the ladder can keep proteins
    // distinct. It must still fill all five nights.
    const allChicken = [
      candidate(11, 'Chicken A', ['sheet-pan', 'american']),
      candidate(12, 'Chicken B', ['stir-fry', 'asian']),
      candidate(13, 'Chicken C', ['one-pot', 'mexican']),
      candidate(14, 'Chicken D', ['soup-stew', 'italian']),
      candidate(15, 'Chicken E', ['slow-cooker', 'mediterranean']),
      candidate(16, 'Chicken F', ['pasta', 'american']),
    ]

    const picks = selectVarietyRecipes(allChicken, 5)

    expect(picks).toHaveLength(5)
    expect(new Set(ids(picks)).size).toBe(5)
  })

  it('never returns more than the candidate pool holds', () => {
    const picks = selectVarietyRecipes(varied().slice(0, 2), 5)
    expect(picks).toHaveLength(2)
  })

  it('returns nothing when no slots are open', () => {
    expect(selectVarietyRecipes(varied(), 0)).toEqual([])
    expect(selectVarietyRecipes(varied(), -1)).toEqual([])
  })

  it('skips recipes already on the plan', () => {
    const picks = selectVarietyRecipes(varied(), 2, [1, 3])

    expect(ids(picks)).toEqual([2, 4])
    expect(ids(picks)).not.toContain(1)
    expect(ids(picks)).not.toContain(3)
  })

  it('orders picks most perishable first, treating freezer-friendly as shelf stable', () => {
    const pool = [
      candidate(1, 'Sheet-pan chicken thighs', ['sheet-pan', 'american'], {
        freshnessCategory: 'shelf_stable',
      }),
      candidate(3, 'Beef tacos', ['one-pot', 'mexican'], {
        freshnessCategory: 'very_perishable',
      }),
      candidate(4, 'Pork ragu', ['pasta', 'italian'], { freshnessCategory: 'perishable' }),
      candidate(5, 'Salmon traybake', ['soup-stew', 'mediterranean'], {
        freshnessCategory: 'very_perishable',
        freezerFriendly: true,
      }),
    ]

    const picks = selectVarietyRecipes(pool, 4)

    // very_perishable → perishable → shelf_stable. Salmon is bought frozen, so
    // it sorts last despite its raw very_perishable classification, and ties
    // keep their ranking order.
    expect(ids(picks)).toEqual([3, 4, 1, 5])
  })

  it('does not mutate the candidate list it is given', () => {
    const pool = varied()
    const before = ids(pool)

    selectVarietyRecipes(pool, 5)

    expect(ids(pool)).toEqual(before)
  })

  it('returns nothing for a non-numeric slot count', () => {
    // NaN would make every `selected.length >= slotsNeeded` test false, so the
    // first rung would "succeed" holding the whole pool.
    expect(selectVarietyRecipes(varied(), Number.NaN)).toEqual([])
    expect(selectVarietyRecipes(varied(), Number.POSITIVE_INFINITY)).toEqual([])
  })

  it('floors a fractional slot count', () => {
    expect(selectVarietyRecipes(varied(), 2.9)).toHaveLength(2)
  })
})

describe('input guards', () => {
  beforeEach(() => {
    vi.mocked(fetchAndParseRecipe).mockClear()
  })

  it('refuses to scrape loopback, private and link-local addresses', async () => {
    const blocked = [
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:3000/admin',
      'http://127.0.0.1/',
      'http://2130706433/', // decimal form of 127.0.0.1
      'http://10.0.0.5/recipe',
      'http://192.168.1.1/recipe',
      'http://172.16.0.1/recipe',
      'http://[::1]/recipe',
      'http://db.internal/recipe',
    ]

    for (const url of blocked) {
      await expect(upsertRecipeFromUrl(url)).rejects.toThrow(/Refusing to import/)
    }
    expect(fetchAndParseRecipe).not.toHaveBeenCalled()
  })

  it('refuses non-HTTP schemes, credentialled URLs and unparseable URLs', async () => {
    await expect(upsertRecipeFromUrl('file:///etc/passwd')).rejects.toThrow(/non-HTTP/)
    await expect(upsertRecipeFromUrl('https://user:pw@example.com/r')).rejects.toThrow(
      /credentials/,
    )
    await expect(upsertRecipeFromUrl('not a url')).rejects.toThrow(/Invalid recipe URL/)
    expect(fetchAndParseRecipe).not.toHaveBeenCalled()
  })

  it('rejects a weekStart that is not an ISO date', async () => {
    await expect(createPlan('next monday')).rejects.toThrow(/Invalid weekStart/)
    await expect(createPlan('2026-9-1')).rejects.toThrow(/Invalid weekStart/)
    await expect(getPlanByWeek('sometime')).rejects.toThrow(/Invalid weekStart/)
  })

  it('rejects a day of week outside 0–6', async () => {
    await expect(addPlanItem(1, 1, 7)).rejects.toThrow(/Invalid dayOfWeek/)
    await expect(addPlanItem(1, 1, -1)).rejects.toThrow(/Invalid dayOfWeek/)
    await expect(addPlanItem(1, 1, 1.5)).rejects.toThrow(/Invalid dayOfWeek/)
  })

  it('rejects a non-finite family score before it reaches the integer column', async () => {
    await expect(rateRecipe(1, Number.NaN)).rejects.toThrow(/Invalid family score/)
  })
})
