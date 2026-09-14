export interface ParsedIngredient {
  amount: number
  unit: string
  item: string
  raw: string
}

const UNIT_ALIASES: Record<string, string> = {
  'pound': 'lb', 'pounds': 'lb', 'lbs': 'lb', 'lb': 'lb',
  'ounce': 'oz', 'ounces': 'oz', 'oz': 'oz',
  'cup': 'cup', 'cups': 'cup',
  'tablespoon': 'tbsp', 'tablespoons': 'tbsp', 'tbsp': 'tbsp', 'tbs': 'tbsp',
  'teaspoon': 'tsp', 'teaspoons': 'tsp', 'tsp': 'tsp',
  'liter': 'L', 'liters': 'L', 'litre': 'L', 'litres': 'L',
  'milliliter': 'mL', 'milliliters': 'mL', 'ml': 'mL',
  'gram': 'g', 'grams': 'g', 'g': 'g',
  'kilogram': 'kg', 'kilograms': 'kg', 'kg': 'kg',
  'clove': 'clove', 'cloves': 'clove',
  'can': 'can', 'cans': 'can',
  'jar': 'jar', 'jars': 'jar',
  'bunch': 'bunch', 'bunches': 'bunch',
  'slice': 'slice', 'slices': 'slice',
  'piece': 'piece', 'pieces': 'piece',
  'sprig': 'sprig', 'sprigs': 'sprig',
  'fillet': 'fillet', 'fillets': 'fillet',
  'head': 'head', 'heads': 'head',
  'ear': 'ear', 'ears': 'ear',
  'stalk': 'stalk', 'stalks': 'stalk',
  'package': 'package', 'packages': 'package',
  // Measures that are words. "Pinch of red pepper flakes" has no digit in
  // front, so it parsed as amount 0 with "pinch" left inside the item name;
  // normalizeMeasures puts a "1" in front and these make the word a unit.
  'pinch': 'pinch', 'pinches': 'pinch',
  'handful': 'handful', 'handfuls': 'handful',
  'dash': 'dash', 'dashes': 'dash',
  'splash': 'splash', 'splashes': 'splash',
  'squeeze': 'squeeze',
  'knob': 'knob',
  'drizzle': 'drizzle',
  'sprinkle': 'sprinkle',
}

// `freshly` must precede `fresh`, and both are safe next to each other: the
// boundary after "fresh" cannot match inside "freshly", so the shorter
// alternative never strands an "ly". Without `freshly`, "freshly grated
// Parmesan" lost only the participle and became the item "freshly parmesan".
//
// The boundaries are lookarounds that treat a hyphen as part of the word, not
// `\b`, which does not: `\bwhole\b` matched the front of "whole-wheat" and put
// "regular or -wheat fusilli" on the list. "home-cooked", "skin-on" and
// "center-cut" survive for the same reason.
const FILLER_WORDS = /(?<![\w-])(?:large|small|medium|whole|freshly|fresh|dried|frozen|cooked|warmed|warm|ripe|boneless|skinless|chopped|diced|sliced|minced|grated|shredded|smashed|torn|tightly|loosely|firmly|packed|heaping|leveled|peeled|unpeeled|pitted|seeded|stemmed|trimmed|rinsed|drained|halved|quartered|crushed|ground|cracked|coarsely|finely|roughly|thinly|lightly|or more|to taste|as needed|optional)(?![\w-])/gi

/**
 * Unicode vulgar fractions, which is how recipe sites overwhelmingly write
 * amounts — NYT Cooking uses them on essentially every line.
 *
 * The amount regex below matches `[\d\s/]`, and `\d` is ASCII-only, so an
 * unexpanded `¼` failed the match entirely and the whole string became the item
 * name. That is why "¼ cup dill" and "½ cup dill" were two grocery rows: the
 * consolidator keys on the item name, so the amount was part of the key and the
 * same herb could never merge with itself.
 */
const VULGAR_FRACTIONS: Record<string, string> = {
  '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4',
  '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5', '⅙': '1/6',
  '⅚': '5/6', '⅐': '1/7', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8',
  '⅞': '7/8', '⅑': '1/9', '⅒': '1/10',
}

/**
 * Rewrite vulgar fractions as ASCII so the amount regex can read them.
 *
 * Each becomes a *space-prefixed* `1/2`, so "1½" turns into "1 1/2" — the mixed
 * number the parser already sums — rather than "11/2", which would read as five
 * and a half. U+2044 (fraction slash) is folded onto "/" for the same reason.
 */
export function expandFractions(input: string): string {
  return input
    .replace(/[⁄]/g, '/')
    .replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒]/g, (c) => ` ${VULGAR_FRACTIONS[c] ?? c}`)
    .replace(/\s+/g, ' ')
    .trim()
}

