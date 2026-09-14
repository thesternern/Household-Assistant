import { describe, expect, it } from 'vitest'

import {
  categorizeIngredient,
  GROCERY_SECTIONS,
  isGrocerySection,
  PANTRY_STAPLES,
} from '../src/recipes/grocery/categories.js'
import { parseIngredient } from '../src/recipes/grocery/parser.js'
import { consolidateIngredients } from '../src/recipes/grocery/consolidator.js'
import type { RecipeConsolidationInput } from '../src/recipes/grocery/consolidator.js'
import {
  classifyCuisine,
  classifyFreshness,
  compareFreshness,
  detectFrozenIngredients,
  effectiveFreshness,
} from '../src/recipes/grocery/freshness.js'
import type { GroceryItem, GroceryListData, Ingredient } from '../src/recipes/types.js'

/** Convenience: pull one item out of a section, or fail loudly. */
function itemIn(data: GroceryListData, section: string, name: string): GroceryItem {
  const bucket = data[section as keyof GroceryListData] ?? []
  const found = bucket.find((i) => i.item === name)
  if (!found) {
    throw new Error(`expected "${name}" in section ${section}; got ${JSON.stringify(bucket)}`)
  }
  return found
}

function allItems(data: GroceryListData): string[] {
  return Object.values(data).flatMap((bucket) => (bucket ?? []).map((i) => i.item))
}

describe('categorizeIngredient', () => {
  it('places a representative ingredient in each keyword-backed section', () => {
    const cases: Array<[string, string]> = [
      ['chicken thighs', 'meat_seafood'],
      ['carrots', 'produce'],
      ['greek yogurt', 'dairy_eggs'],
      ['spaghetti', 'grains_pasta_rice'],
      ['black beans', 'canned_jarred'],
      ['sourdough bread', 'bakery_bread'],
      ['frozen peas', 'frozen'],
      ['balsamic vinegar', 'oils_vinegars_condiments'],
      ['ground cumin', 'spices_seasonings'],
      ['honey', 'pantry_dry_goods'],
      ['salt', 'pantry_staples'],
      ['tofu', 'other'],
    ]
    for (const [item, section] of cases) {
      expect(categorizeIngredient(item), item).toBe(section)
    }
  })

  it('matches pantry staples on the exact lowercased name, before any keyword', () => {
    // 'olive oil' would otherwise hit the 'oil' keyword in oils_vinegars_condiments.
    expect(categorizeIngredient('Olive Oil')).toBe('pantry_staples')
    expect(categorizeIngredient('extra virgin olive oil')).toBe('oils_vinegars_condiments')
    // 'garlic' is a staple; 'garlic cloves' falls through to the produce keyword.
    expect(PANTRY_STAPLES.has('garlic')).toBe(true)
    expect(categorizeIngredient('garlic')).toBe('pantry_staples')
    expect(categorizeIngredient('garlic cloves')).toBe('produce')
  })

  it('honours keyword-table order when several sections would match', () => {
    // meat_seafood is scanned first, so 'chicken' beats the produce/broth keywords.
    expect(categorizeIngredient('chicken and mushroom soup')).toBe('meat_seafood')
    // A phrase keyword is the most specific answer there is and is asked
    // first: 'diced tomato' is listed under canned_jarred for exactly this
    // line, and it outranks the bare 'tomato' in produce.
    expect(categorizeIngredient('canned diced tomatoes')).toBe('canned_jarred')
    expect(categorizeIngredient('cherry tomatoes')).toBe('produce')
  })

  it('falls through to other for the two sections with no keywords', () => {
    // snacks and beverages are valid sections but unreachable by keyword —
    // they only ever arrive via an explicit Ingredient.section.
    expect(GROCERY_SECTIONS).toContain('snacks')
    expect(GROCERY_SECTIONS).toContain('beverages')
    expect(categorizeIngredient('pretzels')).toBe('other')
    expect(categorizeIngredient('sparkling water')).toBe('other')
  })
})

