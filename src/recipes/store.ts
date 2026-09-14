/**
 * Recipe + meal-plan storage on Postgres (Drizzle).
 *
 * This replaces the recipe-planner's SQLite Express routes. The planning
 * algorithms — protein/style/cuisine variety scoring, freshness-ordered day
 * assignment, grocery consolidation and the weekend/midweek split — are ported
 * from `plans-routes.ts` and `grocery-routes.ts`; only the storage layer and
 * the field naming changed.
 */
import { isPrivateHost } from '../net/public-host.js'
import { DateTime } from 'luxon'
import { and, asc, desc, eq, gte, ilike, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { getConfig } from '../config.js'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { dinnerCandidates } from './protein.js'
import { consolidateIngredients } from './grocery/consolidator.js'
import type { RecipeConsolidationInput } from './grocery/consolidator.js'
import { anthropicModelCall, refineGroceryList, sourceHash, storedRefinement } from './grocery/refine.js'
import {
  CUISINE_KEYWORDS,
  classifyCuisine,
  classifyFreshness,
  compareFreshness,
  detectFrozenIngredients,
  effectiveFreshness,
} from './grocery/freshness.js'
import { fetchAndParseRecipe } from './scraper.js'
import type {
  Difficulty,
  FreshnessCategory,
  GroceryItem,
  GroceryListData,
  GroceryListResponse,
  GrocerySection,
  Ingredient,
  MealPlan,
  MealPlanItem,
  Recipe,
  RecipeInput,
} from './types.js'

type RecipeRow = typeof schema.recipes.$inferSelect
type MealPlanRow = typeof schema.mealPlans.$inferSelect
type MealPlanItemRow = typeof schema.mealPlanItems.$inferSelect

/** Weeknight dinner slots the planner fills: Mon(0) … Fri(4). */
const WEEKNIGHT_DAYS = [0, 1, 2, 3, 4] as const

/* ────────────────────────────── row → domain ─────────────────────────────── */
// jsonb columns come back as `unknown`. These narrow them and shrug off
// anything malformed rather than throwing mid-request.

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
    } catch {
      return []
    }
  }
  return []
}

const FRESHNESS_CATEGORIES: ReadonlySet<string> = new Set<FreshnessCategory>([
  'very_perishable',
  'perishable',
  'moderate',
  'shelf_stable',
])

/**
 * `recipes.freshness_category` is a plain `text` column with no CHECK
 * constraint, and `compareFreshness` indexes a score table with it. An
 * unrecognised value would index to `undefined` and make the autofill sort
 * comparator return NaN, which scrambles the whole week's day assignment. The
 * SQLite original defended against this with a `?? 3` fallback; this restores
 * it at the boundary instead, so nothing downstream has to.
 */
function normalizeFreshness(value: unknown): FreshnessCategory {
  return typeof value === 'string' && FRESHNESS_CATEGORIES.has(value)
    ? (value as FreshnessCategory)
    : 'moderate'
}

/**
 * Tags are the search key (`searchRecipes` lowercases what it is asked for) and
 * the style/cuisine key for the variety scorer, which matches lowercase
 * literals. Store them lowercased, trimmed and deduped so a tag written as
 * `"Italian"` is still findable.
 */
function normalizeTags(tags: readonly unknown[]): string[] {
  const out: string[] = []
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const tag = raw.toLowerCase().trim()
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out
}

