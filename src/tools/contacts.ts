/**
 * The household address book.
 *
 * This is what turns "call the dentist" into a phone number: the phone subagent
 * runs `contact_search` on the role or name it heard, and places the call
 * against the number it gets back. That makes the ranking here load-bearing —
 * an exact name match must always beat a fuzzy role match, and a contact with
 * no phone number must never outrank one that has a number to dial.
 */
import { and, asc, eq, ilike, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { z } from 'zod'
import { audit } from '../audit/log.js'
import { ageOn } from '../contacts/birthdays.js'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { householdNow } from '../time.js'
import { fail, ok } from './types.js'
import type { ToolDef } from './types.js'

const log = logger.child({ mod: 'tools/contacts' })

const SEARCH_LIMIT = 20
const MAX_TEXT_LINES = 15
/**
 * How many rows the ranking sees. The database can only order by name, so a
 * tight cap here would let an alphabetical cut drop the exact match — and
 * `structuredContent.best` is the row the phone subagent dials. A household
 * address book does not reach this number; if it ever does, the ranking is
 * degraded, not the correctness of a call.
 */
const CANDIDATE_LIMIT = 200

/** Words that mean "clear this field" in an update. */
const CLEAR_WORDS = new Set(['none', 'clear', 'unset', 'remove', '-'])

type ContactRow = typeof schema.contacts.$inferSelect

/* ────────────────────────────── small helpers ────────────────────────────── */

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * True for an ISO calendar day that actually exists. The column is a Postgres
 * `date`; anything else is rejected here rather than at the driver, where the
 * error would name the query and not the field.
 */
export function isBirthdayString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  return DateTime.fromISO(value, { zone: 'utc' }).isValid
}

function issueText(error: z.ZodError): string {
  const first = error.issues[0]
  if (!first) return 'the arguments were not valid'
  const path = first.path.join('.')
  return path === '' ? first.message : `${path}: ${first.message}`
}

/** Escapes LIKE wildcards, then wraps the result for a substring match. */
function likePattern(query: string): string {
  return `%${escapeLike(query)}%`
}

/**
 * Escapes LIKE wildcards without adding any. An `ilike` against this is a
 * case-insensitive *equality* test, which is what the name-collision lookup in
 * `contact_add` needs: an unescaped `%` in a business name ("100% Plumbing")
 * would otherwise match some unrelated row and silently overwrite it.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/**
 * Best-effort E.164 for a North American household. A number that already
 * carries a `+`, or that has an extension or any other shape we do not
 * recognise, is kept verbatim — a wrong "correction" would dial the wrong
 * person, which is worse than an unnormalised string.
 */
export function normalizePhone(raw: string): string {
  const input = raw.trim()
  if (input === '') return input
  if (/(ext|x)\.? ?\d+$/i.test(input)) return input.replace(/\s+/g, ' ')

  const digits = input.replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) {
    const rest = digits.slice(1).replace(/\D/g, '')
    return rest.length >= 8 && rest.length <= 15 ? `+${rest}` : input.replace(/\s+/g, ' ')
  }
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return input.replace(/\s+/g, ' ')
}

function toStructured(row: ContactRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    phone: row.phone,
    email: row.email,
    address: row.address,
    notes: row.notes,
    birthday: row.birthday,
    // Derived on every read. Never stored — see src/contacts/birthdays.ts.
    age: row.birthday ? ageOn(row.birthday, householdNow()) : null,
    household: row.household,
  }
}

function describeContact(row: ContactRow): string {
  const bits: string[] = []
  // The model reads this line, not `structuredContent`. Leaving the flag out of
  // it means proposing a call to someone who lives here, spending an approval
  // card on it, and being refused by the phone tool at the end of all that.
  if (row.household) bits.push('household (never call or text)')
  if (row.role) bits.push(row.role)
  if (row.birthday) {
    const age = ageOn(row.birthday, householdNow())
    if (age !== null) bits.push(`age ${age}`)
  }
  if (row.phone) bits.push(row.phone)
  if (row.email) bits.push(row.email)
  if (!row.phone && !row.email) bits.push('no number on file')
  return `#${row.id} ${row.name} — ${bits.join(' · ')}`
}

/**
 * Ranks a row against the query. Lower is better. Exact name, then name prefix,
 * then name substring, then role; a missing phone number costs half a point so
 * a dialable contact wins any tie.
 */
