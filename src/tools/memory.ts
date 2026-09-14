/**
 * Long-term household memory: the small durable facts that make the assistant
 * feel like it lives here. Shoe sizes, the pediatrician's name, who hates
 * cilantro, which bin goes out on Tuesday.
 *
 * Two design rules keep this from turning into a landfill:
 *  1. `memory_save` deduplicates. Restating a fact the household already told
 *     us updates the existing row instead of adding a near-identical one, so
 *     the context preamble stays short and never contradicts itself.
 *  2. Forgetting is a soft delete. `active = false` keeps the history for the
 *     audit trail while taking the fact out of every prompt.
 */
import { and, desc, eq, ilike, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from '../audit/log.js'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { fail, ok } from './types.js'
import type { ToolDef } from './types.js'

const log = logger.child({ mod: 'tools/memory' })

/** Hard ceiling on search results, per the tool contract. */
const SEARCH_LIMIT = 25
const LIST_LIMIT = 50
const MAX_TEXT_LINES = 25

/**
 * How alike two fact strings must be before a save is treated as a restatement
 * rather than a new fact. Deliberately strict: a false merge silently destroys
 * something the household told us, while a false split just leaves two facts
 * the model can reconcile and retire. "Maya wears size 11 shoes" replaces "Maya
 * wears size 10 shoes"; "Maya likes skiing" does not replace "Maya likes
 * swimming".
 *
 * The bar sits above raw Dice on purpose. Two four-word facts that differ in
 * one word score 0.75 — "trash goes out on tuesday" against "recycling goes out
 * on tuesday" — and those are different facts, not a restatement. Every case
 * this tool is *meant* to merge clears 0.9: an exact match scores 1, one fact
 * containing the other scores 0.95, and a same-sentence-different-number
 * restatement scores 0.9. Nothing legitimate lives in the 0.72–0.8 band.
 */
const DEDUPE_THRESHOLD = 0.9

/**
 * Content dice above which two facts differing only in a number are the same
 * fact. This is a *different* bar from `DEDUPE_THRESHOLD`: it scores only the
 * non-numeric words, and clearing it lifts the pair's overall score to exactly
 * 0.9 — the merge bar — rather than merging on its own.
 */
const NUMERIC_RESTATEMENT_THRESHOLD = 0.8

/** Words too common to carry meaning when comparing two facts. */
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'for',
  'from',
  'has',
  'have',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'they',
  'this',
  'to',
  'was',
  'were',
  'with',
])

type MemoryRow = typeof schema.memoryFacts.$inferSelect

/* ───────────────────────────── similarity maths ──────────────────────────── */

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function contentTokens(value: string): string[] {
  const words = normalizeText(value).split(' ').filter(Boolean)
  const kept = words.filter((word) => !STOP_WORDS.has(word))
  return kept.length > 0 ? kept : words
}

/** "11", "6pm", "30pm" — a token whose meaning is the number it carries. */
function isNumericToken(token: string): boolean {
  return /^\d+[a-z]{0,3}$/.test(token)
}

function diceCoefficient(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left)
  const b = new Set(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return (2 * shared) / (a.size + b.size)
}

/**
 * 0…1 overlap between two facts. Exact matches and containment score high; the
 * rest is a Dice coefficient over content words, which is stable, cheap, and
 * has no model call in it.
 *
 * One special case earns its keep: when both facts say the same thing around a
 * different number — a shoe size, a bedtime, a dose — the number is the update,
 * so the surrounding words decide. That is what makes "dinner at 6pm" and
 * "dinner at 6:30pm" one fact instead of two contradictory ones.
 */
export function factSimilarity(a: string, b: string): number {
  const left = normalizeText(a)
  const right = normalizeText(b)
  if (left === '' || right === '') return 0
  if (left === right) return 1

  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  if (longer.includes(shorter) && shorter.length >= longer.length * 0.5) return 0.95

  const leftTokens = contentTokens(a)
  const rightTokens = contentTokens(b)
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0

  const tokenScore = diceCoefficient(leftTokens, rightTokens)

  const leftWords = leftTokens.filter((token) => !isNumericToken(token))
  const rightWords = rightTokens.filter((token) => !isNumericToken(token))
  const hasNumbers = leftWords.length !== leftTokens.length || rightWords.length !== rightTokens.length
  if (hasNumbers && leftWords.length > 0 && rightWords.length > 0) {
    const wordScore = diceCoefficient(leftWords, rightWords)
    if (wordScore >= NUMERIC_RESTATEMENT_THRESHOLD) return Math.max(tokenScore, 0.9)
  }

  return tokenScore
}

