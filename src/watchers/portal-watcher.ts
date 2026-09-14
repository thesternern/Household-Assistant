/**
 * The portal watcher: the last resort for a provider with no email and no feed.
 *
 * Plenty of daycares publish everything to a parent portal and nowhere else. So
 * this watcher opens the announcements page in the household's one shared
 * browser, signs in if the portal asks, reads the text, and hands it to the
 * same extractor the email watcher uses. Everything it finds then goes through
 * the same watcher-origin tool gate.
 *
 * What it is allowed to do is deliberately tiny:
 *
 *  - It runs only when `BROWSER_ENABLED` is true. Off means off, with no error
 *    recorded, because "off" is a configuration and not a failure.
 *  - Navigation goes through `openAllowed`, so `BROWSER_ALLOWED_DOMAINS` gates
 *    every page it can reach. A portal that is not on the allowlist produces a
 *    readable error rather than a visit.
 *  - Signing in is `loginToSite` from `src/browser/credentials.js`. That module
 *    never returns the secret, so this file never holds one, never logs one,
 *    and cannot put one in an error message or a digest.
 *  - It reads. It never buys, cancels, submits any form but the sign-in one, or
 *    follows a link the page suggests. There is no model deciding where to
 *    click, so a hostile page has nothing to steer.
 *
 * Everything the page says is foreign text, so it goes to the extractor inside
 * an `<untrusted>` fence like any email body.
 */
import { DateTime } from 'luxon'
import { getConfig } from '../config.js'
import { checkUrl } from '../browser/allowlist.js'
import { loginToSite, normalizeSite } from '../browser/credentials.js'
import {
  browserAvailable,
  errorText,
  firstVisible,
  openAllowed,
  pageText,
  textOf,
  withBrowser,
} from '../browser/worker.js'
import { logger } from '../logger.js'
import { extractEventsDetailed } from './extract.js'
import {
  PORTAL_WATCHER_TYPES,
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
import type { Page } from 'playwright'

const log = logger.child({ mod: 'watchers/portal' })

/** Cap on scraped text handed to the extractor. */
const MAX_PAGE_CHARS = 20_000
/** How long to look for a sign-in form before deciding the page is already open. */
const LOGIN_PROBE_MS = 3_000
const DEFAULT_MAX_ITEMS = 20

/** Fields that mean "this is a sign-in wall, not the announcements page". */
const PASSWORD_FIELDS = ['input[type="password"]', 'input[name="password"]']

/* ────────────────────────────── configuration ────────────────────────────── */

export interface PortalConfig {
  /** Bare hostname, the key `site_credentials` and `loginToSite` use. */
  site: string
  /** The announcements or events page to read. */
  eventsUrl: string
  /** CSS selector for the announcements area. Empty means the whole page. */
  contentSelector: string
  maxItems: number
}

function httpUrl(raw: string | undefined): URL | null {
  if (raw === undefined) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
  } catch {
    return null
  }
}

/** Validate one watcher's config into something the scrape can run against. */
export function readPortalConfig(
  row: WatcherRow,
): { ok: true; value: PortalConfig } | { ok: false; error: string } {
  const cfg = configOf(row)

  const events = httpUrl(
    readString(cfg.eventsUrl) ?? readString(cfg.announcementsUrl) ?? readString(cfg.url),
  )
  if (events === null) {
    return { ok: false, error: 'no valid eventsUrl is configured for this portal.' }
  }

  // The login page is only ever reached by redirect from the events page, so a
  // configured loginUrl must live on the same site — otherwise a tampered
  // config could walk a session cookie somewhere else.
  const loginRaw = readString(cfg.loginUrl)
  if (loginRaw !== undefined) {
    const login = httpUrl(loginRaw)
    if (login === null) return { ok: false, error: `"${loginRaw}" is not a valid loginUrl.` }
    if (login.origin !== events.origin) {
      return { ok: false, error: 'loginUrl and eventsUrl must be on the same site.' }
    }
  }

  const site = normalizeSite(readString(cfg.site) ?? events.hostname)
  if (site === '') return { ok: false, error: 'could not work out a site name for this portal.' }

  return {
    ok: true,
    value: {
      site,
      eventsUrl: events.toString(),
      contentSelector: readString(cfg.contentSelector) ?? '',
      maxItems: readNumber(cfg.maxItems, DEFAULT_MAX_ITEMS, 1, 50),
    },
  }
}

/* ─────────────────────────────── the scrape ──────────────────────────────── */

/**
 * Open the announcements page, signing in on the way if the portal insists.
 *
 * The whole browser script is these four steps. No loop, no alternate selector
 * hunt, no retry against a different page — which is what makes it something a
 * hostile page cannot redirect into doing something else.
 */