/** Denominators a recipe actually uses. 1/7 and 1/9 exist as glyphs, not as cooking. */
const DISPLAY_DENOMINATORS = [2, 3, 4, 8]

/**
 * Render a parsed amount the way a recipe would have written it.
 *
 * Amounts are read as numbers but shopped as text. Once vulgar fractions began
 * parsing correctly, a third of a cup rendered as "0.3333333333333333 cup" —
 * accurate, and worse on a phone than the bug it replaced.
 */
export function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const whole = Math.floor(n)
  const remainder = n - whole

  if (remainder < 1e-6) return String(whole)

  for (const den of DISPLAY_DENOMINATORS) {
    const num = Math.round(remainder * den)
    if (num > 0 && num < den && Math.abs(remainder - num / den) < 1e-6) {
      const fraction = `${num}/${den}`
      return whole === 0 ? fraction : `${whole} ${fraction}`
    }
  }

  // Not a fraction anyone writes: keep it short rather than exact.
  return String(Math.round(n * 100) / 100)
}

/**
 * Clause openers that mark what follows a comma as preparation, not more of the
 * ingredient's name.
 *
 * cleanItem used to cut at the *first* comma unconditionally, which is right
 * for "1 large onion, diced" and catastrophic for "(6-ounce) skin-on,
 * center-cut salmon fillets" — that produced the item "skin-on": an adjective,
 * on a shopping list, with no fish attached.
 */
const PREP_CLAUSE =
  /^(?:diced|minced|chopped|sliced|cut|trimmed|peeled|halved|quartered|crushed|ground|grated|shredded|rinsed|drained|pitted|stemmed|seeded|stems?|plus|about|for|to|or|like|thinly|roughly|finely|coarsely|freshly|preferably|such|if|optional|divided|at|room|well|lightly|packed|torn|smashed|separated|softened|melted|beaten|patted|scrubbed|more|soaked|washed|dried|thawed|toasted|warmed|chilled|reserved|removed|discarded|picked|stripped|crumbled|cubed|julienned|shaved|zested|juiced|scrubbed)\b/i

/**
 * A preparation clause that opens with a noun — "white and green parts
 * separated and cut into 2-inch pieces", "tough ends removed", "kernels cut
 * from the cob", "skin on or off depending on your preference". No list of
 * opening words catches these; what gives them away is a prep verb anywhere
 * inside. Standalone verbs only: "center-cut" contains "cut" and opens the
 * clause that names the fish.
 */
const PREP_VERB_ANYWHERE =
  /(?<![\w-])(?:separated|removed|cut|sliced|torn|picked|discarded|reserved|patted|crumbled|shaved|julienned|smashed|peeled|unpeeled|minced|chopped|diced|grated|halved|quartered|trimmed|rinsed|drained|beaten|softened|melted|thawed|scrubbed|cored|seeded|stemmed|pitted|shredded|crushed|cubed|zested|juiced|deveined|shelled|split|snapped|broken|canned|homemade|store-bought|depending|skin (?:on|off)|bone (?:in|out))(?![\w-])/i

function isPrepClause(part: string): boolean {
  const trimmed = part.trim()
  return PREP_CLAUSE.test(trimmed) || PREP_VERB_ANYWHERE.test(trimmed)
}

/**
 * Keep the name, drop any comma clause that is only telling you what to do to
 * it.
 *
 * One shape has the food on the far side of that comma: "can whole, peeled
 * tomatoes". Cutting at "peeled" leaves "whole", which the filler list then
 * empties. So when what is kept has no word left in it, the first dropped
 * clause comes back — its participle goes the same way as any other filler.
 */
function dropPrepClauses(s: string): string {
  const parts = s.split(',')
  const kept: string[] = [parts[0] ?? '']
  let dropped: string | null = null
  for (const part of parts.slice(1)) {
    if (isPrepClause(part)) {
      dropped = part
      break
    }
    kept.push(part)
  }
  if (dropped !== null && kept.join(' ').replace(FILLER_WORDS, ' ').trim() === '') {
    kept.push(dropped)
  }
  return kept.join(' ')
}

/**
 * Text that tells you when to use it, not what to buy: "for serving", "at the
 * table", "for garnish". Dropped from wherever it starts to the end of the
 * line, comma or no comma — "Grated Parmigiano-Reggiano at the table" has none.
 */
const SERVING_NOTE =
  /\b(?:at the table|for serving|for garnish(?:ing)?|to serve|for drizzling|for sprinkling|for brushing|for greasing|for dusting|for the pan|for topping|for finishing|if desired|if using|see tip|see note)\b.*$/i

