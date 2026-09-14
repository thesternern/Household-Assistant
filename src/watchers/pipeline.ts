/**
 * The watcher containment layer, and the one ingest path every watcher shares.
 *
 * A watcher reads text an attacker can write. Email, ICS feeds, and portal
 * pages are all open to anyone who knows the family's address or the feed URL.
 * So the rule this file exists to enforce is structural, not advisory:
 *
 *   **Every tool call a watcher makes goes through `callWatcherTool`, which is
 *   the only place in the subsystem that constructs a `ToolContext`, and it
 *   hard-codes `origin: 'watcher'`.**
 *
 * The policy engine denies every category except `read`,
 * `calendar_write_from_watcher`, `reminder_write`, `todo_write`, and
 * `memory_write` for that origin, regardless of what /policy is set to. On top
 * of that, this gate keeps its own allowlist of the four tool names the
 * pipeline actually uses, and — importantly — it **never creates a pending
 * action**. A watcher cannot ask the household for permission, because asking
 * would turn "an email told me to phone someone" into a button a tired spouse
 * might tap. Denied is denied.
 *
 * There is deliberately no parameter anywhere in this subsystem that could set
 * a different origin, and no import of `createPendingAction`.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { InlineKeyboard } from 'grammy'
import { DateTime } from 'luxon'
import { audit } from '../audit/log.js'
import { getConfig } from '../config.js'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { decide } from '../policy/engine.js'
import { getTool } from '../tools/registry.js'
import type { ToolContext, ToolResult } from '../tools/types.js'
import { md, primaryChatId, sendToAll } from '../telegram/send.js'
import { contentHash } from './extract.js'
import type { ExtractedItem } from './extract.js'

const log = logger.child({ mod: 'watchers/pipeline' })

export type WatcherRow = typeof schema.watchers.$inferSelect

/** The name every watcher-origin write is attributed to in the audit log. */
export const WATCHER_ACTOR = 'watcher'

/**
 * The only tool names the pipeline may name at all.
 *
 * This is narrower than the policy engine's watcher-allowed categories on
 * purpose. The policy engine defends the system; this defends against a future
 * edit to *this* subsystem quietly reaching for something new. Adding a name
 * here is a deliberate act with a code review attached.
 */
export const WATCHER_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'calendar_create_event_from_watcher',
  'reminder_set',
  'reminder_cancel',
  'todo_add',
])

/**
 * Why a call did not happen. `policy` means the engine refused it by origin;
 * `handler-error` means the call was permitted but the handler itself threw.
 */
export type WatcherBlockReason =
  | 'unknown-tool'
  | 'policy'
  | 'allowlist'
  | 'wrong-origin'
  | 'handler-error'

export type WatcherToolOutcome =
  | { ok: true; result: ToolResult }
  | { ok: false; blockedBy: WatcherBlockReason; reason: string }

/* ─────────────────────────────── watcher types ───────────────────────────── */

/**
 * Type strings each poller answers to. The first entry is canonical — what
 * `createWatcher` stores — and the rest are aliases the household or an older
 * row may already be using.
 */
export const EMAIL_WATCHER_TYPES = ['email_sender', 'email', 'gmail', 'email_watcher'] as const
export const ICS_WATCHER_TYPES = ['ics_feed', 'ics', 'ical', 'calendar_ics'] as const
export const PORTAL_WATCHER_TYPES = ['portal', 'portal_login', 'web_portal', 'portal_scrape'] as const
/**
 * The assistant's own mailbox. Distinct from an `email` watcher: that one reads
 * the household's Gmail for daycare notices, whereas this reads the assistant's
 * Workspace inbox for replies to mail the assistant itself sent — the plumber
 * writing back. Different account, different account role, different purpose.
 */
export const REPLY_WATCHER_TYPES = ['assistant_inbox', 'reply', 'assistant_replies'] as const

export type WatcherKind = 'email' | 'ics' | 'portal' | 'reply'

