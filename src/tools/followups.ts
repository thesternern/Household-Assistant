/**
 * Follow-ups: the loose ends that need chasing.
 *
 * A to-do is work someone will do. A follow-up is a promise someone else made —
 * the dentist who was going to call back, the form the school said it would
 * send — and the assistant's job is to keep asking about it until it closes.
 * Each row carries a `next_nag_at`; the nag cron picks those up, bumps
 * `nag_count`, and pushes the next one out.
 *
 * Same category as to-dos (`todo_write`): nothing here touches the world.
 */
import { householdNow } from '../time.js'
import { and, asc, eq, isNotNull, lte } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { z } from 'zod'
import { audit } from '../audit/log.js'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { fail, ok } from './types.js'
import type { ToolDef } from './types.js'

const log = logger.child({ mod: 'tools/followups' })

/**
 * Lifecycle of a follow-up, shared with the nag cron and the Telegram Done
 * button: `done` is a human closing it, `abandoned` is the cron giving up after
 * the nag limit.
 */
const FOLLOWUP_STATUSES = ['open', 'done', 'abandoned'] as const
type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number]

/** How long we wait before the first nag when the caller does not say. */
const DEFAULT_NAG_HOURS = 24
/** Nagging further out than this is really a reminder or a to-do. */
const MAX_NAG_HOURS = 24 * 90
const MAX_LIST = 50
const MAX_TEXT_LINES = 20

type FollowupRow = typeof schema.followups.$inferSelect

/* ────────────────────────────── small helpers ────────────────────────────── */

/** Always a valid DateTime: a bad HOUSEHOLD_TIMEZONE falls back rather than yielding NaN. */
function nowLocal(): DateTime {
  return householdNow()
}

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

/** "in 3 hours", "tomorrow at 9:00 AM", "on Fri Sep 11" — shortest true phrasing. */
function describeNagTime(at: Date, now: DateTime): string {
  const local = DateTime.fromJSDate(at).setZone(now.zone)
  const hours = local.diff(now, 'hours').hours
  if (hours < 0) return 'now (overdue)'
  if (hours < 1) return `in ${Math.max(1, Math.round(local.diff(now, 'minutes').minutes))} min`
  if (hours < 24 && local.hasSame(now, 'day')) return `today at ${local.toFormat('h:mm a')}`
  if (local.hasSame(now.plus({ days: 1 }), 'day')) return `tomorrow at ${local.toFormat('h:mm a')}`
  return `on ${local.toFormat("ccc MMM d 'at' h:mm a")}`
}

function toStructured(row: FollowupRow): Record<string, unknown> {
  return {
    id: row.id,
    description: row.description,
    status: row.status,
    nagCount: row.nagCount,
    nextNagAt: row.nextNagAt?.toISOString() ?? null,
    relatedTodoId: row.relatedTodoId,
    telegramChatId: row.telegramChatId,
    createdAt: row.createdAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
  }
}

async function loadFollowup(id: number): Promise<FollowupRow | undefined> {
  const rows = await getDb().select().from(schema.followups).where(eq(schema.followups.id, id)).limit(1)
  return rows[0]
}

/**
 * Works out when the next nag lands. `nagAt` wins when it is a real future
 * timestamp; otherwise the hour offset does, and it is clamped to something
 * sane so a hallucinated 900000 never parks a nag past the heat death.
 */
function resolveNagTime(
  nagAt: string | undefined,
  nagInHours: number | undefined,
  now: DateTime,
): { ok: true; at: DateTime } | { ok: false; error: string } {
  if (nagAt !== undefined) {
    const parsed = DateTime.fromISO(nagAt, { zone: now.zone })
    if (!parsed.isValid) {
      return { ok: false, error: `I could not read "${nagAt}" as a date. Use ISO, e.g. 2026-09-08T09:00.` }
    }
    if (parsed <= now) {
      return { ok: false, error: `${parsed.toFormat("ccc MMM d 'at' h:mm a")} has already passed.` }
    }
    return { ok: true, at: parsed }
  }
  const hours = Math.min(Math.max(nagInHours ?? DEFAULT_NAG_HOURS, 1), MAX_NAG_HOURS)
  return { ok: true, at: now.plus({ hours }) }
}

/* ───────────────────────────── followup_create ───────────────────────────── */

const createShape = {
  description: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      'The loose end, written so it still makes sense in a week: "Dentist was going to call back about Maya\'s filling".',
    ),
  nagInHours: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_NAG_HOURS)
    .describe('Hours to wait before the first nudge. Defaults to 24.'),
  nagAt: z
    .string()
    .trim()
    .max(64)
    .optional()
    .describe('Exact ISO timestamp for the first nudge, e.g. 2026-09-08T09:00. Overrides nagInHours.'),
  relatedTodoId: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe('Id of the to-do this follow-up is chasing, if there is one.'),
}
const createSchema = z.object(createShape)