function rank(row: ContactRow, query: string): number {
  const q = query.toLowerCase().trim()
  const name = row.name.toLowerCase()
  const role = (row.role ?? '').toLowerCase()

  let score = 6
  if (name === q) score = 0
  else if (role === q) score = 1
  else if (name.startsWith(q)) score = 2
  else if (name.includes(q)) score = 3
  else if (role.startsWith(q)) score = 4
  else if (role.includes(q)) score = 5

  if (!row.phone) score += 0.5
  return score
}

/* ─────────────────────────────── contact_add ─────────────────────────────── */

const addShape = {
  name: z.string().trim().min(1).max(160).describe('Person or business name, as the household would say it.'),
  role: z
    .string()
    .trim()
    .max(120)
    .optional()
    .describe("What they are to the household: 'dentist', 'plumber', 'Maya\\'s teacher', 'neighbour'."),
  phone: z.string().trim().max(40).optional().describe('Phone number. Normalised to +1XXXXXXXXXX where possible.'),
  email: z.string().trim().max(200).optional().describe('Email address.'),
  address: z.string().trim().max(300).optional().describe('Street address.'),
  notes: z.string().trim().max(1000).optional().describe('Anything useful when contacting them: hours, gate code, who to ask for.'),
  birthday: z
    .string()
    .trim()
    .max(10)
    .optional()
    .describe('Date of birth as YYYY-MM-DD, e.g. 2018-03-04. Used to work out their age.'),
  household: z
    .boolean()
    .optional()
    .describe(
      'True only for people who live in this household — the parents and the children. ' +
        'Their numbers are here so they can be given to a doctor or a booking. Chessy may ' +
        'never call or text a household member, and cannot take anyone back out of the ' +
        'household once they are in it.',
    ),
}
const addSchema = z.object(addShape)

const contactAdd: ToolDef = {
  name: 'contact_add',
  description:
    'Save a person or business to the household address book. Saving the same name twice updates the existing ' +
    'entry rather than creating a second one.',
  schema: addShape,
  category: 'memory_write',
  consequential: false,
  summarize: (args) => {
    const name = readString(args['name']) ?? 'a contact'
    const role = readString(args['role'])
    const phone = readString(args['phone'])
    return `Save contact: ${name}${role ? ` (${role})` : ''}${phone ? `, ${phone}` : ''}.`
  },
  handler: async (args, ctx) => {
    const parsed = addSchema.safeParse(args)
    if (!parsed.success) return fail(`I could not save that contact: ${issueText(parsed.error)}`)
    const { name, role, email, address, notes, birthday, household } = parsed.data
    const phone = parsed.data.phone === undefined ? undefined : normalizePhone(parsed.data.phone)

    if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return fail(`"${email}" does not look like an email address.`)
    }
    if (birthday !== undefined && !isBirthdayString(birthday)) {
      return fail(`"${birthday}" is not a date I can store. Give me a birthday as YYYY-MM-DD.`)
    }

    try {
      const db = getDb()
      // ilike against an escaped literal is a case-insensitive equality test.
      const existingRows = await db
        .select()
        .from(schema.contacts)
        .where(ilike(schema.contacts.name, escapeLike(name)))
        .orderBy(asc(schema.contacts.id))
        .limit(1)
      const existing = existingRows[0]

      if (existing) {
        // Saving a name that is already in the book edits that row, which makes
        // this the same door `contact_update` guards: "add Sam, household
        // false" would clear the flag through a tool that runs unattended under
        // `memory_write`. A new contact created without the flag is just an
        // ordinary contact, so only clearing an existing one is refused.
        if (household === false && existing.household) {
          return fail(
            'I will not take someone out of the household. That flag is what stops me calling or ' +
              'texting them, so it can only be cleared by a person editing the contact directly.',
          )
        }

        const patch: Partial<typeof schema.contacts.$inferInsert> = {}
        if (role !== undefined) patch.role = role
        if (phone !== undefined) patch.phone = phone
        if (email !== undefined) patch.email = email
        if (address !== undefined) patch.address = address
        if (notes !== undefined) patch.notes = notes
        if (birthday !== undefined) patch.birthday = birthday
        if (household !== undefined) patch.household = household

        if (Object.keys(patch).length === 0) {
          return ok(`${existing.name} is already in the address book as #${existing.id}.`, {
            contact: toStructured(existing),
            action: 'unchanged',
          })
        }

        const updated = await db
          .update(schema.contacts)
          .set(patch)
          .where(eq(schema.contacts.id, existing.id))
          .returning()
        const row = updated[0] ?? existing

        await audit({
          actor: ctx.actor,
          event: 'contact.update',
          category: 'memory_write',
          toolName: 'contact_add',
          args: { id: row.id, ...patch },
          resultSummary: row.name,
          ok: true,
        })
        log.info({ contactId: row.id, actor: ctx.actor }, 'contact updated via contact_add')

        return ok(`Updated ${row.name} in the address book: ${describeContact(row)}.`, {
          contact: toStructured(row),
          action: 'updated',
        })
      }

      const inserted = await db
        .insert(schema.contacts)
        .values({
          name,
          role: role ?? null,
          phone: phone ?? null,
          email: email ?? null,
          address: address ?? null,
          notes: notes ?? null,
          birthday: birthday ?? null,
          household: household ?? false,
        })
        .returning()
      const row = inserted[0]
      if (!row) return fail('The contact could not be saved.')

      await audit({
        actor: ctx.actor,
        event: 'contact.add',
        category: 'memory_write',
        toolName: 'contact_add',
        args: { name, role: role ?? null, phone: phone ?? null },
        resultSummary: `contact #${row.id}`,
        ok: true,
      })
      log.info({ contactId: row.id, actor: ctx.actor }, 'contact added')

      return ok(`Saved ${row.name}${row.role ? ` (${row.role})` : ''}${row.phone ? ` — ${row.phone}` : ''}.`, {
        contact: toStructured(row),
        action: 'created',
      })
    } catch (err) {
      log.error({ err }, 'contact_add failed')
      return fail('I could not save that contact — the database rejected the write.')
    }
  },
}

