/**
 * One-line sanitising for text that came from somewhere else.
 *
 * Recipe titles come off scraped web pages; shopping item names come out of a
 * chat message the household typed. Either can carry a newline, a control
 * character, or an invisible codepoint that renders as nothing yet still
 * reaches the model — and a newline in a name forges an extra row in a list
 * that is about to be pasted into a store's importer.
 *
 * Strip, collapse, clamp. `src/tools/recipes.ts` has done this to every
 * scraped field since the recipe library landed; this is that same routine,
 * written once so the shopping list cannot drift away from it.
 */

/** Renders as nothing, still reaches the model. Includes the tag block. */
const INVISIBLE = /[\u00AD\u200B-\u200F\u2060-\u2064\u2066-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu

/** Newlines included: one field must never become two rows. */
const CONTROL = /[\u0000-\u001F\u007F]/g

/** Make one untrusted field safe to render on a single line. */
export function cleanText(value: unknown, max = 120): string {
  const raw =
    typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
  const flat = raw.replace(INVISIBLE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}
