/**
 * Folding a week's meal plan into the same shop.
 *
 * The weekend shop is the big one, so that is where the standing list joins.
 * The midweek trip is the freshness-driven top-up and stays its own errand —
 * folding it in would send basil out with the bin bags a week early.
 *
 * This lives here rather than inside `src/tools/shopping.ts` for two reasons.
 * The tool layer should own argument shapes and phrasing, not plan lookup; and
 * a fold that fails has to say *why*, in a sentence the household can act on,
 * which is a decision about the domain and not about Telegram.
 */
import { generateGroceryList, getPlanByWeek } from '../recipes/store.js'
import { logger } from '../logger.js'
import { resolveWeekStart } from '../time.js'
import { groceryDataToLines } from './list.js'
import type { ShoppingLine } from './list.js'

const log = logger.child({ mod: 'shopping/fold' })

export type WeekFold =
  | { ok: true; week: string; lines: ShoppingLine[] }
  | { ok: false; reason: string }

/**
 * The weekend groceries for a week, ready to append to the paste block.
 *
 * The week is read through `resolveWeekStart`, the same resolution every
 * recipe tool uses, so "this week" works here too. `normalizeWeekStart` in the
 * recipe store throws on anything that is not an ISO date, and reaching it
 * with the household's most natural wording used to cost them the fold-in
 * silently.
 *
 * A failure is never fatal: the standing list is still worth a block on its
 * own. But it is never silent either — the caller is handed a reason to say
 * out loud, because the household is about to have their standing items ticked
 * off whether or not the week made it in.
 */
export async function foldWeekIntoShop(week: string): Promise<WeekFold> {
  const resolved = resolveWeekStart(week)
  if (!resolved.ok) return { ok: false, reason: resolved.error }

  try {
    const plan = await getPlanByWeek(resolved.date)
    if (!plan) {
      return { ok: false, reason: `there is no meal plan for the week of ${resolved.date}` }
    }

    const groceries = await generateGroceryList(plan.id)
    const lines = groceryDataToLines(groceries.weekendItems)
    if (lines.length === 0) {
      return {
        ok: false,
        reason: `the plan for the week of ${resolved.date} has no weekend groceries yet`,
      }
    }

    log.info({ week: resolved.date, planId: plan.id, lines: lines.length }, 'week folded into the shop')
    return { ok: true, week: resolved.date, lines }
  } catch (err) {
    log.error({ err, week: resolved.date }, 'could not fold the week into the shop')
    return { ok: false, reason: `I could not read the meal plan for the week of ${resolved.date}` }
  }
}