/** ILIKE pattern with the caller's wildcards neutralised. */
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`
}

function asIngredients(value: unknown): Ingredient[] {
  let raw: unknown = value
  if (typeof value === 'string') {
    try {
      raw = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(raw)) return []

  const out: Ingredient[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const o = entry as Record<string, unknown>
    if (typeof o['item'] !== 'string') continue
    const ing: Ingredient = {
      item: o['item'],
      quantity: typeof o['quantity'] === 'string' ? o['quantity'] : '',
    }
    if (typeof o['section'] === 'string') ing.section = o['section'] as GrocerySection
    out.push(ing)
  }
  return out
}

function toRecipe(row: RecipeRow): Recipe {
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    sourceUrl: row.sourceUrl,
    author: row.author,
    description: row.description,
    totalTimeMinutes: row.totalTimeMinutes,
    activeTimeMinutes: row.activeTimeMinutes,
    servings: row.servings,
    difficulty: row.difficulty as Difficulty | null,
    ingredients: asIngredients(row.ingredients),
    steps: asStringArray(row.steps),
    familyScore: row.familyScore,
    familyNotes: row.familyNotes,
    tags: asStringArray(row.tags),
    groceryCategories:
      (row.groceryCategories as Partial<Record<GrocerySection, string[]>> | null) ?? null,
    imageUrl: row.imageUrl,
    scrapedAt: row.scrapedAt,
    timesPlanned: row.timesPlanned,
    lastPlannedDate: row.lastPlannedDate,
    isArchived: row.isArchived,
    freshnessCategory: normalizeFreshness(row.freshnessCategory),
    freezerFriendly: row.freezerFriendly,
  }
}

function toMealPlan(row: MealPlanRow, items?: MealPlanItem[]): MealPlan {
  const plan: MealPlan = {
    id: row.id,
    weekStart: row.weekStart,
    notes: row.notes,
    createdAt: row.createdAt,
  }
  if (items) plan.items = items
  return plan
}

function toMealPlanItem(row: MealPlanItemRow, recipe?: Recipe): MealPlanItem {
  const item: MealPlanItem = {
    id: row.id,
    planId: row.planId,
    recipeId: row.recipeId,
    dayOfWeek: row.dayOfWeek,
    mealType: row.mealType,
    servingsOverride: row.servingsOverride,
    notes: row.notes,
  }
  if (recipe) item.recipe = recipe
  return item
}

/**
 * Today in the household timezone, as `yyyy-MM-dd`.
 *
 * `HOUSEHOLD_TIMEZONE` is an unvalidated string in the config schema. A typo
 * there would otherwise write the literal `"Invalid DateTime"` into
 * `recipes.last_planned_date` and corrupt the rotation ordering, so fall back
 * to the process zone with a loud log — the same guard
 * `src/policy/engine.ts` uses for the spend window.
 */
function householdToday(): string {
  const zone = getConfig().HOUSEHOLD_TIMEZONE
  let now = DateTime.now().setZone(zone)
  if (!now.isValid) {
    logger.error(
      { zone, reason: now.invalidReason },
      'invalid HOUSEHOLD_TIMEZONE, using the process zone for last_planned_date',
    )
    now = DateTime.now()
  }
  return now.toFormat('yyyy-MM-dd')
}

/**
 * Canonicalise a plan's week key to the ISO Monday of that week.
 *
 * `meal_plans.week_start` is a bare text column and the one-plan-per-week
 * invariant is enforced in code, so `'2026-09-02'` (a Wednesday) and
 * `'2026-08-31'` (its Monday) must not become two plans for the same week —
 * and `getPlanByWeek` must find the plan whichever day the caller names.
 * Throws on anything that is not an ISO date so a malformed key never reaches
 * the table.
 */
function normalizeWeekStart(weekStart: string): string {
  const raw = typeof weekStart === 'string' ? weekStart.trim() : ''
  const parsed = DateTime.fromISO(raw, { zone: 'utc' })
  if (!parsed.isValid) {
    throw new Error(`Invalid weekStart "${weekStart}" — expected an ISO date such as 2026-08-31`)
  }
  return parsed.startOf('week').toFormat('yyyy-MM-dd')
}

/* ─────────────────────────────── recipe reads ────────────────────────────── */

export interface RecipeSearchFilters {
  /** Every tag listed must be present on the recipe (jsonb containment). */
  tags?: string[]
  minScore?: number
  difficulty?: string
  cuisine?: string
  freezerFriendly?: boolean
  /** Free text matched against title, description and ingredient text. */
  query?: string
  limit?: number
}

/** Best-rated first. Archived recipes are never returned. */
export async function searchRecipes(filters: RecipeSearchFilters = {}): Promise<Recipe[]> {
  const db = getDb()
  const conds: SQL[] = [eq(schema.recipes.isArchived, false)]

  if (filters.tags && filters.tags.length > 0) {
    const wanted = filters.tags.map((t) => t.toLowerCase().trim()).filter(Boolean)
    if (wanted.length > 0) {
      conds.push(sql`${schema.recipes.tags} @> ${JSON.stringify(wanted)}::jsonb`)
    }
  }

  if (typeof filters.minScore === 'number') {
    conds.push(gte(schema.recipes.familyScore, filters.minScore))
  }

  if (filters.difficulty) {
    conds.push(eq(schema.recipes.difficulty, filters.difficulty.toLowerCase().trim()))
  }

  if (filters.cuisine) {
    const cuisine = filters.cuisine.toLowerCase().trim()
    const like = likePattern(cuisine)
    const cuisineMatch = or(
      sql`${schema.recipes.tags} @> ${JSON.stringify([cuisine])}::jsonb`,
      ilike(schema.recipes.title, like),
      ilike(schema.recipes.description, like),
    )
    if (cuisineMatch) conds.push(cuisineMatch)
  }

  if (typeof filters.freezerFriendly === 'boolean') {
    conds.push(eq(schema.recipes.freezerFriendly, filters.freezerFriendly))
  }

  if (filters.query && filters.query.trim()) {
    const like = likePattern(filters.query.trim())
    const textMatch = or(
      ilike(schema.recipes.title, like),
      ilike(schema.recipes.description, like),
      sql`${schema.recipes.ingredients}::text ILIKE ${like}`,
    )
    if (textMatch) conds.push(textMatch)
  }

  const limit = Math.min(Math.max(1, filters.limit ?? 20), 100)

  const rows = await db
    .select()
    .from(schema.recipes)
    .where(and(...conds))
    .orderBy(sql`${schema.recipes.familyScore} DESC NULLS LAST`, asc(schema.recipes.title))
    .limit(limit)

  return rows.map(toRecipe)
}

export async function getRecipe(id: number): Promise<Recipe | undefined> {
  const db = getDb()
  const rows = await db.select().from(schema.recipes).where(eq(schema.recipes.id, id)).limit(1)
  const row = rows[0]
  return row ? toRecipe(row) : undefined
}

/* ────────────────────────────── recipe writes ────────────────────────────── */

/**
 * Fill in the derived fields the planner depends on: freshness (which drives
 * both the weekend/midweek grocery split and the day ordering), freezer
 * friendliness, and a cuisine tag for the variety scorer. Values already on the
 * input win — a human classification is never overwritten by a guess.
 */
function applyClassifiers(input: RecipeInput): RecipeInput {
  const ingredients = input.ingredients ?? []
  const tags = normalizeTags(input.tags ?? [])

  const cuisine = classifyCuisine(input.title ?? '', input.description ?? '', tags)
  if (cuisine && !tags.includes(cuisine)) tags.push(cuisine)

  return {
    ...input,
    tags,
    freshnessCategory: normalizeFreshness(input.freshnessCategory ?? classifyFreshness(ingredients)),
    freezerFriendly: input.freezerFriendly ?? detectFrozenIngredients(ingredients),
  }
}

function fallbackSourceUrl(title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'recipe'
  return `manual:${slug}-${Date.now()}`
}

/**
 * Insert or update a recipe keyed on `sourceUrl`.
 *
 * On conflict only the scraped content is refreshed. `familyScore`,
 * `familyNotes`, `timesPlanned`, `lastPlannedDate` and `isArchived` are left
 * alone, so re-importing a page never wipes a family rating or the rotation
 * history. Use `rateRecipe` to change a score.
 */
export async function saveParsedRecipe(
  input: RecipeInput,
): Promise<{ id: number; created: boolean; title: string }> {
  const title = (input.title ?? '').trim()
  if (!title) throw new Error('Recipe is missing a title')

  const classified = applyClassifiers(input)
  const sourceUrl = (classified.sourceUrl ?? '').trim() || fallbackSourceUrl(title)
  const db = getDb()

  const existing = await db
    .select({ id: schema.recipes.id })
    .from(schema.recipes)
    .where(eq(schema.recipes.sourceUrl, sourceUrl))
    .limit(1)
  const created = existing.length === 0

  const content = {
    title,
    source: classified.source || 'manual',
    author: classified.author ?? null,
    description: classified.description ?? null,
    totalTimeMinutes: classified.totalTimeMinutes ?? null,
    activeTimeMinutes: classified.activeTimeMinutes ?? null,
    servings: classified.servings ?? null,
    difficulty: classified.difficulty ?? null,
    ingredients: classified.ingredients ?? [],
    steps: classified.steps ?? [],
    tags: classified.tags ?? [],
    groceryCategories: classified.groceryCategories ?? null,
    imageUrl: classified.imageUrl ?? null,
    freshnessCategory: normalizeFreshness(classified.freshnessCategory),
    freezerFriendly: classified.freezerFriendly ?? false,
    scrapedAt: new Date(),
  }

  const rows = await db
    .insert(schema.recipes)
    .values({
      ...content,
      sourceUrl,
      familyScore: classified.familyScore ?? null,
      familyNotes: classified.familyNotes ?? null,
    })
    .onConflictDoUpdate({ target: schema.recipes.sourceUrl, set: content })
    .returning({ id: schema.recipes.id, title: schema.recipes.title })

  const row = rows[0]
  if (!row) throw new Error(`Failed to save recipe "${title}"`)
  logger.debug({ recipeId: row.id, created, sourceUrl }, 'recipe saved')
  return { id: row.id, created, title: row.title }
}

/**
 * Is this host a loopback / private / link-local target we must never fetch?
 *
 * `recipe_write` is an `allow` category, so the model reaches
 * `upsertRecipeFromUrl` with an arbitrary URL and no human in the loop. Without
 * this, "import the recipe at http://169.254.169.254/latest/meta-data/" is a
 * server-side request forgery against cloud metadata, and `http://localhost:<p>`
 * is a port scan of everything else running on the box.
 *
 * Node's URL parser canonicalises decimal/octal/hex IPv4 forms
 * (`http://2130706433/` → `127.0.0.1`), so the dotted-quad check below is not
 * bypassable that way. It does NOT cover a public hostname whose DNS resolves
 * to a private address, nor a public page that 302s to one — the scraper
 * fetches with `redirect: 'follow'`. Closing those needs a redirect-checking
 * fetch in `src/recipes/scraper.ts`.
 */
