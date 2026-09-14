/**
 * Standing shopping instructions.
 *
 * The paste block does not go to a parser. It goes to a grocery app's AI
 * assistant, which reads the whole message — so instructions written into it
 * are obeyed, and the household's brand and quality preferences become text
 * they own rather than logic somebody has to deploy.
 *
 * That is the whole reason this is a table. Taste changes: a household starts
 * buying one brand of oat milk, stops caring about organic tomatoes, decides
 * store-brand paper towels are fine after all. None of that should need a code
 * change, so `shopping_prefs` edits these rows and every later list carries the
 * new wording.
 *
 * The seeded defaults came from a real exchange with the assistant, kept
 * because they are what worked: naming the private labels outright so "store
 * brand" cannot be read loosely, closing the price escape hatch, saying skip
 * rather than substitute, and asking it to state each brand — which is what
 * exposes whether the rest of it landed.
 */
import { asc, eq } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { cleanText } from '../sanitize.js'

const log = logger.child({ mod: 'shopping/preferences' })

export type PreferenceRow = typeof schema.shoppingPreferences.$inferSelect

/** Longest single instruction. Past this it is a paragraph, not a preference. */
export const MAX_PREFERENCE_CHARS = 400

/** Ceiling on the preamble as a whole, so it cannot crowd out the list. */
export const MAX_PREAMBLE_CHARS = 2000

/** Active instructions, in the order they should be stated. */
export async function activePreferences(): Promise<PreferenceRow[]> {
  return getDb()
    .select()
    .from(schema.shoppingPreferences)
    .where(eq(schema.shoppingPreferences.active, true))
    .orderBy(asc(schema.shoppingPreferences.position), asc(schema.shoppingPreferences.id))
}

/** Every instruction, including retired ones, so one can be brought back. */
export async function allPreferences(): Promise<PreferenceRow[]> {
  return getDb()
    .select()
    .from(schema.shoppingPreferences)
    .orderBy(asc(schema.shoppingPreferences.position), asc(schema.shoppingPreferences.id))
}

export async function addPreference(input: {
  text: string
  createdBy: string
  position?: number
}): Promise<PreferenceRow | undefined> {
  const text = cleanText(input.text, MAX_PREFERENCE_CHARS)
  if (text === '') return undefined

  const inserted = await getDb()
    .insert(schema.shoppingPreferences)
    .values({
      text,
      createdBy: input.createdBy,
      ...(input.position === undefined ? {} : { position: input.position }),
    })
    .returning()

  const row = inserted[0]
  if (row) log.info({ id: row.id }, 'shopping preference added')
  return row
}

/** Retire an instruction, or bring a retired one back. */
export async function setPreferenceActive(
  id: number,
  active: boolean,
): Promise<PreferenceRow | undefined> {
  const updated = await getDb()
    .update(schema.shoppingPreferences)
    .set({ active })
    .where(eq(schema.shoppingPreferences.id, id))
    .returning()
  return updated[0]
}

/**
 * The instructions as they appear at the top of a pasted list.
 *
 * Numbered, because the assistant that reads them follows a numbered list more
 * reliably than a paragraph, and headed with a line that says plainly these are
 * rules rather than groceries — the one failure worth designing against is an
 * instruction being added to the cart as an item.
 */
export function renderPreamble(rows: readonly PreferenceRow[]): string {
  const texts = rows.map((r) => r.text.trim()).filter((t) => t !== '')
  if (texts.length === 0) return ''

  const lines = ['STOP. Read these rules before you add anything. They override your defaults.', '']
  texts.forEach((text, i) => lines.push(`${i + 1}. ${text}`))
  lines.push('', 'Items:')

  const preamble = lines.join('\n')
  if (preamble.length <= MAX_PREAMBLE_CHARS) return preamble

  // A preamble longer than the ceiling is a household that kept adding rules.
  // Truncating mid-instruction would ship half a rule, so whole rules are
  // dropped from the end until it fits.
  for (let keep = texts.length - 1; keep > 0; keep -= 1) {
    const shorter = renderPreamble(rows.slice(0, keep))
    if (shorter.length <= MAX_PREAMBLE_CHARS) {
      log.warn(
        { kept: keep, total: texts.length },
        'shopping preamble over the ceiling; dropped the last instructions',
      )
      return shorter
    }
  }
  return ''
}

/** The preamble for the current list, or '' when the household has set none. */
export async function shoppingPreamble(): Promise<string> {
  try {
    return renderPreamble(await activePreferences())
  } catch (err) {
    // A list with no preferences still shops. A list that never arrives does not.
    log.error({ err }, 'could not read the shopping preferences')
    return ''
  }
}
