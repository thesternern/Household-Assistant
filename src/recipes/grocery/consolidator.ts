import type { Ingredient, GroceryItem, GroceryListData, GrocerySection } from '../types.js'
import type { FreshnessCategory } from '../types.js'
import { categorizeIngredient, isGrocerySection } from './categories.js'
import { formatAmount } from './parser.js'

export interface RecipeConsolidationInput {
  /** Recipe title, used as the provenance label on each grocery item. */
  recipe: string
  ingredients: Ingredient[]
  /** 0 = Monday … 6 = Sunday. */
  dayOfWeek: number
  /** Effective freshness — apply the freezer-friendly override before passing it in. */
  freshnessCategory: FreshnessCategory
}

function mergeQuantities(quantities: string[]): string {
  if (quantities.length === 0) return 'as needed'
  if (quantities.length === 1) return quantities[0] ?? 'as needed'

  // Try to extract leading numbers and check if units are compatible.
  //
  // The run has to cover a whole mixed number: `formatAmount` writes "1 1/2
  // cup", and taking only the first number left "1/2" sitting in the unit. Two
  // identical quantities then agreed on that bogus unit and summed their whole
  // parts, so "1 1/2 cup" twice came out as "2 1/2 cup" rather than "3 cup".
  const parts = quantities.map(q => {
    const m = q.trim().match(/^((?:\d+(?:\.\d+)?(?:\/\d+)?\s+)*\d+(?:\.\d+)?(?:\/\d+)?)\s*(.*)$/)
    if (!m) return null
    const num = (m[1] ?? '')
      .trim()
      .split(/\s+/)
      .reduce((sum, token) => {
        if (!token.includes('/')) return sum + Number(token)
        const [a, b] = token.split('/')
        const den = Number(b)
        return den === 0 ? sum : sum + Number(a) / den
      }, 0)
    return { num, rest: (m[2] ?? '').trim().toLowerCase() }
  })

  if (parts.every(p => p !== null)) {
    const units = new Set(parts.map(p => p!.rest))
    // If all have same unit (or no unit), sum them
    if (units.size <= 1) {
      const total = parts.reduce((sum, p) => sum + p!.num, 0)
      const unit = [...units][0]
      // Summing thirds gives 0.6666666666666666; nobody shops for that.
      return unit ? `${formatAmount(total)} ${unit}` : formatAmount(total)
    }
  }

  return quantities.join(' + ')
}

/**
 * A plural-insensitive key, so "lemon" and "lemons" are one line on the list.
 *
 * Only the *last* word is folded — the head noun — and only when stripping it
 * leaves something substantial. Words that merely end in "s" ("asparagus",
 * "couscous") keep their spelling, and the "-es"/"-ies" endings are handled so
 * "tomatoes" and "tomato" agree.
 *
 * This is a merge key, never a display name: the row shows whatever the first
 * recipe called it, so nothing on the list reads as though a machine stemmed it.
 */
function mergeKey(item: string): string {
  const words = item.toLowerCase().trim().split(/\s+/)
  const last = words[words.length - 1]
  if (last === undefined || last.length < 4) return item.toLowerCase().trim()

  let singular = last
  if (/[^aeiou]ies$/.test(last)) singular = `${last.slice(0, -3)}y`
  // "tomatoes", "potatoes": an -o noun pluralised with -es. Checked before the
  // generic -es rule, which would leave "tomatoe" and never meet "tomato".
  else if (/[^aeiou]oes$/.test(last)) singular = last.slice(0, -2)
  else if (/(?:ch|sh|s|x|z)es$/.test(last)) singular = last.slice(0, -2)
  else if (/[^s]s$/.test(last) && !/(?:us|is|ss)$/.test(last)) singular = last.slice(0, -1)

  if (singular.length < 3) return item.toLowerCase().trim()
  return [...words.slice(0, -1), singular].join(' ')
}

type ItemAccumulator = Map<
  string,
  { display: string; quantities: string[]; recipes: string[]; section: GrocerySection; day?: 'Thu' | 'Fri' }
>

function buildSection(
  inputs: RecipeConsolidationInput[],
  isMidweek: boolean
): ItemAccumulator {
  const byItem: ItemAccumulator = new Map()

  for (const { recipe, ingredients, dayOfWeek, freshnessCategory } of inputs) {
    // The midweek pickup is Thursday and Friday. A weekend dinner (5, 6) is
    // bought at the weekend shop like everything else; sending it to the
    // pickup would file it under "Buy Thu/Fri" with no day tag.
    const isPickupRecipe =
      freshnessCategory === 'very_perishable' && (dayOfWeek === 3 || dayOfWeek === 4)
    const dayLabel: 'Thu' | 'Fri' | undefined = dayOfWeek === 3 ? 'Thu' : dayOfWeek === 4 ? 'Fri' : undefined

    for (const ing of ingredients) {
      const display = ing.item.trim()
      const key = mergeKey(ing.item)
      // `ing.section` is typed but not validated — it round-trips through jsonb
      // from the scraper, the text parser, and model tool calls. Anything that
      // is not a real GrocerySection falls back to keyword categorization,
      // because using it as an object key below either throws (`__proto__`,
      // `constructor`, `toString` resolve to inherited members) or invents a
      // section no renderer will display.
      const section: GrocerySection = isGrocerySection(ing.section)
        ? ing.section
        : categorizeIngredient(ing.item)
      const isPickupSection = section === 'meat_seafood' || section === 'produce'
      const belongsToMidweek = isPickupRecipe && isPickupSection

      // Route this ingredient only if it matches the bucket we're building
      if (isMidweek !== belongsToMidweek) continue

      if (byItem.has(key)) {
        const existing = byItem.get(key)!
        if (ing.quantity) {
          existing.quantities.push(ing.quantity)
        }
        if (!existing.recipes.includes(recipe)) {
          existing.recipes.push(recipe)
        }
      } else {
        byItem.set(key, {
          display,
          quantities: ing.quantity ? [ing.quantity] : [],
          recipes: [recipe],
          section,
          // Only set day in the midweek accumulator
          day: isMidweek ? dayLabel : undefined,
        })
      }
    }
  }

  return byItem
}

function accumulatorToGroceryListData(acc: ItemAccumulator): GroceryListData {
  const result: GroceryListData = {}
  for (const [, { display, quantities, recipes, section, day }] of acc) {
    if (!result[section]) result[section] = []
    const quantity = mergeQuantities(quantities)
    const groceryItem: GroceryItem = { item: display, quantity, recipes }
    if (day) groceryItem.day = day
    result[section]!.push(groceryItem)
  }
  // Sort alphabetically within each section
  for (const section of Object.keys(result) as GrocerySection[]) {
    result[section]!.sort((a, b) => a.item.localeCompare(b.item))
  }
  return result
}

export function consolidateIngredients(
  inputs: RecipeConsolidationInput[]
): { weekend: GroceryListData; midweek: GroceryListData } {
  return {
    weekend: accumulatorToGroceryListData(buildSection(inputs, false)),
    midweek: accumulatorToGroceryListData(buildSection(inputs, true)),
  }
}
