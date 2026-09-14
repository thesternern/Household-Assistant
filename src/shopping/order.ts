/**
 * Building the block the household pastes into their grocery app.
 *
 * This lives apart from `shopping_order` because two callers need it and only
 * one of them is a tool: the agent builds a list when asked, and the button on
 * the grocery card builds the same list when tapped. The step that matters is
 * `markSent` — it is what stops "hand soap" being offered every week — and two
 * copies of that decision would eventually disagree about when an item is
 * spent.
 *
 * What stays with the callers is everything about *presentation*: the audit
 * entry, the wording, and how the blocks reach Telegram. What lives here is the
 * part that must be identical however it was asked for.
 */
import { logger } from '../logger.js'
import { foldWeekIntoShop } from './fold.js'
import type { ShoppingLine } from './list.js'
import { formatPasteBlocks } from './paste.js'
import { shoppingPreamble } from './preferences.js'
import { markSent, pendingItems, standingToLines } from './standing-list.js'
import type { StandingItem } from './standing-list.js'

const log = logger.child({ mod: 'shopping/order' })

export interface ShopListBuild {
  /** Paste blocks as plain text, preamble included. Presentation is the caller's. */
  blocks: string[]
  /** Item lines across every block, never counting the preamble's rules. */
  pasted: number
  /** The standing items that went in, so the caller can name them. */
  standingItems: StandingItem[]
  /** How many lines came from the week's meal plan. */
  foldedCount: number
  /** Why the week could not be folded in, or '' when it was or was not asked for. */
  foldNote: string
  /** False when the standing items could not be ticked off; they may be offered again. */
  consumed: boolean
}

export type ShopListResult =
  | { ok: true; build: ShopListBuild }
  | { ok: false; reason: string; foldNote: string }

export interface BuildShopListOptions {
  /** Only items flagged urgent. Never folds the week in. */
  urgentOnly?: boolean
  /** A week to fold the meal-plan groceries in from, e.g. 'this week'. */
  week?: string
}

/**
 * Collect the standing list, optionally fold in a week's groceries, render the
 * paste blocks, and consume the standing items.
 *
 * Consuming happens only once a block actually exists. A failed `markSent` is
 * reported rather than thrown: the household has already been shown the items,
 * so offering them again next week is a far better failure than losing them.
 */
export async function buildShopList(opts: BuildShopListOptions = {}): Promise<ShopListResult> {
  const urgentOnly = opts.urgentOnly === true
  const standingItems = (await pendingItems()).filter((i) => (urgentOnly ? i.urgent : true))
  const lines: ShoppingLine[] = standingToLines(standingItems)

  // The weekend shop is the big one, so that is where the standing list joins.
  // Midweek is the freshness-driven top-up and stays separate.
  let foldedCount = 0
  let foldNote = ''
  if (opts.week !== undefined && opts.week !== '' && !urgentOnly) {
    const fold = await foldWeekIntoShop(opts.week)
    if (fold.ok) {
      foldedCount = fold.lines.length
      lines.push(...fold.lines)
    } else {
      // Saying nothing here used to cost the household the week's groceries
      // silently, while still ticking their standing items off.
      foldNote = `I could not fold the week in: ${fold.reason}.`
      log.warn({ week: opts.week, reason: fold.reason }, 'week not folded into the shop')
    }
  }

  if (lines.length === 0) {
    return {
      ok: false,
      reason: urgentOnly ? 'Nothing on the list is marked urgent.' : 'Nothing on the list right now.',
      foldNote,
    }
  }

  // The household's standing instructions ride on every block. The importer on
  // the other side is an assistant that reads the whole message, so these are
  // obeyed — and they are what stops it filling the cart with store brands,
  // which is what it does left to its own defaults.
  const preamble = await shoppingPreamble()
  const blocks = formatPasteBlocks({ title: 'Shopping list', lines }, { preamble })

  // Count the items, not the preamble's rules — "included 5 items" under a
  // twenty-item shop would be a lie the household reads every week.
  const preambleLines = preamble === '' ? 0 : preamble.split('\n').length
  const pasted = blocks.reduce((n, block) => n + block.split('\n').length - preambleLines, 0)

  let consumed = true
  try {
    await markSent(standingItems.map((i) => i.id))
  } catch (err) {
    consumed = false
    log.error({ err, items: standingItems.length }, 'could not mark the shopping items sent')
  }

  log.info(
    { items: standingItems.length, folded: foldedCount, pasted, blocks: blocks.length, consumed },
    'shopping list built',
  )

  return { ok: true, build: { blocks, pasted, standingItems, foldedCount, foldNote, consumed } }
}