describe('parseIngredient', () => {
  it('parses a mixed number with a unit alias', () => {
    const parsed = parseIngredient('1 1/2 cups all-purpose flour')
    expect(parsed.amount).toBe(1.5)
    expect(parsed.unit).toBe('cup')
    expect(parsed.item).toBe('all-purpose flour')
    expect(parsed.raw).toBe('1 1/2 cups all-purpose flour')
  })

  it('parses an abbreviated unit', () => {
    const parsed = parseIngredient('2 tbsp olive oil')
    expect(parsed).toMatchObject({ amount: 2, unit: 'tbsp', item: 'olive oil' })
  })

  it('parses a bare fraction', () => {
    expect(parseIngredient('1/4 tsp cayenne')).toMatchObject({
      amount: 0.25,
      unit: 'tsp',
      item: 'cayenne',
    })
  })

  it('reads a word-measure like "a pinch" as one of that measure', () => {
    // Used to parse as amount 0 with the whole phrase as the item, which put
    // "pinch of red pepper flakes" on the list as a thing to buy.
    const parsed = parseIngredient('a pinch of salt')
    expect(parsed.amount).toBe(1)
    expect(parsed.unit).toBe('pinch')
    expect(parsed.item).toBe('salt')
  })

  it('treats an unrecognised word after the number as part of the item', () => {
    const parsed = parseIngredient('3 large eggs')
    expect(parsed.amount).toBe(3)
    expect(parsed.unit).toBe('')
    expect(parsed.item).toBe('eggs') // 'large' is a filler word
  })

  it('parses a count with no unit word at all', () => {
    expect(parseIngredient('3 eggs')).toMatchObject({ amount: 3, unit: '', item: 'eggs' })
  })

  it('keeps a bare number as the item when nothing follows it', () => {
    expect(parseIngredient('3')).toMatchObject({ amount: 0, unit: '', item: '3' })
  })

  it('strips filler words, parentheticals, and everything after the first comma', () => {
    const parsed = parseIngredient('1 lb boneless skinless chicken thighs (about 4), trimmed')
    expect(parsed.amount).toBe(1)
    expect(parsed.unit).toBe('lb')
    expect(parsed.item).toBe('chicken thighs')
  })

  it('does not treat an inherited Object.prototype key as a unit', () => {
    // Regression: `unitStr in UNIT_ALIASES` matched 'constructor', so `unit`
    // came back as the Object constructor function — a string-typed field
    // holding a function, which JSON.stringify then drops entirely.
    const parsed = parseIngredient('2 constructor eggs')
    expect(typeof parsed.unit).toBe('string')
    expect(parsed.unit).toBe('')
    expect(parsed.item).toBe('constructor eggs')
    expect(JSON.parse(JSON.stringify(parsed))).toHaveProperty('unit', '')
  })
})