export const TYPES_BY_KIND: Record<WatcherKind, readonly string[]> = {
  email: EMAIL_WATCHER_TYPES,
  ics: ICS_WATCHER_TYPES,
  portal: PORTAL_WATCHER_TYPES,
  reply: REPLY_WATCHER_TYPES,
}

/** Canonical type string stored for a kind. */
export const CANONICAL_TYPE: Record<WatcherKind, string> = {
  email: 'email_sender',
  ics: 'ics_feed',
  portal: 'portal',
  reply: 'assistant_inbox',
}

/** Which poller owns a stored type string, or null when nothing does. */
export function kindOfType(type: string): WatcherKind | null {
  const wanted = String(type ?? '').trim().toLowerCase()
  for (const kind of ['email', 'ics', 'portal', 'reply'] as const) {
    if (TYPES_BY_KIND[kind].includes(wanted)) return kind
  }
  return null
}

/* ──────────────────────────────── the gate ───────────────────────────────── */

/**
 * The single constructor of a watcher `ToolContext`.
 *
 * `origin` is a literal here and takes no argument. That is the whole
 * containment story in one line: there is no code path in this subsystem that
 * can produce a context claiming to be an agent, an executor, or a workflow.
 */
function watcherContext(chatId: string): ToolContext {
  return { chatId, actor: WATCHER_ACTOR, origin: 'watcher' }
}

async function refuse(
  toolName: string,
  args: Record<string, unknown>,
  blockedBy: WatcherBlockReason,
  reason: string,
): Promise<WatcherToolOutcome> {
  log.warn({ tool: toolName, blockedBy, reason }, 'watcher tool call refused')
  await audit({
    actor: WATCHER_ACTOR,
    event: 'watcher.tool_blocked',
    toolName,
    args,
    resultSummary: `${blockedBy}: ${reason}`,
    ok: false,
  })
  return { ok: false, blockedBy, reason }
}

/**
 * Run one tool as the watcher.
 *
 * Order matters. The policy engine goes first, so that when something outside
 * the watcher's blast radius is named — `phone_place_call`, `gmail_send`, a
 * purchase — the refusal comes from the policy layer and says so. The local
 * allowlist runs behind it as a second, narrower filter.
 *
 * A `require_approval` decision is treated exactly like `deny`. Nothing here
 * creates a pending action: an approval card raised by a watcher would be an
 * attacker asking the household for permission in the assistant's voice.
 */
