/**
 * The ICS watcher: mirror a school or club calendar feed into the family one.
 *
 * A published `.ics` URL is already structured, so this watcher does not spend
 * a model call on it. It parses the feed with the small RFC 5545 reader below,
 * diffs the result against `extracted_events`, and pushes what is new or moved
 * through the same ingest path the email watcher uses — same dedupe, same
 * watcher-origin tool gate, same digest.
 *
 * A feed is still foreign text: anyone who can publish to that URL chooses the
 * titles. So summaries and descriptions are flattened and length-capped before
 * they become a calendar entry, the event count per pass is capped, and dates
 * far outside the horizon are dropped.
 *
 * "Changed" means the date moved, because the content hash covers the date. The
 * new instance is added; the superseded one is *not* deleted here, because
 * deleting a calendar event is `calendar_write`, which a watcher may never do.
 * The digest offers a 🗑 Remove button for the stale entry instead, so a human
 * makes that call.
 */
import { isIP } from 'node:net'
import { isPrivateHost, resolvesToPrivate } from '../net/public-host.js'
import { and, desc, eq } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { getConfig } from '../config.js'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { contentHash } from './extract.js'
import type { ExtractedItem } from './extract.js'
import {
  ICS_WATCHER_TYPES,
  configOf,
  describeError,
  ingestItems,
  loadActiveWatchers,
  markWatcherChecked,
  markWatcherError,
  readNumber,
  readString,
  sendWatcherDigest,
} from './pipeline.js'
import type { DigestEntry, WatcherRow } from './pipeline.js'

const log = logger.child({ mod: 'watchers/ics' })

/** How far ahead a feed is mirrored by default. */
const DEFAULT_HORIZON_DAYS = 180
const MAX_HORIZON_DAYS = 400
/** Yesterday's events still matter for a morning brief; last month's do not. */
const PAST_HORIZON_DAYS = 2
/** Ceiling on VEVENTs read from one feed. A calendar is not a bulk import. */
const MAX_EVENTS_PER_FEED = 500
/** Ceiling on new events created from one pass, so a churning feed cannot flood. */
const MAX_NEW_PER_PASS = 40
/** Ceiling on bytes read from a feed. */
const MAX_FEED_BYTES = 4_000_000
const FETCH_TIMEOUT_MS = 20_000

const MAX_TITLE_CHARS = 300
const MAX_NOTES_CHARS = 1000

/* ────────────────────────────── the ICS reader ───────────────────────────── */

export interface IcsProperty {
  name: string
  params: Record<string, string>
  value: string
}

export interface IcsEvent {
  uid: string
  /**
   * Raw RECURRENCE-ID value, or `''`. A recurrence override shares its series'
   * UID, so without this a feed carrying "the 3rd of the month, except October
   * lands on the 5th" reads as one event that keeps rescheduling itself.
   */
  recurrenceId: string
  summary: string
  description: string
  location: string
  status: string
  /** `YYYY-MM-DD` in the household zone, or null when DTSTART was unreadable. */
  date: string | null
  /** `HH:mm` in the household zone, or null for an all-day event. */
  time: string | null
  /** True when DTSTART carried `VALUE=DATE`. */
  allDay: boolean
}

/**
 * Undo RFC 5545 line folding: a line that begins with a space or a tab is a
 * continuation of the one before it, with that single character removed.
 */
