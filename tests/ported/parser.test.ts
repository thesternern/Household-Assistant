// Ported verbatim from thesternern/recipe-planner tests/grocery/parser.test.ts.
import { describe, it, expect } from 'vitest'
import { formatAmount, parseIngredient } from '../../src/recipes/grocery/parser.js'

describe('parseIngredient', () => {
  it('parses "2 lbs chicken thighs"', () => {
    const r = parseIngredient('2 lbs chicken thighs')
    expect(r.amount).toBe(2)
    expect(r.unit).toBe('lb')
    expect(r.item).toBe('chicken thighs')
  })

  it('parses "1 large onion, diced"', () => {
    const r = parseIngredient('1 large onion, diced')
    expect(r.amount).toBe(1)
    expect(r.item).toBe('onion')
  })

  it('parses "3 cloves garlic"', () => {
    const r = parseIngredient('3 cloves garlic')
    expect(r.amount).toBe(3)
    expect(r.item).toBe('garlic')
  })

  it('handles "salt and pepper to taste"', () => {
    const r = parseIngredient('salt and pepper to taste')
    expect(r.item).toContain('salt')
    expect(r.amount).toBe(0)
  })

  it('parses fractional amounts "1/2 cup flour"', () => {
    const r = parseIngredient('1/2 cup flour')
    expect(r.amount).toBeCloseTo(0.5)
    expect(r.unit).toBe('cup')
    expect(r.item).toBe('flour')
  })

  it('parses "2 cans diced tomatoes"', () => {
    const r = parseIngredient('2 cans diced tomatoes')
    expect(r.amount).toBe(2)
    expect(r.item).toContain('tomato')
  })
})

/**
 * NYT Cooking — and most recipe sites — write amounts as Unicode vulgar
 * fractions (¼, ½, ¾, ⅓). The original regex matched `[\d\s/]`, which is
 * ASCII-only, so those failed to parse and the amount stayed glued to the front
 * of the item name: "¼ cup dill" became an *item* rather than 0.25 cup of dill.
 *
 * That is not a cosmetic problem. The consolidator keys on the item name, so
 * the same herb at two amounts produced two rows that could never merge, and
 * every such line rendered with the quantity "as needed".
 */
describe('parseIngredient: Unicode fractions', () => {
  it('reads a bare vulgar fraction as its value', () => {
    const r = parseIngredient('¼ teaspoon garlic powder')
    expect(r.amount).toBeCloseTo(0.25)
    expect(r.unit).toBe('tsp')
    expect(r.item).toBe('garlic powder')
  })

  it('adds a vulgar fraction to a whole number', () => {
    const r = parseIngredient('1 ½ ounces Parmesan')
    expect(r.amount).toBeCloseTo(1.5)
    expect(r.unit).toBe('oz')
    expect(r.item).toBe('parmesan')
  })

  it('keeps the item name free of the amount', () => {
    expect(parseIngredient('½ cup chopped dill').item).toBe('dill')
    expect(parseIngredient('¼ cup dill').item).toBe('dill')
  })

  it('handles the fractions recipe sites actually use', () => {
    expect(parseIngredient('⅓ cup white miso').amount).toBeCloseTo(1 / 3)
    expect(parseIngredient('⅔ cup rice').amount).toBeCloseTo(2 / 3)
    expect(parseIngredient('⅛ teaspoon cayenne').amount).toBeCloseTo(0.125)
    expect(parseIngredient('¾ cup stock').amount).toBeCloseTo(0.75)
  })

  it('still parses an ASCII fraction the same way', () => {
    expect(parseIngredient('1/2 cup flour').amount).toBeCloseTo(0.5)
    expect(parseIngredient('1 1/2 cups flour').amount).toBeCloseTo(1.5)
  })
})

describe('parseIngredient: filler words', () => {
  it('strips "freshly" along with the participle it modifies', () => {
    expect(parseIngredient('1 cup freshly grated Parmesan').item).toBe('parmesan')
  })

  it('strips "freshly" wherever it appears', () => {
    expect(parseIngredient('2 tablespoons freshly chopped parsley').item).toBe('parsley')
  })
})