/** Reject anything the scraper must not be pointed at, before it hits the network. */
function assertFetchableUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid recipe URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing to import from a non-HTTP URL (${parsed.protocol}//…)`)
  }
  if (parsed.username || parsed.password) {
    throw new Error('Refusing to import from a URL that carries credentials')
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error(`Refusing to import from a private or loopback address: ${parsed.hostname}`)
  }
}

/** Scrape a recipe page, classify it, then upsert on the `sourceUrl` conflict. */
export async function upsertRecipeFromUrl(
  url: string,
): Promise<{ id: number; created: boolean; title: string }> {
  assertFetchableUrl(url)
  const parsed = await fetchAndParseRecipe(url)
  // saveParsedRecipe runs applyClassifiers: freshness, freezer, cuisine tag.
  const saved = await saveParsedRecipe({ ...parsed, sourceUrl: parsed.sourceUrl || url })
  logger.info({ url, recipeId: saved.id, created: saved.created }, 'recipe imported from url')
  return saved
}

/** Record the family verdict. Scores clamp to 1–10. */
export async function rateRecipe(id: number, familyScore: number, notes?: string): Promise<void> {
  // Clamping NaN yields NaN, which the pg driver hands to an integer column and
  // Postgres rejects with a syntax error. Fail with a sentence the tool layer
  // can show instead.
  if (!Number.isFinite(familyScore)) {
    throw new Error(`Invalid family score "${familyScore}" — expected a number from 1 to 10`)
  }
  const score = Math.round(Math.max(1, Math.min(10, familyScore)))
  const db = getDb()
  const set: { familyScore: number; familyNotes?: string } = { familyScore: score }
  if (notes !== undefined) set.familyNotes = notes

  const rows = await db
    .update(schema.recipes)
    .set(set)
    .where(eq(schema.recipes.id, id))
    .returning({ id: schema.recipes.id })

  if (rows.length === 0) throw new Error(`Recipe ${id} not found`)
  logger.info({ recipeId: id, familyScore: score }, 'recipe rated')
}