export function unfoldIcs(text: string): string[] {
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const out: string[] = []
  for (const line of raw) {
    if (line === '') continue
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1] ?? ''}${line.slice(1)}`
      continue
    }
    out.push(line)
  }
  return out
}

/** Unescape an RFC 5545 TEXT value. Order matters: backslash last. */
function unescapeText(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = value[i + 1]
    i += 1
    if (next === 'n' || next === 'N') out += '\n'
    else if (next === undefined) out += '\\'
    else out += next
  }
  return out
}

/**
 * Split one content line into name, parameters, and value.
 *
 * The value starts at the first colon that is not inside a quoted parameter —
 * `DTSTART;TZID="Europe/London":20260912T090000` must not split on the colon in
 * the quoted zone name.
 */
export function parseIcsLine(line: string): IcsProperty | null {
  let inQuotes = false
  let colon = -1
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === ':' && !inQuotes) {
      colon = i
      break
    }
  }
  if (colon < 0) return null

  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)

  const segments: string[] = []
  let current = ''
  inQuotes = false
  for (const ch of head) {
    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (ch === ';' && !inQuotes) {
      segments.push(current)
      current = ''
      continue
    }
    current += ch
  }
  segments.push(current)

  const name = (segments.shift() ?? '').trim().toUpperCase()
  if (name === '') return null

  const params: Record<string, string> = {}
  for (const segment of segments) {
    const eq = segment.indexOf('=')
    if (eq < 0) continue
    params[segment.slice(0, eq).trim().toUpperCase()] = segment.slice(eq + 1).trim()
  }

  return { name, params, value }
}

const ICS_DATE = /^(\d{4})(\d{2})(\d{2})$/
const ICS_DATETIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/

/**
 * Resolve a DTSTART into household-local date and time.
 *
 * Three forms are handled, which is all a school feed ever emits: a bare date
 * (`VALUE=DATE`), a UTC stamp (trailing `Z`), and a local stamp with or without
 * a `TZID`. A stamp with no zone at all is "floating" and, per the spec, means
 * local time wherever it is read — which is the household zone.
 */
export function resolveIcsStart(
  property: IcsProperty,
  householdZone: string,
): { date: string | null; time: string | null; allDay: boolean } {
  const value = property.value.trim()
  const wantsDate = (property.params.VALUE ?? '').toUpperCase() === 'DATE'

  const dateOnly = ICS_DATE.exec(value)
  if (dateOnly !== null && (wantsDate || value.length === 8)) {
    const day = DateTime.fromFormat(value, 'yyyyMMdd', { zone: householdZone })
    return day.isValid
      ? { date: day.toFormat('yyyy-MM-dd'), time: null, allDay: true }
      : { date: null, time: null, allDay: true }
  }

  const stamp = ICS_DATETIME.exec(value)
  if (stamp === null) return { date: null, time: null, allDay: false }

  const isUtc = stamp[7] === 'Z'
  const tzid = property.params.TZID
  const sourceZone = isUtc ? 'utc' : (tzid !== undefined && tzid !== '' ? tzid : householdZone)

  let dt = DateTime.fromFormat(value.replace(/Z$/, ''), "yyyyMMdd'T'HHmmss", { zone: sourceZone })
  if (!dt.isValid && tzid !== undefined) {
    // An unknown TZID is not a reason to lose the event; fall back to local.
    dt = DateTime.fromFormat(value.replace(/Z$/, ''), "yyyyMMdd'T'HHmmss", { zone: householdZone })
  }
  if (!dt.isValid) return { date: null, time: null, allDay: false }

  const local = dt.setZone(householdZone)
  return { date: local.toFormat('yyyy-MM-dd'), time: local.toFormat('HH:mm'), allDay: false }
}

/**
 * Read every VEVENT out of a feed.
 *
 * Deliberately not a general iCalendar implementation: no RRULE expansion, no
 * VALARM, no VTIMEZONE definitions. A recurring event is mirrored at its first
 * occurrence, which is what a "picture day is on the 12th" feed carries anyway,
 * and pretending otherwise would put wrong dates on a family calendar.
 */
export function parseIcs(text: string, householdZone: string): IcsEvent[] {
  const events: IcsEvent[] = []
  let current: Partial<IcsEvent> & { start?: IcsProperty } | null = null
  /**
   * How many sub-components are open inside the current VEVENT.
   *
   * A VALARM carries its own SUMMARY, DESCRIPTION, and (for EMAIL alarms) other
   * text properties. Google Calendar puts `DESCRIPTION:This is an event
   * reminder` in every alarm it exports, so a parser that reads properties at
   * any depth ends up writing the alarm's text onto the event — the family
   * calendar fills with entries titled after their own reminders. Properties
   * only count when they sit directly inside the VEVENT.
   */
  let nested = 0

  for (const line of unfoldIcs(text)) {
    const property = parseIcsLine(line)
    if (property === null) continue

    const upperValue = property.value.trim().toUpperCase()

    if (property.name === 'BEGIN') {
      if (upperValue === 'VEVENT' && current === null) current = {}
      else if (current !== null) nested += 1
      continue
    }

    if (property.name === 'END') {
      if (current !== null && nested > 0) {
        nested -= 1
        continue
      }
      if (upperValue === 'VEVENT' && current !== null) {
        const start = current.start
        const resolved =
          start === undefined
            ? { date: null, time: null, allDay: false }
            : resolveIcsStart(start, householdZone)
        events.push({
          uid: current.uid ?? '',
          recurrenceId: current.recurrenceId ?? '',
          summary: current.summary ?? '',
          description: current.description ?? '',
          location: current.location ?? '',
          status: current.status ?? '',
          date: resolved.date,
          time: resolved.time,
          allDay: resolved.allDay,
        })
        current = null
        nested = 0
        if (events.length >= MAX_EVENTS_PER_FEED) break
      }
      continue
    }

    if (current === null || nested > 0) continue

    switch (property.name) {
      case 'UID':
        current.uid = property.value.trim()
        break
      case 'RECURRENCE-ID':
        current.recurrenceId = property.value.trim()
        break
      case 'SUMMARY':
        current.summary = unescapeText(property.value)
        break
      case 'DESCRIPTION':
        current.description = unescapeText(property.value)
        break
      case 'LOCATION':
        current.location = unescapeText(property.value)
        break
      case 'STATUS':
        current.status = property.value.trim().toUpperCase()
        break
      case 'DTSTART':
        current.start = property
        break
      default:
        break
    }
  }

  return events
}

/* ─────────────────────────────── sanitising ──────────────────────────────── */

const CONTROL = /[\u0000-\u001F\u007F]/g
const INVISIBLE = /[\u00AD\u200B-\u200F\u2060-\u2064\u2066-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu

function flatten(value: string, max: number): string {
  const text = value
    .normalize('NFKC')
    .replace(CONTROL, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}

/** A parsed VEVENT as the ingest path wants it, or null when it is not usable. */
function toItem(event: IcsEvent): ExtractedItem | null {
  if (event.date === null) return null
  const title = flatten(event.summary, MAX_TITLE_CHARS)
  if (title === '') return null

  const noteParts: string[] = []
  const location = flatten(event.location, 200)
  if (location !== '') noteParts.push(location)
  const description = flatten(event.description, MAX_NOTES_CHARS)
  if (description !== '') noteParts.push(description)

  const item: ExtractedItem = { kind: 'event', title, date: event.date }
  if (!event.allDay && event.time !== null) item.time = event.time
  if (noteParts.length > 0) item.notes = flatten(noteParts.join(' — '), MAX_NOTES_CHARS)
  return item
}

/* ──────────────────────────────── fetching ───────────────────────────────── */

/** `webcal://` is an `https://` URL wearing a hat. Anything else is rejected. */
export function normalizeFeedUrl(raw: string): URL | null {
  let candidate = raw.trim()
  if (candidate === '') return null
  if (/^webcal:\/\//i.test(candidate)) candidate = candidate.replace(/^webcal:\/\//i, 'https://')
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  return url
}

/* ─────────────────────────── where a feed may live ───────────────────────── */

/**
 * A feed URL is a string a chat turn put in a config row, and the fetch runs
 * from inside the household's own network with no browser allowlist in front of
 * it. Unguarded, `watcher_add` is a request forgery primitive: point a "calendar
 * feed" at `http://169.254.169.254/…` or `http://127.0.0.1:5432/` and the poller
 * reads it, then puts whatever came back on the family calendar where a person
 * can see it.
 *
 * So every hop is checked — the URL as configured, and each redirect target,
 * since `redirect: 'follow'` would otherwise let a public host hand us a
 * private one.
 */
const BLOCKED_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa']

/** Null when the host is fine to fetch, otherwise why it is not. */
export function feedHostProblem(url: URL): string | null {
  const host = url.hostname.toLowerCase()
  if (host === '') return 'the feed URL has no host'
  if (host === 'localhost' || host === '0.0.0.0') return `${host} is not a public address`
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return `${host} is a private network name`
  }
  // One guard for every fetcher that outside text can steer — see net/public-host.
  if (isPrivateHost(host)) {
    return isIP(host.replace(/^\[|\]$/g, '')) !== 0
      ? `${host} is a private or link-local address`
      : `${host} is not a public host name`
  }
  return null
}

