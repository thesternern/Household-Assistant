/**
 * The one Playwright process this household runs.
 *
 * Everything about it is built to fail safe and fail loudly, because it drives a
 * logged-in Amazon session on behalf of a language model that reads
 * attacker-controlled product pages.
 *
 * The guarantees:
 *
 *  - **Off by default.** With `BROWSER_ENABLED=false` nothing launches, ever.
 *    `withBrowser` throws before it touches Playwright and `browserAvailable()`
 *    answers false, so `/status` can say so honestly instead of guessing.
 *  - **Lazy and singular.** Chromium starts on the first real task and then
 *    stays up with a persistent profile at `BROWSER_PROFILE_DIR`, so a sign-in
 *    survives a task, a deploy, and a restart. Tasks are serialised: there is
 *    one profile and one logged-in session, and two of them interleaving on the
 *    same cart is a way to buy the wrong thing.
 *  - **A hard 90-second budget.** A task that overruns is abandoned and its page
 *    closed. A wedged browser must not wedge the assistant.
 *  - **Every request checked, redirects included.** A context-level route runs
 *    each request through {@link isAllowedUrl} and aborts anything off the
 *    allowlist. Chromium follows a 3xx internally without re-running route
 *    handlers — for subresources exactly as for navigations — so the guard
 *    fetches every allowed request itself with redirects disabled and replays
 *    each hop as a fresh request — every hop faces the allowlist. Service
 *    workers are blocked outright, because requests they make bypass route
 *    interception entirely. A second tripwire watches main-frame navigations,
 *    so even a route we somehow miss is caught before a scraper reads the page.
 *
 * The route guard blocks *subresources* as well as navigations. That is the safe
 * default and it is the only knob: a household that needs Amazon's asset CDNs
 * for a page to render adds those hosts to `BROWSER_ALLOWED_DOMAINS` rather than
 * getting a quiet exception carved out here.
 */
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import type { BrowserContext, Locator, Page, Request as PwRequest, Route } from 'playwright'
import { getConfig } from '../config.js'
import { logger } from '../logger.js'
import { checkUrl, isAllowedUrl, redactUrl } from './allowlist.js'

const log = logger.child({ mod: 'browser/worker' })

/** Hard ceiling on one browser task. Nothing in here may run longer. */
export const BROWSER_BUDGET_MS = 90_000

/** Per-action defaults. Both sit well inside the task budget. */
const DEFAULT_ACTION_TIMEOUT_MS = 20_000
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000

/** How many tasks may wait for the single browser before we refuse outright. */
const MAX_QUEUE_DEPTH = 4

/**
 * A recent, ordinary desktop Chrome string. Playwright's default advertises
 * HeadlessChrome, which is an instant bot flag on a retail site.
 */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/140.0.0.0 Safari/537.36'

export type BrowserErrorCode =
  /** BROWSER_ENABLED is false. */
  | 'disabled'
  /** Chromium is not installed, or the context would not launch. */
  | 'unavailable'
  /** The task blew the 90-second budget. */
  | 'timeout'
  /** Too many tasks already waiting for the single browser. */
  | 'busy'
  /** A URL or a landed page was off the allowlist. */
  | 'blocked'
  /** The page was not the page we expected — selectors drifted, or a wall appeared. */
  | 'page_shape'
  /** The caller asked for something nonsensical. */
  | 'bad_input'

/**
 * Every failure this subsystem raises. The `code` lets the tool layer turn a
 * throw into an honest sentence, and `url` records where we actually were —
 * which is the first thing a human needs when a selector drifts.
 */
export class BrowserError extends Error {
  readonly code: BrowserErrorCode
  readonly url: string | undefined

  constructor(code: BrowserErrorCode, message: string, url?: string) {
    super(url ? `${message} (page: ${redactUrl(url)})` : message)
    this.name = 'BrowserError'
    this.code = code
    this.url = url === undefined ? undefined : redactUrl(url)
  }
}

export function isBrowserError(err: unknown): err is BrowserError {
  return err instanceof BrowserError
}

