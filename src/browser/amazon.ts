/**
 * Amazon, driven through a real browser, because there is no API a household
 * can use. `docs/AMAZON.md` records why, and what the two modes are:
 *
 *  - **Cart and hand off** (the default). Search, compare, add to the cart, send
 *    the link. No money moves, a human taps checkout in the app.
 *  - **Full checkout** (opt-in, experimental). An approval card every time, a
 *    hard monthly cap, and a re-check of both immediately before the click.
 *
 * Three rules run through every function here.
 *
 * **1. Scraped text is hostile.** A product title, a price, a seller blurb — all
 * of it is written by someone who would like the agent to do something else.
 * Nothing scraped goes to the model except inside {@link wrapUntrusted}, which
 * is what {@link untrustedProductList} and {@link untrustedCart} are for. The
 * plain fields on {@link AmazonProduct} exist for our own formatting and
 * arithmetic, not to be pasted into a prompt.
 *
 * **2. Selectors drift, so check the page before you touch it.** Every function
 * looks for the landmarks it expects and stops with a clear message and the URL
 * when they are missing. It never falls back to "click the first button that
 * looks right" — on a shopping site that is how you buy a warranty.
 *
 * **3. Dry run means nothing happens.** With `DRY_RUN_BROWSER=true`, search
 * still runs (it is a read), and `addToCart` and `checkout` simulate and say so
 * in the first word of the result.
 */
import { getConfig } from '../config.js'
import { logger } from '../logger.js'
import { hasApprovedAction } from '../policy/pending.js'
import { wrapUntrusted } from '../tools/untrusted.js'
import { assertAllowedUrl, isAllowedUrl, redactUrl } from './allowlist.js'
import { loginToSite } from './credentials.js'
import {
  BrowserError,
  errorText,
  firstVisible,
  openAllowed,
  pageText,
  textOf,
  withBrowser,
} from './worker.js'
import type { Locator, Page } from 'playwright'

const log = logger.child({ mod: 'browser/amazon' })

const BASE = 'https://www.amazon.com'
export const CART_URL = `${BASE}/gp/cart/view.html`
const SITE_KEY = 'amazon.com'

/** Label used on every untrusted fence out of this module. */
const SOURCE_PREFIX = 'amazon'

/** Ceilings that keep one call from turning into a crawl. */
const MAX_SEARCH_RESULTS = 20
const DEFAULT_SEARCH_RESULTS = 5
const MAX_QUANTITY = 30

/** How far a re-read total may drift from the approved one before we refuse. */
const TOTAL_TOLERANCE_USD = 0.5
const TOTAL_TOLERANCE_FRACTION = 0.02

export interface AmazonProduct {
  asin: string
  /** Scraped. Untrusted text — fence it before it reaches the model. */
  title: string
  /** Scraped, as displayed, e.g. `$18.99`. Untrusted text. */
  price: string
  /** `price` parsed to a number, or null when it could not be read. */
  priceUsd: number | null
  /** Scraped, e.g. `4.5 out of 5 stars`. Untrusted text. */
  rating: string | null
  /** Product URL on an allowlisted host. */
  url: string
}

export interface AmazonCartItem {
  /** Scraped. Untrusted text. */
  title: string
  /** Scraped, as displayed. Untrusted text. */
  price: string
  quantity: number
}

export interface AmazonCart {
  items: AmazonCartItem[]
  /** Scraped, as displayed. Untrusted text. */
  subtotal: string
  cartUrl: string
}

/* ─────────────────────────────── small helpers ───────────────────────────── */