describe('consolidateIngredients', () => {
  const chickenA: Ingredient = { item: 'chicken thighs', quantity: '2 lb' }
  const chickenB: Ingredient = { item: 'Chicken Thighs', quantity: '1 lb' }

  it('merges the same item across two recipes and sums the quantities', () => {
    const inputs: RecipeConsolidationInput[] = [
      {
        recipe: 'Sheet Pan Chicken',
        ingredients: [chickenA, { item: 'olive oil', quantity: '2 tbsp' }],
        dayOfWeek: 0,
        freshnessCategory: 'perishable',
      },
      {
        recipe: 'Chicken Rice Bowls',
        ingredients: [chickenB, { item: 'jasmine rice', quantity: '1 cup' }],
        dayOfWeek: 1,
        freshnessCategory: 'perishable',
      },
    ]

    const { weekend, midweek } = consolidateIngredients(inputs)

    const chicken = itemIn(weekend, 'meat_seafood', 'chicken thighs')
    expect(chicken.quantity).toBe('3 lb')
    expect(chicken.recipes).toEqual(['Sheet Pan Chicken', 'Chicken Rice Bowls'])

    // Nothing is very_perishable, so the midweek pickup list stays empty.
    expect(allItems(midweek)).toEqual([])
    expect(itemIn(weekend, 'pantry_staples', 'olive oil').quantity).toBe('2 tbsp')
    expect(itemIn(weekend, 'grains_pasta_rice', 'jasmine rice').quantity).toBe('1 cup')
  })

  it('concatenates quantities whose units do not match', () => {
    const { weekend } = consolidateIngredients([
      {
        recipe: 'A',
        ingredients: [{ item: 'butter', quantity: '2 tbsp' }],
        dayOfWeek: 0,
        freshnessCategory: 'moderate',
      },
      {
        recipe: 'B',
        ingredients: [{ item: 'butter', quantity: '1 stick' }],
        dayOfWeek: 1,
        freshnessCategory: 'moderate',
      },
    ])
    expect(itemIn(weekend, 'pantry_staples', 'butter').quantity).toBe('2 tbsp + 1 stick')
  })

  it('falls back to "as needed" when no quantity is given', () => {
    const { weekend } = consolidateIngredients([
      {
        recipe: 'A',
        ingredients: [{ item: 'flaky sea salt', quantity: '' }],
        dayOfWeek: 0,
        freshnessCategory: 'shelf_stable',
      },
    ])
    expect(itemIn(weekend, 'other', 'flaky sea salt').quantity).toBe('as needed')
  })

  it('respects an explicit section on the ingredient', () => {
    const { weekend } = consolidateIngredients([
      {
        recipe: 'A',
        ingredients: [{ item: 'kettle chips', quantity: '1 bag', section: 'snacks' }],
        dayOfWeek: 0,
        freshnessCategory: 'shelf_stable',
      },
    ])
    expect(itemIn(weekend, 'snacks', 'kettle chips').quantity).toBe('1 bag')
  })

  it('ignores a section value that is not a real GrocerySection', () => {
    // `Ingredient.section` is typed but never validated — it round-trips through
    // jsonb from the scraper and the text parser. '__proto__' / 'constructor' /
    // 'toString' resolve to inherited members and used to throw
    // "result[section].push is not a function"; 'nonsense' used to invent a
    // section key that no renderer iterating GROCERY_SECTIONS would show.
    for (const bad of ['__proto__', 'constructor', 'toString', 'nonsense']) {
      const { weekend } = consolidateIngredients([
        {
          recipe: 'A',
          ingredients: [{ item: 'chicken thighs', quantity: '1 lb', section: bad as never }],
          dayOfWeek: 0,
          freshnessCategory: 'perishable',
        },
      ])
      expect(Object.keys(weekend), bad).toEqual(['meat_seafood'])
      expect(itemIn(weekend, 'meat_seafood', 'chicken thighs').quantity, bad).toBe('1 lb')
    }
  })

  it('accepts every declared GrocerySection verbatim', () => {
    for (const section of GROCERY_SECTIONS) {
      expect(isGrocerySection(section), section).toBe(true)
      const { weekend } = consolidateIngredients([
        {
          recipe: 'A',
          ingredients: [{ item: 'chicken thighs', quantity: '1 lb', section }],
          dayOfWeek: 0,
          freshnessCategory: 'perishable',
        },
      ])
      expect(Object.keys(weekend), section).toEqual([section])
    }
  })

  it('sorts items alphabetically within a section', () => {
    const { weekend } = consolidateIngredients([
      {
        recipe: 'A',
        ingredients: [
          { item: 'zucchini', quantity: '2' },
          { item: 'carrots', quantity: '3' },
          { item: 'onion', quantity: '1' },
        ],
        dayOfWeek: 0,
        freshnessCategory: 'moderate',
      },
    ])
    expect((weekend.produce ?? []).map((i) => i.item)).toEqual(['carrots', 'onion', 'zucchini'])
  })
})

