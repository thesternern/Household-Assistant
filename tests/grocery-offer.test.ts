/**
 * The recipe summary that leads every shopping-list reply.
 *
 * The household asked for the plan restated before the list arrives: what am I
 * cooking, how long does it take, and roughly what turns up in the bag. It is a
 * pure formatter over a stored plan, so nothing here touches Telegram or the
 * database.
 */
import { describe, expect, it } from 'vitest'
import { formatPlanRecipeSummary } from '../src/tools/recipes.js'
import type { MealPlan, MealPlanItem, Recipe } from '../src/recipes/types.js'

function recipe(over: Partial<Recipe> = {}): Recipe {
  return {
    id: 1,
    title: 'Miso-Maple Sheet-Pan Chicken',
    source: 'nyt_cooking',
    sourceUrl: 'https://cooking.nytimes.com/recipes/1-x',
    author: null,
    description: null,
    totalTimeMinutes: 45,
    activeTimeMinutes: 15,
    servings: '4 servings',
    difficulty: 'easy',
    ingredients: [
      { item: 'chicken thighs', quantity: '4', section: 'meat_seafood' },
      { item: 'brussels sprouts', quantity: '12 oz', section: 'produce' },
      { item: 'white miso', quantity: '1/3 cup', section: 'other' },
      { item: 'maple syrup', quantity: '1/3 cup', section: 'pantry_dry_goods' },
    ],
    steps: ['Roast it.'],
    familyScore: 8,
    familyNotes: null,
    tags: [],
    groceryCategories: null,
    imageUrl: null,
    scrapedAt: new Date('2026-01-01T00:00:00Z'),
    timesPlanned: 0,
    lastPlannedDate: null,
    isArchived: false,
    freshnessCategory: 'moderate',
    freezerFriendly: false,
    ...over,
  }
}

function plan(recipes: Recipe[]): MealPlan {
  const items: MealPlanItem[] = recipes.map((r, i) => ({
    id: i + 1,
    planId: 7,
    recipeId: r.id,
    dayOfWeek: i,
    mealType: 'dinner',
    servingsOverride: null,
    notes: null,
    recipe: r,
  }))
  return { id: 7, weekStart: '2026-09-14', notes: null, createdAt: new Date(), items }
}

/** Read the rendered text back without its MarkdownV2 escapes. */
function plain(text: string): string {
  return text.replace(/\\(.)/g, '$1')
}

describe('formatPlanRecipeSummary', () => {
  it('names the recipe, its times, its servings and its main ingredients', () => {
    const text = plain(formatPlanRecipeSummary(plan([recipe()])))

    expect(text).toContain('Miso-Maple Sheet-Pan Chicken')
    expect(text).toContain('45 min')
    expect(text).toContain('15 active')
    expect(text).toContain('4 servings')
    expect(text).toContain('chicken thighs')
    expect(text).toContain('brussels sprouts')
  })

  it('numbers the recipes in day order', () => {
    const text = plain(formatPlanRecipeSummary(
      plan([recipe({ id: 1, title: 'First' }), recipe({ id: 2, title: 'Second' })]),
    ))
    expect(text.indexOf('First')).toBeLessThan(text.indexOf('Second'))
    expect(text).toMatch(/1\./)
    expect(text).toMatch(/2\./)
  })

  /**
   * Nobody reads a summary to be told the dish contains salt. The point of the
   * ingredient line is recognising the meal, and staples crowd that out.
   */
  it('leaves pantry staples out of the ingredient line', () => {
    const text = plain(formatPlanRecipeSummary(
      plan([
        recipe({
          ingredients: [
            { item: 'salt', quantity: '', section: 'pantry_staples' },
            { item: 'olive oil', quantity: '2 tbsp', section: 'pantry_staples' },
            { item: 'cod fillets', quantity: '4', section: 'meat_seafood' },
          ],
        }),
      ]),
    ))
    expect(text).toContain('cod fillets')
    expect(text).not.toContain('salt')
  })

  it('caps a long ingredient list rather than restating the recipe', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      item: `thing ${i}`,
      quantity: '1',
      section: 'produce' as const,
    }))
    const text = plain(formatPlanRecipeSummary(plan([recipe({ ingredients: many })])))
    expect(text).toContain('thing 0')
    expect(text).not.toContain('thing 19')
  })

  it('says nothing about a time it does not know', () => {
    const text = plain(formatPlanRecipeSummary(
      plan([recipe({ totalTimeMinutes: null, activeTimeMinutes: null, servings: null })]),
    ))
    expect(text).toContain('Miso-Maple Sheet-Pan Chicken')
    expect(text).not.toContain('null')
    expect(text).not.toMatch(/\bmin\b/)
  })

  it('handles a plan with no recipes on it', () => {
    expect(plain(formatPlanRecipeSummary(plan([])))).toMatch(/no recipes|nothing/i)
  })
})