/** Redirect hops to follow before giving up. */
const MAX_REDIRECTS = 4

/** Exported for tests; not part of the watcher API. */
export async function fetchFeed(url: URL): Promise<string> {
  let target = url
  let response: Response | undefined

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const problem = feedHostProblem(target)
    if (problem !== null) throw new Error(`refusing to read the feed: ${problem}`)
    const privateAddress = await resolvesToPrivate(target.hostname)
    if (privateAddress !== null) {
      log.warn({ host: target.hostname, address: privateAddress }, 'feed host resolves to a private address')
      throw new Error(`refusing to read the feed: ${target.hostname} resolves to a non-public address`)
    }

    // Manual redirects, so each hop goes through the host check above.
    const hopResponse = await fetch(target, {
      redirect: 'manual',
      headers: { accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (hopResponse.status >= 300 && hopResponse.status < 400) {
      const location = hopResponse.headers.get('location')
      // Cancel the body rather than reading it: a redirect page is also
      // attacker-sized, and draining it would buffer whatever they serve.
      await hopResponse.body?.cancel().catch(() => undefined)
      if (location === null || location.trim() === '') {
        throw new Error(`the feed answered ${hopResponse.status} with no redirect target`)
      }
      let next: URL
      try {
        next = new URL(location, target)
      } catch {
        throw new Error('the feed redirected somewhere unreadable')
      }
      if (next.protocol !== 'https:' && next.protocol !== 'http:') {
        throw new Error(`the feed redirected to an unsupported ${next.protocol} URL`)
      }
      target = next
      continue
    }

    response = hopResponse
    break
  }

  if (response === undefined) throw new Error('the feed redirected too many times')
  if (!response.ok) throw new Error(`the feed answered ${response.status} ${response.statusText}`)

  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`the feed is ${declared} bytes, over the ${MAX_FEED_BYTES} byte limit`)
  }

  // Stream with a running byte cap. `arrayBuffer()` would buffer the entire
  // body BEFORE any size check ran, so a hostile feed that omits
  // content-length could stream gigabytes into memory. Here the download is
  // cancelled the moment it crosses the limit.
  const body = response.body
  if (body === null) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > MAX_FEED_BYTES) {
        throw new Error(`the feed is over the ${MAX_FEED_BYTES} byte limit`)
      }
      chunks.push(value)
    }
  } finally {
    // Harmless after a clean read; stops the transfer when the cap threw.
    await reader.cancel().catch(() => undefined)
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8').decode(merged)
}

