/**
 * The email watcher: "tell me what the daycare just announced".
 *
 * One pass looks like this. For each active `email_sender` watcher, build a
 * Gmail query from its configured senders and its own checkpoint, fetch the
 * messages that arrived since, run each body through the extractor, dedupe the
 * results against `extracted_events`, and put what survives on the calendar and
 * the to-do list. Both spouses get one digest at the end, with a 🗑 Remove
 * button beside every event that was added without being asked.
 *
 * Two things about failure. `last_checked_at` moves only after a clean pass, so
 * a Google outage means the next run re-reads the same window rather than
 * skipping it. And a failure is written to `last_error` so `/status` can show
 * it, instead of the watcher quietly going dark.
 *
 * Nothing in here writes anything directly. Every creation goes through
 * `callWatcherTool`, which runs as `origin: 'watcher'` and cannot reach mail,
 * phone, purchases, or the ordinary calendar-write path.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { getConfig } from '../config.js'
import { getDb, schema } from '../db/client.js'
import { gmail } from '../integrations/google.js'
import { logger } from '../logger.js'
import { extractEventsDetailed } from './extract.js'
import {
  EMAIL_WATCHER_TYPES,
  configOf,
  describeError,
  ingestItems,
  loadActiveWatchers,
  markWatcherChecked,
  markWatcherError,
  readNumber,
  readString,
  readStringArray,
  sendWatcherDigest,
} from './pipeline.js'
import type { DigestEntry, WatcherRow } from './pipeline.js'
import type { gmail_v1 } from 'googleapis'

const log = logger.child({ mod: 'watchers/email' })

/** How many messages one watcher may process in a single pass. */
const DEFAULT_MAX_MESSAGES = 15
const MAX_MESSAGES_CEILING = 50
/** How far back a watcher looks the very first time it runs. */
const DEFAULT_FIRST_RUN_DAYS = 7
const MAX_LOOKBACK_DAYS = 90
/**
 * Re-read a few minutes either side of the checkpoint. Gmail's `after:` is
 * inclusive and delivery is not instantaneous, so a hard edge drops mail that
 * landed while the previous pass was running. Duplicates are free — the content
 * hash catches them.
 */
const OVERLAP_MINUTES = 10
/** Cap on how much of one body reaches the extractor. */
const MAX_BODY_CHARS = 20_000

/* ────────────────────────────── the Gmail query ──────────────────────────── */

/**
 * Normalise one configured sender into something Gmail's `from:` understands.
 * `@brightwheel.com`, `brightwheel.com`, and `hello@brightwheel.com` all work;
 * quotes, spaces, and parentheses are stripped so nothing can break out of the
 * clause we are building.
 */