/** Message text for anything thrown, without leaking a stack into a chat reply. */
export function errorText(err: unknown): string {
  if (isBrowserError(err)) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

/* ─────────────────────────────── the singleton ───────────────────────────── */

let contextPromise: Promise<BrowserContext> | null = null

/** Hosts the route guard refused during the current task, for the failure message. */
let blockedHosts = new Set<string>()

function noteBlocked(url: string): void {
  try {
    blockedHosts.add(new URL(url).hostname.toLowerCase())
  } catch {
    blockedHosts.add('(unparseable)')
  }
}

/** Hosts blocked during the task that just ran. Diagnostics only. */
export function lastBlockedHosts(): string[] {
  return [...blockedHosts]
}

/**
 * What the route guard does with one request. Pure, so the hostile cases are
 * testable without launching a browser.
 *
 *  - `continue`: a non-network scheme that cannot be a cross-host hop.
 *  - `pin-redirects`: every allowlisted network request. Playwright's route
 *    handler "will only be called for the first url if the response is a
 *    redirect" — Chromium follows a 3xx internally without ever re-entering
 *    the guard, and it does that for subresources exactly as for navigations.
 *    So the guard fetches the response itself with redirects disabled and
 *    hands the raw 3xx back to the browser; the browser then issues the hop
 *    as a fresh request, which lands back in this guard and faces the
 *    allowlist like any other URL. Without this, an approved amazon.com URL
 *    that 302s to evil.tld sails through on the strength of its first hop —
 *    and so does an amazon.com script or XHR that redirects off-site.
 *  - `abort`: everything else — an off-allowlist host, plain http, or a scheme
 *    such as file:// that has no business in this browser. Closed by default.
 */
export type RouteDecision = 'continue' | 'pin-redirects' | 'abort'

/** Schemes that never reach the network and cannot hop to another host. */
const NON_NETWORK_OK = /^(?:about:|data:|blob:)/i

export function routeDecisionFor(url: string, isNavigation: boolean): RouteDecision {
  if (NON_NETWORK_OK.test(url)) return 'continue'
  // Everything else faces the allowlist, which only ever passes https on an
  // allowlisted host. file:, ftp:, chrome-extension:, and friends all land here
  // and are refused.
  if (!isAllowedUrl(url)) return 'abort'
  // Redirects bypass route handlers for every resource type, so every allowed
  // request gets its redirects pinned. `isNavigation` deliberately does not
  // change the decision — it only changes how loudly a block is logged.
  return 'pin-redirects'
}

/** Enforces {@link routeDecisionFor}. Every request in the context comes through here. */
async function guardRequest(route: Route, request: PwRequest): Promise<void> {
  const url = request.url()
  const navigation = request.isNavigationRequest()
  const decision = routeDecisionFor(url, navigation)

  if (decision === 'continue') {
    try {
      await route.continue()
    } catch {
      // The request went away underneath us (page closed, navigation cancelled).
    }
    return
  }

  if (decision === 'pin-redirects') {
    try {
      const response = await route.fetch({ maxRedirects: 0 })
      await route.fulfill({ response })
    } catch (err) {
      // The fetch or the fulfil failed — page closed mid-flight, or a network
      // error. Failing the request is the safe direction; a plain continue
      // here would let the network stack follow a redirect unseen.
      log.warn(
        { url: redactUrl(url), navigation, err: errorText(err) },
        'could not pin redirects for a request, failing it',
      )
      try {
        await route.abort('failed')
      } catch {
        // Same race as above; the abort is best-effort.
      }
    }
    return
  }

  noteBlocked(url)
  const detail = { url: redactUrl(url), navigation, reason: checkUrl(url) }
  if (navigation) {
    // A navigation off the allowlist is the case this whole module exists for.
    log.error(detail, 'blocked a navigation to a host that is not on the browser allowlist')
  } else {
    log.warn(detail, 'blocked a subresource from a host that is not on the browser allowlist')
  }

  try {
    await route.abort('blockedbyclient')
  } catch {
    // Same race as above; the abort is best-effort.
  }
}

async function launchContext(): Promise<BrowserContext> {
  const cfg = getConfig()
  if (!cfg.BROWSER_ENABLED) {
    throw new BrowserError('disabled', 'Browser automation is off (BROWSER_ENABLED=false).')
  }

  let chromium: typeof import('playwright').chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch (err) {
    throw new BrowserError('unavailable', `Playwright is not loadable: ${errorText(err)}`)
  }

  try {
    await mkdir(cfg.BROWSER_PROFILE_DIR, { recursive: true })
  } catch (err) {
    throw new BrowserError(
      'unavailable',
      `Cannot use the browser profile directory ${cfg.BROWSER_PROFILE_DIR}: ${errorText(err)}`,
    )
  }

  let context: BrowserContext
  try {
    context = await chromium.launchPersistentContext(cfg.BROWSER_PROFILE_DIR, {
      headless: true,
      viewport: { width: 1366, height: 900 },
      userAgent: USER_AGENT,
      locale: 'en-US',
      timezoneId: cfg.HOUSEHOLD_TIMEZONE,
      acceptDownloads: false,
      // Requests a service worker makes bypass route interception entirely
      // (playwright#1090), which would put them outside the allowlist guard.
      // No service workers, no unguarded requests.
      serviceWorkers: 'block',
      // Chromium advertises itself as automated by default; retail bot detection
      // reads that flag first. This is not a cloaking effort, just not shouting.
      args: ['--disable-blink-features=AutomationControlled'],
    })
  } catch (err) {
    throw new BrowserError('unavailable', `Chromium would not start: ${errorText(err)}`)
  }

  context.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT_MS)
  context.setDefaultNavigationTimeout(DEFAULT_NAVIGATION_TIMEOUT_MS)

  // One guard for every page this context will ever open.
  await context.route('**/*', (route, request) => {
    void guardRequest(route, request)
  })

  context.on('close', () => {
    log.info('browser context closed')
    contextPromise = null
  })

  log.info({ profileDir: cfg.BROWSER_PROFILE_DIR }, 'browser context launched')
  return context
}

