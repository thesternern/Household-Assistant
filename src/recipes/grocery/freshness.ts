import type { Ingredient, FreshnessCategory, CuisineGroup } from '../types.js'

// Ordered most-perishable first — the `break` in classifyFreshness relies on this order
const FRESHNESS_PRIORITY = ['very_perishable', 'perishable', 'moderate', 'shelf_stable'] as const satisfies readonly FreshnessCategory[]

export const FRESHNESS_SCORE: Record<FreshnessCategory, number> = {
  very_perishable: 1, perishable: 2, moderate: 3, shelf_stable: 4,
}

const FRESHNESS_KEYWORDS: Record<FreshnessCategory, string[]> = {
  very_perishable: [
    'fish', 'salmon', 'tuna', 'cod', 'halibut', 'tilapia', 'trout', 'sea bass',
    'shrimp', 'prawn', 'scallop', 'crab', 'lobster', 'oyster', 'clam', 'mussel',
    'shellfish', 'seafood', 'sashimi', 'squid', 'octopus',
  ],
  perishable: [
    'chicken', 'turkey', 'duck', 'ground beef', 'ground pork', 'ground lamb',
    'pork chop', 'pork tenderloin', 'steak', 'beef', 'lamb', 'veal',
    'spinach', 'arugula', 'lettuce', 'mixed greens', 'kale', 'chard',
    'fresh basil', 'fresh cilantro', 'fresh parsley', 'fresh dill',
    'fresh chives', 'green onion', 'scallion', 'fresh herbs',
    'asparagus', 'strawberry', 'raspberry', 'blueberry', 'blackberry', 'cherry',
  ],
  moderate: [
    'broccoli', 'cauliflower', 'bell pepper', 'zucchini', 'eggplant',
    'tomato', 'carrot', 'celery', 'onion', 'shallot', 'leek', 'fennel',
    'potato', 'sweet potato', 'butternut squash', 'beet',
    'mushroom', 'apple', 'pear', 'lemon', 'lime', 'orange', 'grapefruit',
    'milk', 'heavy cream', 'sour cream', 'yogurt', 'fresh mozzarella',
    'ricotta', 'feta', 'brie', 'egg', 'tofu', 'tempeh',
    'deli', 'sausage', 'bacon', 'pancetta',
  ],
  shelf_stable: [
    'pasta', 'rice', 'quinoa', 'farro', 'barley', 'lentil', 'chickpea',
    'black bean', 'kidney bean', 'white bean', 'canned', 'jarred', 'dried',
    'frozen', 'flour', 'bread', 'tortilla', 'pita', 'naan',
    'olive oil', 'vegetable oil', 'sesame oil', 'vinegar', 'soy sauce',
    'fish sauce', 'oyster sauce', 'hoisin', 'coconut milk',
    'tomato sauce', 'tomato paste', 'crushed tomatoes', 'broth', 'stock',
    'almond', 'cashew', 'walnut', 'pine nut', 'sesame seed', 'oat',
    'panko', 'breadcrumb', 'cornstarch', 'baking powder', 'baking soda',
    'sugar', 'honey', 'maple syrup', 'miso', 'tahini',
  ],
}

export const CUISINE_KEYWORDS: Record<Exclude<CuisineGroup, 'other'>, string[]> = {
  italian: [
    'italian', 'pasta', 'risotto', 'pizza', 'lasagna', 'carbonara', 'bolognese',
    'pesto', 'parmesan', 'marinara', 'tiramisu', 'focaccia', 'gnocchi', 'polenta',
    'prosciutto', 'arrabbiata', 'fettuccine', 'linguine', 'penne', 'tagliatelle',
    'cacio e pepe', 'saltimbocca', 'osso buco', 'caprese',
  ],
  asian: [
    'asian', 'chinese', 'japanese', 'korean', 'thai', 'vietnamese',
    'stir-fry', 'stir fry', 'fried rice', 'noodle', 'ramen', 'pho', 'sushi',
    'teriyaki', 'miso', 'sesame', 'bok choy', 'dumplings', 'potsticker',
    'pad thai', 'curry', 'tikka', 'satay', 'bibimbap', 'bulgogi',
    'udon', 'soba', 'tempura', 'tonkatsu',
  ],
  mexican: [
    'mexican', 'taco', 'burrito', 'enchilada', 'quesadilla', 'salsa', 'guacamole',
    'tortilla', 'tamale', 'chile', 'chili', 'fajita', 'carnitas', 'ceviche',
    'pozole', 'mole', 'jalapeño', 'chipotle', 'cumin', 'cilantro lime',
  ],
  mediterranean: [
    'mediterranean', 'greek', 'middle eastern', 'turkish', 'moroccan', 'lebanese',
    'hummus', 'falafel', 'shawarma', 'kebab', 'tzatziki', 'tabouleh', 'couscous',
    'tagine', 'shakshuka', "za'atar", 'sumac', 'tahini', 'pita', 'spanakopita', 'moussaka',
  ],
  american: [
    'american', 'bbq', 'barbecue', 'burger', 'sandwich', 'mac and cheese', 'macaroni',
    'meatloaf', 'pot roast', 'pulled pork', 'fried chicken', 'biscuit', 'gravy',
    'cornbread', 'chowder', 'buffalo', 'coleslaw', 'baked potato',
  ],
}