/* ──────────────────────────────── one watcher ────────────────────────────── */

type PriorRow = {
  id: number
  contentHash: string
  eventDate: string | null
  title: string
  reminderId: number | null
}

/**
 * The diff key for one VEVENT, and whether a prior row under that key may be
 * read as this event's earlier incarnation.
 *
 *  - A recurrence override shares its series' UID, so the RECURRENCE-ID is
 *    folded into the key. Otherwise "October's session lands on the 5th" reads
 *    as the whole series rescheduling itself: a false "moved" digest line, and
 *    the series' reminders cancelled.
 *  - Without a UID the fallback key is the title, which two genuinely different
 *    events can share ("Swim class", weekly, no UIDs). The shared key still
 *    dedupes a re-poll — the content hash covers the date — but it must never
 *    claim one of those events supersedes the other, so `canSupersede` is
 *    false and a reschedule in a UID-less feed is simply a new entry.
 */
export function icsDiffKey(event: IcsEvent, title: string): { ref: string; canSupersede: boolean } {
  if (event.uid === '') return { ref: `no-uid:${title}`, canSupersede: false }
  if (event.recurrenceId !== '') {
    return { ref: `${event.uid}#${event.recurrenceId}`, canSupersede: true }
  }
  return { ref: event.uid, canSupersede: true }
}