/* ──────────────────────────────── meal plans ─────────────────────────────── */

async function loadPlanItems(planId: number): Promise<MealPlanItem[]> {
  const db = getDb()
  const rows = await db
    .select({ item: schema.mealPlanItems, recipe: schema.recipes })
    .from(schema.mealPlanItems)
    .innerJoin(schema.recipes, eq(schema.recipes.id, schema.mealPlanItems.recipeId))
    .where(eq(schema.mealPlanItems.planId, planId))
    .orderBy(asc(schema.mealPlanItems.dayOfWeek), asc(schema.mealPlanItems.mealType))

  return rows.map((r) => toMealPlanItem(r.item, toRecipe(r.recipe)))
}

/**
 * Create the plan for a week, or return the one that already exists.
 *
 * One plan per week is the invariant the rest of this module assumes —
 * `getPlanByWeek` has no way to disambiguate duplicates — so a second call for
 * the same `weekStart` reuses the existing plan and only updates its notes.
 * The key is snapped to that week's Monday first, so naming any day of the week
 * reaches the same plan. Throws on a `weekStart` that is not an ISO date.
 */
export async function createPlan(weekStartInput: string, notes?: string): Promise<MealPlan> {
  const weekStart = normalizeWeekStart(weekStartInput)
  const db = getDb()
  const existing = await db
    .select()
    .from(schema.mealPlans)
    .where(eq(schema.mealPlans.weekStart, weekStart))
    .orderBy(asc(schema.mealPlans.id))
    .limit(1)

  const found = existing[0]
  if (found) {
    let row: MealPlanRow = found
    if (notes !== undefined && notes !== found.notes) {
      const updated = await db
        .update(schema.mealPlans)
        .set({ notes })
        .where(eq(schema.mealPlans.id, found.id))
        .returning()
      row = updated[0] ?? found
    }
    return toMealPlan(row, await loadPlanItems(row.id))
  }

  const inserted = await db
    .insert(schema.mealPlans)
    .values({ weekStart, notes: notes ?? null })
    .returning()
  const row = inserted[0]
  if (!row) throw new Error(`Failed to create meal plan for week ${weekStart}`)
  logger.info({ planId: row.id, weekStart }, 'meal plan created')
  return toMealPlan(row, [])
}

