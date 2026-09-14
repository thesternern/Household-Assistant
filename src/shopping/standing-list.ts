/**
 * The standing shopping list.
 *
 * Items accumulate here until the household asks for a list. That batching is
 * the point: a shopper sent out for one bottle of hand soap is a bad errand,
 * and a household that has to remember to batch will not. Urgency is the
 * escape hatch, and it has to be said out loud.
 */
import { desc, eq, inArray } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { cleanText } from '../sanitize.js'
import { lineFromGroceryItem } from './list.js'
import type { ShoppingLine } from './list.js'

const log = logger.child({ mod: 'shopping/standing-list' })

export type StandingStatus = 'pending' | 'sent' | 'dropped'
export type StandingItem = typeof schema.shoppingListItems.$inferSelect

/**
 * One thing to add. A bare string is the common case — "dish soap" — and the
 * object form carries the amount the household actually said.
 *
 * The quantity stays free text on purpose. `2 lb`, `a big one` and `as needed`
 * are all things a person says, and `standingToLines` decides later whether
 * any of it parses into structure. Guessing a number here would put a wrong
 * one in the cart.
 */
export interface StandingItemInput {
  name: string
  quantity?: string
  note?: string
}

export interface AddItemsInput {
  items: Array<string | StandingItemInput>
  urgent?: boolean
  addedBy: string
}

/** Add each entry as its own pending item. Blank names are dropped, not stored. */
export async function addItems(input: AddItemsInput): Promise<StandingItem[]> {
  const rows = input.items
    .map((entry) => (typeof entry === 'string' ? { name: entry } : entry))
    .map((entry) => ({
      name: cleanText(entry.name, 200),
      quantityText: cleanText(entry.quantity, 60),
      note: cleanText(entry.note, 120),
    }))
    .filter((entry) => entry.name !== '')
  if (rows.length === 0) return []

  const inserted = await getDb()
    .insert(schema.shoppingListItems)
    .values(
      rows.map((row) => ({
        name: row.name,
        // Null rather than '' so `quantityText ? ...` reads the same in the
        // tools as it does against a row the migration left empty.
        quantityText: row.quantityText === '' ? null : row.quantityText,
        note: row.note === '' ? null : row.note,
        status: 'pending',
        urgent: input.urgent === true,
        addedBy: input.addedBy,
      })),
    )
    .returning()

  log.info({ count: inserted.length, urgent: input.urgent === true }, 'items added to the list')
  return inserted
}

/** What is waiting, oldest first. */
export async function pendingItems(): Promise<StandingItem[]> {
  return getDb()
    .select()
    .from(schema.shoppingListItems)
    .where(eq(schema.shoppingListItems.status, 'pending'))
    .orderBy(schema.shoppingListItems.addedAt)
}

/**
 * Consume items into a shop. Returns how many were actually moved.
 *
 * Nothing reads back from the store, so this is a guess that they were bought.
 * `setStatus(id, 'pending')` is how the household corrects it.
 */
export async function markSent(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0
  const updated = await getDb()
    .update(schema.shoppingListItems)
    .set({ status: 'sent', sentAt: new Date() })
    .where(inArray(schema.shoppingListItems.id, ids))
    .returning()
  return updated.length
}

/**
 * The items most recently consumed into a shop, newest first.
 *
 * This is the other half of `setStatus(id, 'pending')`. Nothing reads back
 * from the store, so "sent" is a guess, and the household corrects it by id —
 * which means an id they can still find a day later. `pendingItems` cannot
 * show them one, because a sent item is by definition not pending.
 */
export async function recentlySent(limit = 20): Promise<StandingItem[]> {
  return getDb()
    .select()
    .from(schema.shoppingListItems)
    .where(eq(schema.shoppingListItems.status, 'sent'))
    .orderBy(desc(schema.shoppingListItems.sentAt))
    .limit(limit)
}

/** Drop an item, or put a sent one back. */
export async function setStatus(
  id: number,
  status: StandingStatus,
): Promise<StandingItem | undefined> {
  const updated = await getDb()
    .update(schema.shoppingListItems)
    .set({ status, ...(status === 'pending' ? { sentAt: null } : {}) })
    .where(eq(schema.shoppingListItems.id, id))
    .returning()
  return updated[0]
}

/** Standing items as shopping lines, reusing the same quantity discipline. */
export function standingToLines(items: readonly StandingItem[]): ShoppingLine[] {
  return items.map((item) =>
    lineFromGroceryItem({
      item: item.name,
      quantity: item.quantityText ?? '',
      recipes: item.note ? [item.note] : [],
    }),
  )
}
