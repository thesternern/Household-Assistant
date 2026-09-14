import { autoScore, detectSource } from './scraper.js'
import { formatAmount, parseIngredient } from './grocery/parser.js'
import { categorizeIngredient } from './grocery/categories.js'
import type { RecipeInput, RecipePreview, Ingredient, Difficulty } from './types.js'

/**
 * Pasted-text recipe parser, ported from the recipe-planner app.
 * Used when a site blocks scraping (`BLOCKED:`) or carries no JSON-LD (`NO_SCHEMA:`)
 * and the household pastes the page text instead.
 *
 * The text is typed or pasted by a spouse, but it usually originates from a web
 * page, so the parsed strings are still UNTRUSTED. Nothing here calls
 * `wrapUntrusted`; whoever renders a title/description/step into a model prompt
 * must wrap it first (`src/tools/untrusted.ts`).
 */

// Lines to strip outright — UI chrome, boilerplate, ads
const BOILERPLATE = [
  /^(jump to recipe|print recipe|save recipe|rate this|add to|pin it|share|follow us)/i,
  /^(subscribe|newsletter|sign up|log in|sign in|create account)/i,
  /^(advertisement|sponsored|related recipes?|you (may|might) also like)/i,
  /^[★☆✓•·–—\-]{1,5}$/, // lone symbols
  /^\d+(\.\d+)?\s*(out of\s*)?\/?5(\s*stars?)?$/i, // star ratings
  /^\(?\d+\)?\s*(ratings?|reviews?|comments?)$/i,
  /^(total time|prep time|cook time|active time|yield|serves?|servings?|difficulty|calories):\s*$/i, // label-only lines
  /^(by|from|recipe by)\s*$/i,
  /^https?:\/\//, // bare URLs
  /^\d+\s+(hours?|minutes?|mins?|hrs?)\s*\+?\s*(\d+\s+(hours?|minutes?|mins?|hrs?)\s*)?$/i, // time-only lines
]

const SECTION_HEADERS = {
  ingredients: /^(ingredients?|what you['']?ll need|you['']?ll need|shopping list)\s*:?\s*$/i,
  instructions: /^(instructions?|preparation|directions?|method|steps?|how to (make|prepare|cook))\s*:?\s*$/i,
  notes: /^(notes?|tips?|chef['']?s? notes?|make.ahead|storage)\s*:?\s*$/i,
}

function isBoilerplate(line: string): boolean {
  return BOILERPLATE.some((re) => re.test(line.trim()))
}

/** ~69 days. Above this the value is junk, and `integer` columns overflow at 2^31. */
const MAX_DURATION_MINUTES = 100_000

export function parseTime(text: string): { total?: number; active?: number } {
  const result: { total?: number; active?: number } = {}

  function toMinutes(s: string): number {
    let mins = 0
    const h = s.match(/(\d+)\s*(hours?|hrs?)/i)
    const m = s.match(/(\d+)\s*(minutes?|mins?)/i)
    if (h) mins += Number(h[1] ?? 0) * 60
    if (m) mins += Number(m[1] ?? 0)
    if (!h && !m) {
      const n = Number(s.replace(/[^\d]/g, ''))
      if (!isNaN(n) && n > 0 && n < 600) mins = n
    }
    // `4444444444444 hours` parses to Infinity / a value no int4 column can hold.
    if (!Number.isFinite(mins) || mins <= 0) return 0
    return Math.min(Math.round(mins), MAX_DURATION_MINUTES)
  }

  // "Total Time: 45 minutes" or "Time 45 minutes" (NYT style)
  const totalMatch = text.match(/(?:total\s+)?time[:\s]+(.+?)(?:\n|$)/i)
  if (totalMatch) result.total = toMinutes(totalMatch[1] ?? '')

  // "Prep Time: 15 min" and "Cook Time: 30 min"
  const prepMatch = text.match(/prep(?:\s+time)?[:\s]+(.+?)(?:\n|$)/i)
  const cookMatch = text.match(/cook(?:ing)?(?:\s+time)?[:\s]+(.+?)(?:\n|$)/i)
  if (prepMatch) result.active = toMinutes(prepMatch[1] ?? '')
  if (prepMatch && cookMatch && !result.total) {
    result.total = toMinutes(prepMatch[1] ?? '') + toMinutes(cookMatch[1] ?? '')
  }

  // "45 minutes" standalone near start of text
  if (!result.total) {
    const standalone = text.slice(0, 500).match(/\b(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/i)
    if (standalone) result.total = toMinutes(standalone[0])
  }

  return result
}

function parseServings(text: string): string | undefined {
  const m = text.match(/(?:serves?|yield|servings?|makes?)[:\s]+([^\n]+)/i)
  if (!m) return undefined
  const val = (m[1] ?? '').trim().replace(/\s+(servings?|people|portions?).*$/i, '')
  return val.slice(0, 20) || undefined
}

function parseAuthor(lines: string[]): { author?: string; authorLineIdx: number } {
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const line = lines[i]
    if (line === undefined) continue
    const m = line.match(/^(?:by|recipe by|from)[:\s]+(.+)/i)
    if (m) return { author: (m[1] ?? '').trim().replace(/\s*\|.*$/, ''), authorLineIdx: i }
  }
  return { authorLineIdx: -1 }
}