const followupCreate: ToolDef = {
  name: 'followup_create',
  description:
    'Track something the household is waiting on from someone else, so it gets chased instead of forgotten. ' +
    'Use this whenever a call, email, or errand ends with "they will get back to us".',
  schema: createShape,
  category: 'todo_write',
  consequential: false,
  summarize: (args) => {
    const description = readString(args['description']) ?? 'something'
    const hours = typeof args['nagInHours'] === 'number' ? args['nagInHours'] : DEFAULT_NAG_HOURS
    const at = readString(args['nagAt'])
    const when = at ? `on ${at}` : `in ${hours} hour${hours === 1 ? '' : 's'}`
    return `Track a follow-up: "${description}", first nudge ${when}.`
  },
  handler: async (args, ctx) => {
    const parsed = createSchema.safeParse(args)
    if (!parsed.success) return fail(`I could not create that follow-up: ${issueText(parsed.error)}`)
    const { description, relatedTodoId } = parsed.data

    const now = nowLocal()
    const nag = resolveNagTime(parsed.data.nagAt, parsed.data.nagInHours, now)
    if (!nag.ok) return fail(nag.error)

    try {
      const inserted = await getDb()
        .insert(schema.followups)
        .values({
          description,
          nextNagAt: nag.at.toJSDate(),
          nagCount: 0,
          status: 'open',
          relatedTodoId: relatedTodoId ?? null,
          telegramChatId: ctx.chatId || null,
        })
        .returning()

      const row = inserted[0]
      if (!row) return fail('The follow-up could not be saved. Nothing is being tracked.')

      await audit({
        actor: ctx.actor,
        event: 'followup.create',
        category: 'todo_write',
        toolName: 'followup_create',
        args: { description, nextNagAt: nag.at.toISO(), relatedTodoId: relatedTodoId ?? null },
        resultSummary: `followup #${row.id}`,
        ok: true,
      })
      log.info({ followupId: row.id, actor: ctx.actor }, 'followup created')

      return ok(
        `Tracking follow-up #${row.id}: "${description}". I will nudge ${describeNagTime(nag.at.toJSDate(), now)}.`,
        { followup: toStructured(row) },
      )
    } catch (err) {
      log.error({ err }, 'followup_create failed')
      return fail('I could not save that follow-up — the database rejected the write.')
    }
  },
}

/* ────────────────────────────── followup_list ────────────────────────────── */

const listShape = {
  status: z
    .enum(['open', 'done', 'abandoned', 'all'])
    .default('open')
    .describe('Which follow-ups to return. Defaults to the ones still open.'),
  dueOnly: z
    .boolean()
    .default(false)
    .describe('Only follow-ups whose next nudge is already due. Useful for the nag job and the daily brief.'),
  limit: z.coerce.number().int().min(1).default(20).describe('Maximum follow-ups to return (capped at 50).'),
}
const listSchema = z.object(listShape)

const followupList: ToolDef = {
  name: 'followup_list',
  description:
    'List the things the household is waiting on, soonest nudge first. Call this before acknowledging one ' +
    'so you have the right id.',
  schema: listShape,
  category: 'read',
  consequential: false,
  readOnly: true,
  summarize: (args) => `List ${readString(args['status']) ?? 'open'} follow-ups.`,
  handler: async (args) => {
    const parsed = listSchema.safeParse(args)
    if (!parsed.success) return fail(`I could not read that follow-up filter: ${issueText(parsed.error)}`)
    const { status, dueOnly } = parsed.data
    const limit = Math.min(parsed.data.limit, MAX_LIST)
    const now = nowLocal()

    try {
      const conditions: SQL[] = []
      if (status !== 'all') conditions.push(eq(schema.followups.status, status))
      if (dueOnly) {
        conditions.push(isNotNull(schema.followups.nextNagAt))
        conditions.push(lte(schema.followups.nextNagAt, now.toJSDate()))
      }
      const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions)

      const rows = await getDb()
        .select()
        .from(schema.followups)
        .where(where)
        .orderBy(asc(schema.followups.nextNagAt), asc(schema.followups.id))
        .limit(limit)

      if (rows.length === 0) {
        return ok(status === 'open' ? 'Nothing is waiting on anyone right now.' : 'No follow-ups match that filter.', {
          followups: [],
          count: 0,
        })
      }

      const lines = rows.slice(0, MAX_TEXT_LINES).map((row) => {
        const when = row.nextNagAt ? ` — nudge ${describeNagTime(row.nextNagAt, now)}` : ''
        const nags = row.nagCount > 0 ? ` · nudged ${row.nagCount}×` : ''
        const state = row.status === 'open' ? '' : ` · ${row.status}`
        return `#${row.id} ${row.description}${when}${nags}${state}`
      })
      if (rows.length > MAX_TEXT_LINES) lines.push(`…and ${rows.length - MAX_TEXT_LINES} more.`)

      return ok(`${rows.length} follow-up${rows.length === 1 ? '' : 's'}:\n${lines.join('\n')}`, {
        followups: rows.map(toStructured),
        count: rows.length,
      })
    } catch (err) {
      log.error({ err }, 'followup_list failed')
      return fail('I could not read the follow-up list right now.')
    }
  },
}