async function readPortalPage(page: Page, config: PortalConfig): Promise<string> {
  await openAllowed(page, config.eventsUrl)

  // A deep link into a portal usually bounces to a sign-in form. That is the
  // only condition under which credentials are ever used.
  const wall = await firstVisible(page, PASSWORD_FIELDS, LOGIN_PROBE_MS)
  if (wall !== null) {
    const signedIn = await loginToSite(page, config.site)
    if (!signedIn) {
      throw new Error(
        `could not sign in to ${config.site}. Check the stored credential, or whether the portal is asking for a second factor.`,
      )
    }
    await openAllowed(page, config.eventsUrl)
  }

  if (config.contentSelector !== '') {
    const scoped = await textOf(page, [config.contentSelector], { maxChars: MAX_PAGE_CHARS })
    if (scoped !== null && scoped.trim() !== '') return scoped
    log.warn(
      { site: config.site, selector: config.contentSelector },
      'contentSelector matched nothing, falling back to the whole page',
    )
  }
  return pageText(page, MAX_PAGE_CHARS)
}

/* ──────────────────────────────── one watcher ────────────────────────────── */

interface PassResult {
  added: DigestEntry[]
  injectionNotes: string[]
}

async function pollOne(row: WatcherRow, now: DateTime): Promise<PassResult> {
  const result: PassResult = { added: [], injectionNotes: [] }

  const parsed = readPortalConfig(row)
  if (!parsed.ok) {
    await markWatcherError(row.id, parsed.error)
    log.warn({ watcherId: row.id, name: row.name, error: parsed.error }, 'portal watcher misconfigured')
    return result
  }
  const config = parsed.value

  // Fail before launching a browser, and say the useful thing.
  const allowed = checkUrl(config.eventsUrl)
  if (!allowed.ok) {
    await markWatcherError(
      row.id,
      `${allowed.reason}. Add the portal's host to BROWSER_ALLOWED_DOMAINS to let this watcher read it.`,
    )
    return result
  }

  const checkpoint = now.toJSDate()
  const text = await withBrowser((page) => readPortalPage(page, config))
  if (text.trim() === '') {
    await markWatcherError(row.id, 'the portal page came back empty.')
    return result
  }

  // The page URL is the source reference, so an announcement that stays up for
  // a fortnight hashes the same on every scrape and is only ever added once.
  const extraction = await extractEventsDetailed(`portal:${config.site}`, text, config.eventsUrl)
  result.injectionNotes.push(...extraction.injectionNotes)

  if (extraction.items.length > 0) {
    const ingested = await ingestItems({
      watcherId: row.id,
      watcherName: row.name,
      sourceRef: config.eventsUrl,
      sourceLabel: `${row.name} portal, read ${now.toFormat('yyyy-MM-dd')}`,
      items: extraction.items.slice(0, config.maxItems),
    })
    result.added.push(...ingested.added)
  }

  await markWatcherChecked(row.id, checkpoint)
  return result
}

/* ───────────────────────────────── the sweep ─────────────────────────────── */

/**
 * Poll every active portal watcher.
 *
 * Returns `{ checked: 0, added: 0 }` without touching anything when
 * `BROWSER_ENABLED` is false — the deliberate default for this household.
 */
export async function pollPortalWatchers(): Promise<{ checked: number; added: number }> {
  let cfg: ReturnType<typeof getConfig>
  try {
    cfg = getConfig()
  } catch (err) {
    log.error({ err }, 'portal watchers skipped: configuration unavailable')
    return { checked: 0, added: 0 }
  }

  if (!cfg.BROWSER_ENABLED) {
    log.debug('portal watchers skipped: BROWSER_ENABLED is false')
    return { checked: 0, added: 0 }
  }

  const rows = await loadActiveWatchers(PORTAL_WATCHER_TYPES)
  if (rows.length === 0) return { checked: 0, added: 0 }

  if (!(await browserAvailable())) {
    const message = 'Chromium is not installed on this host, so the portal could not be read.'
    for (const row of rows) await markWatcherError(row.id, message)
    log.warn({ watchers: rows.length }, 'portal watchers skipped: no usable browser')
    return { checked: 0, added: 0 }
  }

  const now = DateTime.now().setZone(cfg.HOUSEHOLD_TIMEZONE)
  const added: DigestEntry[] = []
  const injectionNotes: string[] = []
  let checked = 0

  for (const row of rows) {
    try {
      const pass = await pollOne(row, now)
      added.push(...pass.added)
      for (const note of pass.injectionNotes) {
        if (!injectionNotes.includes(note)) injectionNotes.push(note)
      }
      checked += 1
    } catch (err) {
      // `errorText` is the browser subsystem's own scrubbed renderer; nothing a
      // credential touched can reach a log line or `/status` through it.
      const message = errorText(err) || describeError(err)
      log.error({ watcherId: row.id, name: row.name, err: message }, 'portal watcher pass failed')
      await markWatcherError(row.id, message)
    }
  }

  await sendWatcherDigest(added, injectionNotes)
  return { checked, added: added.length }
}