/** The plan and its items, each item carrying its full recipe. */
export async function getPlan(id: number): Promise<MealPlan | undefined> {
  const db = getDb()
  const rows = await db.select().from(schema.mealPlans).where(eq(schema.mealPlans.id, id)).limit(1)
  const row = rows[0]
  if (!row) return undefined
  return toMealPlan(row, await loadPlanItems(row.id))
}

/** Snaps `weekStart` to that week's Monday, matching `createPlan`. */
export async function getPlanByWeek(weekStartInput: string): Promise<MealPlan | undefined> {
  const weekStart = normalizeWeekStart(weekStartInput)
  const db = getDb()
  const rows = await db
    .select()
    .from(schema.mealPlans)
    .where(eq(schema.mealPlans.weekStart, weekStart))
    .orderBy(asc(schema.mealPlans.id))
    .limit(1)
  const row = rows[0]
  if (!row) return undefined
  return toMealPlan(row, await loadPlanItems(row.id))
}

/**
 * Put a recipe on a day. Replaces whatever held that slot.
 *
 * `meal_plan_items.plan_id` and `recipe_id` carry no foreign keys, so a bad id
 * would otherwise insert silently: `loadPlanItems` inner-joins `recipes`, so an
 * item pointing at a nonexistent recipe never appears in `getPlan` — yet it
 * still occupies the slot, keeps `autofillPlan` from filling that night, and
 * can never be removed because its id is never surfaced. Check first, and
 * throw in the same style as `autofillPlan` / `rateRecipe`.
 */
export async function addPlanItem(
  planId: number,
  recipeId: number,
  dayOfWeek: number,
  mealType = 'dinner',
): Promise<void> {
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    throw new Error(`Invalid dayOfWeek ${dayOfWeek} — expected 0 (Monday) through 6 (Sunday)`)
  }
  const meal = mealType.trim() || 'dinner'
  const db = getDb()

  const planRows = await db
    .select({ id: schema.mealPlans.id })
    .from(schema.mealPlans)
    .where(eq(schema.mealPlans.id, planId))
    .limit(1)
  if (!planRows[0]) throw new Error(`Meal plan ${planId} not found`)

  const recipeRows = await db
    .select({ id: schema.recipes.id })
    .from(schema.recipes)
    .where(eq(schema.recipes.id, recipeId))
    .limit(1)
  if (!recipeRows[0]) throw new Error(`Recipe ${recipeId} not found`)

  await db
    .insert(schema.mealPlanItems)
    .values({ planId, recipeId, dayOfWeek, mealType: meal })
    .onConflictDoUpdate({
      target: [
        schema.mealPlanItems.planId,
        schema.mealPlanItems.dayOfWeek,
        schema.mealPlanItems.mealType,
      ],
      set: { recipeId },
    })
}

export async function removePlanItem(planId: number, itemId: number): Promise<void> {
  const db = getDb()
  await db
    .delete(schema.mealPlanItems)
    .where(and(eq(schema.mealPlanItems.id, itemId), eq(schema.mealPlanItems.planId, planId)))
}

/* ──────────────────────── variety selection (pure core) ──────────────────── */

/**
 * The slice of a recipe the variety scorer reads. `Recipe` satisfies this
 * structurally, so `autofillPlan` hands it whole recipe rows.
 */
export interface VarietyCandidate {
  id: number
  title: string
  tags: string[]
  totalTimeMinutes?: number | null
  freshnessCategory?: FreshnessCategory | null
  freezerFriendly?: boolean | null
}