function normalizeSender(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^from:/, '')
    .replace(/["'()<>]/g, '')
    .replace(/\s+/g, '')
    .replace(/^@/, '')
  if (cleaned === '') return null
  if (!/^[a-z0-9._%+-]*@?[a-z0-9.-]+\.[a-z]{2,}$/.test(cleaned)) return null
  return cleaned
}

/** Same treatment for a label name, which may legitimately contain spaces. */
function normalizeLabel(raw: string): string | null {
  const cleaned = raw.trim().replace(/["'()]/g, '')
  if (cleaned === '') return null
  return cleaned.includes(' ') ? `"${cleaned}"` : cleaned
}

/**
 * True when every `(` has its `)` and no `)` arrives early. The `extra` clause
 * from a watcher config is appended inside parentheses so it stays ANDed with
 * the `from:` scope; an unbalanced clause such as `x) OR (from:me` would close
 * that group early and widen the read to mail the watcher never named. Balanced
 * or dropped — never appended raw.
 */
export function balancedParens(text: string): boolean {
  let depth = 0
  for (const ch of text) {
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth < 0) return false
    }
  }
  return depth === 0
}

export interface EmailQueryInput {
  senders: string[]
  labels?: string[]
  /** Extra Gmail syntax from the watcher config, appended verbatim. */
  extra?: string
  /** The checkpoint. Null on a watcher's first run. */
  since: Date | null
  /** Days to look back when there is no checkpoint. */
  firstRunDays: number
  now: DateTime
}

/**
 * Build the Gmail query for one pass.
 *
 * Returns null when the watcher names no usable sender: a watcher with an empty
 * `from:` clause would read the entire mailbox and feed it to the extractor,
 * which is the one mistake this function exists to prevent.
 */
export function buildGmailQuery(input: EmailQueryInput): string | null {
  const senders = input.senders
    .map(normalizeSender)
    .filter((s): s is string => s !== null)
  if (senders.length === 0) return null

  const clauses = [`from:(${senders.join(' OR ')})`]

  const labels = (input.labels ?? [])
    .map(normalizeLabel)
    .filter((s): s is string => s !== null)
  if (labels.length > 0) clauses.push(`label:(${labels.join(' OR ')})`)

  const after =
    input.since === null
      ? input.now.minus({ days: input.firstRunDays })
      : DateTime.fromJSDate(input.since).minus({ minutes: OVERLAP_MINUTES })
  clauses.push(`after:${Math.floor(after.toSeconds())}`)

  // Hangouts/Chat threads are not newsletters and have no announcements in them.
  clauses.push('-in:chats')

  const extra = input.extra?.trim()
  if (extra !== undefined && extra !== '' && balancedParens(extra)) clauses.push(`(${extra})`)

  return clauses.join(' ')
}

/* ─────────────────────────────── body reading ────────────────────────────── */

function decodeBase64Url(data: string): string {
  try {
    return Buffer.from(data, 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  hellip: '...',
}

/**
 * A numeric entity's code point as a string, or null when it is not a scalar
 * value. `String.fromCodePoint` THROWS on anything above 0x10FFFF, so a mailed
 * `&#x110000;` would otherwise abort the whole watcher pass — and, because the
 * checkpoint only moves on success, every later pass too. Surrogate halves are
 * refused as well: a lone surrogate is an invalid string that JSON-encoding
 * (the extractor API call) cannot carry.
 */
function codePointText(code: number): string | null {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return null
  if (code >= 0xd800 && code <= 0xdfff) return null
  return String.fromCodePoint(code)
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    const key = body.toLowerCase()
    const named = ENTITIES[key]
    if (named !== undefined) return named
    if (key.startsWith('#x')) {
      return codePointText(Number.parseInt(key.slice(2), 16)) ?? match
    }
    if (key.startsWith('#')) {
      return codePointText(Number.parseInt(key.slice(1), 10)) ?? match
    }
    return match
  })
}

/** Flatten HTML to something a text extractor can read, keeping line structure. */
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Walk a Gmail MIME tree and return the best text for the message: the
 * `text/plain` parts when there are any, otherwise the HTML flattened.
 */
export function readMessageBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  const plain: string[] = []
  const html: string[] = []

  const walk = (part: gmail_v1.Schema$MessagePart | undefined, depth: number): void => {
    if (!part || depth > 12) return
    const mime = (part.mimeType ?? '').toLowerCase()
    const data = part.body?.data
    if (typeof data === 'string' && data !== '') {
      if (mime.startsWith('text/plain')) plain.push(decodeBase64Url(data))
      else if (mime.startsWith('text/html')) html.push(decodeBase64Url(data))
    }
    for (const child of part.parts ?? []) walk(child, depth + 1)
  }
  walk(payload, 0)

  const text = plain.length > 0 ? plain.join('\n\n') : htmlToText(html.join('\n\n'))
  return text.replace(/\r\n/g, '\n').trim().slice(0, MAX_BODY_CHARS)
}

export function headerOf(payload: gmail_v1.Schema$MessagePart | undefined, name: string): string {
  const wanted = name.toLowerCase()
  for (const header of payload?.headers ?? []) {
    if ((header.name ?? '').toLowerCase() === wanted) return header.value ?? ''
  }
  return ''
}

/* ───────────────────────────── already-seen check ────────────────────────── */

/**
 * Message ids this watcher has already extracted from.
 *
 * The content hash makes a re-poll harmless, but it does not make it free: a
 * message that has already been read costs a model call every time it stays
 * inside the query window. This filter is what keeps the overlap cheap.
 */
async function alreadySeen(watcherId: number, messageIds: string[]): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set()
  try {
    const rows = await getDb()
      .select({ sourceRef: schema.extractedEvents.sourceRef })
      .from(schema.extractedEvents)
      .where(
        and(
          eq(schema.extractedEvents.watcherId, watcherId),
          inArray(schema.extractedEvents.sourceRef, messageIds),
        ),
      )
    return new Set(rows.map((r) => r.sourceRef))
  } catch (err) {
    log.warn({ err, watcherId }, 'could not read the seen-message set; re-extracting the window')
    return new Set()
  }
}

/* ──────────────────────────────── one watcher ────────────────────────────── */

interface PassResult {
  added: DigestEntry[]
  injectionNotes: string[]
}