describe('freshness split', () => {
  const salmonNight: RecipeConsolidationInput = {
    recipe: 'Roast Salmon',
    ingredients: [
      { item: 'salmon fillets', quantity: '1.5 lb' }, // meat_seafood -> midweek
      { item: 'lemon', quantity: '1' },               // produce      -> midweek
      { item: 'olive oil', quantity: '2 tbsp' },      // staple       -> weekend
      { item: 'jasmine rice', quantity: '1 cup' },    // grains       -> weekend
    ],
    dayOfWeek: 4, // Friday
    freshnessCategory: 'very_perishable',
  }

  const pastaNight: RecipeConsolidationInput = {
    recipe: 'Baked Ziti',
    ingredients: [
      { item: 'penne', quantity: '1 lb' },
      { item: 'crushed tomatoes', quantity: '2 cans' },
    ],
    dayOfWeek: 1,
    freshnessCategory: 'shelf_stable',
  }

  it('routes very_perishable meat and produce to midweek with a pickup day', () => {
    const { midweek } = consolidateIngredients([salmonNight, pastaNight])

    expect(itemIn(midweek, 'meat_seafood', 'salmon fillets').day).toBe('Fri')
    expect(itemIn(midweek, 'produce', 'lemon').day).toBe('Fri')
    expect(allItems(midweek).sort()).toEqual(['lemon', 'salmon fillets'])
  })

  it('keeps shelf-stable items and non-pickup sections on the weekend list', () => {
    const { weekend } = consolidateIngredients([salmonNight, pastaNight])
    const weekendItems = allItems(weekend).sort()

    expect(weekendItems).toEqual(['crushed tomatoes', 'jasmine rice', 'olive oil', 'penne'])
    // Weekend items never carry a pickup day.
    expect(Object.values(weekend).flatMap((b) => b ?? []).every((i) => i.day === undefined)).toBe(true)
  })

  it('keeps a very_perishable recipe on the weekend list when it is cooked early in the week', () => {
    const monday: RecipeConsolidationInput = { ...salmonNight, dayOfWeek: 0 }
    const { weekend, midweek } = consolidateIngredients([monday])

    expect(allItems(midweek)).toEqual([])
    expect(itemIn(weekend, 'meat_seafood', 'salmon fillets').day).toBeUndefined()
  })

  it('labels a Thursday pickup as Thu', () => {
    const { midweek } = consolidateIngredients([{ ...salmonNight, dayOfWeek: 3 }])
    expect(itemIn(midweek, 'meat_seafood', 'salmon fillets').day).toBe('Thu')
  })

  it('sends a freezer-friendly recipe to the weekend list via the shelf_stable override', () => {
    // The raw category stays 'very_perishable' in the DB; the read-time override
    // makes the recipe shop like a shelf-stable one.
    const effective = effectiveFreshness('very_perishable', true)
    expect(effective).toBe('shelf_stable')

    const { weekend, midweek } = consolidateIngredients([
      { ...salmonNight, recipe: 'Freezer Salmon Cakes', freshnessCategory: effective },
    ])

    expect(allItems(midweek)).toEqual([])
    expect(itemIn(weekend, 'meat_seafood', 'salmon fillets').day).toBeUndefined()
    expect(itemIn(weekend, 'produce', 'lemon')).toBeTruthy()
  })
})

describe('classifyFreshness', () => {
  const ing = (...items: string[]): Ingredient[] => items.map((item) => ({ item, quantity: '1' }))

  it('takes the most perishable ingredient in the recipe', () => {
    expect(classifyFreshness(ing('salmon fillets', 'jasmine rice', 'olive oil'))).toBe('very_perishable')
    expect(classifyFreshness(ing('chicken thighs', 'penne', 'carrots'))).toBe('perishable')
    expect(classifyFreshness(ing('carrots', 'penne'))).toBe('moderate')
    expect(classifyFreshness(ing('dried pasta', 'olive oil', 'canned chickpeas'))).toBe('shelf_stable')
  })

  it('stops at the first matching category in priority order', () => {
    // 'crushed tomatoes' hits 'tomato' (moderate) before 'crushed tomatoes'
    // (shelf_stable), because moderate is scanned first and the loop breaks.
    expect(classifyFreshness(ing('crushed tomatoes'))).toBe('moderate')
  })

  it('defaults to shelf_stable when nothing matches', () => {
    expect(classifyFreshness([])).toBe('shelf_stable')
    expect(classifyFreshness(ing('mystery powder'))).toBe('shelf_stable')
  })
})