async function getContext(): Promise<BrowserContext> {
  if (!contextPromise) {
    contextPromise = launchContext().catch((err: unknown) => {
      contextPromise = null
      throw err
    })
  }
  return contextPromise
}

/* ──────────────────────────────── the mutex ──────────────────────────────── */

let chain: Promise<unknown> = Promise.resolve()
let waiting = 0

/** FIFO lock. One browser, one profile, one task at a time. */
async function acquire(): Promise<() => void> {
  if (waiting >= MAX_QUEUE_DEPTH) {
    throw new BrowserError(
      'busy',
      `The browser already has ${waiting} tasks queued. Try again in a minute.`,
    )
  }
  waiting += 1
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const myTurn = chain.then(
    () => undefined,
    () => undefined,
  )
  chain = myTurn.then(() => held)
  await myTurn
  waiting -= 1
  return release
}

/* ──────────────────────────────── the budget ─────────────────────────────── */

/**
 * `work`, or a `timeout` {@link BrowserError} after `ms` — whichever settles
 * first. Exported for tests; {@link withBrowser} is the only production caller.
 */
export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const alarm = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new BrowserError('timeout', `The browser task ran past its ${Math.round(ms / 1000)}s budget.`),
      )
    }, ms)
    timer.unref?.()
  })
  return Promise.race([work, alarm]).finally(() => {
    if (timer) clearTimeout(timer)
    // When the alarm wins, `work` is still in flight and will usually reject a
    // moment later, once the page underneath it is closed. Nothing is listening
    // to it any more, and an unhandled rejection takes the whole process down —
    // so give the loser a listener that drops its result on the floor.
    void work.then(
      () => undefined,
      () => undefined,
    )
  })
}

/* ─────────────────────────────── public surface ──────────────────────────── */

/**
 * Run `fn` against a fresh page in the shared browser.
 *
 * Launches Chromium on first use, serialises against every other task, applies
 * the 90-second budget, and always closes the page — including when `fn` throws
 * or the budget expires.
 *
 * Throws {@link BrowserError} with code `disabled`, `unavailable`, `busy`, or
 * `timeout`. Anything `fn` throws propagates unchanged.
 */
export async function withBrowser<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const cfg = getConfig()
  if (!cfg.BROWSER_ENABLED) {
    throw new BrowserError(
      'disabled',
      'Browser automation is off. Set BROWSER_ENABLED=true to turn it on.',
    )
  }

  const release = await acquire()
  blockedHosts = new Set<string>()
  try {
    const context = await getContext()
    const page = await context.newPage()

    // A popup is a page outside the guarded flow. Close it and carry on.
    page.on('popup', (popup) => {
      log.warn({ url: redactUrl(popup.url()) }, 'closing a popup opened by the page')
      void popup.close().catch(() => undefined)
    })

    // Tripwire behind the route guard: if a main-frame navigation ever lands
    // somewhere off the allowlist, say so loudly. `assertPageAllowed` is what
    // turns it into a refusal, and every navigation helper calls it.
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      const url = frame.url()
      if (url === '' || url === 'about:blank') return
      if (!isAllowedUrl(url)) {
        noteBlocked(url)
        log.error({ url: redactUrl(url) }, 'main frame landed on a host that is not allowlisted')
      }
    })

    try {
      return await withDeadline(fn(page), BROWSER_BUDGET_MS)
    } finally {
      await page.close({ runBeforeUnload: false }).catch((err: unknown) => {
        log.warn({ err: errorText(err) }, 'could not close the browser page')
      })
    }
  } finally {
    release()
  }
}

/** Closes Chromium and drops the singleton. Safe to call when nothing is running. */
export async function shutdownBrowser(): Promise<void> {
  const pending = contextPromise
  contextPromise = null
  if (!pending) return
  try {
    const context = await pending
    await context.close()
    log.info('browser shut down')
  } catch (err) {
    log.warn({ err: errorText(err) }, 'browser shutdown was not clean')
  }
}

