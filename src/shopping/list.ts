/**
 * The shopping list, and the one type at the seam.
 *
 * Producers map into `ShoppingList`; consumers map out of it. The seam is
 * deliberately the list rather than a provider interface: Amazon's flow is
 * "pick this product from these search results" and a grocery service's is
 * "here are names, you match them". Forcing both through one interface gives
 * an Amazon-shaped interface with the other faking half of it. What they
 * genuinely share is the ending — a list a human turns into a shop.
 */
import { parseIngredient } from '../recipes/grocery/parser.js'
import type { GroceryItem, GroceryListData } from '../recipes/types.js'
import { cleanText } from '../sanitize.js'

/**
 * Every string on a `ShoppingLine` is sanitised on the way in.
 *
 * A name reaches here from a scraped recipe page or from a chat message, and
 * one carrying a newline would become two rows in the paste block — an item
 * the household never asked for, sitting in their cart. `src/tools/recipes.ts`
 * has run every scraped field through the same routine since the recipe
 * library landed; the shopping list is the other end of that same text.
 *
 * The clamps are generous: `shopping_add` already caps a name at 200, and a
 * quantity or a recipe title is short by nature. They exist to stop a pasted
 * paragraph, not to edit the household's phrasing.
 */
const MAX_NAME = 200
const MAX_QUANTITY = 60
const MAX_NOTE = 120

export interface ShoppingLine {
  /** What a store matches on. Never carries provenance or a quantity. */
  name: string
  /** Omitted whenever the source text will not parse to a single number. */
  quantity?: number
  unit?: string
  /** The original human phrasing, kept whether or not it parsed. */
  displayText?: string
  /** Which recipe wanted it. For the household's eyes only. */
  note?: string
}

export interface ShoppingList {
  title: string
  lines: ShoppingLine[]
}

/**
 * A quantity is only structured when the whole string is one amount and unit.
 *
 * `parseIngredient` is lenient by design — it is built to rescue something from
 * a messy recipe line — so its output is checked here rather than trusted. A
 * compound like "2 lb + 3 cups" would otherwise silently become 2 lb, and the
 * household would find out at the till.
 */
function structuredQuantity(text: string): { quantity: number; unit: string } | null {
  const trimmed = text.trim()
  if (trimmed === '') return null

  // One number, then at most one unit word. Anything else — a '+', a range,
  // "as needed" — is not a structured quantity and degrades to the name alone.
  const shape = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(trimmed)
  if (!shape) return null

  // The number is read here rather than from `parseIngredient`, which returns 0
  // for a decimal — "1.5 lb carrots" used to lose its quantity entirely.
  const quantity = Number(shape[1])
  if (!Number.isFinite(quantity) || quantity <= 0) return null

  const rawUnit = shape[2] ?? ''
  if (rawUnit === '') return { quantity, unit: '' }

  /*
   * `parseIngredient` normalises the units a recipe uses — "pounds" to "lb" —
   * but its table is a recipe vocabulary, not the whole language. It does not
   * know "L" or "box", and for those it returned the number with an empty
   * unit, so "2 L" of stock became "2 chicken stock": two cartons, on a list
   * someone shops from.
   *
   * A unit it does not recognise is kept verbatim instead. "2 L chicken stock"
   * and "1 box dishwasher pods" are both correct and both shoppable; the only
   * unacceptable outcome is the number surviving without them.
   */
  const normalised = parseIngredient(`1 ${rawUnit} x`).unit
  return { quantity, unit: normalised === '' ? rawUnit : normalised }
}

/** One grocery item becomes one shopping line, sanitised. */
export function lineFromGroceryItem(item: GroceryItem): ShoppingLine {
  const name = cleanText(item.item, MAX_NAME)
  const quantityText = cleanText(item.quantity, MAX_QUANTITY)
  const line: ShoppingLine = { name }

  if (quantityText !== '') {
    line.displayText = quantityText
    const structured = structuredQuantity(quantityText)
    if (structured) {
      line.quantity = structured.quantity
      if (structured.unit !== '') line.unit = cleanText(structured.unit, 20)
    }
  }

  const recipe = cleanText(item.recipes?.[0], MAX_NOTE)
  if (recipe !== '') line.note = recipe

  return line
}

/** Every section, flattened in order. Section headers do not survive. */
export function groceryDataToLines(data: GroceryListData): ShoppingLine[] {
  const lines: ShoppingLine[] = []
  for (const items of Object.values(data)) {
    for (const item of items ?? []) {
      const line = lineFromGroceryItem(item)
      // A name that sanitises away to nothing is not an item a store can match.
      if (line.name === '') continue
      lines.push(line)
    }
  }
  return lines
}