/**
 * "Juice of 2 lemons", "Finely grated zest of 1 lemon".
 *
 * The amount regex wants its number first, so these parsed as amount 0 with the
 * count left sitting in the item name — which meant "zest of 1 lemon" and "zest
 * of 2 lemons" were two grocery rows that could never merge. What the household
 * actually buys, in every one of these, is the fruit.
 */
const OF_COUNT = /\bof\s+(\d+(?:\s+\d+\/\d+)?|\d+\/\d+)\s+([a-zA-Z][\w-]*(?:\s+[a-zA-Z][\w-]*)?)/

/**
 * Fold the two remaining ways a recipe writes an amount into the one the
 * leading-number regex can read.
 *
 * A range ("3 to 4 chicken breasts") kept only its lower bound and left "to 4
 * chicken breasts" as the item name. The upper bound is what belongs on a
 * shopping list — arriving home one chicken breast short is the failure that
 * costs someone a second trip, while an extra one keeps.
 *
 * A dual measure ("1½ cups/10 ounces basmati rice") states the same quantity
 * twice; the second was landing in the item name. The first measure wins.
 */
const NUMBER_WORDS: Record<string, string> = {
  two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  nine: '9', ten: '10', twelve: '12', dozen: '12',
}

/** The measures that are words; see UNIT_ALIASES. */
const WORD_MEASURE = /(?:pinch|handful|dash|splash|squeeze|knob|drizzle|sprinkle)(?:es|s)?\b/i

const AMOUNT = /(?:\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)/

function normalizeMeasures(input: string): string {
  const measure = AMOUNT.source
  return (
    input
      // A count that is a word. "Half a cucumber", "A pinch of saffron", "two
      // lemons", "a few sprigs" all parsed as amount 0 with the word left in
      // the item name. A size in front of a word-measure ("large pinch") is
      // not a count at all and goes.
      .replace(/^(?:an?\s+)?(?:large|small|big|generous|good|heaping|scant)\s+(?=(?:pinch|handful|dash|splash|squeeze|knob|drizzle|sprinkle)\b)/i, '')
      .replace(/^(?:an?\s+)?few\s+/i, '3 ')
      .replace(/^(?:an?\s+)?couple(?:\s+of)?\s+/i, '2 ')
      .replace(/^half\s+(?:an?\s+|of\s+an?\s+)?/i, '1/2 ')
      .replace(/^(?:an?|one)\s+(?=[a-zA-Z])/i, '1 ')
      .replace(/^(two|three|four|five|six|seven|eight|nine|ten|twelve|dozen)\s+/i, (_m, w: string) => `${NUMBER_WORDS[w.toLowerCase()] ?? w} `)
      .replace(new RegExp(`^(?=${WORD_MEASURE.source})`, 'i'), '1 ')
      // "3 to 4", "3-4", "3–4" → "4". Only at the front, where an amount lives.
      .replace(new RegExp(`^(${measure})\\s*(?:to|-|–|—|or)\\s*(${measure})(?=\\s)`, 'i'), '$2')
      // "cups/10 ounces" → "cups".
      .replace(/\b([a-zA-Z]+)\/\d+(?:\.\d+)?\s+[a-zA-Z]+\b/, '$1')
      // A second measure after "plus" is never part of the name. Right behind
      // the first one it is dropped on its own ("½ cup plus 1 tablespoon
      // neutral oil" → "½ cup neutral oil"); anywhere later it is the start
      // of a note ("3 tablespoons butter plus 1 tablespoon for tossing the
      // pasta") and the rest of the line goes with it.
      .replace(new RegExp(`^(${measure}\\s+[a-zA-Z]+)\\s+plus\\s+${measure}\\s+[a-zA-Z]+(?=\\s)`, 'i'), '$1')
      .replace(new RegExp(`\\s+plus\\s+${measure}\\s+[a-zA-Z]+\\b.*$`, 'i'), '')
  )
}

function parseFraction(s: string): number {
  const trimmed = s.trim()
  const parts = trimmed.split('/')
  if (parts.length === 2) {
    const num = Number(parts[0])
    const den = Number(parts[1])
    if (!isNaN(num) && !isNaN(den) && den !== 0) return num / den
  }
  const n = Number(trimmed)
  return isNaN(n) ? 0 : n
}