export function classifyFreshness(ingredients: Ingredient[]): FreshnessCategory {
  let worst: FreshnessCategory = 'shelf_stable'
  for (const ing of ingredients) {
    const lower = ing.item.toLowerCase()
    for (const category of FRESHNESS_PRIORITY) {
      if (FRESHNESS_KEYWORDS[category].some(kw => lower.includes(kw))) {
        if (FRESHNESS_SCORE[category] < FRESHNESS_SCORE[worst]) {
          worst = category
        }
        break
      }
    }
  }
  return worst
}

export function classifyCuisine(
  title: string,
  description: string,
  existingTags: string[]
): CuisineGroup | null {
  for (const tag of existingTags) {
    const lower = tag.toLowerCase()
    // Tags are controlled vocabulary — use exact match; free text uses substring (below)
    for (const [group, keywords] of Object.entries(CUISINE_KEYWORDS) as [Exclude<CuisineGroup, 'other'>, string[]][]) {
      if (keywords.includes(lower)) return group
    }
  }
  for (const text of [title.toLowerCase(), description.toLowerCase()]) {
    for (const [group, keywords] of Object.entries(CUISINE_KEYWORDS) as [Exclude<CuisineGroup, 'other'>, string[]][]) {
      if (keywords.some(kw => text.includes(kw))) return group
    }
  }
  return null
}

export function detectFrozenIngredients(ingredients: Ingredient[]): boolean {
  // Check `item` field ONLY — not `section` — to avoid false positives from GrocerySection 'frozen'
  return ingredients.some(ing => ing.item.toLowerCase().includes('frozen'))
}

/** Anything a freshness comparison needs off a recipe row. */
export interface FreshnessLike {
  freshnessCategory?: FreshnessCategory | null
  freezerFriendly?: boolean | null
}

/**
 * Read-time override: a freezer-friendly recipe shops like a shelf-stable one,
 * so it lands in the weekend list and takes an early day in the plan. The raw
 * category stays untouched in the database.
 */
export function effectiveFreshness(
  freshnessCategory: FreshnessCategory | null | undefined,
  freezerFriendly: boolean | null | undefined,
): FreshnessCategory {
  if (freezerFriendly) return 'shelf_stable'
  // `recipes.freshness_category` is a bare text column, so the argument is only
  // nominally a FreshnessCategory. Honour the declared return type rather than
  // passing an unlisted string through to callers that index FRESHNESS_SCORE.
  // Object.hasOwn, not `in`: `in` would accept the inherited key 'constructor'.
  if (freshnessCategory && Object.hasOwn(FRESHNESS_SCORE, freshnessCategory)) return freshnessCategory
  return 'moderate'
}

/**
 * Score a row, tolerating a category outside the union.
 *
 * `recipes.freshness_category` is a plain `text` column with no CHECK
 * constraint and no enum, so an older row, a bad write, or a category added
 * later reaches this code as an unlisted string. The original sorted those as
 * 'moderate' (`FRESHNESS_SCORE[eff] ?? 3`); without that fallback the lookup is
 * `undefined` and the comparator returns NaN, which makes Array#sort produce an
 * arbitrary order for the whole list, not just the offending row.
 */
function freshnessScore(row: FreshnessLike): number {
  const category = effectiveFreshness(row.freshnessCategory, row.freezerFriendly)
  return FRESHNESS_SCORE[category] ?? FRESHNESS_SCORE.moderate
}

/** Sort comparator: most perishable first. */
export function compareFreshness(a: FreshnessLike, b: FreshnessLike): number {
  return freshnessScore(a) - freshnessScore(b)
}