describe('freshness helpers', () => {
  it('defaults a missing category to moderate', () => {
    expect(effectiveFreshness(null, false)).toBe('moderate')
    expect(effectiveFreshness(undefined, null)).toBe('moderate')
    expect(effectiveFreshness('perishable', false)).toBe('perishable')
  })

  it('normalises a stored category outside the union to moderate', () => {
    // freshness_category is a bare text column; honour the declared return type
    // rather than leaking an unlisted string to callers that index by it.
    expect(effectiveFreshness('unknown' as never, false)).toBe('moderate')
    expect(effectiveFreshness('constructor' as never, false)).toBe('moderate')
    // The freezer-friendly override still wins over a garbage category.
    expect(effectiveFreshness('unknown' as never, true)).toBe('shelf_stable')
  })

  it('orders recipes most-perishable-first, with freezer-friendly last', () => {
    const rows = [
      { name: 'ziti', freshnessCategory: 'shelf_stable' as const, freezerFriendly: false },
      { name: 'salmon', freshnessCategory: 'very_perishable' as const, freezerFriendly: false },
      { name: 'chili', freshnessCategory: 'very_perishable' as const, freezerFriendly: true },
      { name: 'chicken', freshnessCategory: 'perishable' as const, freezerFriendly: false },
    ]
    expect([...rows].sort(compareFreshness).map((r) => r.name)).toEqual([
      'salmon',
      'chicken',
      'ziti',
      'chili',
    ])
  })

  it('sorts an unknown stored category as moderate instead of returning NaN', () => {
    // recipes.freshness_category is a bare text column with no CHECK constraint,
    // so an unlisted value can reach the comparator. The original guarded with
    // `?? 3`; without it the subtraction is NaN and Array#sort scrambles the
    // whole list, not just the offending row.
    const rogue = { freshnessCategory: 'unknown' as never, freezerFriendly: false }
    expect(Number.isNaN(compareFreshness(rogue, rogue))).toBe(false)
    expect(compareFreshness(rogue, { freshnessCategory: 'moderate', freezerFriendly: false })).toBe(0)

    const rows = [
      { name: 'rogue', freshnessCategory: 'unknown' as never, freezerFriendly: false },
      { name: 'salmon', freshnessCategory: 'very_perishable' as const, freezerFriendly: false },
      { name: 'ziti', freshnessCategory: 'shelf_stable' as const, freezerFriendly: false },
      { name: 'chicken', freshnessCategory: 'perishable' as const, freezerFriendly: false },
    ]
    expect([...rows].sort(compareFreshness).map((r) => r.name)).toEqual([
      'salmon',
      'chicken',
      'rogue',
      'ziti',
    ])
  })

  it('detects frozen ingredients from the item text only', () => {
    expect(detectFrozenIngredients([{ item: 'frozen peas', quantity: '1 cup' }])).toBe(true)
    expect(detectFrozenIngredients([{ item: 'peas', quantity: '1 cup', section: 'frozen' }])).toBe(false)
  })
})

describe('classifyCuisine', () => {
  it('matches a controlled-vocabulary tag exactly', () => {
    expect(classifyCuisine('Weeknight Bowls', '', ['pasta'])).toBe('italian')
    expect(classifyCuisine('Weeknight Bowls', '', ['teriyaki'])).toBe('asian')
  })

  it('falls back to substring matching on the title and description', () => {
    expect(classifyCuisine('Chicken Tacos', '', [])).toBe('mexican')
    expect(classifyCuisine('Weeknight Bowls', 'A quick greek salad', [])).toBe('mediterranean')
    expect(classifyCuisine('Backyard BBQ Ribs', '', [])).toBe('american')
  })

  it('returns null when nothing matches', () => {
    expect(classifyCuisine('Mystery Dinner', 'something plain', [])).toBeNull()
  })
})

/**
 * Regressions from a real week's list, where six recipes produced a shop that
 * sent the household hunting in the wrong aisles.
 */