function cleanStepText(line: string): string {
  // Remove leading step numbers/labels: "1.", "Step 1:", "Step 1 —", etc.
  return line
    .replace(/^(?:step\s+)?\d+[\.\:\-\s]+/i, '')
    .replace(/^[IVX]+\.\s+/i, '') // Roman numerals
    .trim()
}

function looksLikeIngredient(line: string): boolean {
  // Starts with a number, fraction, or known quantity word
  if (/^[\d¼½¾⅓⅔⅛⅜⅝⅞]/.test(line)) return true
  if (/^(a |an |one |two |three |four |five |six |several |some |handful )/i.test(line)) return true
  // Short enough to be an ingredient (not a paragraph)
  if (line.length < 80 && line.length > 2) return true
  return false
}

export type { RecipePreview } from './types.js'

/** Back-compat alias for the name the recipe-planner original used. */
export type ParsedRecipePreview = RecipePreview

export interface RecipeTextEdits {
  title: string
  author?: string
  description?: string
  sourceUrl?: string
  source: string
  totalTimeMinutes?: number
  activeTimeMinutes?: number
  servings?: string
  difficulty: Difficulty
  imageUrl?: string
  ingredientsRaw: string
  stepsRaw: string
  tags: string[]
}

export function parseRecipeText(text: string, imageUrl?: string, sourceUrl?: string): ParsedRecipePreview {
  const rawLines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  const cleanLines = rawLines.filter((l) => !isBoilerplate(l))

  // Find title and author in the first ~10 lines
  const { author, authorLineIdx } = parseAuthor(cleanLines)
  const titleLine = cleanLines[0]
  const title = titleLine?.replace(/\s+\|.*$/, '').trim() || 'Untitled Recipe'

  // Parse times and servings from full text
  const times = parseTime(text)
  const servings = parseServings(text)

  // Split into sections
  let section: 'preamble' | 'ingredients' | 'instructions' | 'notes' = 'preamble'
  const preambleLines: string[] = []
  const ingredientLines: string[] = []
  const stepLines: string[] = []

  const skipUntilIdx = Math.max(authorLineIdx, 0)

  for (let i = skipUntilIdx + 1; i < cleanLines.length; i++) {
    const line = cleanLines[i]
    if (line === undefined) continue

    if (SECTION_HEADERS.ingredients.test(line)) {
      section = 'ingredients'
      continue
    }
    if (SECTION_HEADERS.instructions.test(line)) {
      section = 'instructions'
      continue
    }
    if (SECTION_HEADERS.notes.test(line)) {
      section = 'notes'
      continue
    }

    // Skip sub-section headers (ALL CAPS lines in ingredient section, like "FOR THE SAUCE")
    if (section === 'ingredients' && /^[A-Z\s]+$/.test(line) && line.length > 3) continue

    if (section === 'preamble') {
      // Stop collecting preamble at likely ingredient lines
      if (looksLikeIngredient(line) && preambleLines.length > 0) {
        section = 'ingredients'
        ingredientLines.push(line)
      } else if (line !== title && i !== authorLineIdx) {
        preambleLines.push(line)
      }
    } else if (section === 'ingredients') {
      ingredientLines.push(line)
    } else if (section === 'instructions') {
      const cleaned = cleanStepText(line)
      if (cleaned) stepLines.push(cleaned)
    }
    // notes section is intentionally ignored
  }

  // Build description from preamble (skip title, author, time/servings metadata)
  const metaPattern = /^(total|prep|cook|active|time|serves?|yield|servings?|difficulty|calories|rating|makes?)[:\s]/i
  const descLines = preambleLines.filter(
    (l) =>
      l !== title &&
      !metaPattern.test(l) &&
      l.length > 20, // skip short metadata fragments
  )
  const description = descLines.slice(0, 3).join(' ').slice(0, 500) || undefined

  // Consolidate steps: merge very short consecutive lines (continuation of previous step)
  const steps: string[] = []
  for (const line of stepLines) {
    const last = steps[steps.length - 1]
    if (last !== undefined && line.length < 40 && !/^[A-Z]/.test(line)) {
      steps[steps.length - 1] = last + ' ' + line
    } else {
      steps.push(line)
    }
  }

  // Auto-score using a lightweight version (ingredients are raw strings here)
  const fakeIngredients: Ingredient[] = ingredientLines.map((raw) => {
    const p = parseIngredient(raw)
    return { item: p.item || raw.toLowerCase(), quantity: '', section: categorizeIngredient(p.item || raw, p.unit) }
  })

  const scored = autoScore({
    title,
    ingredients: fakeIngredients,
    steps,
    totalTimeMinutes: times.total,
    tags: [],
  })

  return {
    title,
    author,
    description,
    sourceUrl,
    totalTimeMinutes: times.total,
    activeTimeMinutes: times.active,
    servings,
    imageUrl,
    ingredientsRaw: ingredientLines,
    stepsRaw: steps,
    familyScore: scored.familyScore,
    familyNotes: scored.familyNotes,
    difficulty: scored.difficulty,
    tags: scored.tags,
    source: detectSource(sourceUrl ?? ''),
  }
}

