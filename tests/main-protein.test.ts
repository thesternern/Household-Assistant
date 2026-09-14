/**
 * Whether a recipe can be seated as a weeknight dinner.
 *
 * The library holds sides, sauces and puddings alongside mains — potato salad,
 * smashed potatoes, tomato sauce, two chocolate cakes — and the planner had no
 * way to tell them apart. `detectProtein` reads only the title and tags, and
 * only to *vary* the protein across a week; it never asked whether there was
 * one. So "Arugula Salad with Lime Vinaigrette" was a legal Tuesday dinner.
 *
 * The test is on the ingredients, never the title: a title lies about its
 * contents far more often than an ingredient list does.
 */
import { describe, expect, it } from 'vitest'
import { dinnerCandidates, hasMainProtein } from '../src/recipes/protein.js'
import type { Ingredient } from '../src/recipes/types.js'

function ing(item: string, section: Ingredient['section']): Ingredient {
  return { item, quantity: '1', section }
}

describe('hasMainProtein', () => {
  it('accepts anything from the meat and seafood counter', () => {
    expect(hasMainProtein([ing('chicken thighs', 'meat_seafood')])).toBe(true)
    expect(hasMainProtein([ing('salmon fillet', 'meat_seafood')])).toBe(true)
    expect(hasMainProtein([ing('pork chops', 'meat_seafood')])).toBe(true)
  })

  it('accepts the plant proteins a main is actually built on', () => {
    for (const item of [
      'silken tofu',
      'tempeh',
      'red lentils',
      'chickpeas',
      'cannellini beans',
      'black beans',
      'edamame',
    ]) {
      expect(hasMainProtein([ing(item, 'canned_jarred')]), item).toBe(true)
    }
  })

  /**
   * "Green beans" and "peanut butter" both contain a protein word and neither
   * is a protein. Bare "bean" and "pea" are why this list names the legumes
   * individually.
   */
  it('is not fooled by a vegetable that sounds like a legume', () => {
    expect(hasMainProtein([ing('green beans', 'produce'), ing('scallions', 'produce')])).toBe(false)
    expect(hasMainProtein([ing('peanut butter', 'pantry_dry_goods'), ing('noodles', 'grains_pasta_rice')])).toBe(
      false,
    )
    expect(hasMainProtein([ing('snap peas', 'produce')])).toBe(false)
  })

  /** The real sides and puddings sitting in the library right now. */
  it('rejects a salad, a side and a pudding', () => {
    expect(
      hasMainProtein([ing('arugula', 'produce'), ing('lime', 'produce'), ing('olive oil', 'pantry_staples')]),
    ).toBe(false)
    expect(
      hasMainProtein([ing('red new potatoes', 'produce'), ing('mayonnaise', 'oils_vinegars_condiments')]),
    ).toBe(false)
    expect(
      hasMainProtein([ing('flour', 'pantry_dry_goods'), ing('sugar', 'pantry_dry_goods'), ing('eggs', 'dairy_eggs')]),
    ).toBe(false)
  })

  /**
   * Cheese is protein, but counting it would readmit every side in the
   * library — parmesan-crusted potatoes chief among them. Ruled out
   * deliberately, not by oversight.
   */
  it('does not treat cheese as a main protein', () => {
    expect(
      hasMainProtein([ing('red new potatoes', 'produce'), ing('parmesan', 'dairy_eggs')]),
    ).toBe(false)
  })

  it('handles a recipe with no ingredients at all', () => {
    expect(hasMainProtein([])).toBe(false)
  })

  it('reads the section before the wording, so an odd name still counts', () => {
    expect(hasMainProtein([ing('two 6-ounce fillets', 'meat_seafood')])).toBe(true)
  })
})

/**
 * The filter autofill actually applies. Kept as its own pure function so the
 * rule is testable without a database, which is where autofillPlan lives.
 */
describe('dinnerCandidates', () => {
  const salad = { id: 1, title: 'Arugula Salad', ingredients: [ing('arugula', 'produce')] }
  const chicken = { id: 2, title: 'Roast Chicken', ingredients: [ing('chicken', 'meat_seafood')] }
  const cake = { id: 3, title: 'Lava Cake', ingredients: [ing('flour', 'pantry_dry_goods')] }
  const tofu = { id: 4, title: 'Mapo Tofu', ingredients: [ing('silken tofu', 'other')] }

  it('keeps only what can be a dinner, in the order given', () => {
    expect(dinnerCandidates([salad, chicken, cake, tofu]).map((r) => r.id)).toEqual([2, 4])
  })

  it('returns nothing rather than guessing when the library is all sides', () => {
    expect(dinnerCandidates([salad, cake])).toEqual([])
  })

  it('does not mutate the list it is given', () => {
    const input = [salad, chicken]
    dinnerCandidates(input)
    expect(input).toHaveLength(2)
  })
})