/** Every row this watcher has already recorded for one UID, newest first. */
async function priorRows(watcherId: number, uid: string): Promise<PriorRow[]> {
  return getDb()
    .select({
      id: schema.extractedEvents.id,
      contentHash: schema.extractedEvents.contentHash,
      eventDate: schema.extractedEvents.eventDate,
      title: schema.extractedEvents.title,
      reminderId: schema.extractedEvents.reminderId,
    })
    .from(schema.extractedEvents)
    .where(
      and(eq(schema.extractedEvents.watcherId, watcherId), eq(schema.extractedEvents.sourceRef, uid)),
    )
    .orderBy(desc(schema.extractedEvents.id))
}

async function pollOne(row: WatcherRow, now: DateTime): Promise<DigestEntry[]> {
  const cfg = configOf(row)
  const rawUrl = readString(cfg.url) ?? readString(cfg.feedUrl) ?? readString(cfg.ics)
  if (rawUrl === undefined) {
    await markWatcherError(row.id, 'This watcher has no feed URL configured.')
    return []
  }
  const url = normalizeFeedUrl(rawUrl)
  if (url === null) {
    await markWatcherError(row.id, `"${rawUrl}" is not an http, https, or webcal feed URL.`)
    return []
  }

  const horizonDays = readNumber(cfg.horizonDays, DEFAULT_HORIZON_DAYS, 1, MAX_HORIZON_DAYS)
  const zone = now.zone.name
  const checkpoint = now.toJSDate()

  const text = await fetchFeed(url)
  const events = parseIcs(text, zone)
  log.info({ watcherId: row.id, name: row.name, vevents: events.length }, 'ics feed parsed')

  const earliest = now.startOf('day').minus({ days: PAST_HORIZON_DAYS })
  const latest = now.startOf('day').plus({ days: horizonDays })

  const added: DigestEntry[] = []
  let created = 0

  for (const event of events) {
    if (created >= MAX_NEW_PER_PASS) break
    if (event.status === 'CANCELLED') continue

    const item = toItem(event)
    if (item === null || item.date === undefined) continue

    const when = DateTime.fromISO(item.date, { zone })
    if (!when.isValid || when < earliest || when > latest) continue

    // A UID is what makes a feed diffable; `icsDiffKey` also keeps a
    // recurrence override from masquerading as its whole series.
    const key = icsDiffKey(event, item.title)
    const hash = contentHash(row.id, key.ref, item)

    const prior = await priorRows(row.id, key.ref)
    if (prior.some((p) => p.contentHash === hash)) continue

    const newest = key.canSupersede ? prior[0] : undefined
    const ingested = await ingestItems({
      watcherId: row.id,
      watcherName: row.name,
      sourceRef: key.ref,
      sourceLabel: `${row.name} calendar feed`,
      items: [item],
      ...(newest === undefined
        ? {}
        : {
            supersedes: {
              extractedEventId: newest.id,
              date: newest.eventDate,
              title: newest.title,
              reminderId: newest.reminderId,
            },
          }),
    })

    added.push(...ingested.added)
    created += ingested.added.length
  }

  await markWatcherChecked(row.id, checkpoint)
  return added
}

/* ───────────────────────────────── the sweep ─────────────────────────────── */

/**
 * Poll every active ICS watcher.
 *
 * @returns `checked` — feeds that completed a pass; `added` — events mirrored.
 */
export async function pollIcsWatchers(): Promise<{ checked: number; added: number }> {
  const rows = await loadActiveWatchers(ICS_WATCHER_TYPES)
  if (rows.length === 0) return { checked: 0, added: 0 }

  let zone = 'UTC'
  try {
    zone = getConfig().HOUSEHOLD_TIMEZONE
  } catch (err) {
    log.error({ err }, 'ics watchers skipped: configuration unavailable')
    return { checked: 0, added: 0 }
  }

  const now = DateTime.now().setZone(zone)
  const added: DigestEntry[] = []
  let checked = 0

  for (const row of rows) {
    try {
      added.push(...(await pollOne(row, now)))
      checked += 1
    } catch (err) {
      const message = describeError(err)
      log.error({ err, watcherId: row.id, name: row.name }, 'ics watcher pass failed')
      await markWatcherError(row.id, message)
    }
  }

  await sendWatcherDigest(added)
  return { checked, added: added.length }
}