/**
 * Turn the (possibly human-edited) raw ingredient/step textareas into a storable
 * RecipeInput. `preview` is kept in the signature for call-site symmetry; every
 * value written comes from `edits`, which the caller seeds from the preview.
 */
export function rawStringsToRecipeInput(preview: ParsedRecipePreview, edits: RecipeTextEdits): RecipeInput {
  void preview

  const ingredientLines = edits.ingredientsRaw.split('\n').map((l) => l.trim()).filter(Boolean)
  const stepLines = edits.stepsRaw.split('\n').map((l) => l.trim()).filter(Boolean)

  const ingredients: Ingredient[] = ingredientLines.map((raw) => {
    const p = parseIngredient(raw)
    const quantity = p.amount > 0 ? `${formatAmount(p.amount)}${p.unit ? ' ' + p.unit : ''}`.trim() : p.unit || ''
    return {
      item: p.item || raw.toLowerCase(),
      quantity,
      section: categorizeIngredient(p.item || raw, p.unit),
    }
  })

  const scored = autoScore({
    title: edits.title,
    ingredients,
    steps: stepLines,
    totalTimeMinutes: edits.totalTimeMinutes,
    tags: edits.tags,
  })

  return {
    title: edits.title,
    source: edits.source,
    sourceUrl: edits.sourceUrl || `manual:${Date.now()}`,
    author: edits.author,
    description: edits.description,
    totalTimeMinutes: edits.totalTimeMinutes,
    activeTimeMinutes: edits.activeTimeMinutes,
    servings: edits.servings,
    difficulty: edits.difficulty,
    ingredients,
    steps: stepLines,
    familyScore: scored.familyScore,
    familyNotes: scored.familyNotes,
    tags: edits.tags,
    imageUrl: edits.imageUrl,
  }
}
