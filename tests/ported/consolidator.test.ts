// Ported verbatim from thesternern/recipe-planner tests/grocery/consolidator.test.ts.
// Only the input field names changed (snake_case -> camelCase house style); every
// behavioural assertion is the original, so this suite proves the port is faithful.
import { describe, it, expect } from 'vitest'
import { consolidateIngredients } from '../../src/recipes/grocery/consolidator.js'
import type { Ingredient } from '../../src/recipes/types.js'

const ing = (item: string, quantity = '1'): Ingredient => ({ item, quantity })

describe('consolidateIngredients — house additions', () => {
  it('merges "tomato" and "tomatoes" onto one line, filed under produce', () => {
    const result = consolidateIngredients([
      { recipe: 'A', ingredients: [ing('tomato', '2')], dayOfWeek: 0, freshnessCategory: 'moderate' },
      { recipe: 'B', ingredients: [ing('tomatoes', '3')], dayOfWeek: 1, freshnessCategory: 'moderate' },
    ])
    const produce = result.weekend.produce ?? []
    const tomato = produce.find((i) => /^tomato/i.test(i.item))
    expect(tomato).toBeDefined()
    expect(tomato!.recipes).toEqual(['A', 'B'])
    expect(tomato!.quantity).toBe('5')
    expect(result.weekend.other ?? []).toHaveLength(0)
  })

  it('keeps a weekend dinner on the weekend shop even when it is very perishable', () => {
    // Only Thursday (3) and Friday (4) are the midweek pickup. A Saturday
    // salmon bought Thursday is not what "buy Thu/Fri" means.
    const result = consolidateIngredients([
      { recipe: 'Saturday salmon', ingredients: [ing('salmon', '1 lb')], dayOfWeek: 5, freshnessCategory: 'very_perishable' },
      { recipe: 'Sunday fish', ingredients: [ing('halibut', '1 lb')], dayOfWeek: 6, freshnessCategory: 'very_perishable' },
    ])
    expect(Object.keys(result.midweek)).toHaveLength(0)
    const weekend = Object.values(result.weekend).flat().map((i) => i.item)
    expect(weekend).toEqual(expect.arrayContaining(['salmon', 'halibut']))
  })
})

describe('consolidateIngredients — weekend/midweek split', () => {
  it('puts all ingredients in weekend when no midweek-pickup recipes', () => {
    const result = consolidateIngredients([
      {
        recipe: 'Pasta Bolognese',
        ingredients: [ing('penne pasta'), ing('ground beef', '1 lb')],
        dayOfWeek: 1, // Tuesday — perishable but day < 3
        freshnessCategory: 'perishable',
      },
    ])
    expect(Object.keys(result.midweek)).toHaveLength(0)
    expect(result.weekend.grains_pasta_rice).toBeDefined()
    expect(result.weekend.meat_seafood).toBeDefined()
  })

  it('routes meat_seafood to midweek for very_perishable recipe on Thursday (day 3)', () => {
    const result = consolidateIngredients([
      {
        recipe: 'Miso Salmon',
        ingredients: [
          ing('salmon fillets', '1.5 lbs'),
          ing('miso paste', '2 tbsp'),
        ],
        dayOfWeek: 3,
        freshnessCategory: 'very_perishable',
      },
    ])
    expect(result.midweek.meat_seafood).toHaveLength(1)
    expect(result.midweek.meat_seafood![0].item).toBe('salmon fillets')
    expect(result.midweek.meat_seafood![0].day).toBe('Thu')
    // miso paste (other/pantry) stays in weekend
    expect(result.weekend.meat_seafood).toBeUndefined()
    const midweekHasMiso = (result.midweek.other ?? []).some(i => i.item === 'miso paste')
    expect(midweekHasMiso).toBe(false)
  })

  it('routes meat_seafood to midweek with day=Fri for recipe on Friday (day 4)', () => {
    const result = consolidateIngredients([
      {
        recipe: 'Shrimp Tacos',
        ingredients: [ing('shrimp, peeled', '1 lb'), ing('tortillas', '8')],
        dayOfWeek: 4,
        freshnessCategory: 'very_perishable',
      },
    ])
    expect(result.midweek.meat_seafood![0].day).toBe('Fri')
    // tortillas go to weekend
    expect(result.weekend.bakery_bread).toBeDefined()
  })

  it('does NOT assign day field to weekend items even when their recipe is also midweek-pickup', () => {
    const result = consolidateIngredients([
      {
        recipe: 'Miso Salmon',
        ingredients: [ing('salmon fillets'), ing('miso paste')],
        dayOfWeek: 3,
        freshnessCategory: 'very_perishable',
      },
    ])
    // All items in weekend should have no day field
    for (const items of Object.values(result.weekend)) {
      for (const item of items ?? []) {
        expect(item.day).toBeUndefined()
      }
    }
  })

  it('does NOT route to midweek when effective freshness is shelf_stable (freezer override applied by caller)', () => {
    const result = consolidateIngredients([
      {
        recipe: 'Frozen Fish Tacos',
        ingredients: [ing('frozen salmon', '1 lb'), ing('tortillas', '8')],
        dayOfWeek: 3,
        freshnessCategory: 'shelf_stable', // caller already applied freezer_friendly override
      },
    ])
    expect(Object.keys(result.midweek)).toHaveLength(0)
  })

  it('consolidates same item from two weekend recipes', () => {
    const result = consolidateIngredients([
      {
        recipe: 'Recipe A',
        ingredients: [ing('onion', '2')],
        dayOfWeek: 0,
        freshnessCategory: 'moderate',
      },
      {
        recipe: 'Recipe B',
        ingredients: [ing('onion', '1')],
        dayOfWeek: 1,
        freshnessCategory: 'moderate',
      },
    ])
    const onions = result.weekend.produce?.find(i => i.item === 'onion')
    expect(onions).toBeDefined()
    expect(onions!.recipes).toContain('Recipe A')
    expect(onions!.recipes).toContain('Recipe B')
    expect(onions!.quantity).toBe('3')
  })

  it('sums identical quantities from two recipes (does not deduplicate)', () => {
    const result = consolidateIngredients([
      {
        recipe: 'Recipe A',
        ingredients: [ing('chicken thighs', '2 lbs')],
        dayOfWeek: 0,
        freshnessCategory: 'perishable',
      },
      {
        recipe: 'Recipe B',
        ingredients: [ing('chicken thighs', '2 lbs')],
        dayOfWeek: 1,
        freshnessCategory: 'perishable',
      },
    ])
    const chicken = result.weekend.meat_seafood?.find(i => i.item === 'chicken thighs')
    expect(chicken).toBeDefined()
    expect(chicken!.quantity).toBe('4 lbs')
  })

  it('splits same ingredient into both weekend and midweek when it appears in different recipes', () => {
    const result = consolidateIngredients([
      {
        recipe: 'Monday Salad',
        ingredients: [ing('cilantro', '1 bunch')],
        dayOfWeek: 0,
        freshnessCategory: 'moderate',
      },
      {
        recipe: 'Friday Tacos',
        ingredients: [ing('cilantro', '1 bunch')],
        dayOfWeek: 4,
        freshnessCategory: 'very_perishable',
      },
    ])
    // cilantro (produce) from Monday goes to weekend
    expect(result.weekend.produce?.some(i => i.item === 'cilantro')).toBe(true)
    // cilantro (produce) from Friday very_perishable goes to midweek
    expect(result.midweek.produce?.some(i => i.item === 'cilantro')).toBe(true)
  })
})
