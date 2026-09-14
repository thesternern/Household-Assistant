import type { GrocerySection } from '../types.js'

export const GROCERY_SECTIONS: GrocerySection[] = [
  'produce', 'meat_seafood', 'dairy_eggs', 'bakery_bread',
  'pantry_dry_goods', 'canned_jarred', 'frozen',
  'spices_seasonings', 'oils_vinegars_condiments',
  'grains_pasta_rice', 'snacks', 'beverages', 'other', 'pantry_staples'
]

export const PANTRY_STAPLES = new Set([
  'salt', 'kosher salt', 'sea salt', 'black pepper', 'white pepper', 'pepper',
  'salt and pepper', 'olive oil', 'butter',
  'garlic', 'all-purpose flour', 'flour', 'sugar', 'soy sauce',
  'vegetable oil', 'canola oil', 'neutral oil', 'baking soda', 'baking powder',
  'water', 'chicken broth', 'vegetable broth'
])

/**
 * Spices that the produce keyword "pepper" would otherwise claim, plus the
 * ones no keyword reached at all. "red pepper flakes" was filed with the
 * vegetables and "black peppercorns", "nutmeg" and "saffron" under Other.
 * Tested before the keyword table because "pepper" sits in produce, and
 * produce is scanned before spices.
 */
const SPICE_PHRASES =
  /\b(?:(?:red[- ]|chil[ei] |chilli |aleppo )?pepper flakes?|crushed red pepper|peppercorns?|aleppo pepper|nutmeg|saffron|cumin|allspice|cardamom|cayenne|sumac|za'?atar|garam masala|five-spice|caraway|star anise|vanilla|bay lea(?:f|ves)|(?:fennel|coriander|mustard|sesame|poppy|celery) seeds?|(?:garlic|onion|chil[ei]|curry|mustard|ginger|cocoa) powder)\b/

/**
 * Liquids that name their animal — "chicken stock", "low-sodium beef broth".
 *
 * These have to be decided before SECTION_KEYWORDS runs. That list is ordered
 * and first match wins, with meat_seafood first, so "chicken or veal stock"
 * matched 'chicken' and was filed under Meat & seafood — sending someone to the
 * butcher counter for a carton off a shelf two aisles away.
 */
const LIQUID_BASES = ['stock', 'broth', 'bouillon', 'consomme', 'consommé']

const SECTION_KEYWORDS: [GrocerySection, string[]][] = [
  ['meat_seafood', ['chicken', 'beef', 'pork', 'lamb', 'turkey', 'salmon', 'shrimp', 'fish', 'tuna', 'cod', 'sausage', 'bacon', 'ham', 'pancetta', 'steak', 'steaks', 'rib-eye', 'ribeye', 'rib', 'ribs', 'brisket', 'tenderloin', 'shoulder', 'shank', 'duck', 'veal', 'chorizo', 'prosciutto', 'salami', 'halibut', 'haddock', 'tilapia', 'trout', 'snapper', 'scallop', 'scallops', 'crab', 'lobster', 'mussel', 'mussels', 'clam', 'clams', 'squid', 'anchovy', 'anchovies', 'sardine', 'sardines', 'meatball', 'meatballs', 'mince', 'sparerib', 'spareribs', 'chuck', 'flank', 'sirloin', 'brisket', 'loin', 'drumstick', 'drumsticks', 'wing', 'wings', 'cutlet', 'cutlets', 'chop', 'chops', 'thigh', 'thighs', 'breast', 'breasts', 'fillet', 'fillets']],
  // 'sprout' catches brussels sprouts; 'sprig' catches the fresh-herb lines
  // ("thyme sprigs") without dragging dried and ground herbs out of spices.
  ['produce', ['onion', 'garlic', 'tomato', 'pepper', 'carrot', 'celery', 'spinach', 'kale', 'lettuce', 'cabbage', 'broccoli', 'cauliflower', 'zucchini', 'squash', 'potato', 'sweet potato', 'apple', 'lemon', 'lime', 'orange', 'banana', 'herb', 'cilantro', 'parsley', 'basil', 'ginger', 'avocado', 'cucumber', 'mushroom', 'corn', 'green onion', 'brussels', 'sprout', 'sprig', 'scallion', 'shallot', 'dill', 'asparagus', 'leek', 'green bean', 'arugula', 'chive', 'radish', 'fennel', 'eggplant', 'beet', 'pear', 'berry', 'grape', 'melon', 'plum', 'peach', 'nectarine', 'mango', 'pineapple']],
  ['dairy_eggs', ['milk', 'cream', 'cheese', 'yogurt', 'sour cream', 'butter', 'egg', 'parmesan', 'mozzarella', 'cheddar', 'ricotta', 'feta', 'gruyere']],
  ['grains_pasta_rice', ['pasta', 'rice', 'noodle', 'spaghetti', 'penne', 'fettuccine', 'orzo', 'couscous', 'quinoa', 'oat', 'barley', 'macaroni', 'ditalini', 'gnocchi', 'ramen', 'udon', 'soba', 'vermicelli', 'farro', 'polenta']],
  ['canned_jarred', ['can', 'canned', 'jar', 'tomato sauce', 'tomato paste', 'diced tomato', 'crushed tomato', 'coconut milk', 'bean', 'chickpea', 'lentil', 'broth', 'stock', 'cannellini']],
  ['bakery_bread', ['bread', 'baguette', 'roll', 'tortilla', 'pita', 'naan', 'bun', 'crouton']],
  ['frozen', ['frozen', 'peas', 'edamame']],
  ['oils_vinegars_condiments', ['oil', 'vinegar', 'mustard', 'ketchup', 'mayo', 'mayonnaise', 'hot sauce', 'worcestershire', 'fish sauce', 'sesame oil', 'tahini', 'oyster sauce']],
  ['spices_seasonings', ['spice', 'cumin', 'paprika', 'oregano', 'thyme', 'rosemary', 'cinnamon', 'turmeric', 'coriander', 'chili', 'cayenne', 'bay leaf', 'seasoning', 'curry']],
  // 'peanut butter' is a phrase keyword so it is asked before 'butter' in dairy.
  ['pantry_dry_goods', ['flour', 'sugar', 'honey', 'maple syrup', 'panko', 'breadcrumb', 'cornstarch', 'baking', 'peanut butter', 'almond butter', 'nut butter', 'peanut', 'almond', 'walnut', 'pecan', 'cashew', 'pistachio', 'pine nut', 'chocolate', 'cocoa']],
]

/**
 * Keyword tests, built once, tolerant of a plural.
 *
 * Bare substring matching filed "grapeseed oil" under the fruit, because
 * "grape" sits inside "grapeseed". A strict word boundary fixes that but then
 * "carrot" stops matching "carrots", so the trailing s (or es) is allowed and
 * nothing else is.
 */
const KEYWORD_PATTERNS: Array<[GrocerySection, RegExp]> = SECTION_KEYWORDS.flatMap(
  ([section, keywords]) =>
    keywords.map(
      (keyword) =>
        [
          section,
          new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:e?s)?\\b`),
        ] as [GrocerySection, RegExp],
    ),
)

/** Every pattern for one section, in table order. */
function sectionMatches(section: GrocerySection, text: string): boolean {
  return KEYWORD_PATTERNS.some(([s, pattern]) => s === section && pattern.test(text))
}

/**
 * The keywords that are themselves a phrase — "green bean", "sweet potato",
 * "fish sauce". A hit on one of these is the most specific answer there is,
 * so they are asked first, against the whole string.
 */
const PHRASE_PATTERNS = KEYWORD_PATTERNS.filter(([, pattern]) => pattern.source.includes(' '))

/**
 * Which aisle, settled by three rules that none of them could settle alone.
 *
 * **A phrase keyword outranks everything.** "fish sauce" is a condiment even
 * though "fish" is a protein; "green beans" are produce even though "beans"
 * are canned. Two-word keywords are tested first, on the whole string.
 *
 * **Then protein.** "chicken and mushroom soup" is shopped at the meat
 * counter, so meat_seafood is tested against the whole phrase before the
 * head-noun rule runs. This is why "most specific keyword wins" is not the
 * answer: it hands that soup to the mushrooms.
 *
 * **Otherwise the head noun decides.** Plain section order put "apple cider
 * vinegar" in produce, because produce outranks the vinegars and "apple"
 * matched; the two-word tail put "rice vinegar" with the rice. In both the
 * last word is the thing being bought and everything before it is a modifier,
 * so the last word is asked first, then the last two, then the whole string.
 */
export function categorizeIngredient(item: string, unit?: string): GrocerySection {
  const lower = item.toLowerCase()
  if (PANTRY_STAPLES.has(lower)) return 'pantry_staples'
  if (LIQUID_BASES.some((kw) => lower.includes(kw))) return 'canned_jarred'
  // The unit settles it when it is the container: "1 (28-ounce) can whole,
  // peeled tomatoes" is a can, wherever the word "tomatoes" would file it.
  if (unit === 'can' || unit === 'jar' || /\bcanned\b/.test(lower)) return 'canned_jarred'
  for (const [section, pattern] of PHRASE_PATTERNS) {
    if (pattern.test(lower)) return section
  }
  if (SPICE_PHRASES.test(lower)) return 'spices_seasonings'
  if (sectionMatches('meat_seafood', lower)) return 'meat_seafood'

  const words = lower.split(/\s+/).filter((w) => w !== '')
  const tails = [words.slice(-1).join(' '), words.slice(-2).join(' ')].filter((t) => t !== '')

  for (const text of [...tails, lower]) {
    for (const [section, pattern] of KEYWORD_PATTERNS) {
      if (pattern.test(text)) return section
    }
  }
  return 'other'
}

const SECTION_SET: ReadonlySet<string> = new Set<string>(GROCERY_SECTIONS)

/**
 * Runtime guard for a section that came out of jsonb.
 *
 * `Ingredient.section` is *typed* `GrocerySection`, but the values arrive from
 * scraped pages, pasted text, and model tool calls — none of which the compiler
 * checks. A rogue value used as an object key is not merely wrong: `__proto__`,
 * `constructor`, and `toString` all resolve to inherited members and crash the
 * consolidator, and any other unknown string produces a phantom section that no
 * renderer iterating GROCERY_SECTIONS will ever show.
 */
export function isGrocerySection(value: unknown): value is GrocerySection {
  return typeof value === 'string' && SECTION_SET.has(value)
}