/* ────────────────────────────── small helpers ────────────────────────────── */

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function issueText(error: z.ZodError): string {
  const first = error.issues[0]
  if (!first) return 'the arguments were not valid'
  const path = first.path.join('.')
  return path === '' ? first.message : `${path}: ${first.message}`
}

/** Escapes the wildcards so a user's `%` searches for a literal percent sign. */
function likePattern(query: string): string {
  return `%${escapeLike(query)}%`
}

/**
 * Escapes LIKE wildcards without adding any, so an `ilike` against the result
 * is a case-insensitive equality test. The dedupe lookup in `memory_save` needs
 * exactly that: an unescaped `%` or `_` in a subject would widen the lookup to
 * other subjects' facts, and the winner of that comparison gets overwritten.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function toStructured(row: MemoryRow): Record<string, unknown> {
  return {
    id: row.id,
    subject: row.subject,
    category: row.category,
    fact: row.fact,
    active: row.active,
    source: row.source,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  }
}

function describeFact(row: MemoryRow): string {
  return `#${row.id} ${row.subject}: ${row.fact}${row.active ? '' : ' (forgotten)'}`
}

/* ─────────────────────────────── memory_save ─────────────────────────────── */

const saveShape = {
  subject: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe('Who or what the fact is about: a person, a pet, the house, a service. Reuse existing subjects.'),
  fact: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe('The fact itself, as one self-contained sentence that will still make sense in a year.'),
  category: z
    .string()
    .trim()
    .max(60)
    .default('general')
    .describe("A loose grouping: 'preference', 'medical', 'schedule', 'logistics', 'general'."),
}
const saveSchema = z.object(saveShape)

const memorySave: ToolDef = {
  name: 'memory_save',
  description:
    'Remember a durable fact about the household. Save preferences, constraints, names, and standing arrangements — ' +
    'not one-off events, which belong on the calendar or the to-do list. Restating a known fact updates it in place.',
  schema: saveShape,
  category: 'memory_write',
  consequential: false,
  summarize: (args) => {
    const subject = readString(args['subject']) ?? 'the household'
    const fact = readString(args['fact']) ?? 'something'
    return `Remember about ${subject}: ${fact}`
  },
  handler: async (args, ctx) => {
    const parsed = saveSchema.safeParse(args)
    if (!parsed.success) return fail(`I could not save that fact: ${issueText(parsed.error)}`)
    const { subject, fact, category } = parsed.data

    try {
      const db = getDb()
      // ilike against an escaped literal is a case-insensitive equality test.
      const siblings = await db
        .select()
        .from(schema.memoryFacts)
        .where(
          and(eq(schema.memoryFacts.active, true), ilike(schema.memoryFacts.subject, escapeLike(subject))),
        )
        .orderBy(desc(schema.memoryFacts.updatedAt))
        .limit(100)

      let best: { row: MemoryRow; score: number } | null = null
      for (const row of siblings) {
        const score = factSimilarity(row.fact, fact)
        if (score >= DEDUPE_THRESHOLD && (best === null || score > best.score)) best = { row, score }
      }

      if (best) {
        if (best.row.fact === fact && best.row.category === category) {
          return ok(`Already remembered: ${subject} — ${fact}`, {
            fact: toStructured(best.row),
            action: 'unchanged',
          })
        }
        const updated = await db
          .update(schema.memoryFacts)
          .set({ fact, category, updatedAt: new Date(), active: true })
          .where(eq(schema.memoryFacts.id, best.row.id))
          .returning()
        const row = updated[0]
        if (!row) return fail('I could not update that fact.')

        await audit({
          actor: ctx.actor,
          event: 'memory.update',
          category: 'memory_write',
          toolName: 'memory_save',
          args: { id: row.id, subject, fact, previous: best.row.fact },
          resultSummary: `${subject}: ${fact}`,
          ok: true,
        })
        log.info({ factId: row.id, score: best.score }, 'memory fact updated in place')

        return ok(`Updated what I knew about ${subject}: ${fact} (was "${best.row.fact}").`, {
          fact: toStructured(row),
          previousFact: best.row.fact,
          action: 'updated',
        })
      }

      const inserted = await db
        .insert(schema.memoryFacts)
        .values({
          subject,
          category,
          fact,
          active: true,
          source: ctx.origin === 'watcher' ? 'watcher' : 'chat',
        })
        .returning()
      const row = inserted[0]
      if (!row) return fail('The fact could not be saved.')

      await audit({
        actor: ctx.actor,
        event: 'memory.save',
        category: 'memory_write',
        toolName: 'memory_save',
        args: { subject, fact, category },
        resultSummary: `fact #${row.id}`,
        ok: true,
      })
      log.info({ factId: row.id, subject }, 'memory fact saved')

      return ok(`Noted — ${subject}: ${fact}`, { fact: toStructured(row), action: 'created' })
    } catch (err) {
      log.error({ err }, 'memory_save failed')
      return fail('I could not save that fact — the database rejected the write.')
    }
  },
}

