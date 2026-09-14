/**
 * Shared machinery for the predefined workflows.
 *
 * ## What a workflow is, and what it is not
 *
 * A workflow is a *kickoff*, not a script. Telegram is asynchronous: a function
 * cannot stand still waiting for a spouse to answer "swap the salmon one" or
 * "yes, book it". So every workflow does the same three things and returns:
 *
 *  1. Gather the cheap, deterministic facts from Postgres and the integrations,
 *     so the model does not spend paid turns rediscovering what a SELECT knows.
 *  2. Run exactly one agent turn through `runTurn`, carrying those facts plus a
 *     *playbook* — the numbered steps for the rest of the exchange.
 *  3. Return. The household replies in chat, the session resumes, and the model
 *     continues from the playbook it was given.
 *
 * The playbook is why the multi-step workflows (meal prep, booking, calls) do
 * not commit anything on the first turn: step one is always "propose and stop".
 *
 * ## Failure
 *
 * `runWorkflow` wraps every entry point. A thrown error becomes one short
 * sentence to both spouses — "I couldn't finish the morning brief: …" — because
 * the alternative is a cron that fails in silence for a fortnight.
 *
 * A turn that merely comes back `ok: false` is *not* re-reported here: `runTurn`
 * has already delivered its own apology to the chat, and two apologies for one
 * failure is worse than one.
 */
import { and, asc, desc, eq, gte, isNotNull, lt, lte } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { getConfig } from '../config.js'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { listPending } from '../policy/pending.js'
import { primaryChatId, sendToChat } from '../telegram/send.js'

export const log = logger.child({ mod: 'workflows' })

/** How a workflow was started. Decides the cost-accounting trigger. */
export type WorkflowTrigger = 'cron' | 'command'

/** `runTurn`'s trigger for a workflow started this way. */
export function turnTrigger(trigger: WorkflowTrigger): 'cron' | 'workflow' {
  return trigger === 'cron' ? 'cron' : 'workflow'
}

/* ────────────────────────────── errors and time ──────────────────────────── */

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err) ?? String(err)
  } catch {
    return String(err)
  }
}

/** Household timezone, or UTC when the config cannot be read. */
export function zone(): string {
  try {
    return getConfig().HOUSEHOLD_TIMEZONE
  } catch {
    return 'UTC'
  }
}

/** Now, in the household timezone. Falls back to the process zone if that is invalid. */
export function nowLocal(): DateTime {
  const local = DateTime.now().setZone(zone())
  if (local.isValid) return local
  log.warn({ zone: zone() }, 'invalid household timezone, using the process zone')
  return DateTime.now()
}

export function today(): string {
  return nowLocal().toFormat('yyyy-MM-dd')
}

/** "Monday 31 August 2026". */
export function longDate(dt: DateTime = nowLocal()): string {
  return dt.toFormat('cccc d LLLL yyyy')
}

/* ──────────────────────────────── delivery ───────────────────────────────── */

/** Every whitelisted spouse's private chat id. Empty when config is unreadable. */
export function householdChatIds(): string[] {
  try {
    return [...getConfig().telegramUserIds]
  } catch (err) {
    log.error({ err: describeError(err) }, 'no telegram recipients configured')
    return []
  }
}

/**
 * The chat a workflow runs its turn in: the primary spouse, falling back to the
 * first whitelisted id. Null means nobody is configured and there is no point
 * spending a turn.
 */
export async function workflowChatId(): Promise<string | null> {
  try {
    return await primaryChatId()
  } catch (err) {
    log.error({ err: describeError(err) }, 'could not resolve a chat for the workflow')
    return householdChatIds()[0] ?? null
  }
}

/**
 * Delivers a copy of `text` to every spouse other than `except`.
 *
 * `runTurn` sends the turn's reply to the one chat it ran in; this is how a
 * broadcast workflow like the brief reaches the other half of the household
 * without sending the first one two identical messages.
 */
export async function fanOut(text: string, except: string): Promise<void> {
  const body = text.trim()
  if (!body) return
  for (const chatId of householdChatIds()) {
    if (chatId === except) continue
    await sendToChat(chatId, body, { markdown: false })
  }
}

/** One short line to both spouses. Plain text — workflow copy is never markup. */
export async function tellHousehold(text: string): Promise<void> {
  for (const chatId of householdChatIds()) {
    await sendToChat(chatId, text, { markdown: false })
  }
}

/**
 * The wrapper every exported workflow runs inside.
 *
 * @param label how the failure names itself: "morning brief" becomes
 * "I couldn't finish the morning brief: …".
 */
export async function runWorkflow(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    const reason = describeError(err)
    log.error({ workflow: label, err }, 'workflow failed')
    try {
      await tellHousehold(`I couldn't finish the ${label}: ${reason.slice(0, 300)}`)
    } catch (sendErr) {
      // Last line of defence. A cron must not die because Telegram is down.
      log.error({ workflow: label, err: describeError(sendErr) }, 'could not report the failure')
    }
  }
}

/* ────────────────────────── deterministic fact reads ─────────────────────── */

/**
 * Everything below is a plain SELECT the model would otherwise pay a tool round
 * trip for. Each one is capped, each one is ordered, and none of them throw
 * shapes the formatters cannot render.
 */

export interface TodoFact {
  id: number
  title: string
  dueDate: string | null
  assignee: string | null
  /** Days overdue; 0 means due today. */
  overdueDays: number
}

