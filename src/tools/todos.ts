/**
 * The shared household to-do list.
 *
 * These are the cheapest writes in the system: a to-do is a note to two adults,
 * not an action in the world, so the whole file sits in the `todo_write`
 * category and never needs an approval card. `todo_list` is a plain read.
 *
 * Two conventions the rest of the tool layer also follows:
 *  - handlers re-validate their arguments even though the SDK already did, and
 *    never throw — a bad call comes back as `fail()` text the model can read;
 *  - the text result is one sentence a human can be shown verbatim, and the
 *    machine-readable version goes in `structuredContent`.
 */
import { householdNow } from '../time.js'
import { and, asc, eq, ilike, lte, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { z } from 'zod'
import { audit } from '../audit/log.js'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { fail, ok } from './types.js'
import type { ToolDef } from './types.js'

const log = logger.child({ mod: 'tools/todos' })

/** Lifecycle of a to-do. `cancelled` means "dropped, not done". */
const TODO_STATUSES = ['open', 'done', 'cancelled'] as const
type TodoStatus = (typeof TODO_STATUSES)[number]

/** How many rows a single list call may return, whatever the model asks for. */
const MAX_LIST = 50
/** How many rows the text summary spells out before it starts counting. */
const MAX_TEXT_LINES = 25

/** Words that mean "no due date" / "nobody" in an update. */
const CLEAR_WORDS = new Set(['none', 'clear', 'unset', 'remove', 'no', 'nobody', '-'])

type TodoRow = typeof schema.todos.$inferSelect

/* ────────────────────────────── small helpers ────────────────────────────── */

/** Always a valid DateTime: a bad HOUSEHOLD_TIMEZONE falls back rather than yielding NaN. */
function nowLocal(): DateTime {
  return householdNow()
}

/** Escapes LIKE wildcards so a search for "50%" looks for a literal percent. */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

/** Reads a trimmed non-empty string out of unvalidated args, else undefined. */
function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

const WEEKDAY_NUMBERS: Record<string, number> = {
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  weds: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
  sunday: 7,
  sun: 7,
}

const MONTH_NUMBERS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
}

export type DueParse = { ok: true; date: string } | { ok: false; error: string }

const DUE_HELP =
  "Use 'YYYY-MM-DD', 'today', 'tomorrow', 'in 3 days', a weekday like 'friday' or 'next tuesday', a date like 'Sep 12', or 'none' to clear it."

/**
 * Turns the loose date wording a person types into a `yyyy-MM-dd` string in the
 * household timezone. Deterministic on purpose — no model call inside a tool.
 * A bare weekday means the next one that has not happened yet; `next <weekday>`
 * always lands in the following calendar week.
 */
