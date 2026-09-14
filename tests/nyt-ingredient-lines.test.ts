/**
 * Real NYT Cooking ingredient lines, and the grocery rows they have to become.
 *
 * Every line here was read back from a page in the household's recipe box on
 * 2026-09-08, alongside the row the parser had stored for it. The stored rows
 * were not shoppable: "regular or -wheat fusilli", "garlic cloves smashed",
 * "pinch of red pepper flakes" with no amount, "salt and pepper" filed under
 * Produce, "rice vinegar" under Grains, "tightly basil leaves". Each block
 * below names the shape that produced one of those and pins the fix.
 *
 * The parser and the categoriser are tested together on purpose: the question
 * that matters is what ends up on the list, and that is both of them.
 */
import { describe, expect, it } from 'vitest'
import { categorizeIngredient } from '../src/recipes/grocery/categories.js'
import { parseIngredient } from '../src/recipes/grocery/parser.js'

describe('filler words do not eat half of a hyphenated word', () => {
  /**
   * FILLER_WORDS matched `\bwhole\b`, and a hyphen is a word boundary, so
   * "whole-wheat" lost its front half and "regular or -wheat fusilli" went on
   * the list.
   */
  it('keeps "whole-wheat" whole', () => {
    const r = parseIngredient('8 ounces regular or whole-wheat fusilli or other short, sturdy pasta')
    expect(r.amount).toBe(8)
    expect(r.unit).toBe('oz')
    expect(r.item).toContain('whole-wheat fusilli')
    expect(r.item).not.toMatch(/(^|\s)-wheat/)
  })

  it('keeps "home-cooked" and "skin-on" whole too', () => {
    expect(parseIngredient('1 pound home-cooked beans').item).toBe('home-cooked beans')
    expect(parseIngredient('4 skin-on chicken thighs').item).toBe('skin-on chicken thighs')
  })

  it('still strips the same word when it stands alone', () => {
    expect(parseIngredient('1 (28-ounce) can whole tomatoes').item).toBe('tomatoes')
    expect(parseIngredient('2 cups cooked chickpeas').item).toBe('chickpeas')
  })
})

describe('a comma clause that is preparation is dropped however it opens', () => {
  /**
   * "smashed" was not a known prep word, so ", smashed and peeled" survived,
   * lost only "peeled" to the filler list, and left "garlic cloves smashed".
   */
  it('drops "smashed and peeled"', () => {
    const r = parseIngredient('2 garlic cloves, smashed and peeled')
    expect(r.amount).toBe(2)
    expect(r.item).toBe('garlic cloves')
  })

  /**
   * These clauses open with a noun, not a verb — "white and green parts…",
   * "tough ends…", "kernels…" — so a list of opening verbs never catches them.
   * What gives them away is a prep verb anywhere inside the clause.
   */
  it('drops a clause that opens with a noun but is still preparation', () => {
    expect(
      parseIngredient('2 bunches scallions, white and green parts separated and cut into 2-inch pieces').item,
    ).toBe('scallions')
    expect(
      parseIngredient('1 bunch asparagus, tough ends removed and stalks cut into ½-inch pieces').item,
    ).toBe('asparagus')
    expect(parseIngredient('1 ear of corn, kernels cut from the cob').item).toBe('corn')
    expect(parseIngredient('1 head garlic, unpeeled and halved crosswise').item).toBe('garlic')
    expect(parseIngredient('4 salmon fillets, skin on or off depending on your preference').item).toBe(
      'salmon fillets',
    )
    expect(parseIngredient('2 cups cooked chickpeas, home-cooked or canned').item).toBe('chickpeas')
  })

  /**
   * The guard from the parser's own history: "center-cut" contains "cut", and
   * the clause it opens is the fish. A hyphenated verb is not a verb.
   */
  it('does not mistake a hyphenated adjective for a prep verb', () => {
    const r = parseIngredient('4 (6-ounce) skin-on, center-cut salmon fillets')
    expect(r.item).toContain('salmon fillets')
  })
})