function detectProtein(title: string, tags: string[]): string {
  const text = `${title} ${tags.join(' ')}`.toLowerCase()
  if (/\bchicken\b/.test(text)) return 'chicken'
  if (/\bbeef\b|\bsteak\b|\bground beef\b/.test(text)) return 'beef'
  if (/\bpork\b|\bsausage\b|\bbacon\b/.test(text)) return 'pork'
  if (/\bfish\b|\bsalmon\b|\bshrimp\b|\bseafood\b|\bcod\b/.test(text)) return 'seafood'
  if (/\bpasta\b|\bnoodle\b/.test(text)) return 'pasta'
  if (/\btofu\b|\blentil\b|\bchickpea\b|\bbean\b/.test(text)) return 'vegetarian'
  return 'other'
}

function detectStyle(tags: string[]): string {
  for (const s of ['sheet-pan', 'one-pot', 'slow-cooker', 'stir-fry', 'pasta', 'soup-stew']) {
    if (tags.includes(s)) return s
  }
  return 'other'
}

function detectCuisine(tags: string[]): string {
  for (const tag of tags) {
    const lower = tag.toLowerCase()
    if (['italian', 'asian', 'mexican', 'mediterranean', 'american'].includes(lower)) return lower
    for (const [group, keywords] of Object.entries(CUISINE_KEYWORDS)) {
      if (keywords.includes(lower)) return group
    }
  }
  return 'other'
}

/**
 * Pick `slotsNeeded` recipes for the week, penalising repeated protein, style
 * and cuisine, then order them most-perishable-first so the fish gets cooked on
 * Monday and the freezer-friendly chilli waits until Friday.
 *
 * Candidates must arrive pre-ranked — fewest times planned, least recently
 * planned, best family score. The scorer walks them in that order and takes the
 * first that does not blow a diversity cap, so ranking is the tie-breaker
 * throughout.
 *
 * The caps relax in rungs until the week fills:
 * `1/2/2 → 2/2/2 → 2/2/3 → 3/3/3 → anything left`.
 * The 2/2/2 rung and below are the original recipe-planner ladder. The 1/2/2
 * rung is one deliberate tightening: it fires only when a fully
 * protein-distinct week is reachable, so it can raise variety, never lower it.
 */
export function selectVarietyRecipes<T extends VarietyCandidate>(
  candidates: readonly T[],
  slotsNeededInput: number,
  alreadyUsedRecipeIds: Iterable<number> = [],
): T[] {
  // A NaN slot count would make every `selected.length >= slotsNeeded` test
  // false, so the first rung would "succeed" holding the entire candidate pool.
  if (!Number.isFinite(slotsNeededInput)) return []
  const slotsNeeded = Math.floor(slotsNeededInput)
  if (slotsNeeded <= 0) return []
  const used = new Set<number>(alreadyUsedRecipeIds)

  function trySelect(maxProtein: number, maxStyle: number, maxCuisine: number): T[] {
    const selected: T[] = []
    const proteinCounts: Record<string, number> = {}
    const styleCounts: Record<string, number> = {}
    const cuisineCounts: Record<string, number> = {}
    let longCookCount = 0

    for (const r of candidates) {
      if (selected.length >= slotsNeeded) break
      if (used.has(r.id)) continue

      const protein = detectProtein(r.title, r.tags)
      const style = detectStyle(r.tags)
      const cuisine = detectCuisine(r.tags)

      if ((proteinCounts[protein] ?? 0) >= maxProtein) continue
      if ((styleCounts[style] ?? 0) >= maxStyle) continue
      if ((cuisineCounts[cuisine] ?? 0) >= maxCuisine) continue
      // No more than three long cooks in one week.
      if (longCookCount >= 3 && (r.totalTimeMinutes ?? 0) > 45) continue

      selected.push(r)
      proteinCounts[protein] = (proteinCounts[protein] ?? 0) + 1
      styleCounts[style] = (styleCounts[style] ?? 0) + 1
      cuisineCounts[cuisine] = (cuisineCounts[cuisine] ?? 0) + 1
      if ((r.totalTimeMinutes ?? 0) > 45) longCookCount++
    }
    return selected
  }

  let selected = trySelect(1, 2, 2)
  if (selected.length < slotsNeeded) selected = trySelect(2, 2, 2)
  // Relax cuisine only, preserving protein and style diversity.
  if (selected.length < slotsNeeded) selected = trySelect(2, 2, 3)
  if (selected.length < slotsNeeded) selected = trySelect(3, 3, 3)
  // Last resort: anything not already on the plan.
  if (selected.length < slotsNeeded) {
    selected = candidates.filter((r) => !used.has(r.id)).slice(0, slotsNeeded)
  }

  // Most perishable first → earliest free day. Array#sort is stable, so
  // equal-freshness recipes keep their ranking order.
  return [...selected].sort((a, b) =>
    compareFreshness(
      { freshnessCategory: a.freshnessCategory, freezerFriendly: a.freezerFriendly },
      { freshnessCategory: b.freshnessCategory, freezerFriendly: b.freezerFriendly },
    ),
  )
}