export function normalizeDueDate(raw: string, now: DateTime): DueParse {
  const input = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^(due|by|on|the)\s+/, '')
  if (input === '') return { ok: false, error: `I need a due date. ${DUE_HELP}` }

  const today = now.startOf('day')

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(input)
  if (iso) {
    const parsed = DateTime.fromObject(
      { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) },
      { zone: now.zone },
    )
    if (!parsed.isValid) return { ok: false, error: `"${raw}" is not a real date.` }
    return { ok: true, date: parsed.toFormat('yyyy-MM-dd') }
  }

  const slash = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(input)
  if (slash) {
    const month = Number(slash[1])
    const day = Number(slash[2])
    const rawYear = slash[3]
    let year = today.year
    if (rawYear !== undefined) year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear)
    let parsed = DateTime.fromObject({ year, month, day }, { zone: now.zone })
    if (!parsed.isValid) return { ok: false, error: `"${raw}" is not a real date.` }
    // A bare M/D that already passed means next year.
    if (rawYear === undefined && parsed < today) parsed = parsed.plus({ years: 1 })
    return { ok: true, date: parsed.toFormat('yyyy-MM-dd') }
  }

  if (input === 'today' || input === 'tonight' || input === 'this evening') {
    return { ok: true, date: today.toFormat('yyyy-MM-dd') }
  }
  if (input === 'tomorrow' || input === 'tmrw' || input === 'tomorow') {
    return { ok: true, date: today.plus({ days: 1 }).toFormat('yyyy-MM-dd') }
  }
  if (input === 'day after tomorrow' || input === 'the day after tomorrow') {
    return { ok: true, date: today.plus({ days: 2 }).toFormat('yyyy-MM-dd') }
  }
  if (input === 'next week') {
    return { ok: true, date: today.plus({ weeks: 1 }).toFormat('yyyy-MM-dd') }
  }
  if (input === 'next month') {
    return { ok: true, date: today.plus({ months: 1 }).toFormat('yyyy-MM-dd') }
  }
  if (input === 'end of week' || input === 'this week') {
    // Friday of the current Monday-start week, or today if that already passed.
    const friday = today.startOf('week').plus({ days: 4 })
    return { ok: true, date: (friday < today ? today : friday).toFormat('yyyy-MM-dd') }
  }

  const inDays = /^in (\d{1,3}) (day|days|week|weeks|month|months)$/.exec(input)
  if (inDays) {
    const amount = Number(inDays[1])
    const unit = inDays[2] ?? 'days'
    const target = unit.startsWith('day')
      ? today.plus({ days: amount })
      : unit.startsWith('week')
        ? today.plus({ weeks: amount })
        : today.plus({ months: amount })
    return { ok: true, date: target.toFormat('yyyy-MM-dd') }
  }

  const weekday = /^(next |this |coming )?([a-z]+)$/.exec(input)
  if (weekday) {
    const target = WEEKDAY_NUMBERS[weekday[2] ?? '']
    if (target !== undefined) {
      const modifier = (weekday[1] ?? '').trim()
      return { ok: true, date: resolveWeekday(today, target, modifier === 'next').toFormat('yyyy-MM-dd') }
    }
  }

  // "Sep 12", "12 September", "December 24, 2026" — the reminder parser takes
  // these, so a due date has to as well, or the same wording means two things.
  const monthFirst = /^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/.exec(input)
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)(?:,? (\d{4}))?$/.exec(input)
  const named = monthFirst
    ? { month: MONTH_NUMBERS[monthFirst[1] ?? ''], day: Number(monthFirst[2]), year: monthFirst[3] }
    : dayFirst
      ? { month: MONTH_NUMBERS[dayFirst[2] ?? ''], day: Number(dayFirst[1]), year: dayFirst[3] }
      : null
  if (named && named.month !== undefined) {
    const year = named.year === undefined ? today.year : Number(named.year)
    let parsed = DateTime.fromObject({ year, month: named.month, day: named.day }, { zone: now.zone })
    if (!parsed.isValid) return { ok: false, error: `"${raw}" is not a real date.` }
    // A bare "Sep 12" that already passed means next year.
    if (named.year === undefined && parsed < today) parsed = parsed.plus({ years: 1 })
    return { ok: true, date: parsed.toFormat('yyyy-MM-dd') }
  }

  return { ok: false, error: `I could not read "${raw}" as a date. ${DUE_HELP}` }
}

/**
 * First date with `weekday` on or after `today`. With `forceNextWeek`, the
 * result is pushed past the end of the current Monday-start week, which is what
 * people mean by "next Tuesday" when today is already a Monday.
 */
function resolveWeekday(today: DateTime, weekday: number, forceNextWeek: boolean): DateTime {
  const delta = (weekday - today.weekday + 7) % 7
  let candidate = today.plus({ days: delta })
  if (forceNextWeek) {
    const endOfThisWeek = today.endOf('week')
    while (candidate <= endOfThisWeek) candidate = candidate.plus({ days: 7 })
  }
  return candidate
}

/** "today", "tomorrow", "Fri Sep 4" — whichever a tired parent reads fastest. */
export function formatDueLabel(date: string, now: DateTime): string {
  const parsed = DateTime.fromFormat(date, 'yyyy-MM-dd', { zone: now.zone })
  if (!parsed.isValid) return date
  const days = Math.round(parsed.startOf('day').diff(now.startOf('day'), 'days').days)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  if (days > 1 && days < 7) return parsed.toFormat('cccc') // "Friday"
  return parsed.toFormat('ccc MMM d') // "Fri Sep 4"
}