/**
 * Amounts are read as numbers but shopped as text. Once vulgar fractions parsed
 * correctly, a third of a cup started rendering as "0.3333333333333333 cup" —
 * accurate, unreadable, and worse on a phone than the bug it replaced.
 */
describe('formatAmount', () => {
  it('renders the fractions a recipe would have written', () => {
    expect(formatAmount(0.5)).toBe('1/2')
    expect(formatAmount(0.25)).toBe('1/4')
    expect(formatAmount(0.75)).toBe('3/4')
    expect(formatAmount(1 / 3)).toBe('1/3')
    expect(formatAmount(2 / 3)).toBe('2/3')
    expect(formatAmount(0.125)).toBe('1/8')
  })

  it('renders a mixed number rather than an improper fraction', () => {
    expect(formatAmount(1.5)).toBe('1 1/2')
    expect(formatAmount(2.25)).toBe('2 1/4')
    expect(formatAmount(1 + 1 / 3)).toBe('1 1/3')
  })

  it('leaves whole numbers whole', () => {
    expect(formatAmount(1)).toBe('1')
    expect(formatAmount(12)).toBe('12')
  })

  it('falls back to a short decimal when no common fraction fits', () => {
    expect(formatAmount(0.4)).toBe('0.4')
    expect(formatAmount(1.85)).toBe('1.85')
  })
})

/**
 * Recipe lines that are prose, not data. Each of these came off a real NYT
 * page and produced a grocery row nobody could shop from.
 */
describe('parseIngredient: prose ingredient lines', () => {
  /**
   * "Juice of 2 lemons" hides its number in the middle, so the leading-number
   * regex found nothing and the count stayed in the item name — the same fault
   * as the vulgar fractions, and with the same consequence: "zest of 1 lemon"
   * and "zest of 2 lemons" were two rows that could never merge. What you buy
   * in every case is lemons.
   */
  it('reads the count out of an "of N" phrase', () => {
    const juice = parseIngredient('Juice of 2 lemons')
    expect(juice.amount).toBe(2)
    expect(juice.item).toBe('lemons')

    const zest = parseIngredient('Finely grated zest of 1 lemon')
    expect(zest.amount).toBe(1)
    expect(zest.item).toBe('lemon')
  })

  /**
   * An earlier version cut the phrase at "or" to shorten the row. It was tried
   * twice — first gated on word count, then on the alternative looking generic
   * — and both times real recipe lines lost the food itself: "rib or loin pork
   * chops" became "rib", and "wild king or other salmon fillets" became "wild
   * king". The head noun frequently arrives after the "or", and no cheap rule
   * tells that apart from a genuine choice. So the phrase is kept whole. A
   * verbose row is a nuisance; a row with no fish on it is a failed shop.
   */
  it('keeps both sides of an "or", because the food is often on the far side', () => {
    expect(parseIngredient('1 pound mezze rigatoni or other short pasta').item).toBe(
      'mezze rigatoni or other short pasta',
    )
    expect(parseIngredient('4 skin-on, center-cut wild king or other salmon fillets').item).toContain(
      'salmon',
    )
  })

  /**
   * The guard on the rule above. "chicken or veal stock" is not a choice
   * between chicken and something else — the head noun is stock, and cutting at
   * "or" would send someone to the butcher for a carton.
   */
  it('does not cut an "or" that shares its head noun', () => {
    expect(parseIngredient('3/4 cup chicken or veal stock').item).toBe('chicken or veal stock')
    expect(parseIngredient('2 cups beef or chicken broth').item).toBe('beef or chicken broth')
  })

  /**
   * cleanItem cut everything after the first comma, and did it before removing
   * parentheses. "4 (6-ounce) skin-on, center-cut salmon fillets" therefore
   * became the item "skin-on" — an adjective, on a shopping list, with no fish.
   */
  it('keeps the noun when a comma separates two adjectives', () => {
    const r = parseIngredient('4 (6-ounce) skin-on, center-cut salmon fillets')
    expect(r.amount).toBe(4)
    expect(r.item).toContain('salmon')
  })

  it('still drops a comma clause that is only preparation', () => {
    expect(parseIngredient('1 large onion, diced').item).toBe('onion')
    expect(parseIngredient('2 cloves garlic, minced').item).toBe('garlic')
    expect(parseIngredient('4 cups kale, stems removed').item).toBe('kale')
    expect(parseIngredient('Zest of 1 lemon, plus wedges for serving').item).toBe('lemon')
  })
})