function shapeError(what: string, url: string): BrowserError {
  return new BrowserError(
    'page_shape',
    `Amazon's page was not what I expected: ${what}. ` +
      'That usually means the layout changed or a wall appeared, so I stopped instead of clicking something at random.',
    url,
  )
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * `$1,234.56` -> 1234.56. Null when there is no number in there.
 *
 * A dollar-marked amount wins over any bare number: the text around a total
 * often carries other digits — "Subtotal (3 items): $154.21" — and the first
 * bare number in that string is the item count, not the money. The bare-number
 * fallback only runs when no `$` amount exists at all.
 */
export function parseUsd(text: string | null | undefined): number | null {
  if (typeof text !== 'string') return null
  const flat = text.replace(/\s/g, '')
  const dollar = /\$(-?\d[\d,]*(?:\.\d{1,2})?)/.exec(flat)
  const bare = /-?\d[\d,]*(?:\.\d{1,2})?/.exec(flat)
  const match = dollar?.[1] ?? bare?.[0]
  if (match === undefined) return null
  const n = Number(match.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`
}

/** True when two totals differ by more than the greater of 50c and 2%. */
export function totalsDisagree(approvedUsd: number, observedUsd: number): boolean {
  const tolerance = Math.max(TOTAL_TOLERANCE_USD, Math.abs(approvedUsd) * TOTAL_TOLERANCE_FRACTION)
  return Math.abs(observedUsd - approvedUsd) > tolerance
}

/** Flatten scraped text to one line and cap it, for our own log lines. */
function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat
}

const BOT_WALL_MARKERS = [
  'enter the characters you see below',
  'type the characters you see in this image',
  'to discuss automated access to amazon data',
  'sorry, we just need to make sure',
  'click the button below to continue shopping',
]

/** Stops everything: a captcha or a robot interstitial. */
async function assertNotWalled(page: Page): Promise<void> {
  const url = page.url()
  if (url.includes('/errors/validateCaptcha') || url.includes('/errors/robot')) {
    throw shapeError('Amazon served a bot check instead of the page', url)
  }
  const text = (await pageText(page, 3_000)).toLowerCase()
  for (const marker of BOT_WALL_MARKERS) {
    if (text.includes(marker)) {
      throw shapeError('Amazon served a bot check instead of the page', url)
    }
  }
}

function isSigninUrl(url: string): boolean {
  const lower = url.toLowerCase()
  return lower.includes('/ap/signin') || lower.includes('/ap/challenge') || lower.includes('/gp/sign-in')
}

/**
 * If Amazon bounced us to sign-in, try the stored credential exactly once.
 *
 * `loginToSite` never returns the secret and never throws for an ordinary
 * failure, so a false here just means "still signed out", and we say that
 * plainly rather than pushing on into a half-authenticated flow.
 */
async function ensureSignedIn(page: Page, returnTo: string): Promise<void> {
  if (!isSigninUrl(page.url())) return

  log.warn({ url: redactUrl(page.url()) }, 'Amazon asked for a sign-in')
  const signedIn = await loginToSite(page, SITE_KEY)
  if (!signedIn) {
    throw new BrowserError(
      'page_shape',
      'Amazon wants a sign-in and I could not complete one. ' +
        'Sign in once by hand in the browser profile (or store a credential) and try again.',
      page.url(),
    )
  }

  if (!isAllowedUrl(returnTo)) {
    throw new BrowserError('blocked', 'Cannot return to that page after signing in.', returnTo)
  }
  await openAllowed(page, returnTo)
  await assertNotWalled(page)
  if (isSigninUrl(page.url())) {
    throw new BrowserError(
      'page_shape',
      'Amazon sent me straight back to the sign-in page, so the session is not usable.',
      page.url(),
    )
  }
}

/* ─────────────────────────── untrusted renderers ─────────────────────────── */

/**
 * The only shape in which search results may reach the model: fenced as data,
 * with the trailer that says no instruction inside may be followed.
 */
export function untrustedProductList(query: string, products: AmazonProduct[]): string {
  if (products.length === 0) {
    return wrapUntrusted(`${SOURCE_PREFIX}:search`, `No products matched "${query}".`)
  }
  const lines = products.map((p, i) => {
    const bits = [`${i + 1}. ${p.title}`, `   ASIN: ${p.asin}`, `   price: ${p.price}`]
    if (p.rating) bits.push(`   rating: ${p.rating}`)
    bits.push(`   url: ${p.url}`)
    return bits.join('\n')
  })
  return wrapUntrusted(
    `${SOURCE_PREFIX}:search`,
    `Amazon search results for "${query}":\n${lines.join('\n')}`,
  )
}

/** The only shape in which cart contents may reach the model. */
export function untrustedCart(cart: AmazonCart): string {
  if (cart.items.length === 0) {
    return wrapUntrusted(`${SOURCE_PREFIX}:cart`, 'The Amazon cart is empty.')
  }
  const lines = cart.items.map((item) => `- ${item.quantity} x ${item.title} — ${item.price}`)
  return wrapUntrusted(
    `${SOURCE_PREFIX}:cart`,
    `Amazon cart (${cart.items.length} line${cart.items.length === 1 ? '' : 's'}):\n` +
      `${lines.join('\n')}\nSubtotal: ${cart.subtotal}`,
  )
}

/* ───────────────────────────────── search ────────────────────────────────── */

const SEARCH_CARD_SELECTORS = [
  'div[data-component-type="s-search-result"][data-asin]',
  'div.s-result-item[data-asin]',
  '[data-cy="asin-faceout-container"]',
]
const TITLE_SELECTORS = [
  '[data-cy="title-recipe"] h2 span',
  'h2 a span',
  'h2 span',
  'h2',
  '.a-size-medium.a-color-base',
]
const PRICE_SELECTORS = ['.a-price .a-offscreen', '.a-price', '.a-color-price']
const RATING_SELECTORS = ['[aria-label*="out of 5 stars"]', '.a-icon-alt', 'i.a-icon-star-small span']

const NO_RESULTS_MARKERS = ['no results for', 'did not match any products', 'try checking your spelling']

/**
 * Search Amazon and return up to `maxResults` products.
 *
 * A read, so it runs in dry-run mode too. Throws {@link BrowserError} when the
 * page is not a search page — the caller turns that into a sentence with the URL
 * in it, which is what a human needs when Amazon reshuffles its markup.
 */
export async function searchAmazon(
  query: string,
  opts?: { maxResults?: number },
): Promise<AmazonProduct[]> {
  const q = String(query ?? '').trim()
  if (q === '') throw new BrowserError('bad_input', 'Give me something to search for.')
  if (q.length > 200) {
    throw new BrowserError('bad_input', 'That search query is too long for Amazon.')
  }
  const max = clampInt(opts?.maxResults, 1, MAX_SEARCH_RESULTS, DEFAULT_SEARCH_RESULTS)

  const url = `${BASE}/s?k=${encodeURIComponent(q)}`
  assertAllowedUrl(url)

  return withBrowser(async (page) => {
    await openAllowed(page, url)
    await assertNotWalled(page)
    await ensureSignedIn(page, url)

    const cards = await firstSearchCards(page)
    if (!cards) {
      const text = (await pageText(page, 4_000)).toLowerCase()
      if (NO_RESULTS_MARKERS.some((marker) => text.includes(marker))) {
        log.info({ query: oneLine(q) }, 'amazon search returned nothing')
        return []
      }
      throw shapeError('no product cards on the search results page', page.url())
    }

    const count = Math.min(await cards.count(), max * 3)
    const products: AmazonProduct[] = []

    for (let i = 0; i < count && products.length < max; i += 1) {
      const card = cards.nth(i)
      const asin = ((await card.getAttribute('data-asin').catch(() => null)) ?? '').trim()
      // Sponsored rails and layout spacers carry an empty data-asin.
      if (!/^[A-Za-z0-9]{10}$/.test(asin)) continue

      const title = await textOf(card, TITLE_SELECTORS, { maxChars: 300 })
      if (!title) continue

      const priceText = await textOf(card, PRICE_SELECTORS, { maxChars: 40 })
      const rating = await textOf(card, RATING_SELECTORS, { maxChars: 60 })

      products.push({
        asin: asin.toUpperCase(),
        title,
        price: priceText ?? 'no price shown',
        priceUsd: parseUsd(priceText),
        rating,
        url: `${BASE}/dp/${asin.toUpperCase()}`,
      })
    }

    if (products.length === 0) {
      throw shapeError('product cards were present but none of them had a title', page.url())
    }

    log.info({ query: oneLine(q), found: products.length }, 'amazon search complete')
    return products
  })
}

async function firstSearchCards(page: Page): Promise<Locator | null> {
  for (const selector of SEARCH_CARD_SELECTORS) {
    const locator = page.locator(selector)
    const count = await locator.count().catch(() => 0)
    if (count > 0) return locator
  }
  return null
}

/* ──────────────────────────────── add to cart ────────────────────────────── */

const ASIN_RE = /^[A-Za-z0-9]{10}$/

/** Turn an ASIN or a product URL into a product page URL we are allowed to open. */
export function resolveProductUrl(asinOrUrl: string): { asin: string | null; url: string } {
  const raw = String(asinOrUrl ?? '').trim()
  if (raw === '') throw new BrowserError('bad_input', 'Give me an ASIN or an Amazon product URL.')

  if (ASIN_RE.test(raw)) {
    const asin = raw.toUpperCase()
    return { asin, url: `${BASE}/dp/${asin}` }
  }

  if (!raw.includes('://')) {
    throw new BrowserError(
      'bad_input',
      `"${oneLine(raw, 60)}" is neither a 10-character ASIN nor an Amazon URL. ` +
        'Get one from browser_search_amazon.',
    )
  }

  // Anything else has to be a URL, and it has to pass the allowlist.
  assertAllowedUrl(raw)
  const parsed = new URL(raw)
  // The trailing boundary matters: without it an 11-character path segment
  // yields a wrong 10-character ASIN instead of no ASIN at all.
  const match = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Za-z0-9]{10})(?:[/?#]|$)/.exec(parsed.pathname)
  const asin = match?.[1] ? match[1].toUpperCase() : null
  // Drop the query string: Amazon URLs carry tracking and, occasionally, a
  // redirect parameter. The path is all we need.
  return { asin, url: `${parsed.origin}${parsed.pathname}` }
}

const ADD_TO_CART_SELECTORS = [
  '#add-to-cart-button',
  'input#add-to-cart-button',
  'input[name="submit.add-to-cart"]',
  '#submit\\.add-to-cart',
  '#desktop_buybox #add-to-cart-button',
]
const QUANTITY_SELECT_SELECTORS = ['select#quantity', 'select[name="quantity"]', '#quantity']
const ADDED_CONFIRMATION_SELECTORS = [
  '#attachDisplayAddBaseAlert',
  '#huc-v2-order-row-confirm-text',
  '#sw-atc-details-single-container',
  '#NATC_SMART_WAGON_CONF_MSG_SUCCESS',
  '[data-testid="atc-confirmation"]',
]
const UNAVAILABLE_MARKERS = [
  'currently unavailable',
  'we don’t know when or if this item will be back',
  'this item cannot be shipped to your selected delivery location',
]

/**
 * Add one product to the cart.
 *
 * This is the default path and it spends nothing, but it still drives a
 * logged-in session, which is why the tool that calls it sits in the
 * `browser_task` policy category.
 *
 * Never throws for an ordinary failure: it returns `ok: false` with a message
 * that names the URL, so the model can tell the household what happened instead
 * of retrying blind.
 */
export async function addToCart(
  asinOrUrl: string,
  quantity: number,
): Promise<{ ok: boolean; cartUrl: string; message: string }> {
  let target: { asin: string | null; url: string }
  try {
    target = resolveProductUrl(asinOrUrl)
  } catch (err) {
    return { ok: false, cartUrl: CART_URL, message: errorText(err) }
  }
  const qty = clampInt(quantity, 1, MAX_QUANTITY, 1)
  const label = target.asin ?? target.url

  const cfg = getConfig()
  if (cfg.DRY_RUN_BROWSER) {
    log.info({ asin: target.asin, qty }, 'dry run: add to cart simulated')
    return {
      ok: true,
      cartUrl: CART_URL,
      message:
        `SIMULATED — nothing was added. With DRY_RUN_BROWSER=false I would put ${qty} x ${label} ` +
        `in the Amazon cart. Set DRY_RUN_BROWSER=false to do it for real.`,
    }
  }

  try {
    return await withBrowser(async (page) => {
      await openAllowed(page, target.url)
      await assertNotWalled(page)
      await ensureSignedIn(page, target.url)

      const button = await firstVisible(page, ADD_TO_CART_SELECTORS, 8_000)
      if (!button) {
        const text = (await pageText(page, 5_000)).toLowerCase()
        if (UNAVAILABLE_MARKERS.some((marker) => text.includes(marker))) {
          return {
            ok: false,
            cartUrl: CART_URL,
            message: `Amazon says ${label} is currently unavailable, so there was nothing to add. Page: ${redactUrl(page.url())}`,
          }
        }
        return {
          ok: false,
          cartUrl: CART_URL,
          message:
            `I could not find an Add to Cart button on ${redactUrl(page.url())}. ` +
            'The page layout may have changed, or this listing may need options chosen first. ' +
            'Nothing was added.',
        }
      }

      // Quantity first: setting it after the click adds one and then edits the cart.
      let quantitySet = qty === 1
      if (qty > 1) {
        const select = await firstVisible(page, QUANTITY_SELECT_SELECTORS, 2_000)
        if (select) {
          const chosen = await select
            .selectOption(String(qty), { timeout: 5_000 })
            .then(() => true)
            .catch(() => false)
          if (!chosen) {
            const filled = await select
              .fill(String(qty), { timeout: 3_000 })
              .then(() => true)
              .catch(() => false)
            quantitySet = filled
          } else {
            quantitySet = true
          }
        }
      }

      await button.click({ timeout: 10_000 })
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined)
      await assertNotWalled(page)

      const confirmed =
        (await firstVisible(page, ADDED_CONFIRMATION_SELECTORS, 8_000)) !== null ||
        /\/(cart|huc\/view|gp\/cart)/.test(page.url())

      if (!confirmed) {
        return {
          ok: false,
          cartUrl: CART_URL,
          message:
            `I clicked Add to Cart on ${redactUrl(page.url())} but Amazon never confirmed it. ` +
            `Check the cart at ${CART_URL} before trying again — it may or may not have gone in.`,
        }
      }

      const qtyNote = quantitySet
        ? ''
        : ` I could not set the quantity to ${qty}, so only 1 went in — adjust it in the cart.`
      log.info({ asin: target.asin, qty, quantitySet }, 'added to amazon cart')
      return {
        ok: true,
        cartUrl: CART_URL,
        message: `Added ${quantitySet ? qty : 1} x ${label} to the Amazon cart.${qtyNote}`,
      }
    })
  } catch (err) {
    log.error({ err: errorText(err), asin: target.asin }, 'add to cart failed')
    return {
      ok: false,
      cartUrl: CART_URL,
      message: `Nothing was added: ${errorText(err)}`,
    }
  }
}

/* ─────────────────────────────────── cart ────────────────────────────────── */

const CART_ITEM_SELECTORS = [
  'div[data-name="Active Items"] div[data-asin][data-itemtype="active"]',
  'div[data-name="Active Items"] div.sc-list-item',
  'div[data-itemtype="active"]',
  '.sc-list-item[data-asin]',
]
const CART_TITLE_SELECTORS = [
  '.sc-product-title',
  '.sc-grid-item-product-title a span',
  '.sc-grid-item-product-title',
  'span.a-truncate-cut',
  '[data-a-truncate]',
]
const CART_PRICE_SELECTORS = [
  '.sc-product-price',
  '.sc-badge-price-to-pay .a-offscreen',
  '.a-price .a-offscreen',
  '.sc-price',
]
const CART_QTY_SELECT_SELECTORS = ['select[name="quantity"]', '.sc-quantity-textfield', 'input[name="quantity"]']
const CART_QTY_TEXT_SELECTORS = ['.a-dropdown-prompt', '[data-a-selector="value"]', '.sc-quantity-display']
const SUBTOTAL_SELECTORS = [
  '#sc-subtotal-amount-activecart .a-price .a-offscreen',
  '#sc-subtotal-amount-activecart .a-size-medium',
  '#sc-subtotal-amount-buybox .a-price .a-offscreen',
  '#sc-subtotal-amount-buybox',
  '[data-name="Subtotals"] .a-price .a-offscreen',
]
const EMPTY_CART_MARKERS = ['your amazon cart is empty', 'your cart is empty']

/** Read the cart. A read, so it runs in dry-run mode too. */
export async function getCart(): Promise<AmazonCart> {
  assertAllowedUrl(CART_URL)

  return withBrowser(async (page) => {
    await openAllowed(page, CART_URL)
    await assertNotWalled(page)
    await ensureSignedIn(page, CART_URL)

    const rows = await firstCartRows(page)
    if (!rows) {
      const text = (await pageText(page, 5_000)).toLowerCase()
      if (EMPTY_CART_MARKERS.some((marker) => text.includes(marker))) {
        return { items: [], subtotal: formatUsd(0), cartUrl: CART_URL }
      }
      throw shapeError('the cart page had neither line items nor an empty-cart message', page.url())
    }

    const count = await rows.count()
    const items: AmazonCartItem[] = []
    for (let i = 0; i < count && items.length < 60; i += 1) {
      const row = rows.nth(i)
      const title = await textOf(row, CART_TITLE_SELECTORS, { maxChars: 300 })
      if (!title) continue
      const price = await textOf(row, CART_PRICE_SELECTORS, { maxChars: 40 })
      items.push({ title, price: price ?? 'no price shown', quantity: await readQuantity(row) })
    }

    if (items.length === 0) {
      throw shapeError('cart rows were present but none of them had a title', page.url())
    }

    const subtotal = await textOf(page, SUBTOTAL_SELECTORS, { maxChars: 40 })
    if (!subtotal) {
      throw shapeError('the cart had items but no readable subtotal', page.url())
    }

    log.info({ lines: items.length }, 'read the amazon cart')
    return { items, subtotal, cartUrl: CART_URL }
  })
}

async function firstCartRows(page: Page): Promise<Locator | null> {
  for (const selector of CART_ITEM_SELECTORS) {
    const locator = page.locator(selector)
    const count = await locator.count().catch(() => 0)
    if (count > 0) return locator
  }
  return null
}

async function readQuantity(row: Locator): Promise<number> {
  for (const selector of CART_QTY_SELECT_SELECTORS) {
    const value = await row
      .locator(selector)
      .first()
      .inputValue({ timeout: 1_000 })
      .catch(() => null)
    const n = value === null ? null : Number(value)
    if (n !== null && Number.isFinite(n) && n > 0) return Math.round(n)
  }
  const text = await textOf(row, CART_QTY_TEXT_SELECTORS, { maxChars: 12 })
  const parsed = text === null ? null : Number(text.replace(/[^\d]/g, ''))
  if (parsed !== null && Number.isFinite(parsed) && parsed > 0) return Math.round(parsed)
  return 1
}

/* ─────────────────────────────────── checkout ────────────────────────────── */

const PROCEED_SELECTORS = [
  'input[name="proceedToRetailCheckout"]',
  '#sc-buy-box-ptc-button input',
  '#hlb-ptc-btn-native',
  'input[data-feature-id="proceed-to-checkout-action"]',
]
const PLACE_ORDER_SELECTORS = [
  '#placeYourOrder input',
  'input[name="placeYourOrder1"]',
  '#submitOrderButtonId input',
  '#bottomSubmitOrderButtonId input',
  '[data-testid="place-order-button"]',
]
const ORDER_TOTAL_SELECTORS = [
  '#subtotals-marketplace-table .grand-total-price',
  '.grand-total-price',
  '#subtotals .a-color-price',
  '[data-testid="order-total"]',
]
const ORDER_PLACED_MARKERS = [
  'order placed',
  'thank you, your order has been placed',
  'your order has been placed',
]

/**
 * Place the order that is already in the cart. Opt-in, experimental, and the
 * only function in this repo that spends money.
 *
 * Before anything is clicked it re-verifies, in this order:
 *
 *  1. the browser is enabled;
 *  2. a human actually approved *this* action (`hasApprovedAction` against the
 *     pending row — the tool layer checked too, this is defence in depth);
 *  3. the month's spend plus this order still fits under `PURCHASE_MONTHLY_CAP`;
 *  4. the cart on screen still totals what was approved.
 *
 * Step 4 is the one that catches the interesting failure: an approval card said
 * $54.21, and by the time the click happens the cart says $154.21. That is a
 * refusal, not a rounding difference.
 *
 * The parameters are optional so the call shape stays `checkout()`, but omitting
 * `pendingActionId` guarantees a refusal — there is no unapproved path.
 */
export async function checkout(opts?: {
  pendingActionId?: number
  /** The dollar total a human approved. Required for the cap and the drift check. */
  expectedTotalUsd?: number
}): Promise<{ ok: boolean; orderTotal?: string; message: string }> {
  const cfg = getConfig()

  if (!cfg.BROWSER_ENABLED) {
    return { ok: false, message: 'Browser automation is off (BROWSER_ENABLED=false). No order was placed.' }
  }

  // 1. Approval. No pending row, no order.
  const approved = await hasApprovedAction(opts?.pendingActionId, 'browser_checkout')
  if (!approved) {
    log.error({ pendingActionId: opts?.pendingActionId }, 'checkout attempted without an approved action')
    return {
      ok: false,
      message:
        'No approved checkout is on file for this request, so I placed no order. ' +
        'Ask for it and wait for the approval card.',
    }
  }

  // 2. The cap, read from audit history rather than trusted from the caller.
  const expected = typeof opts?.expectedTotalUsd === 'number' ? opts.expectedTotalUsd : null
  if (expected === null || !Number.isFinite(expected) || expected <= 0) {
    return {
      ok: false,
      message:
        'I need the approved dollar total to check it against the monthly cap and against the cart. No order was placed.',
    }
  }

  const cap = cfg.PURCHASE_MONTHLY_CAP
  let spent: number
  try {
    // Imported lazily: policy/engine imports the tool registry, which imports the
    // browser tools, which import this file. A static import would close that loop.
    const { monthlySpendUsd } = await import('../policy/engine.js')
    spent = await monthlySpendUsd()
  } catch (err) {
    log.error({ err: errorText(err) }, 'could not read the monthly spend, refusing to check out')
    return {
      ok: false,
      message: 'I could not read this month’s spending, so I refused to place the order.',
    }
  }

  const projected = Math.round((spent + expected) * 100) / 100
  if (!Number.isFinite(cap) || cap < 0) {
    return { ok: false, message: 'PURCHASE_MONTHLY_CAP is misconfigured, so I placed no order.' }
  }
  if (projected > cap) {
    return {
      ok: false,
      message:
        `Blocked by the monthly cap: ${formatUsd(spent)} already spent plus ${formatUsd(expected)} ` +
        `is ${formatUsd(projected)}, over the ${formatUsd(cap)} limit. No order was placed.`,
    }
  }

  // 3. Dry run: read the cart so the simulation is honest, then stop.
  if (cfg.DRY_RUN_BROWSER) {
    let observed: string | null = null
    try {
      observed = (await getCart()).subtotal
    } catch (err) {
      log.warn({ err: errorText(err) }, 'dry-run checkout could not read the cart')
    }
    const totalPart = observed ? ` The cart currently shows ${observed}.` : ''
    return {
      ok: true,
      ...(observed ? { orderTotal: observed } : {}),
      message:
        `SIMULATED — no order was placed and no money moved. With DRY_RUN_BROWSER=false I would ` +
        `place the Amazon order for ${formatUsd(expected)}.${totalPart}`,
    }
  }

  // 4. For real.
  try {
    return await withBrowser(async (page) => {
      await openAllowed(page, CART_URL)
      await assertNotWalled(page)
      await ensureSignedIn(page, CART_URL)

      const rows = await firstCartRows(page)
      if (!rows || (await rows.count()) === 0) {
        return {
          ok: false,
          message: `The Amazon cart is empty, so there was nothing to order. Page: ${redactUrl(page.url())}`,
        }
      }

      const cartSubtotal = await textOf(page, SUBTOTAL_SELECTORS, { maxChars: 40 })
      const cartTotalUsd = parseUsd(cartSubtotal)
      if (cartTotalUsd === null) {
        return {
          ok: false,
          message:
            `I could not read the cart subtotal on ${redactUrl(page.url())}, so I would have been ordering blind. No order was placed.`,
        }
      }
      if (totalsDisagree(expected, cartTotalUsd)) {
        return {
          ok: false,
          message:
            `The cart now totals ${formatUsd(cartTotalUsd)} but ${formatUsd(expected)} was approved. ` +
            'I placed no order. Ask again and I will get a fresh approval for the new total.',
        }
      }

      const proceed = await firstVisible(page, PROCEED_SELECTORS, 8_000)
      if (!proceed) {
        return {
          ok: false,
          message: `I could not find the Proceed to Checkout button on ${page.url()}. No order was placed.`,
        }
      }
      await proceed.click({ timeout: 10_000 })
      await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => undefined)
      await assertNotWalled(page)
      await ensureSignedIn(page, CART_URL)

      if (!/\/(gp\/buy|checkout)/.test(page.url())) {
        return {
          ok: false,
          message:
            `Proceed to Checkout did not land on a checkout page — I ended up at ${redactUrl(page.url())}. No order was placed.`,
        }
      }

      const placeOrder = await firstVisible(page, PLACE_ORDER_SELECTORS, 10_000)
      if (!placeOrder) {
        return {
          ok: false,
          message:
            `I got as far as ${redactUrl(page.url())} but could not find the Place Your Order button, ` +
            'so I stopped. Nothing was ordered — finish it in the Amazon app if you still want it.',
        }
      }

      // Last look at the number, on the page that will actually charge the card.
      const finalTotalText = await textOf(page, ORDER_TOTAL_SELECTORS, { maxChars: 40 })
      const finalTotalUsd = parseUsd(finalTotalText)
      if (finalTotalUsd !== null && totalsDisagree(expected, finalTotalUsd)) {
        return {
          ok: false,
          message:
            `The order total on the final page is ${formatUsd(finalTotalUsd)} but ${formatUsd(expected)} was approved ` +
            '(shipping or tax changed it). I placed no order.',
        }
      }

      await placeOrder.click({ timeout: 15_000 })
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined)

      const text = (await pageText(page, 4_000)).toLowerCase()
      const placed =
        page.url().includes('thankyou') ||
        page.url().includes('/gp/buy/thankyou') ||
        ORDER_PLACED_MARKERS.some((marker) => text.includes(marker))

      const total = finalTotalText ?? cartSubtotal ?? formatUsd(expected)
      if (!placed) {
        return {
          ok: false,
          orderTotal: total,
          message:
            `I clicked Place Your Order but Amazon never showed a confirmation — I ended up at ${redactUrl(page.url())}. ` +
            'Check your Amazon orders before retrying: the order may or may not have gone through.',
        }
      }

      log.warn({ total, pendingActionId: opts?.pendingActionId }, 'amazon order placed')
      return { ok: true, orderTotal: total, message: `Order placed on Amazon for ${total}.` }
    })
  } catch (err) {
    log.error({ err: errorText(err) }, 'amazon checkout failed')
    return {
      ok: false,
      message:
        `Checkout failed: ${errorText(err)} ` +
        'Check your Amazon orders before retrying, in case the click landed before the failure.',
    }
  }
}