function describeTodo(row: TodoRow, now: DateTime): string {
  const bits: string[] = []
  if (row.dueDate) {
    const label = formatDueLabel(row.dueDate, now)
    const overdue = row.status === 'open' && row.dueDate < now.toFormat('yyyy-MM-dd')
    bits.push(overdue ? `due ${label} (overdue)` : `due ${label}`)
  }
  if (row.assignee) bits.push(row.assignee)
  if (row.status !== 'open') bits.push(row.status)
  const suffix = bits.length > 0 ? ` — ${bits.join(' · ')}` : ''
  return `#${row.id} ${row.title}${suffix}`
}

function toStructured(row: TodoRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    assignee: row.assignee,
    dueDate: row.dueDate,
    source: row.source,
    createdBy: row.createdBy,
    createdAt: row.createdAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  }
}

async function loadTodo(id: number): Promise<TodoRow | undefined> {
  const rows = await getDb().select().from(schema.todos).where(eq(schema.todos.id, id)).limit(1)
  return rows[0]
}

/* ──────────────────────────────── todo_add ───────────────────────────────── */

const addShape = {
  title: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe('What needs doing, phrased as an action: "Book dentist for Maya".'),
  notes: z.string().trim().max(2000).optional().describe('Any extra detail worth keeping.'),
  assignee: z
    .string()
    .trim()
    .max(80)
    .optional()
    .describe('Which household member owns it. Leave empty if it is unassigned.'),
  due: z
    .string()
    .trim()
    .max(64)
    .optional()
    .describe(
      "When it is due: 'YYYY-MM-DD', 'today', 'tomorrow', 'in 3 days', 'friday', 'next tuesday', 'Sep 12'.",
    ),
}
const addSchema = z.object(addShape)

const todoAdd: ToolDef = {
  name: 'todo_add',
  description:
    'Add an item to the shared household to-do list. Use this for anything someone needs to remember to DO. ' +
    'Use reminder_set instead when the household wants to be pinged at a specific time.',
  schema: addShape,
  category: 'todo_write',
  consequential: false,
  summarize: (args) => {
    const parsed = addSchema.safeParse(args)
    const title = parsed.success ? parsed.data.title : (readString(args['title']) ?? 'a new item')
    const due = parsed.success ? parsed.data.due : readString(args['due'])
    const assignee = parsed.success ? parsed.data.assignee : readString(args['assignee'])
    const duePart = due ? ` due ${due}` : ''
    const whoPart = assignee ? `, assigned to ${assignee}` : ''
    return `Add to-do: "${title}"${duePart}${whoPart}.`
  },
  handler: async (args, ctx) => {
    const parsed = addSchema.safeParse(args)
    if (!parsed.success) return fail(`I could not add that to-do: ${issueText(parsed.error)}`)
    const { title, notes, assignee } = parsed.data

    const now = nowLocal()
    let dueDate: string | null = null
    if (parsed.data.due !== undefined && !CLEAR_WORDS.has(parsed.data.due.toLowerCase())) {
      const due = normalizeDueDate(parsed.data.due, now)
      if (!due.ok) return fail(due.error)
      dueDate = due.date
    }

    try {
      const inserted = await getDb()
        .insert(schema.todos)
        .values({
          title,
          notes: notes ?? null,
          status: 'open',
          assignee: assignee ?? null,
          dueDate,
          source: ctx.origin === 'watcher' ? 'watcher' : 'chat',
          createdBy: ctx.actor,
        })
        .returning()

      const row = inserted[0]
      if (!row) return fail('The to-do could not be saved. Nothing was written.')

      await audit({
        actor: ctx.actor,
        event: 'todo.add',
        category: 'todo_write',
        toolName: 'todo_add',
        args: { title, dueDate, assignee: assignee ?? null },
        resultSummary: `todo #${row.id}`,
        ok: true,
      })
      log.info({ todoId: row.id, actor: ctx.actor }, 'todo added')

      const duePart = dueDate ? `, due ${formatDueLabel(dueDate, now)}` : ''
      const whoPart = assignee ? ` for ${assignee}` : ''
      return ok(`Added to-do #${row.id}: "${row.title}"${duePart}${whoPart}.`, {
        todo: toStructured(row),
      })
    } catch (err) {
      log.error({ err }, 'todo_add failed')
      return fail('I could not save that to-do — the database rejected the write.')
    }
  },
}