/** Is the Chromium build Playwright wants actually on disk? Nothing is launched. */
export async function chromiumInstalled(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright')
    const executable = chromium.executablePath()
    if (!executable || !existsSync(executable)) {
      log.warn({ executable }, 'chromium is not installed, browser tasks will refuse')
      return false
    }
    return true
  } catch (err) {
    log.warn({ err: errorText(err) }, 'chromium is not usable, browser tasks will refuse')
    return false
  }
}

/**
 * Can this box actually drive a browser right now?
 *
 * False when `BROWSER_ENABLED` is off, when Playwright will not load, or when
 * the Chromium build it wants is not on disk. It never throws and never
 * launches anything, so `/status` can call it freely.
 */
export async function browserAvailable(): Promise<boolean> {
  let enabled: boolean
  try {
    enabled = getConfig().BROWSER_ENABLED
  } catch (err) {
    log.warn({ err: errorText(err) }, 'config unreadable, reporting the browser as unavailable')
    return false
  }
  if (!enabled) return false
  return chromiumInstalled()
}

/* ────────────────────────── shared page-reading helpers ──────────────────── */

/**
 * The first of `selectors` that is actually visible, or null.
 *
 * One combined wait, then a cheap per-selector visibility check, so a list of
 * five fallbacks costs one timeout rather than five. Selectors must be plain
 * CSS — they are joined with commas.
 *
 * This is the shape of every "has the page drifted?" check in this subsystem:
 * ask for the landmarks you expect, and when none of them is there, stop.
 */
export async function firstVisible(
  scope: Page | Locator,
  selectors: string[],
  timeoutMs = 5_000,
): Promise<Locator | null> {
  const usable = selectors.filter((s) => s.trim() !== '')
  if (usable.length === 0) return null

  const combined = usable.join(', ')
  try {
    await scope.locator(combined).first().waitFor({ state: 'visible', timeout: timeoutMs })
  } catch {
    return null
  }
  for (const selector of usable) {
    const locator = scope.locator(selector).first()
    if (await locator.isVisible().catch(() => false)) return locator
  }
  return null
}

/** Trimmed text of the first matching selector, or null. Never throws. */
export async function textOf(
  scope: Page | Locator,
  selectors: string[],
  opts?: { maxChars?: number },
): Promise<string | null> {
  for (const selector of selectors) {
    const locator = scope.locator(selector).first()
    const raw = await locator.textContent({ timeout: 1_500 }).catch(() => null)
    if (raw === null) continue
    const text = raw.replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const cap = opts?.maxChars ?? 400
    return text.length > cap ? `${text.slice(0, cap - 3)}...` : text
  }
  return null
}

/** Visible text of the page, capped. Used to spot bot walls and empty states. */
export async function pageText(page: Page, maxChars = 20_000): Promise<string> {
  const raw = await page
    .locator('body')
    .innerText({ timeout: 5_000 })
    .catch(() => '')
  return raw.slice(0, maxChars)
}

/**
 * Throws unless the page is currently sitting on an allowlisted URL. Call it
 * after every navigation: it is what turns the tripwire above into a refusal.
 */
export function assertPageAllowed(page: Page): void {
  const url = page.url()
  if (url === '' || url === 'about:blank') return
  const check = checkUrl(url)
  if (check.ok) return
  throw new BrowserError(
    'blocked',
    `The browser ended up somewhere it is not allowed to be: ${check.reason}.`,
    url,
  )
}

/**
 * Navigate to an allowlisted URL and confirm we landed on one.
 *
 * Checks before the hop (so a bad URL never reaches Chromium) and after it (so a
 * chain of redirects cannot deposit us somewhere else).
 */
export async function openAllowed(
  page: Page,
  url: string,
  opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; timeoutMs?: number },
): Promise<void> {
  const check = checkUrl(url)
  if (!check.ok) {
    throw new BrowserError('blocked', `Refusing to open that URL: ${check.reason}.`, url)
  }

  try {
    await page.goto(url, {
      waitUntil: opts?.waitUntil ?? 'domcontentloaded',
      timeout: opts?.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
    })
  } catch (err) {
    const blocked = lastBlockedHosts()
    if (blocked.length > 0) {
      throw new BrowserError(
        'blocked',
        `Navigation failed and the allowlist blocked ${blocked.join(', ')}. ` +
          'Add those hosts to BROWSER_ALLOWED_DOMAINS if they are genuinely part of the site.',
        url,
      )
    }
    throw new BrowserError('page_shape', `Could not load the page: ${errorText(err)}`, url)
  }

  assertPageAllowed(page)
}