/* ────────────────────────────── contact_search ───────────────────────────── */

const searchShape = {
  query: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("Name or role to look up: 'dentist', 'Dr Moreau', 'plumber'. Matched against both."),
  withPhoneOnly: z
    .boolean()
    .default(false)
    .describe('Only return contacts that have a phone number. Set this before placing a call.'),
  limit: z.coerce.number().int().min(1).default(10).describe('Maximum contacts to return (capped at 20).'),
}
const searchSchema = z.object(searchShape)

const contactSearch: ToolDef = {
  name: 'contact_search',
  description:
    'Look up a person or business in the household address book by name or by role. ' +
    'Use this to turn "call the dentist" into an actual phone number before placing a call.',
  schema: searchShape,
  category: 'read',
  consequential: false,
  readOnly: true,
  summarize: (args) => `Look up "${readString(args['query']) ?? ''}" in the address book.`,
  handler: async (args) => {
    const parsed = searchSchema.safeParse(args)
    if (!parsed.success) return fail(`I could not run that contact search: ${issueText(parsed.error)}`)
    const { query, withPhoneOnly } = parsed.data
    const limit = Math.min(parsed.data.limit, SEARCH_LIMIT)

    try {
      const pattern = likePattern(query)
      const conditions: SQL[] = []
      const match = or(ilike(schema.contacts.name, pattern), ilike(schema.contacts.role, pattern))
      if (match) conditions.push(match)

      const rows = await getDb()
        .select()
        .from(schema.contacts)
        .where(conditions.length === 1 ? conditions[0] : and(...conditions))
        .orderBy(asc(schema.contacts.name))
        .limit(CANDIDATE_LIMIT)

      const filtered = withPhoneOnly ? rows.filter((row) => row.phone !== null && row.phone.trim() !== '') : rows
      const ranked = [...filtered].sort((a, b) => rank(a, query) - rank(b, query) || a.id - b.id).slice(0, limit)

      if (ranked.length === 0) {
        const hint = withPhoneOnly && rows.length > 0 ? ' (I have a match, but no phone number for it.)' : ''
        return ok(`No contact matches "${query}".${hint}`, { contacts: [], count: 0, query })
      }

      const best = ranked[0]
      const lines = ranked.slice(0, MAX_TEXT_LINES).map(describeContact)
      const heading =
        ranked.length === 1
          ? `1 match for "${query}":`
          : `${ranked.length} matches for "${query}", best first:`

      return ok(`${heading}\n${lines.join('\n')}`, {
        contacts: ranked.map(toStructured),
        count: ranked.length,
        best: best ? toStructured(best) : null,
        query,
      })
    } catch (err) {
      log.error({ err }, 'contact_search failed')
      return fail('I could not search the address book right now.')
    }
  },
}

/* ────────────────────────────── contact_update ───────────────────────────── */