/* ──────────────────────────────── todo_list ──────────────────────────────── */

const listShape = {
  status: z
    .enum(['open', 'done', 'cancelled', 'all'])
    .default('open')
    .describe('Which items to return. Defaults to open items only.'),
  assignee: z.string().trim().max(80).optional().describe('Only items owned by this person.'),
  dueBefore: z
    .string()
    .trim()
    .max(64)
    .optional()
    .describe("Only items due on or before this date, e.g. 'today', 'friday', '2026-09-04'."),
  search: z.string().trim().max(200).optional().describe('Only items whose title or notes contain this text.'),
  limit: z.coerce.number().int().min(1).default(25).describe('Maximum items to return (capped at 50).'),
}
const listSchema = z.object(listShape)

const todoList: ToolDef = {
  name: 'todo_list',
  description:
    'List household to-dos. Filter by status, assignee, due date, or free text. ' +
    'Call this before completing or updating an item so you have the right id.',
  schema: listShape,
  category: 'read',
  consequential: false,
  readOnly: true,
  summarize: (args) => {
    const status = readString(args['status']) ?? 'open'
    const assignee = readString(args['assignee'])
    return `List ${status} to-dos${assignee ? ` for ${assignee}` : ''}.`
  },
  handler: async (args) => {
    const parsed = listSchema.safeParse(args)
    if (!parsed.success) return fail(`I could not read that to-do filter: ${issueText(parsed.error)}`)
    const { status, assignee, search } = parsed.data
    const limit = Math.min(parsed.data.limit, MAX_LIST)
    const now = nowLocal()

    const conditions: SQL[] = []
    if (status !== 'all') conditions.push(eq(schema.todos.status, status))
    if (assignee) conditions.push(ilike(schema.todos.assignee, likePattern(assignee)))
    if (search) {
      const pattern = likePattern(search)
      const match = or(ilike(schema.todos.title, pattern), ilike(schema.todos.notes, pattern))
      if (match) conditions.push(match)
    }
    if (parsed.data.dueBefore !== undefined) {
      const due = normalizeDueDate(parsed.data.dueBefore, now)
      if (!due.ok) return fail(due.error)
      conditions.push(lte(schema.todos.dueDate, due.date))
    }

    try {
      const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions)
      const rows = await getDb()
        .select()
        .from(schema.todos)
        .where(where)
        .orderBy(
          sql`case when ${schema.todos.status} = 'open' then 0 else 1 end`,
          sql`${schema.todos.dueDate} asc nulls last`,
          asc(schema.todos.id),
        )
        .limit(limit)

      if (rows.length === 0) {
        return ok(status === 'open' ? 'Nothing open on the to-do list.' : 'No to-dos match that filter.', {
          todos: [],
          count: 0,
        })
      }

      const lines = rows.slice(0, MAX_TEXT_LINES).map((row) => describeTodo(row, now))
      if (rows.length > MAX_TEXT_LINES) lines.push(`…and ${rows.length - MAX_TEXT_LINES} more.`)
      const heading = `${rows.length} ${status === 'all' ? '' : `${status} `}to-do${rows.length === 1 ? '' : 's'}:`

      return ok(`${heading}\n${lines.join('\n')}`, {
        todos: rows.map(toStructured),
        count: rows.length,
      })
    } catch (err) {
      log.error({ err }, 'todo_list failed')
      return fail('I could not read the to-do list right now.')
    }
  },
}

/* ────────────────────────────── todo_complete ────────────────────────────── */