/* ─────────────────────────────────  autofill  ────────────────────────────── */

/**
 * Fill the plan's empty weeknight dinner slots.
 *
 * Returns only the items autofill added, most perishable first; call `getPlan`
 * for the whole week. Days already holding a dinner are left untouched, and the
 * recipes on them are excluded from the candidate pool.
 */
export async function autofillPlan(
  planId: number,
  opts?: { slots?: number },
): Promise<MealPlanItem[]> {
  const db = getDb()

  const planRows = await db
    .select({ id: schema.mealPlans.id })
    .from(schema.mealPlans)
    .where(eq(schema.mealPlans.id, planId))
    .limit(1)
  if (!planRows[0]) throw new Error(`Meal plan ${planId} not found`)

  const existing = await db
    .select({
      dayOfWeek: schema.mealPlanItems.dayOfWeek,
      recipeId: schema.mealPlanItems.recipeId,
    })
    .from(schema.mealPlanItems)
    .where(eq(schema.mealPlanItems.planId, planId))

  const filledDays = new Set(existing.map((i) => i.dayOfWeek))
  const usedRecipeIds = new Set(existing.map((i) => i.recipeId))
  const freeDays = WEEKNIGHT_DAYS.filter((d) => !filledDays.has(d))
  const requested = opts?.slots
  const asked =
    typeof requested === 'number' && Number.isFinite(requested)
      ? Math.floor(requested)
      : freeDays.length
  const slotsNeeded = Math.max(0, Math.min(asked, freeDays.length))
  if (slotsNeeded === 0) return []

  // Pre-ranked: least planned, least recently planned, best rated.
  const candidateRows = await db
    .select()
    .from(schema.recipes)
    .where(and(eq(schema.recipes.isArchived, false), gte(schema.recipes.familyScore, 6)))
    .orderBy(
      asc(schema.recipes.timesPlanned),
      sql`${schema.recipes.lastPlannedDate} ASC NULLS FIRST`,
      sql`${schema.recipes.familyScore} DESC NULLS LAST`,
    )

  // Sides, sauces and puddings live in the same table as the mains, and the
  // variety scorer has no way to tell them apart — it reads titles and tags.
  // Filtering on the ingredients first is what stops "Arugula Salad with Lime
  // Vinaigrette" winning a Tuesday because it happens to be well rated and
  // has not been cooked lately.
  const mains = dinnerCandidates(candidateRows.map(toRecipe))
  if (mains.length === 0) {
    logger.warn(
      { planId, slotsNeeded, candidates: candidateRows.length },
      'autofill found no recipes carrying a main protein',
    )
    return []
  }

  const selected = selectVarietyRecipes(mains, slotsNeeded, usedRecipeIds)
  if (selected.length === 0) {
    logger.warn({ planId, slotsNeeded }, 'autofill found no eligible recipes')
    return []
  }

  const today = householdToday()

  const inserted = await db.transaction(async (tx) => {
    const rows: MealPlanItem[] = []
    for (let i = 0; i < selected.length && i < freeDays.length; i++) {
      const recipe = selected[i]
      const day = freeDays[i]
      if (!recipe || day === undefined) continue

      const itemRows = await tx
        .insert(schema.mealPlanItems)
        .values({ planId, recipeId: recipe.id, dayOfWeek: day, mealType: 'dinner' })
        .onConflictDoUpdate({
          target: [
            schema.mealPlanItems.planId,
            schema.mealPlanItems.dayOfWeek,
            schema.mealPlanItems.mealType,
          ],
          set: { recipeId: recipe.id },
        })
        .returning()

      const itemRow = itemRows[0]
      if (itemRow) rows.push(toMealPlanItem(itemRow, recipe))

      await tx
        .update(schema.recipes)
        .set({
          timesPlanned: sql`${schema.recipes.timesPlanned} + 1`,
          lastPlannedDate: today,
        })
        .where(eq(schema.recipes.id, recipe.id))
    }
    return rows
  })

  logger.info({ planId, filled: inserted.length }, 'meal plan autofilled')
  return inserted
}