const updateShape = {
  id: z.coerce.number().int().positive().describe('The contact id, as shown by contact_search.'),
  name: z.string().trim().min(1).max(160).optional().describe('New name.'),
  role: z.string().trim().max(120).optional().describe("New role. Pass 'none' to clear it."),
  phone: z.string().trim().max(40).optional().describe("New phone number. Pass 'none' to clear it."),
  email: z.string().trim().max(200).optional().describe("New email address. Pass 'none' to clear it."),
  address: z.string().trim().max(300).optional().describe("New street address. Pass 'none' to clear it."),
  notes: z.string().trim().max(1000).optional().describe("New notes. Pass 'none' to clear them."),
  birthday: z
    .string()
    .trim()
    .max(10)
    .optional()
    .describe("New date of birth as YYYY-MM-DD. Pass 'none' to clear it."),
  household: z
    .boolean()
    .optional()
    .describe(
      'True for someone who lives in this household. You can set this. You cannot clear it — ' +
        'someone moving out is a person\'s edit, not yours.',
    ),
}
const updateSchema = z.object(updateShape)

const contactUpdate: ToolDef = {
  name: 'contact_update',
  description:
    "Change a contact's details — a new number, a corrected name, a note about when they answer. " +
    "Pass 'none' for any field to clear it. Get the id from contact_search first.",
  schema: updateShape,
  category: 'memory_write',
  consequential: false,
  summarize: (args) => {
    const id = String(args['id'] ?? '?')
    const changes: string[] = (
      ['name', 'role', 'phone', 'email', 'address', 'notes', 'birthday'] as const
    ).filter((key) => readString(args[key]) !== undefined)
    // `readString` reads a boolean as absent, so the flag needs its own branch —
    // and it is the edit the audit trail can least afford to leave unnamed.
    if (typeof args['household'] === 'boolean') changes.push('household')
    return `Update contact #${id}${changes.length > 0 ? `: ${changes.join(', ')}` : ''}.`
  },
  handler: async (args, ctx) => {
    const parsed = updateSchema.safeParse(args)
    if (!parsed.success) return fail(`I could not read that contact update: ${issueText(parsed.error)}`)
    const { id, name } = parsed.data

    const patch: Partial<typeof schema.contacts.$inferInsert> = {}
    if (name !== undefined) patch.name = name
    for (const key of ['role', 'email', 'address', 'notes'] as const) {
      const value = parsed.data[key]
      if (value === undefined) continue
      patch[key] = CLEAR_WORDS.has(value.toLowerCase()) ? null : value
    }
    if (parsed.data.phone !== undefined) {
      patch.phone = CLEAR_WORDS.has(parsed.data.phone.toLowerCase()) ? null : normalizePhone(parsed.data.phone)
    }
    if (typeof patch.email === 'string' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email)) {
      return fail(`"${patch.email}" does not look like an email address.`)
    }
    if (parsed.data.birthday !== undefined) {
      const raw = parsed.data.birthday
      if (CLEAR_WORDS.has(raw.toLowerCase())) {
        patch.birthday = null
      } else if (!isBirthdayString(raw)) {
        return fail(`"${raw}" is not a date I can store. Give me a birthday as YYYY-MM-DD.`)
      } else {
        patch.birthday = raw
      }
    }
    // `memory_write` seeds to `allow`, so an unattended model turn can reach
    // this handler. Setting the flag is safe — it only ever removes a number
    // from what can be dialled. Clearing it is what dissolves the guardrail, and
    // the design argued for refusing over redirecting where there is no path
    // that keeps the protection. There is one here: a person edits the row. A
    // family member moving out is a once-a-decade change.
    if (parsed.data.household === false) {
      return fail(
        'I will not take someone out of the household. That flag is what stops me calling or ' +
          'texting them, so it can only be cleared by a person editing the contact directly.',
      )
    }
    if (parsed.data.household === true) {
      patch.household = true
    }

    if (Object.keys(patch).length === 0) {
      return fail(
        'Tell me what to change: name, role, phone, email, address, notes, birthday, or household.',
      )
    }

    try {
      const updated = await getDb()
        .update(schema.contacts)
        .set(patch)
        .where(eq(schema.contacts.id, id))
        .returning()
      const row = updated[0]
      if (!row) return fail(`There is no contact #${id}.`)

      await audit({
        actor: ctx.actor,
        event: 'contact.update',
        category: 'memory_write',
        toolName: 'contact_update',
        args: { id, ...patch },
        resultSummary: row.name,
        ok: true,
      })
      log.info({ contactId: id, actor: ctx.actor }, 'contact updated')

      return ok(`Updated ${row.name}: ${describeContact(row)}.`, { contact: toStructured(row) })
    } catch (err) {
      log.error({ err, contactId: id }, 'contact_update failed')
      return fail(`I could not update contact #${id}.`)
    }
  },
}

/* ───────────────────────────────── exports ───────────────────────────────── */

export const contactTools: ToolDef[] = [contactAdd, contactSearch, contactUpdate]

export const tools: ToolDef[] = contactTools