/* ─────────────────────────────── followup_ack ────────────────────────────── */

const ackShape = {
  id: z.coerce.number().int().positive().describe('The follow-up id, as shown by followup_list.'),
  outcome: z
    .string()
    .trim()
    .max(500)
    .optional()
    .describe('What actually happened, in one line. Worth saving to memory too if it matters later.'),
  snoozeHours: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Instead of closing it, wait this many more hours before the next nudge.'),
}
const ackSchema = z.object(ackShape)

const followupAck: ToolDef = {
  name: 'followup_ack',
  description:
    'Close a follow-up because it resolved, or push its next nudge out with snoozeHours when it is still pending.',
  schema: ackShape,
  category: 'todo_write',
  consequential: false,
  summarize: (args) => {
    const id = String(args['id'] ?? '?')
    const snooze = args['snoozeHours']
    if (typeof snooze === 'number' && snooze > 0) {
      return `Snooze follow-up #${id} for ${snooze} hour${snooze === 1 ? '' : 's'}.`
    }
    const outcome = readString(args['outcome'])
    return `Close follow-up #${id}${outcome ? `: ${outcome}` : ''}.`
  },
  handler: async (args, ctx) => {
    const parsed = ackSchema.safeParse(args)
    if (!parsed.success) return fail(`I could not acknowledge that follow-up: ${issueText(parsed.error)}`)
    const { id, outcome, snoozeHours } = parsed.data
    const now = nowLocal()

    try {
      const existing = await loadFollowup(id)
      if (!existing) return fail(`There is no follow-up #${id}.`)

      if (snoozeHours !== undefined) {
        if (existing.status !== 'open') {
          return ok(`Follow-up #${id} is already ${existing.status}, so there is nothing to snooze.`, {
            followup: toStructured(existing),
            changed: false,
          })
        }
        const hours = Math.min(snoozeHours, MAX_NAG_HOURS)
        const next = now.plus({ hours })
        // `nag_count` is deliberately untouched: it counts nudges the household
        // ignored, and a deliberate snooze is the opposite of ignoring one.
        const updated = await getDb()
          .update(schema.followups)
          .set({ nextNagAt: next.toJSDate() })
          .where(eq(schema.followups.id, id))
          .returning()
        const row = updated[0] ?? existing

        await audit({
          actor: ctx.actor,
          event: 'followup.snooze',
          category: 'todo_write',
          toolName: 'followup_ack',
          args: { id, snoozeHours: hours },
          resultSummary: row.description,
          ok: true,
        })
        log.info({ followupId: id, hours, actor: ctx.actor }, 'followup snoozed')

        return ok(
          `Still waiting on "${row.description}". Next nudge ${describeNagTime(next.toJSDate(), now)}.`,
          { followup: toStructured(row), changed: true },
        )
      }

      if (existing.status !== 'open') {
        return ok(`Follow-up #${id} "${existing.description}" is already ${existing.status}.`, {
          followup: toStructured(existing),
          changed: false,
        })
      }

      const closed = await getDb()
        .update(schema.followups)
        .set({ status: 'done', closedAt: new Date(), nextNagAt: null })
        .where(and(eq(schema.followups.id, id), eq(schema.followups.status, 'open')))
        .returning()
      const row = closed[0] ?? existing

      await audit({
        actor: ctx.actor,
        event: 'followup.close',
        category: 'todo_write',
        toolName: 'followup_ack',
        args: { id, outcome: outcome ?? null },
        resultSummary: row.description,
        ok: true,
      })
      log.info({ followupId: id, actor: ctx.actor }, 'followup closed')

      return ok(`Closed follow-up #${id}: "${row.description}"${outcome ? ` — ${outcome}` : ''}.`, {
        followup: toStructured(row),
        outcome: outcome ?? null,
        changed: true,
      })
    } catch (err) {
      log.error({ err, followupId: id }, 'followup_ack failed')
      return fail(`I could not update follow-up #${id}.`)
    }
  },
}

/* ───────────────────────────────── exports ───────────────────────────────── */

export const followupTools: ToolDef[] = [followupCreate, followupList, followupAck]

export const tools: ToolDef[] = followupTools

export type { FollowupStatus }