async function pollOne(
  row: WatcherRow,
  gm: gmail_v1.Gmail,
  now: DateTime,
): Promise<PassResult> {
  const result: PassResult = { added: [], injectionNotes: [] }
  const cfg = configOf(row)

  const senders = readStringArray(cfg.senders ?? cfg.from ?? cfg.addresses)
  const queryInput: EmailQueryInput = {
    senders,
    labels: readStringArray(cfg.labels),
    since: row.lastCheckedAt ?? null,
    firstRunDays: readNumber(cfg.lookbackDays, DEFAULT_FIRST_RUN_DAYS, 1, MAX_LOOKBACK_DAYS),
    now,
  }
  const extra = readString(cfg.query)
  if (extra !== undefined) queryInput.extra = extra

  const query = buildGmailQuery(queryInput)
  if (query === null) {
    await markWatcherError(row.id, 'This watcher has no valid sender configured, so it read nothing.')
    log.warn({ watcherId: row.id, name: row.name }, 'email watcher has no usable sender')
    return result
  }

  const maxMessages = readNumber(cfg.maxMessages, DEFAULT_MAX_MESSAGES, 1, MAX_MESSAGES_CEILING)

  // Stamp the checkpoint before the fetch, so mail that lands mid-pass is
  // picked up next time rather than falling into the gap.
  const checkpoint = now.toJSDate()

  const list = await gm.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: maxMessages,
    includeSpamTrash: false,
  })

  const ids = (list.data.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && id !== '')

  const seen = await alreadySeen(row.id, ids)
  const fresh = ids.filter((id) => !seen.has(id))
  log.info(
    { watcherId: row.id, name: row.name, matched: ids.length, fresh: fresh.length },
    'email watcher fetched',
  )

  for (const messageId of fresh) {
    let message: gmail_v1.Schema$Message
    try {
      const response = await gm.users.messages.get({ userId: 'me', id: messageId, format: 'full' })
      message = response.data
    } catch (err) {
      // One unreadable message must not abort the pass.
      log.warn({ err, watcherId: row.id, messageId }, 'could not read a watched message')
      continue
    }

    const payload = message.payload ?? undefined
    const from = headerOf(payload, 'From')
    const subject = headerOf(payload, 'Subject')
    const body = readMessageBody(payload)
    if (subject.trim() === '' && body === '') continue

    const received = message.internalDate
      ? DateTime.fromMillis(Number(message.internalDate), { zone: now.zone })
      : now
    const dateLabel = received.isValid ? received.toFormat('yyyy-MM-dd') : now.toFormat('yyyy-MM-dd')

    // Headers are as attacker-authored as the body, so they go inside the same
    // fence — `extractEventsDetailed` wraps everything it is handed.
    const document = [`From: ${from}`, `Date: ${dateLabel}`, `Subject: ${subject}`, '', body].join('\n')

    const extraction = await extractEventsDetailed(`email:${row.name}`, document, messageId)
    for (const note of extraction.injectionNotes) {
      if (!result.injectionNotes.includes(note)) result.injectionNotes.push(note)
    }
    if (extraction.items.length === 0) continue

    const ingested = await ingestItems({
      watcherId: row.id,
      watcherName: row.name,
      sourceRef: messageId,
      sourceLabel: `${row.name} email, ${dateLabel}`,
      items: extraction.items,
    })
    result.added.push(...ingested.added)
  }

  await markWatcherChecked(row.id, checkpoint)
  return result
}

/* ───────────────────────────────── the sweep ─────────────────────────────── */

/**
 * Poll every active email watcher.
 *
 * @returns `checked` — watchers that completed a pass; `added` — items created.
 */
export async function pollEmailWatchers(): Promise<{ checked: number; added: number }> {
  const rows = await loadActiveWatchers(EMAIL_WATCHER_TYPES)
  if (rows.length === 0) return { checked: 0, added: 0 }

  const gm = await gmail()
  if (!gm) {
    // Not connected is a state, not a crash. Record it on every watcher so
    // /status explains the silence, and try again next run.
    for (const row of rows) {
      await markWatcherError(row.id, 'Google is not connected, so the mailbox could not be read.')
    }
    log.warn({ watchers: rows.length }, 'email watchers skipped: Google is not connected')
    return { checked: 0, added: 0 }
  }

  // Household-local, so `dateLabel` (the extractor's "Date:" line and the
  // calendar provenance note) names the day the family lives in, not the
  // server's. The `after:` clause is epoch seconds and does not care.
  let now = DateTime.now()
  try {
    const local = now.setZone(getConfig().HOUSEHOLD_TIMEZONE)
    if (local.isValid) now = local
  } catch {
    // Config unavailable mid-shutdown: server zone is a tolerable fallback.
  }
  const added: DigestEntry[] = []
  const injectionNotes: string[] = []
  let checked = 0

  for (const row of rows) {
    try {
      const pass = await pollOne(row, gm, now)
      added.push(...pass.added)
      for (const note of pass.injectionNotes) {
        if (!injectionNotes.includes(note)) injectionNotes.push(note)
      }
      checked += 1
    } catch (err) {
      const message = describeError(err)
      log.error({ err, watcherId: row.id, name: row.name }, 'email watcher pass failed')
      await markWatcherError(row.id, message)
    }
  }

  await sendWatcherDigest(added, injectionNotes)
  return { checked, added: added.length }
}