const completeShape = {
  id: z.coerce.number().int().positive().describe('The to-do id, as shown by todo_list.'),
}
const completeSchema = z.object(completeShape)

const todoComplete: ToolDef = {
  name: 'todo_complete',
  description: 'Mark one to-do as done. Get the id from todo_list first.',
  schema: completeShape,
  category: 'todo_write',
  consequential: false,
  summarize: (args) => `Mark to-do #${String(args['id'] ?? '?')} done.`,
  handler: async (args, ctx) => {
    const parsed = completeSchema.safeParse(args)
    if (!parsed.success) return fail(`I need a numeric to-do id: ${issueText(parsed.error)}`)
    const { id } = parsed.data

    try {
      const updated = await getDb()
        .update(schema.todos)
        .set({ status: 'done', completedAt: new Date() })
        .where(and(eq(schema.todos.id, id), eq(schema.todos.status, 'open')))
        .returning()

      const row = updated[0]
      if (!row) {
        const existing = await loadTodo(id)
        if (!existing) return fail(`There is no to-do #${id}.`)
        return ok(`To-do #${id} "${existing.title}" was already ${existing.status}.`, {
          todo: toStructured(existing),
          changed: false,
        })
      }

      await audit({
        actor: ctx.actor,
        event: 'todo.complete',
        category: 'todo_write',
        toolName: 'todo_complete',
        args: { id },
        resultSummary: row.title,
        ok: true,
      })
      log.info({ todoId: id, actor: ctx.actor }, 'todo completed')
      return ok(`Done: "${row.title}" is off the list.`, { todo: toStructured(row), changed: true })
    } catch (err) {
      log.error({ err, todoId: id }, 'todo_complete failed')
      return fail(`I could not mark to-do #${id} done.`)
    }
  },
}

/* ─────────────────────────────── todo_update ─────────────────────────────── */

const updateShape = {
  id: z.coerce.number().int().positive().describe('The to-do id, as shown by todo_list.'),
  title: z.string().trim().min(1).max(300).optional().describe('New wording for the item.'),
  notes: z.string().trim().max(2000).optional().describe("New notes. Pass 'none' to clear them."),
  assignee: z.string().trim().max(80).optional().describe("New owner. Pass 'none' to unassign."),
  due: z
    .string()
    .trim()
    .max(64)
    .optional()
    .describe("New due date, in the same wording todo_add accepts. Pass 'none' to clear it."),
  status: z.enum(['open', 'done', 'cancelled']).optional().describe('Move the item to another status.'),
}
const updateSchema = z.object(updateShape)