/* ────────────────────────────── memory_search ────────────────────────────── */

const searchShape = {
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('Free text matched against both the subject and the fact. One or two words works best.'),
  subject: z.string().trim().max(120).optional().describe('Narrow the search to one subject.'),
  includeForgotten: z
    .boolean()
    .default(false)
    .describe('Also return facts that were forgotten. Off by default.'),
  limit: z.coerce.number().int().min(1).default(SEARCH_LIMIT).describe('Maximum results (capped at 25).'),
}
const searchSchema = z.object(searchShape)

const memorySearch: ToolDef = {
  name: 'memory_search',
  description:
    'Search household memory for what you already know about a person, place, or topic. ' +
    'Check here before asking the household something they may have told you already.',
  schema: searchShape,
  category: 'read',
  consequential: false,
  readOnly: true,
  summarize: (args) => `Search memory for "${readString(args['query']) ?? ''}".`,
  handler: async (args) => {
    const parsed = searchSchema.safeParse(args)
    if (!parsed.success) return fail(`I could not run that memory search: ${issueText(parsed.error)}`)
    const { query, subject, includeForgotten } = parsed.data
    const limit = Math.min(parsed.data.limit, SEARCH_LIMIT)

    try {
      const pattern = likePattern(query)
      const conditions: SQL[] = []
      const textMatch = or(ilike(schema.memoryFacts.subject, pattern), ilike(schema.memoryFacts.fact, pattern))
      if (textMatch) conditions.push(textMatch)
      if (!includeForgotten) conditions.push(eq(schema.memoryFacts.active, true))
      if (subject) conditions.push(ilike(schema.memoryFacts.subject, likePattern(subject)))

      const rows = await getDb()
        .select()
        .from(schema.memoryFacts)
        .where(conditions.length === 1 ? conditions[0] : and(...conditions))
        .orderBy(desc(schema.memoryFacts.updatedAt), desc(schema.memoryFacts.id))
        .limit(limit)

      if (rows.length === 0) {
        return ok(`I do not know anything about "${query}".`, { facts: [], count: 0, query })
      }

      const lines = rows.map(describeFact)
      return ok(`${rows.length} fact${rows.length === 1 ? '' : 's'} about "${query}":\n${lines.join('\n')}`, {
        facts: rows.map(toStructured),
        count: rows.length,
        query,
      })
    } catch (err) {
      log.error({ err }, 'memory_search failed')
      return fail('I could not search memory right now.')
    }
  },
}

/* ─────────────────────────────── memory_list ─────────────────────────────── */

const listShape = {
  subject: z.string().trim().max(120).optional().describe('Only facts about this subject.'),
  category: z.string().trim().max(60).optional().describe("Only facts in this grouping, e.g. 'medical'."),
  includeForgotten: z.boolean().default(false).describe('Also return facts that were forgotten.'),
  limit: z.coerce.number().int().min(1).default(30).describe('Maximum facts to return (capped at 50).'),
}
const listSchema = z.object(listShape)