export async function callWatcherTool(
  toolName: string,
  args: Record<string, unknown>,
  chatId: string,
): Promise<WatcherToolOutcome> {
  const def = getTool(toolName)
  if (!def) return refuse(toolName, args, 'unknown-tool', `no tool named ${toolName}`)

  const ctx = watcherContext(chatId)

  const decision = await decide(def.name, args, ctx)
  if (decision.decision !== 'allow') {
    // 'require_approval' lands here too, and stays here.
    return refuse(def.name, args, 'policy', decision.reason)
  }

  if (!WATCHER_TOOL_ALLOWLIST.has(def.name)) {
    return refuse(
      def.name,
      args,
      'allowlist',
      `${def.name} is not one of the tools the watcher pipeline uses`,
    )
  }

  // Belt and braces: the handler must never see anything but a watcher context.
  if (ctx.origin !== 'watcher') {
    return refuse(def.name, args, 'wrong-origin', 'watcher context was not marked as a watcher')
  }

  try {
    const result = await def.handler(args, ctx)
    if (result.isError) {
      log.warn({ tool: def.name, text: result.content[0]?.text }, 'watcher tool returned an error')
    }
    return { ok: true, result }
  } catch (err) {
    log.error({ err, tool: def.name }, 'watcher tool handler threw')
    // Not a policy refusal: the gate said yes and the handler failed. Labelling
    // this 'policy' would make the audit trail claim containment fired when it
    // did not.
    return {
      ok: false,
      blockedBy: 'handler-error',
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Pull a field out of a tool's `structuredContent`, defensively. */
function structured(result: ToolResult | undefined, key: string): unknown {
  const bag = result?.structuredContent
  if (bag === undefined || bag === null || typeof bag !== 'object') return undefined
  return (bag as Record<string, unknown>)[key]
}

function structuredString(result: ToolResult | undefined, key: string): string | null {
  const value = structured(result, key)
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function nestedNumber(result: ToolResult | undefined, outer: string, key: string): number | null {
  const bag = structured(result, outer)
  if (bag === null || typeof bag !== 'object') return null
  const value = (bag as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

/* ───────────────────────────── watcher row access ────────────────────────── */

export async function loadActiveWatchers(types: readonly string[]): Promise<WatcherRow[]> {
  if (types.length === 0) return []
  return getDb()
    .select()
    .from(schema.watchers)
    .where(and(eq(schema.watchers.active, true), inArray(schema.watchers.type, [...types])))
}

/**
 * Records a clean pass. `last_checked_at` moves only on success, so a watcher
 * that failed re-reads the same window next time rather than skipping it.
 */
export async function markWatcherChecked(watcherId: number, at: Date): Promise<void> {
  await getDb()
    .update(schema.watchers)
    .set({ lastCheckedAt: at, lastError: null })
    .where(eq(schema.watchers.id, watcherId))
}

/** Records a failure for `/status`, without moving the checkpoint. */
export async function markWatcherError(watcherId: number, message: string): Promise<void> {
  const text = message.length > 500 ? `${message.slice(0, 497)}...` : message
  try {
    await getDb()
      .update(schema.watchers)
      .set({ lastError: text })
      .where(eq(schema.watchers.id, watcherId))
  } catch (err) {
    log.error({ err, watcherId }, 'could not record the watcher error')
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err) ?? 'unknown error'
  } catch {
    return 'unknown error'
  }
}

/* ──────────────────────────── config field readers ───────────────────────── */

export function configOf(row: WatcherRow): Record<string, unknown> {
  const raw = row.config
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  return {}
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function readStringArray(value: unknown): string[] {
  const out: string[] = []
  const push = (candidate: unknown): void => {
    const text = readString(candidate)
    if (text !== undefined && !out.includes(text)) out.push(text)
  }
  if (Array.isArray(value)) {
    for (const entry of value) push(entry)
  } else if (typeof value === 'string') {
    for (const part of value.split(',')) push(part)
  }
  return out
}

export function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/* ──────────────────────────────── ingestion ──────────────────────────────── */

/** One thing the pipeline actually created, for the digest. */
export interface DigestEntry {
  extractedEventId: number
  watcherName: string
  kind: 'event' | 'todo'
  title: string
  date: string | null
  time: string | null
  onCalendar: boolean
  /** Set when this entry replaces an earlier one whose date moved. */
  supersedes?: { extractedEventId: number; date: string | null; title: string }
}

export interface IngestInput {
  watcherId: number
  watcherName: string
  /** Stable id of the message or VEVENT: a Gmail message id, an ICS UID, a page URL + date. */
  sourceRef: string
  /** Human-readable provenance written onto the calendar event. */
  sourceLabel: string
  items: ExtractedItem[]
  /** An earlier row for the same `sourceRef` whose date has moved, if any. */
  supersedes?: { extractedEventId: number; date: string | null; title: string; reminderId: number | null }
}

export interface IngestOutcome {
  added: DigestEntry[]
  duplicates: number
  failed: number
}

/** Evening-before ping. */
const EVENING_BEFORE_HOUR = 18
/** Morning-of ping, pulled earlier when the event itself is early. */
const MORNING_OF_HOUR = 7
const MORNING_OF_MINUTE = 30
/** Never schedule a morning-of ping before this hour, however early the event is. */
const EARLIEST_MORNING_HOUR = 6
/** Default calendar block for an event with a start time but no stated end. */
const DEFAULT_DURATION_MINUTES = 60

function zone(): string {
  try {
    return getConfig().HOUSEHOLD_TIMEZONE
  } catch {
    return 'UTC'
  }
}

/** `2026-09-12` + `14:30` in the household zone, or null when the date is unusable. */
function localMoment(date: string, time?: string): DateTime | null {
  const day = DateTime.fromISO(date, { zone: zone() })
  if (!day.isValid) return null
  if (time === undefined) return day.startOf('day')
  const [h, m] = time.split(':')
  const hour = Number(h)
  const minute = Number(m)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return day.startOf('day')
  return day.set({ hour, minute, second: 0, millisecond: 0 })
}

/**
 * Books the evening-before and morning-of pings for one event.
 *
 * Returns the id of the LAST ping booked, because `extracted_events` has a
 * single `reminder_id` column and that is the one worth keeping. The common
 * moment for tapping 🗑 Remove is right after a ping arrives, and cancelling
 * the ping that has not happened yet is what the person means. The other ping
 * can still fire, which is why both texts simply name the event instead of
 * telling anyone to do anything.
 */
async function scheduleEventReminders(
  item: ExtractedItem,
  date: string,
  chatId: string,
): Promise<number | null> {
  const now = DateTime.now().setZone(zone())
  const start = localMoment(date, item.time)
  if (start === null) return null

  const eveningBefore = start.startOf('day').minus({ days: 1 }).set({
    hour: EVENING_BEFORE_HOUR,
    minute: 0,
    second: 0,
    millisecond: 0,
  })

  let morningOf = start.startOf('day').set({
    hour: MORNING_OF_HOUR,
    minute: MORNING_OF_MINUTE,
    second: 0,
    millisecond: 0,
  })
  if (item.time !== undefined && start > start.startOf('day')) {
    // An 07:00 breakfast club needs its ping before 07:30.
    const anHourBefore = start.minus({ hours: 1 })
    if (anHourBefore < morningOf) {
      const floor = start.startOf('day').set({ hour: EARLIEST_MORNING_HOUR, minute: 0 })
      morningOf = anHourBefore > floor ? anHourBefore : floor
    }
  }

  const whenLabel = item.time === undefined ? '' : ` at ${item.time}`
  const plan: Array<{ at: DateTime; text: string }> = [
    { at: eveningBefore, text: `Tomorrow: ${item.title}${whenLabel}.` },
    { at: morningOf, text: `Today: ${item.title}${whenLabel}.` },
  ]

  let lastId: number | null = null
  for (const step of plan) {
    if (step.at <= now) continue
    const outcome = await callWatcherTool(
      'reminder_set',
      { text: step.text, when: step.at.toFormat('yyyy-MM-dd HH:mm') },
      chatId,
    )
    if (!outcome.ok || outcome.result.isError) continue
    const id = nestedNumber(outcome.result, 'reminder', 'id')
    if (id !== null) lastId = id
  }
  return lastId
}

/**
 * Dedupe, create, and record one batch of extracted items.
 *
 * Dedupe is the unique index on `extracted_events.content_hash`, claimed with
 * `onConflictDoNothing().returning()`. That is atomic: two overlapping polls of
 * the same mailbox cannot both win the insert, so nothing gets added twice even
 * if the cron doubles up.
 */
export async function ingestItems(input: IngestInput): Promise<IngestOutcome> {
  const outcome: IngestOutcome = { added: [], duplicates: 0, failed: 0 }
  if (input.items.length === 0) return outcome

  const chatId = (await primaryChatId()) ?? ''

  for (const item of input.items) {
    const hash = contentHash(input.watcherId, input.sourceRef, item)

    let rowId: number
    try {
      const inserted = await getDb()
        .insert(schema.extractedEvents)
        .values({
          watcherId: input.watcherId,
          sourceRef: input.sourceRef,
          contentHash: hash,
          title: item.title,
          eventDate: item.date ?? null,
          eventTime: item.time ?? null,
          kind: item.kind,
        })
        .onConflictDoNothing({ target: schema.extractedEvents.contentHash })
        .returning({ id: schema.extractedEvents.id })

      const row = inserted[0]
      if (!row) {
        outcome.duplicates += 1
        continue
      }
      rowId = row.id
    } catch (err) {
      log.error({ err, watcherId: input.watcherId, ref: input.sourceRef }, 'extracted_events insert failed')
      outcome.failed += 1
      continue
    }

    const entry: DigestEntry = {
      extractedEventId: rowId,
      watcherName: input.watcherName,
      kind: item.kind,
      title: item.title,
      date: item.date ?? null,
      time: item.time ?? null,
      onCalendar: false,
    }
    if (input.supersedes !== undefined) {
      entry.supersedes = {
        extractedEventId: input.supersedes.extractedEventId,
        date: input.supersedes.date,
        title: input.supersedes.title,
      }
    }

    if (item.kind === 'event' && item.date !== undefined) {
      const args: Record<string, unknown> = {
        title: item.title,
        date: item.date,
        durationMinutes: DEFAULT_DURATION_MINUTES,
        source: input.sourceLabel,
      }
      if (item.time !== undefined) args.time = item.time
      if (item.notes !== undefined) args.notes = item.notes

      const created = await callWatcherTool('calendar_create_event_from_watcher', args, chatId)
      const eventId = created.ok ? structuredString(created.result, 'eventId') : null
      entry.onCalendar = eventId !== null

      const reminderId = eventId === null ? null : await scheduleEventReminders(item, item.date, chatId)

      try {
        await getDb()
          .update(schema.extractedEvents)
          .set({ calendarEventId: eventId, reminderId })
          .where(eq(schema.extractedEvents.id, rowId))
      } catch (err) {
        log.error({ err, extractedEventId: rowId }, 'could not link the calendar event to its row')
      }

      if (eventId === null) outcome.failed += 1
    } else {
      const args: Record<string, unknown> = { title: item.title }
      if (item.notes !== undefined) args.notes = item.notes
      if (item.date !== undefined) args.due = item.date

      const created = await callWatcherTool('todo_add', args, chatId)
      const todoId = created.ok ? nestedNumber(created.result, 'todo', 'id') : null
      if (todoId === null) outcome.failed += 1

      try {
        await getDb()
          .update(schema.extractedEvents)
          .set({ todoId })
          .where(eq(schema.extractedEvents.id, rowId))
      } catch (err) {
        log.error({ err, extractedEventId: rowId }, 'could not link the to-do to its row')
      }
    }

    outcome.added.push(entry)
  }

  // A rescheduled event's old pings are wrong the moment the new ones are set.
  if (input.supersedes?.reminderId != null && outcome.added.length > 0) {
    await callWatcherTool('reminder_cancel', { id: input.supersedes.reminderId }, chatId)
  }

  if (outcome.added.length > 0 || outcome.duplicates > 0) {
    log.info(
      {
        watcherId: input.watcherId,
        ref: input.sourceRef,
        added: outcome.added.length,
        duplicates: outcome.duplicates,
        failed: outcome.failed,
      },
      'watcher ingest complete',
    )
  }
  return outcome
}

/* ───────────────────────────────── the digest ────────────────────────────── */

/** How many 🗑 Remove buttons one digest carries before it stops offering them. */
const MAX_REMOVE_BUTTONS = 10
/** How many lines the digest spells out before it starts counting. */
const MAX_DIGEST_LINES = 20
const MAX_BUTTON_LABEL = 26

function fmtWhen(entry: DigestEntry): string {
  if (entry.date === null) return 'no date given'
  const day = DateTime.fromISO(entry.date, { zone: zone() })
  const label = day.isValid ? day.toFormat('ccc d LLL') : entry.date
  if (entry.time === null) return label
  const at = DateTime.fromISO(`${entry.date}T${entry.time}`, { zone: zone() })
  return at.isValid ? `${label}, ${at.toFormat('h:mm a').toLowerCase()}` : `${label}, ${entry.time}`
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * One Telegram message to both spouses, with a 🗑 Remove button per event the
 * pipeline added on its own.
 *
 * Every title in here was written by an outsider, so it is escaped for
 * MarkdownV2 and never interpolated raw. The buttons carry `rm:<id>`, which
 * `src/telegram/approvals.ts` already handles.
 */
export async function sendWatcherDigest(
  added: DigestEntry[],
  injectionNotes: string[] = [],
): Promise<void> {
  if (added.length === 0 && injectionNotes.length === 0) return

  const lines: string[] = []

  if (added.length > 0) {
    const events = added.filter((e) => e.kind === 'event')
    const todos = added.filter((e) => e.kind === 'todo')
    lines.push(
      md.bold(
        `📥 ${added.length} new item${added.length === 1 ? '' : 's'} from your watchers`,
      ),
    )

    if (events.length > 0) {
      lines.push('')
      lines.push(md.bold('On the calendar'))
      for (const entry of events.slice(0, MAX_DIGEST_LINES)) {
        const flag = entry.onCalendar ? '' : ' (could not reach Google — not added)'
        lines.push(
          `• ${md.escape(entry.title)} — ${md.escape(fmtWhen(entry))}${md.escape(flag)}`,
        )
        lines.push(`  ${md.italic(`from ${entry.watcherName}`)}`)
        if (entry.supersedes !== undefined) {
          const was = entry.supersedes.date ?? 'an earlier date'
          lines.push(
            `  ${md.italic(`moved from ${was} — the old entry is still on the calendar, tap Remove below to clear it`)}`,
          )
        }
      }
      if (events.length > MAX_DIGEST_LINES) {
        lines.push(md.escape(`…and ${events.length - MAX_DIGEST_LINES} more.`))
      }
    }

    if (todos.length > 0) {
      lines.push('')
      lines.push(md.bold('Added to the to-do list'))
      for (const entry of todos.slice(0, MAX_DIGEST_LINES)) {
        const due = entry.date === null ? '' : ` — due ${fmtWhen(entry)}`
        lines.push(`• ${md.escape(entry.title)}${md.escape(due)}`)
        lines.push(`  ${md.italic(`from ${entry.watcherName}`)}`)
      }
      if (todos.length > MAX_DIGEST_LINES) {
        lines.push(md.escape(`…and ${todos.length - MAX_DIGEST_LINES} more.`))
      }
    }
  }

  if (injectionNotes.length > 0) {
    lines.push('')
    lines.push(md.bold('⚠️ One of those messages tried to give me instructions'))
    lines.push(
      md.escape(
        'I ignored it — a watcher can only add calendar entries, reminders, and to-dos, and it can never send mail, place a call, or spend money. What it tried:',
      ),
    )
    for (const note of injectionNotes) lines.push(`• ${md.escape(clip(note, 200))}`)
  }

  const keyboard = new InlineKeyboard()
  let buttons = 0
  for (const entry of added) {
    if (buttons >= MAX_REMOVE_BUTTONS) break
    if (entry.kind !== 'event' || !entry.onCalendar) continue
    keyboard.text(`🗑 ${clip(entry.title, MAX_BUTTON_LABEL)}`, `rm:${entry.extractedEventId}`).row()
    buttons += 1
    if (entry.supersedes !== undefined && buttons < MAX_REMOVE_BUTTONS) {
      keyboard
        .text(
          `🗑 old: ${clip(entry.supersedes.title, MAX_BUTTON_LABEL - 5)}`,
          `rm:${entry.supersedes.extractedEventId}`,
        )
        .row()
      buttons += 1
    }
  }

  await sendToAll(lines.join('\n'), {
    markdown: true,
    ...(buttons > 0 ? { replyMarkup: keyboard } : {}),
  })
}