describe('categorizeIngredient: aisle regressions', () => {
  /**
   * SECTION_KEYWORDS is ordered and first match wins, with meat_seafood first.
   * "chicken or veal stock" therefore matched 'chicken' and was filed under
   * Meat & seafood, sending someone to the butcher counter for a carton of
   * stock. Broth and stock name their animal almost every time, so the liquid
   * has to be decided before the protein.
   */
  it('files stock and broth by what they are, not the animal on the label', () => {
    expect(categorizeIngredient('chicken or veal stock')).toBe('canned_jarred')
    expect(categorizeIngredient('beef stock')).toBe('canned_jarred')
    expect(categorizeIngredient('low-sodium beef broth')).toBe('canned_jarred')
    expect(categorizeIngredient('fish stock')).toBe('canned_jarred')
  })

  it('still files the meat itself under meat and seafood', () => {
    expect(categorizeIngredient('chicken thighs')).toBe('meat_seafood')
    expect(categorizeIngredient('salmon fillet')).toBe('meat_seafood')
  })

  /** These all fell through every keyword list and landed in "other". */
  it('puts common vegetables and herbs in produce', () => {
    for (const item of [
      'brussels sprouts',
      'scallions',
      'dill',
      'shallots',
      'asparagus',
      'leeks',
      'green beans',
      'arugula',
      'cilantro',
      'thyme sprigs',
    ]) {
      expect(categorizeIngredient(item), item).toBe('produce')
    }
  })
})

/**
 * One week's plan produced five separate seasoning rows — "kosher salt and
 * pepper", "salt and black pepper", "salt and freshly ground black pepper",
 * "salt and pepper", and "coarse kosher salt" — because the consolidator keys
 * on the item name and every recipe words it differently.
 */
describe('parseIngredient: seasoning names', () => {
  it('collapses the ways recipes write salt and pepper', () => {
    for (const raw of [
      'Kosher salt and pepper',
      'Salt and black pepper',
      'Salt and freshly ground black pepper',
      'salt and pepper',
      'Fine sea salt and freshly cracked black pepper',
    ]) {
      expect(parseIngredient(raw).item, raw).toBe('salt and pepper')
    }
  })

  it('reduces a salt descriptor to salt', () => {
    expect(parseIngredient('2 teaspoons coarse kosher salt').item).toBe('salt')
    expect(parseIngredient('flaky sea salt').item).toBe('salt')
  })

  it('leaves pepper on its own line alone', () => {
    expect(parseIngredient('1 teaspoon black pepper').item).toBe('black pepper')
  })
})

/**
 * formatAmount emits mixed numbers ("1 1/2 cup"), so the merge has to read them
 * back. Its regex took a single leading number, so the "1/2" fell into the unit
 * and two identical quantities looked like different units — printing
 * "1 1/2 cup + 1 1/2 cup" instead of adding up to three.
 */
describe('consolidateIngredients: merging mixed numbers', () => {
  const recipe = (title: string, quantity: string): RecipeConsolidationInput => ({
    recipe: title,
    ingredients: [{ item: 'flour', quantity, section: 'pantry_dry_goods' }],
    dayOfWeek: 0,
    freshnessCategory: 'shelf_stable',
  })

  it('adds two mixed numbers into one quantity', () => {
    const { weekend } = consolidateIngredients([
      recipe('Bread', '1 1/2 cup'),
      recipe('Cake', '1 1/2 cup'),
    ])
    expect(weekend.pantry_dry_goods?.[0]?.quantity).toBe('3 cup')
  })

  it('adds a mixed number to a plain fraction', () => {
    const { weekend } = consolidateIngredients([
      recipe('Bread', '1 1/2 cup'),
      recipe('Cake', '1/2 cup'),
    ])
    expect(weekend.pantry_dry_goods?.[0]?.quantity).toBe('2 cup')
  })

  it('still refuses to add quantities in different units', () => {
    const { weekend } = consolidateIngredients([
      recipe('Bread', '1 cup'),
      recipe('Cake', '2 tbsp'),
    ])
    expect(weekend.pantry_dry_goods?.[0]?.quantity).toBe('1 cup + 2 tbsp')
  })
})

/**
 * Once "Juice of 2 lemons" and "Zest of 1 lemon" parse properly, they arrive as
 * "lemons" and "lemon" — the same purchase under two spellings, and still two
 * rows. Merging is keyed on a plural-insensitive form; the name shown is the
 * one that turned up first, so nothing reads as though a robot wrote it.
 */
