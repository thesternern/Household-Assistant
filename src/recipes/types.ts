/**
 * Recipe domain types.
 *
 * Ported from the recipe-planner app (SQLite) and realigned with the Drizzle
 * schema in `src/db/schema.ts`:
 *   - field names are camelCase, matching the Drizzle column properties
 *   - `ingredients` / `steps` / `tags` / `groceryCategories` are real arrays and
 *     objects (jsonb columns), never JSON strings
 *   - `freezerFriendly` / `isArchived` are real booleans, never 0/1
 *   - nullable columns are typed `T | null`; not-yet-persisted input uses `?`
 *
 * The string literal unions below are stored VALUES (snake_case in the DB), so
 * they keep their original spelling.
 */

/** Free-form provenance label, e.g. 'nyt_cooking', 'allrecipes', 'manual'. */
export type RecipeSource = string

export type Difficulty = 'easy' | 'medium' | 'hard'

export type GrocerySection =
  | 'produce' | 'meat_seafood' | 'dairy_eggs' | 'bakery_bread'
  | 'pantry_dry_goods' | 'canned_jarred' | 'frozen'
  | 'spices_seasonings' | 'oils_vinegars_condiments'
  | 'grains_pasta_rice' | 'snacks' | 'beverages' | 'other' | 'pantry_staples'

export type FreshnessCategory = 'very_perishable' | 'perishable' | 'moderate' | 'shelf_stable'

export type CuisineGroup = 'italian' | 'asian' | 'mexican' | 'mediterranean' | 'american' | 'other'

export interface Ingredient {
  item: string
  quantity: string
  section?: GrocerySection
}

/** A recipe row as read back from Postgres. */
export interface Recipe {
  id: number
  title: string
  source: RecipeSource
  sourceUrl: string
  author: string | null
  description: string | null
  totalTimeMinutes: number | null
  activeTimeMinutes: number | null
  servings: string | null
  difficulty: Difficulty | null
  ingredients: Ingredient[]
  steps: string[]
  familyScore: number | null
  familyNotes: string | null
  tags: string[]
  groceryCategories: Partial<Record<GrocerySection, string[]>> | null
  imageUrl: string | null
  scrapedAt: Date
  timesPlanned: number
  lastPlannedDate: string | null
  isArchived: boolean
  freshnessCategory: FreshnessCategory
  freezerFriendly: boolean
}

/** What the scraper / text parser produce and the store persists. */
export interface RecipeInput {
  title: string
  source: RecipeSource
  sourceUrl: string
  author?: string
  description?: string
  totalTimeMinutes?: number
  activeTimeMinutes?: number
  servings?: string
  difficulty?: Difficulty
  ingredients: Ingredient[]
  steps: string[]
  familyScore?: number
  familyNotes?: string
  tags?: string[]
  groceryCategories?: Partial<Record<GrocerySection, string[]>>
  imageUrl?: string
  freshnessCategory?: FreshnessCategory
  /** Real boolean here — the SQLite original stored 0/1. */
  freezerFriendly?: boolean
}

/**
 * Intermediate shape from the free-text parser: ingredients and steps are still
 * raw strings awaiting review before they become a `RecipeInput`.
 */
export interface RecipePreview {
  title: string
  author?: string
  description?: string
  sourceUrl?: string
  totalTimeMinutes?: number
  activeTimeMinutes?: number
  servings?: string
  imageUrl?: string
  ingredientsRaw: string[]
  stepsRaw: string[]
  familyScore: number
  familyNotes: string
  difficulty: Difficulty
  tags: string[]
  source: RecipeSource
}

export interface MealPlan {
  id: number
  /** ISO date (yyyy-mm-dd) of the Monday the plan starts. */
  weekStart: string
  notes: string | null
  createdAt: Date
  items?: MealPlanItem[]
}

export interface MealPlanItem {
  id: number
  planId: number
  recipeId: number
  /** 0 = Monday … 6 = Sunday. */
  dayOfWeek: number
  mealType: string
  servingsOverride: string | null
  notes: string | null
  recipe?: Recipe
}

export interface GroceryItem {
  item: string
  quantity: string
  /** Titles of the recipes that call for this item. */
  recipes: string[]
  /** Midweek pickup day, set only on midweek items. */
  day?: 'Thu' | 'Fri'
}

export type GroceryListData = Partial<Record<GrocerySection, GroceryItem[]>>

export interface GroceryListResponse {
  weekendItems: GroceryListData
  midweekItems: GroceryListData
  hasMidweek: boolean
  checkedItems: string[]
  /**
   * False when the Claude tidying pass was skipped or failed and the list is
   * exactly as the parser built it. Absent on lists that predate the pass.
   */
  refined?: boolean
}