/**
 * Regressions from a first attempt at the "or" rule, which cut whenever enough
 * words sat in front of the "or". That reasoning was wrong: what decides it is
 * whether the tail names a whole ingredient or just another modifier of a head
 * noun still to come. "rib or loin pork chops" is the second kind, and cutting
 * there put "1/4-inch-thick center-cut rib" on a shopping list with no pork.
 *
 * So the rule is now conservative: cut only when the alternative is explicitly
 * generic. A long but correct row beats a short wrong one.
 */
describe('parseIngredient: "or" that is not a choice of ingredient', () => {
  it('keeps the head noun when the alternatives are modifiers', () => {
    expect(parseIngredient('5 1/4-inch-thick center-cut rib or loin pork chops').item).toContain('pork chops')
    expect(parseIngredient('4 skin-on center-cut wild king or sockeye salmon fillets').item).toContain('salmon')
    expect(parseIngredient('4 cups baby kale leaves or 1-inch Tuscan kale ribbons').item).toContain('kale')
  })

  /**
   * "4 1 ¼-inch-thick ... pork chops" opens with the count, then a *dimension*
   * that also starts with a number. The amount run swallowed both and reported
   * five chops instead of four — a real over-buy every time this recipe is
   * planned.
   */
  it('does not read a hyphenated dimension as part of the count', () => {
    const chops = parseIngredient('4 1 1/4-inch-thick center-cut rib or loin pork chops, bone in')
    expect(chops.amount).toBe(4)
    expect(chops.item).toContain('pork chops')

    const steak = parseIngredient('2 1-inch-thick rib-eye steaks')
    expect(steak.amount).toBe(2)
  })

  it('still adds a genuine mixed number', () => {
    expect(parseIngredient('1 1/2 cups flour').amount).toBeCloseTo(1.5)
    expect(parseIngredient('1 1/2 cups flour').item).toBe('flour')
  })

  it('drops a soaking or resting instruction after a comma', () => {
    expect(parseIngredient('1 1/2 cups hickory chips, soaked for 30 minutes and drained').item).toBe(
      'hickory chips',
    )
  })

  it('never leaves a dangling conjunction on the end', () => {
    for (const raw of [
      '1 1/2 cups hickory chips, soaked for 30 minutes and drained',
      '2 cups kale, washed and dried',
    ]) {
      expect(parseIngredient(raw).item, raw).not.toMatch(/\b(and|or|with|plus)$/)
    }
  })
})

/**
 * The last two shapes NYT uses that the parser read as nonsense: a range, and
 * a quantity given twice in different measures.
 */
describe('parseIngredient: ranges and dual measures', () => {
  /**
   * "3 to 4 chicken breasts" parsed as three, with "to 4 chicken breasts" as
   * the item. The upper bound is the one to shop for — coming home one breast
   * short is the failure that matters.
   */
  it('shops for the top of a range', () => {
    const chicken = parseIngredient('3 to 4 chicken breasts')
    expect(chicken.amount).toBe(4)
    expect(chicken.item).toBe('chicken breasts')

    const oil = parseIngredient('2 to 3 tablespoons olive oil')
    expect(oil.amount).toBe(3)
    expect(oil.unit).toBe('tbsp')
    expect(oil.item).toBe('olive oil')
  })

  it('reads an en-dash range too', () => {
    expect(parseIngredient('3–4 chicken thighs').amount).toBe(4)
  })

  /**
   * "1½ cups/10 ounces basmati rice" gives the same quantity twice. The first
   * measure wins; the second was ending up in the item name, which put
   * "cups/10 ounces basmati rice" on the shopping list.
   */
  it('takes the first of two measures', () => {
    const rice = parseIngredient('1 1/2 cups/10 ounces basmati rice')
    expect(rice.amount).toBeCloseTo(1.5)
    expect(rice.unit).toBe('cup')
    expect(rice.item).toBe('basmati rice')
  })
})