describe('consolidateIngredients: singular and plural', () => {
  const recipe = (title: string, item: string, quantity: string): RecipeConsolidationInput => ({
    recipe: title,
    ingredients: [{ item, quantity, section: 'produce' }],
    dayOfWeek: 0,
    freshnessCategory: 'shelf_stable',
  })

  it('merges an ingredient written singular in one recipe and plural in another', () => {
    const { weekend } = consolidateIngredients([
      recipe('Salad', 'lemons', '2'),
      recipe('Fish', 'lemon', '1'),
    ])
    expect(weekend.produce).toHaveLength(1)
    expect(weekend.produce?.[0]?.quantity).toBe('3')
    expect(weekend.produce?.[0]?.recipes).toEqual(['Salad', 'Fish'])
  })

  it('shows the name the first recipe used', () => {
    const { weekend } = consolidateIngredients([
      recipe('Salad', 'lemons', '2'),
      recipe('Fish', 'lemon', '1'),
    ])
    expect(weekend.produce?.[0]?.item).toBe('lemons')
  })

  it('does not collapse two genuinely different ingredients', () => {
    const { weekend } = consolidateIngredients([
      recipe('A', 'green beans', '1 lb'),
      recipe('B', 'green onions', '1 bunch'),
    ])
    expect(weekend.produce).toHaveLength(2)
  })

  it('leaves a word that merely ends in s alone', () => {
    const { weekend } = consolidateIngredients([
      recipe('A', 'asparagus', '1 lb'),
      recipe('B', 'couscous', '1 cup'),
    ])
    expect(weekend.produce?.map((i) => i.item).sort()).toEqual(['asparagus', 'couscous'])
  })
})

/**
 * Regressions found while checking which recipes carry a main protein. Two were
 * shipped by the previous commit; three were older gaps it exposed.
 */
describe('categorizeIngredient: meat the aisle map was missing', () => {
  it('knows the cuts a butcher sells', () => {
    for (const item of [
      'rib-eye steaks',
      'baby back ribs',
      'beef brisket',
      'pork tenderloin',
      'lamb shoulder',
      'duck breast',
      'veal shank',
      'chorizo',
      'prosciutto',
      'halibut fillets',
      'scallops',
      'mussels',
      'trout',
      // Compound cut names: "spareribs" is one word, so a boundary-anchored
      // "rib" never sees it.
      'spareribs',
      'short ribs',
      'rack of lamb',
      'ground chuck',
      'flank steak',
    ]) {
      expect(categorizeIngredient(item), item).toBe('meat_seafood')
    }
  })

  /**
   * Keywords were matched as bare substrings, so "grapeseed oil" hit the
   * produce entry for "grape" and was filed with the fruit. Matching is on
   * whole words now.
   */
  it('does not match a keyword buried inside another word', () => {
    expect(categorizeIngredient('grapeseed or canola oil')).toBe('oils_vinegars_condiments')
    expect(categorizeIngredient('tuscan kale ribbons')).toBe('produce')
  })

  /**
   * "apple cider vinegar" matched produce's "apple" because produce is listed
   * before the vinegars. The most specific keyword wins now, whatever section
   * it sits in.
   */
  it('lets the more specific word decide the aisle', () => {
    expect(categorizeIngredient('apple cider vinegar')).toBe('oils_vinegars_condiments')
    expect(categorizeIngredient('sweet potatoes')).toBe('produce')
    expect(categorizeIngredient('chicken thighs')).toBe('meat_seafood')
  })
})

describe('parseIngredient: descriptors that are not preparation', () => {
  /**
   * The previous commit added "skin" and "bone" to the list of words that open
   * a preparation clause. "3 pounds bone-in, skin-on chicken thighs" therefore
   * became the item "bone-in" — the chicken was thrown away, and the recipe
   * stopped looking like a main course at all.
   */
  it('keeps the meat when it is described as bone-in or skin-on', () => {
    const thighs = parseIngredient('3 pounds bone-in, skin-on chicken thighs')
    expect(thighs.item).toContain('chicken')
    expect(categorizeIngredient(thighs.item)).toBe('meat_seafood')

    const breasts = parseIngredient('4 skin-on, bone-in chicken breasts')
    expect(breasts.item).toContain('chicken')
  })
})