const memoryList: ToolDef = {
  name: 'memory_list',
  description:
    'List remembered facts, most recently updated first. Use memory_search when you know what you are looking for.',
  schema: listShape,
  category: 'read',
  consequential: false,
  readOnly: true,
  summarize: (args) => {
    const subject = readString(args['subject'])
    return subject ? `List everything remembered about ${subject}.` : 'List remembered household facts.'
  },
  handler: async (args) => {
    const parsed = listSchema.safeParse(args)
    if (!parsed.success) return fail(`I could not read that memory filter: ${issueText(parsed.error)}`)
    const { subject, category, includeForgotten } = parsed.data
    const limit = Math.min(parsed.data.limit, LIST_LIMIT)

    try {
      const conditions: SQL[] = []
      if (!includeForgotten) conditions.push(eq(schema.memoryFacts.active, true))
      if (subject) conditions.push(ilike(schema.memoryFacts.subject, likePattern(subject)))
      if (category) conditions.push(ilike(schema.memoryFacts.category, likePattern(category)))
      const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions)

      const rows = await getDb()
        .select()
        .from(schema.memoryFacts)
        .where(where)
        .orderBy(desc(schema.memoryFacts.updatedAt), desc(schema.memoryFacts.id))
        .limit(limit)

      if (rows.length === 0) return ok('Nothing is remembered yet.', { facts: [], count: 0 })

      const lines = rows.slice(0, MAX_TEXT_LINES).map(describeFact)
      if (rows.length > MAX_TEXT_LINES) lines.push(`…and ${rows.length - MAX_TEXT_LINES} more.`)

      return ok(`${rows.length} remembered fact${rows.length === 1 ? '' : 's'}:\n${lines.join('\n')}`, {
        facts: rows.map(toStructured),
        count: rows.length,
      })
    } catch (err) {
      log.error({ err }, 'memory_list failed')
      return fail('I could not read household memory right now.')
    }
  },
}

/* ────────────────────────────── memory_forget ────────────────────────────── */

const forgetShape = {
  id: z.coerce.number().int().positive().describe('The fact id, as shown by memory_search or memory_list.'),
}
const forgetSchema = z.object(forgetShape)

const memoryForget: ToolDef = {
  name: 'memory_forget',
  description:
    'Retire a fact that is no longer true. The row is kept for the audit trail but stops appearing in your context.',
  schema: forgetShape,
  category: 'memory_write',
  consequential: false,
  summarize: (args) => `Forget remembered fact #${String(args['id'] ?? '?')}.`,
  handler: async (args, ctx) => {
    const parsed = forgetSchema.safeParse(args)
    if (!parsed.success) return fail(`I need a numeric fact id: ${issueText(parsed.error)}`)
    const { id } = parsed.data

    try {
      const updated = await getDb()
        .update(schema.memoryFacts)
        .set({ active: false, updatedAt: new Date() })
        .where(and(eq(schema.memoryFacts.id, id), eq(schema.memoryFacts.active, true)))
        .returning()

      const row = updated[0]
      if (!row) {
        const existing = await getDb()
          .select()
          .from(schema.memoryFacts)
          .where(eq(schema.memoryFacts.id, id))
          .limit(1)
        const found = existing[0]
        if (!found) return fail(`There is no remembered fact #${id}.`)
        return ok(`Fact #${id} was already forgotten.`, { fact: toStructured(found), changed: false })
      }

      await audit({
        actor: ctx.actor,
        event: 'memory.forget',
        category: 'memory_write',
        toolName: 'memory_forget',
        args: { id, subject: row.subject, fact: row.fact },
        resultSummary: `${row.subject}: ${row.fact}`,
        ok: true,
      })
      log.info({ factId: id, actor: ctx.actor }, 'memory fact forgotten')

      return ok(`Forgotten — ${row.subject}: ${row.fact}`, { fact: toStructured(row), changed: true })
    } catch (err) {
      log.error({ err, factId: id }, 'memory_forget failed')
      return fail(`I could not forget fact #${id}.`)
    }
  },
}

/* ───────────────────────────────── exports ───────────────────────────────── */

export const memoryTools: ToolDef[] = [memorySave, memorySearch, memoryList, memoryForget]

export const tools: ToolDef[] = memoryTools
