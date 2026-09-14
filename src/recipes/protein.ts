/**
 * Does this recipe carry enough protein to be somebody's dinner?
 *
 * The library holds sides, sauces and puddings next to mains, and the planner
 * could not tell them apart: `detectProtein` in `store.ts` reads the title and
 * tags, and only to *vary* the protein across a week — it never asked whether
 * there was one. So "Arugula Salad with Lime Vinaigrette" was a legal Tuesday
 * dinner, as were both chocolate cakes.
 *
 * The test is on the ingredients, never the title. A title lies about its
 * contents constantly ("Steak au Poivre" for a portobello dish); an ingredient
 * list rarely does.
 */
import type { Ingredient } from './types.js'

/**
 * Legumes named one by one, on purpose.
 *
 * A bare "bean" or "pea" would pass green beans, snap peas and peanut butter —
 * three things nobody would call the protein in a meal.
 */
const PLANT_PROTEINS = [
  'tofu',
  'tempeh',
  'seitan',
  'lentil',
  'chickpea',
  'garbanzo',
  'black bean',
  'white bean',
  'cannellini',
  'kidney bean',
  'pinto',
  'borlotti',
  'butter bean',
  'navy bean',
  'fava',
  'edamame',
  'split pea',
  'black-eyed pea',
  'dal',
  'chana',
]

/**
 * Cheese and eggs are protein and are deliberately absent.
 *
 * Counting them would readmit most of the sides and all of the puddings —
 * parmesan-crusted potatoes, and a chocolate cake carrying four eggs. The cost
 * is that a genuine egg-based main (a frittata, shakshuka) reads as a side and
 * has to be placed by hand. That is the right way round: a wrongly excluded
 * frittata is a small annoyance, while a wrongly included cake is dinner.
 */
export function hasMainProtein(ingredients: readonly Ingredient[]): boolean {
  for (const ingredient of ingredients) {
    if (ingredient.section === 'meat_seafood') return true
    const item = ingredient.item.toLowerCase()
    if (PLANT_PROTEINS.some((protein) => item.includes(protein))) return true
  }
  return false
}

/**
 * Narrow a candidate list to the recipes that can be somebody's dinner.
 *
 * Applied by `autofillPlan` before the variety scorer runs, so a side or a
 * pudding can never win a weeknight slot however well it is rated or however
 * long since it was last cooked. Nothing is archived or hidden: sides stay in
 * the library, stay searchable, and can still be placed by hand with
 * `mealplan_add_item` when someone actually wants one.
 */
export function dinnerCandidates<T extends { ingredients: readonly Ingredient[] }>(
  recipes: readonly T[],
): T[] {
  return recipes.filter((recipe) => hasMainProtein(recipe.ingredients))
}