export function parseIngredient(raw: string): ParsedIngredient {
  // `raw` keeps the original text; only the working copy is normalised.
  //
  // Parentheses go first, before the amount is read. "1 (28-ounce) can whole
  // tomatoes" put the bracket between the count and its unit, so "can" was
  // never read as the unit and "can tomatoes" went on the list — as did "cans
  // cannellini or pinto beans" from every "2 (15-ounce) cans …" line.
  const s = normalizeMeasures(expandFractions(raw.trim().replace(/\(.*?\)/g, ' ')))

  // Match: leading number(s)/fraction, optional unit word, then rest
  // Uses non-greedy number match to avoid swallowing embedded measurements like "15-oz"
  const match = s.match(/^([\d\s/]+)\s*([a-zA-Z]+)?\s+(.+)$/)

  if (!match) {
    // No leading amount. Before giving up, look for the "<prep> of N <thing>"
    // shape, where the count sits in the middle of the phrase.
    const ofMatch = OF_COUNT.exec(s)
    if (ofMatch) {
      const count = (ofMatch[1] ?? '')
        .trim()
        .split(/\s+/)
        .reduce((sum, token) => sum + parseFraction(token), 0)
      const item = cleanItem(ofMatch[2] ?? '')
      if (count > 0 && item !== '') return { amount: count, unit: '', item, raw }
    }
    return { amount: 0, unit: '', item: cleanItem(s), raw }
  }

  // Groups 1 and 3 always participate when the pattern matches; the `?? ''`
  // only satisfies noUncheckedIndexedAccess.
  const amountStr = (match[1] ?? '').trim()
  const unitStr = match[2]?.toLowerCase() ?? ''
  const rest = match[3] ?? ''

  // Handle "2 1/2" style amounts (mixed number).
  //
  // The greedy run happily swallows the leading number of a *dimension*:
  // "4 1 1/4-inch-thick ... pork chops" is four chops an inch and a quarter
  // thick, not five of anything. Tokens are handed back to the item name until
  // the run no longer sits against a hyphen.
  let amountParts = amountStr.split(/\s+/).filter((t) => t !== '')
  let tail = s.slice((match[1] ?? '').length)
  while (amountParts.length > 1 && (tail.startsWith('-') || /^[\d/]+-/.test(tail.trim()))) {
    tail = `${amountParts.pop() ?? ''}${tail}`
  }

  let amount = 0
  for (const part of amountParts) {
    if (part.includes('/')) amount += parseFraction(part)
    else if (!isNaN(Number(part)) && part !== '') amount += Number(part)
  }

  // `unitStr in UNIT_ALIASES` also matches inherited Object.prototype keys, and
  // 'constructor' survives the toLowerCase(). "2 constructor eggs" therefore
  // used to return the Object constructor *function* as `unit`, which violates
  // ParsedIngredient and is silently dropped by JSON.stringify. Own keys only.
  const isKnownUnit = Object.hasOwn(UNIT_ALIASES, unitStr)
  const unit = isKnownUnit ? (UNIT_ALIASES[unitStr] ?? unitStr) : ''

  // If unitStr is not a known unit, it's part of the item name. Anything handed
  // back by the dimension guard above rejoins it too.
  const reclaimed = tail === s.slice((match[1] ?? '').length) ? '' : tail.replace(/^\s+/, '')
  const base = isKnownUnit ? rest : `${unitStr} ${rest}`
  const item = cleanItem(reclaimed === '' ? base : `${reclaimed}`)

  return { amount, unit, item, raw }
}

/** Salt descriptors that name the grind, not a different ingredient. */
const SALT_GRIND = '(?:kosher|coarse|fine|flaky|flake|sea|table|iodized)'

/**
 * Fold the many ways a recipe writes "season it" onto one name.
 *
 * The consolidator keys on the item name, so "Kosher salt and pepper", "Salt
 * and black pepper", "Salt and freshly ground black pepper" and "salt and
 * pepper" were four separate rows on one shopping list — for a thing nobody
 * needs to buy. The grind is dropped because no one shops for it separately;
 * pepper on its own line keeps its colour, since black and white pepper are
 * genuinely different purchases.
 */
function normalizeSeasoning(s: string): string {
  return (
    s
      // Strip a chain of grind words, however many, but only in front of salt.
      .replace(new RegExp(`\\b${SALT_GRIND}\\s+(?=(?:${SALT_GRIND}\\s+)*salt\\b)`, 'g'), '')
      .replace(/\bsalt and (?:black |white )?pepper\b/, 'salt and pepper')
  )
}

function cleanItem(s: string): string {
  // Order matters. Parentheses come out first: "(6-ounce) skin-on, center-cut
  // salmon fillets" has to lose its bracket before anything reasons about where
  // its commas fall.
  const withoutNotes = s.replace(/\(.*?\)/g, ' ').replace(SERVING_NOTE, '')
  const withoutPrep = dropPrepClauses(withoutNotes)
  const cleaned = withoutPrep
    .replace(FILLER_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;-]+|[\s,;-]+$/g, '')
    // "1 head of garlic", "pinch of saffron": the unit took the count, and
    // what is left of the phrase starts with the "of".
    .replace(/^of\s+/i, '')
    .replace(/\s+(?:and|or|with|plus)$/i, '')
    .trim()
    .toLowerCase()
  return normalizeSeasoning(cleaned)
}