/** Open to-dos due today or already past due, soonest-overdue last. */
export async function todosDueOrOverdue(limit = 15): Promise<TodoFact[]> {
  const cutoff = today()
  const rows = await getDb()
    .select({
      id: schema.todos.id,
      title: schema.todos.title,
      dueDate: schema.todos.dueDate,
      assignee: schema.todos.assignee,
    })
    .from(schema.todos)
    .where(
      and(
        eq(schema.todos.status, 'open'),
        isNotNull(schema.todos.dueDate),
        lte(schema.todos.dueDate, cutoff),
      ),
    )
    .orderBy(asc(schema.todos.dueDate))
    .limit(limit)

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    dueDate: row.dueDate,
    assignee: row.assignee,
    overdueDays: daysBefore(row.dueDate, cutoff),
  }))
}

/**
 * Open to-dos created more than `olderThanDays` ago, oldest first — due date or
 * not. The weekly review never shows `todosDueOrOverdue`, so overdue items must
 * be able to surface here or they would never appear in a review at all.
 */
export async function staleTodos(olderThanDays = 14, limit = 10): Promise<TodoFact[]> {
  const before = nowLocal().minus({ days: olderThanDays }).toJSDate()
  const rows = await getDb()
    .select({
      id: schema.todos.id,
      title: schema.todos.title,
      dueDate: schema.todos.dueDate,
      assignee: schema.todos.assignee,
    })
    .from(schema.todos)
    .where(and(eq(schema.todos.status, 'open'), lt(schema.todos.createdAt, before)))
    .orderBy(asc(schema.todos.createdAt))
    .limit(limit)

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    dueDate: row.dueDate,
    assignee: row.assignee,
    overdueDays: daysBefore(row.dueDate, today()),
  }))
}

/** To-dos closed inside the window, most recent first. */
export async function completedSince(since: Date, limit = 30): Promise<TodoFact[]> {
  const rows = await getDb()
    .select({
      id: schema.todos.id,
      title: schema.todos.title,
      dueDate: schema.todos.dueDate,
      assignee: schema.todos.assignee,
    })
    .from(schema.todos)
    .where(and(eq(schema.todos.status, 'done'), gte(schema.todos.completedAt, since)))
    .orderBy(desc(schema.todos.completedAt))
    .limit(limit)

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    dueDate: row.dueDate,
    assignee: row.assignee,
    overdueDays: 0,
  }))
}

export interface FollowupFact {
  id: number
  description: string
  nagCount: number
}

/** Follow-ups still being chased, most-nagged first. */
export async function openFollowups(limit = 12): Promise<FollowupFact[]> {
  const rows = await getDb()
    .select({
      id: schema.followups.id,
      description: schema.followups.description,
      nagCount: schema.followups.nagCount,
    })
    .from(schema.followups)
    .where(eq(schema.followups.status, 'open'))
    .orderBy(desc(schema.followups.nagCount), asc(schema.followups.id))
    .limit(limit)
  return rows
}

export interface PendingFact {
  id: number
  summary: string
}

/** Approvals nobody has tapped yet. */
export async function waitingApprovals(limit = 10): Promise<PendingFact[]> {
  const rows = await listPending()
  return rows.slice(0, limit).map((row) => ({ id: row.id, summary: row.humanSummary }))
}

/* ──────────────────────────────── formatting ─────────────────────────────── */

/** Whole days between two `yyyy-MM-dd` strings; 0 when `due` is missing or later. */
export function daysBefore(due: string | null, reference: string): number {
  if (!due) return 0
  const a = DateTime.fromISO(due, { zone: 'utc' })
  const b = DateTime.fromISO(reference, { zone: 'utc' })
  if (!a.isValid || !b.isValid) return 0
  const diff = Math.round(b.diff(a, 'days').days)
  return diff > 0 ? diff : 0
}

export function renderTodo(todo: TodoFact): string {
  const flags: string[] = []
  if (todo.overdueDays === 1) flags.push('overdue 1 day')
  else if (todo.overdueDays > 1) flags.push(`overdue ${todo.overdueDays} days`)
  else if (todo.dueDate) flags.push(`due ${todo.dueDate}`)
  if (todo.assignee) flags.push(todo.assignee)
  const tail = flags.length > 0 ? ` (${flags.join(', ')})` : ''
  return `- ${todo.title}${tail}`
}

export function renderFollowup(f: FollowupFact): string {
  const chased = f.nagCount > 0 ? ` (chased ${f.nagCount}x)` : ''
  return `- ${f.description}${chased}`
}

/**
 * A titled block of lines, or null when there is nothing to show.
 *
 * Returning null rather than "none" matters: an empty section handed to the
 * model invites it to write "nothing due today", and the briefs are supposed to
 * skip empty sections rather than narrate them.
 */
export function section(title: string, lines: string[]): string | null {
  if (lines.length === 0) return null
  return [`${title} (${lines.length}):`, ...lines].join('\n')
}

/** Joins the non-null sections into one facts block. */
export function factsBlock(parts: Array<string | null>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join('\n\n')
}

/**
 * The line every facts block opens with. Says plainly that these numbers are
 * already true, so the model does not burn a turn confirming them.
 */
export const FACTS_HEADER =
  'Facts already read out of the household database. They are current as of this moment — ' +
  'use them as given and do not re-query them.'