const todoUpdate: ToolDef = {
  name: 'todo_update',
  description:
    'Change an existing to-do: reword it, move the due date, hand it to someone else, or reopen it. ' +
    "Pass 'none' for due, notes, or assignee to clear that field.",
  schema: updateShape,
  category: 'todo_write',
  consequential: false,
  summarize: (args) => {
    const id = String(args['id'] ?? '?')
    const parts: string[] = []
    const title = readString(args['title'])
    const due = readString(args['due'])
    const assignee = readString(args['assignee'])
    const status = readString(args['status'])
    if (title) parts.push(`rename to "${title}"`)
    if (due) parts.push(CLEAR_WORDS.has(due.toLowerCase()) ? 'clear the due date' : `move the due date to ${due}`)
    if (assignee) parts.push(CLEAR_WORDS.has(assignee.toLowerCase()) ? 'unassign it' : `assign it to ${assignee}`)
    if (status) parts.push(`set it ${status}`)
    if (readString(args['notes'])) parts.push('update the notes')
    return `Update to-do #${id}: ${parts.length > 0 ? parts.join(', ') : 'no changes'}.`
  },
  handler: async (args, ctx) => {
    const parsed = updateSchema.safeParse(args)
    if (!parsed.success) return fail(`I could not read that update: ${issueText(parsed.error)}`)
    const { id, title, notes, assignee, status } = parsed.data
    const now = nowLocal()

    const patch: Partial<typeof schema.todos.$inferInsert> = {}
    if (title !== undefined) patch.title = title
    if (notes !== undefined) patch.notes = CLEAR_WORDS.has(notes.toLowerCase()) ? null : notes
    if (assignee !== undefined) patch.assignee = CLEAR_WORDS.has(assignee.toLowerCase()) ? null : assignee
    if (parsed.data.due !== undefined) {
      if (CLEAR_WORDS.has(parsed.data.due.toLowerCase())) {
        patch.dueDate = null
      } else {
        const due = normalizeDueDate(parsed.data.due, now)
        if (!due.ok) return fail(due.error)
        patch.dueDate = due.date
      }
    }
    if (status !== undefined) {
      patch.status = status
      patch.completedAt = status === 'done' ? new Date() : null
    }

    if (Object.keys(patch).length === 0) {
      return fail('Tell me what to change: title, notes, assignee, due, or status.')
    }

    try {
      const updated = await getDb().update(schema.todos).set(patch).where(eq(schema.todos.id, id)).returning()
      const row = updated[0]
      if (!row) return fail(`There is no to-do #${id}.`)

      await audit({
        actor: ctx.actor,
        event: 'todo.update',
        category: 'todo_write',
        toolName: 'todo_update',
        args: { id, ...patch },
        resultSummary: row.title,
        ok: true,
      })
      log.info({ todoId: id, actor: ctx.actor }, 'todo updated')

      const duePart = row.dueDate ? `, due ${formatDueLabel(row.dueDate, now)}` : ''
      const whoPart = row.assignee ? `, ${row.assignee}` : ''
      return ok(`Updated to-do #${row.id}: "${row.title}"${duePart}${whoPart} (${row.status}).`, {
        todo: toStructured(row),
      })
    } catch (err) {
      log.error({ err, todoId: id }, 'todo_update failed')
      return fail(`I could not update to-do #${id}.`)
    }
  },
}

/* ─────────────────────────────── todo_delete ─────────────────────────────── */

const deleteShape = {
  id: z.coerce.number().int().positive().describe('The to-do id, as shown by todo_list.'),
}
const deleteSchema = z.object(deleteShape)

const todoDelete: ToolDef = {
  name: 'todo_delete',
  description:
    'Remove a to-do from the list entirely. Prefer todo_complete when the item actually got done, ' +
    "and todo_update with status 'cancelled' when it was dropped but worth remembering.",
  schema: deleteShape,
  category: 'todo_write',
  consequential: false,
  summarize: (args) => `Delete to-do #${String(args['id'] ?? '?')} from the list.`,
  handler: async (args, ctx) => {
    const parsed = deleteSchema.safeParse(args)
    if (!parsed.success) return fail(`I need a numeric to-do id: ${issueText(parsed.error)}`)
    const { id } = parsed.data

    try {
      const removed = await getDb().delete(schema.todos).where(eq(schema.todos.id, id)).returning()
      const row = removed[0]
      if (!row) return fail(`There is no to-do #${id}.`)

      await audit({
        actor: ctx.actor,
        event: 'todo.delete',
        category: 'todo_write',
        toolName: 'todo_delete',
        args: { id, title: row.title },
        resultSummary: row.title,
        ok: true,
      })
      log.info({ todoId: id, actor: ctx.actor }, 'todo deleted')
      return ok(`Deleted to-do #${id}: "${row.title}".`, { todo: toStructured(row), deleted: true })
    } catch (err) {
      log.error({ err, todoId: id }, 'todo_delete failed')
      return fail(`I could not delete to-do #${id}.`)
    }
  },
}

/* ───────────────────────────────── exports ───────────────────────────────── */

/** Flattens a ZodError into one short clause for the model to read. */
function issueText(error: z.ZodError): string {
  const first = error.issues[0]
  if (!first) return 'the arguments were not valid'
  const path = first.path.join('.')
  return path === '' ? first.message : `${path}: ${first.message}`
}

export const todoTools: ToolDef[] = [todoAdd, todoList, todoComplete, todoUpdate, todoDelete]

export const tools: ToolDef[] = todoTools

export type { TodoStatus }
