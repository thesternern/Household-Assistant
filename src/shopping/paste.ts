/**
 * The block the household pastes into a store's list importer.
 *
 * Instacart's Shopping List takes a pasted list of up to 200 items and parses
 * them without separators. Everything that makes a list readable to a person —
 * store sections, which recipe wanted it, markdown — makes it harder for a
 * matcher, so none of it appears here. The readable version is a separate
 * message.
 */
import { cleanText } from '../sanitize.js'
import type { ShoppingLine, ShoppingList } from './list.js'

/** Instacart's documented paste ceiling. */
export const MAX_PASTE_ITEMS = 200

/**
 * Longest block, preamble included, in characters.
 *
 * Each block goes out as one Telegram message inside a code fence, and
 * Telegram caps a message at 4096 characters. The sender chunks longer text
 * on line boundaries with no idea a fence is open, so an over-long block
 * arrives as two malformed halves that Telegram rejects and the fallback
 * delivers as plain text — literal backticks and all. The fence and the
 * escaping the sender adds need a little room, hence the margin.
 */
export const MAX_PASTE_CHARS = 3_800

/**
 * `2 lb chicken thighs`, or just `olive oil` when there is no number.
 *
 * Sanitised again here, not only in `lineFromGroceryItem`. This function is
 * what decides how many rows the block has, and a `ShoppingLine` can be built
 * by hand: one embedded newline would silently add an item to the cart.
 */
export function formatLine(line: ShoppingLine): string {
  const name = cleanText(line.name, 200)
  if (name === '') return ''
  if (line.quantity === undefined) return name
  const unit = cleanText(line.unit, 20)
  return unit === '' ? `${line.quantity} ${name}` : `${line.quantity} ${unit} ${name}`
}

/**
 * At most {@link MAX_PASTE_ITEMS} items and {@link MAX_PASTE_CHARS} characters
 * per block, whichever comes first.
 *
 * Splitting rather than truncating matters: a silently shortened list is
 * discovered at the till, and by then the shop is done.
 */
export function formatPasteBlocks(
  list: ShoppingList,
  opts: { preamble?: string } = {},
): string[] {
  const rows = list.lines.map(formatLine).filter((row) => row !== '')
  if (rows.length === 0) return []

  // The preamble is the household's standing instructions. It goes on EVERY
  // block, not just the first: each block is pasted as its own message, and a
  // second paste without the rules would be shopped under the defaults the
  // rules exist to override.
  const preamble = (opts.preamble ?? '').trim()

  const blocks: string[] = []
  let current: string[] = []
  let length = preamble.length
  const flush = (): void => {
    if (current.length === 0) return
    const items = current.join('\n')
    blocks.push(preamble === '' ? items : `${preamble}\n${items}`)
    current = []
    length = preamble.length
  }
  for (const row of rows) {
    const added = row.length + 1
    const overItems = current.length >= MAX_PASTE_ITEMS
    // A single row longer than the whole budget still goes out, on its own.
    const overChars = current.length > 0 && length + added > MAX_PASTE_CHARS
    if (overItems || overChars) flush()
    current.push(row)
    length += added
  }
  flush()
  return blocks
}