/* ────────────────────────────── grocery list ─────────────────────────────── */

/**
 * Regenerate the grocery list for a plan and persist it.
 *
 * The list is always rebuilt from the plan's current items, so editing the week
 * and re-asking gives an honest list. Checked-off items survive the rebuild —
 * regenerating mid-shop must not empty the trolley.
 *
 * Very perishable recipes cooked Thursday or Friday move their meat and produce
 * into `midweekItems`, a second short shop; everything else is the weekend run.
 */
export async function generateGroceryList(planId: number): Promise<GroceryListResponse> {
  const db = getDb()

  const rows = await db
    .select({
      title: schema.recipes.title,
      ingredients: schema.recipes.ingredients,
      freshnessCategory: schema.recipes.freshnessCategory,
      freezerFriendly: schema.recipes.freezerFriendly,
      dayOfWeek: schema.mealPlanItems.dayOfWeek,
    })
    .from(schema.mealPlanItems)
    .innerJoin(schema.recipes, eq(schema.recipes.id, schema.mealPlanItems.recipeId))
    .where(eq(schema.mealPlanItems.planId, planId))

  if (rows.length === 0) {
    await db.delete(schema.groceryLists).where(eq(schema.groceryLists.planId, planId))
    return { weekendItems: {}, midweekItems: {}, hasMidweek: false, checkedItems: [] }
  }

  const inputs: RecipeConsolidationInput[] = rows.map((row) => ({
    recipe: row.title,
    ingredients: asIngredients(row.ingredients),
    dayOfWeek: row.dayOfWeek,
    // The freezer-friendly override is applied at read time; the raw category
    // stays in the database.
    freshnessCategory: effectiveFreshness(
      normalizeFreshness(row.freshnessCategory),
      row.freezerFriendly,
    ),
  }))

  const raw = consolidateIngredients(inputs)

  // The Claude pass, or the copy of it saved with the last list when the rows
  // have not changed since — a tap on the grocery card must not pay for a
  // model call every time. Read without a lock: the worst a race costs is one
  // extra call, and the lock below is held only for the write.
  const hash = sourceHash(raw)
  const last = await db
    .select({ sourceHash: schema.groceryLists.sourceHash, refined: schema.groceryLists.refined })
    .from(schema.groceryLists)
    .where(eq(schema.groceryLists.planId, planId))
    .orderBy(desc(schema.groceryLists.id))
    .limit(1)
  let refinedLists = storedRefinement(last[0], hash)
  let refined = true
  if (refinedLists === null) {
    const result = await refineGroceryList(raw, { model: anthropicModelCall() })
    refinedLists = { weekend: result.weekend, midweek: result.midweek }
    refined = result.refined
  }
  const { weekend, midweek } = refinedLists
  const hasMidweek = Object.values(midweek).some((arr) => arr && arr.length > 0)

  // The stored `items` blob is the full combined list.
  const combined: GroceryListData = { ...weekend }
  for (const [section, sectionItems] of Object.entries(midweek) as Array<
    [GrocerySection, GroceryItem[] | undefined]
  >) {
    if (sectionItems && sectionItems.length > 0) {
      const already = combined[section]
      combined[section] = already ? [...already, ...sectionItems] : [...sectionItems]
    }
  }

  // Read the saved ticks inside the same transaction that replaces the row, and
  // lock it, so a concurrent tick cannot be read stale and written back. A
  // checked-items setter still has to take the same lock when it lands.
  const savedChecked = await db.transaction(async (tx) => {
    const previous = await tx
      .select({ checkedItems: schema.groceryLists.checkedItems })
      .from(schema.groceryLists)
      .where(eq(schema.groceryLists.planId, planId))
      .orderBy(desc(schema.groceryLists.id))
      .limit(1)
      .for('update')
    const checked = asStringArray(previous[0]?.checkedItems)

    await tx.delete(schema.groceryLists).where(eq(schema.groceryLists.planId, planId))
    await tx.insert(schema.groceryLists).values({
      planId,
      items: combined,
      checkedItems: checked,
      sourceHash: hash,
      refined: refined ? { weekend, midweek, refined: true } : null,
    })
    return checked
  })

  logger.debug({ planId, hasMidweek, recipeCount: rows.length }, 'grocery list generated')

  return {
    weekendItems: weekend,
    midweekItems: midweek,
    hasMidweek,
    checkedItems: savedChecked,
    refined,
  }
}