describe('serving notes are not ingredients', () => {
  it('drops "for serving", "at the table" and the like, with or without a comma', () => {
    expect(parseIngredient('Lemon wedges (optional), for serving').item).toBe('lemon wedges')
    expect(parseIngredient('Warm rice and hot sauce (optional), for serving').item).toBe('rice and hot sauce')
    expect(parseIngredient('Cooked rice, for serving').item).toBe('rice')
    expect(parseIngredient('Grated Parmigiano-Reggiano at the table').item).toBe('parmigiano-reggiano')
    expect(parseIngredient('Chopped cilantro, for garnish').item).toBe('cilantro')
  })
})

describe('an amount that is a word, not a number', () => {
  /**
   * "Pinch of…" has no leading digit, so it parsed as amount 0 and the word
   * "pinch" stayed in the item name. A pinch is a quantity; the flakes are the
   * ingredient.
   */
  it('reads "pinch of", "handful of", "squeeze of" as one of that measure', () => {
    const pinch = parseIngredient('Pinch of red pepper flakes, plus more as needed')
    expect(pinch.amount).toBe(1)
    expect(pinch.unit).toBe('pinch')
    expect(pinch.item).toBe('red pepper flakes')

    const handful = parseIngredient('Handful of cilantro leaves')
    expect(handful.unit).toBe('handful')
    expect(handful.item).toBe('cilantro leaves')

    const squeeze = parseIngredient('Squeeze of lemon')
    expect(squeeze.unit).toBe('squeeze')
    expect(squeeze.item).toBe('lemon')

    expect(parseIngredient('pinch red-pepper flakes').item).toBe('red-pepper flakes')
  })

  it('reads an article or a number word as its count', () => {
    expect(parseIngredient('A pinch of saffron').unit).toBe('pinch')
    expect(parseIngredient('A pinch of saffron').item).toBe('saffron')

    const half = parseIngredient('Half a cucumber')
    expect(half.amount).toBeCloseTo(0.5)
    expect(half.item).toBe('cucumber')

    expect(parseIngredient('two lemons').amount).toBe(2)
    expect(parseIngredient('an onion, diced').amount).toBe(1)
    expect(parseIngredient('an onion, diced').item).toBe('onion')
  })

  it('reads "head" and "ear" as units so the food is the item', () => {
    const garlic = parseIngredient('1 head garlic')
    expect(garlic.unit).toBe('head')
    expect(garlic.item).toBe('garlic')
  })
})

describe('a second measure after "plus" is not part of the name', () => {
  it('keeps the first measure and drops the "plus" one', () => {
    const r = parseIngredient('½ cup plus 1 tablespoon neutral oil, like grapeseed or vegetable')
    expect(r.amount).toBeCloseTo(0.5)
    expect(r.unit).toBe('cup')
    expect(r.item).toBe('neutral oil')
  })
})

describe('packing words go with "packed"', () => {
  /**
   * "packed" was a filler word; "tightly" was not. "½ cup tightly packed basil
   * leaves" therefore became "tightly basil leaves".
   */
  it('strips "tightly", "loosely" and "firmly"', () => {
    expect(parseIngredient('½ cup tightly packed basil leaves').item).toBe('basil leaves')
    expect(parseIngredient('1 cup loosely packed parsley').item).toBe('parsley')
    expect(parseIngredient('1/4 cup firmly packed brown sugar').item).toBe('brown sugar')
  })
})

describe('seasoning lines fold onto one staple', () => {
  it('reads every way NYT writes "season it" as "salt and pepper"', () => {
    for (const raw of [
      'Kosher salt and pepper',
      'Salt and pepper',
      'Salt and freshly ground black pepper',
      'Kosher salt and black pepper',
      'Salt and pepper, to taste',
    ]) {
      expect(parseIngredient(raw).item, raw).toBe('salt and pepper')
    }
  })
})

/* ──────────────────────────────── the aisle ──────────────────────────────── */

describe('which aisle', () => {
  /**
   * "salt and pepper" fell through to the keyword scan, where "pepper" is a
   * vegetable, and 27 of 72 recipes then put a seasoning under Produce.
   */
  it('files the seasoning staples with the pantry', () => {
    expect(categorizeIngredient('salt and pepper')).toBe('pantry_staples')
    expect(categorizeIngredient('kosher salt')).toBe('pantry_staples')
    expect(categorizeIngredient('white pepper')).toBe('pantry_staples')
  })

  /**
   * Same word, different aisle: flakes, peppercorns and powders are spices,
   * and the produce keyword "pepper" must not claim them.
   */
  it('files flakes, peppercorns and powders as spices, not produce', () => {
    for (const item of [
      'red pepper flakes',
      'red-pepper flakes',
      'black peppercorns',
      'garlic powder',
      'onion powder',
      'nutmeg',
      'saffron',
      'cumin seeds',
      'aleppo pepper',
    ]) {
      expect(categorizeIngredient(item), item).toBe('spices_seasonings')
    }
  })

  /**
   * The head noun is the thing being bought. "rice vinegar" is a vinegar,
   * "rice noodles" are noodles; the rice in front is a modifier.
   */
  it('lets the head noun outrank a modifier that is also a keyword', () => {
    expect(categorizeIngredient('rice vinegar')).toBe('oils_vinegars_condiments')
    expect(categorizeIngredient('unseasoned rice vinegar')).toBe('oils_vinegars_condiments')
    expect(categorizeIngredient('rice noodles')).toBe('grains_pasta_rice')
    expect(categorizeIngredient('fish sauce')).toBe('oils_vinegars_condiments')
  })

  /**
   * The aisle is decided on the item name, and "can" is a unit, so "1
   * (28-ounce) can whole, peeled tomatoes" became "tomatoes" and went to
   * Produce. The container is the answer when there is one.
   */
  it('files anything measured in cans or jars, or called canned, with the cans', () => {
    expect(categorizeIngredient('tomatoes', 'can')).toBe('canned_jarred')
    expect(categorizeIngredient('passata', 'jar')).toBe('canned_jarred')
    expect(categorizeIngredient('canned imported italian plum tomatoes')).toBe('canned_jarred')
    expect(categorizeIngredient('tomatoes')).toBe('produce')

    const line = parseIngredient('1 (28-ounce) can whole, peeled tomatoes')
    expect(line.unit).toBe('can')
    expect(categorizeIngredient(line.item, line.unit)).toBe('canned_jarred')
  })

  it('knows the foods the recipe box actually uses', () => {
    expect(categorizeIngredient('shelf-stable potato gnocchi')).toBe('grains_pasta_rice')
    expect(categorizeIngredient('ramen noodles')).toBe('grains_pasta_rice')
    expect(categorizeIngredient('smooth peanut butter')).toBe('pantry_dry_goods')
    expect(categorizeIngredient('roasted peanuts')).toBe('pantry_dry_goods')
    expect(categorizeIngredient('soft plums')).toBe('produce')
  })

  it('still honours the two-word keywords the head-noun rule exists to protect', () => {
    expect(categorizeIngredient('green beans')).toBe('produce')
    expect(categorizeIngredient('sweet potatoes')).toBe('produce')
    expect(categorizeIngredient('coconut milk')).toBe('canned_jarred')
    expect(categorizeIngredient('sour cream')).toBe('dairy_eggs')
    expect(categorizeIngredient('apple cider vinegar')).toBe('oils_vinegars_condiments')
    expect(categorizeIngredient('chicken or veal stock')).toBe('canned_jarred')
    expect(categorizeIngredient('chicken and mushroom soup')).toBe('meat_seafood')
  })
})
