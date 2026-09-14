/**
 * Site logins for the browser worker.
 *
 * One rule governs this whole file, and it outranks every other consideration
 * in it: **the decrypted secret never leaves.** It is not returned, not logged,
 * not put in an error message, not written to an audit row, and not included in
 * any tool result. It exists as a local `string` inside {@link loginToSite} for
 * as long as it takes to type it into a form, and nothing else in the process
 * ever sees it.
 *
 * That is why:
 *  - `loginToSite` returns a bare `boolean`. There is no result object a secret
 *    could ride out in.
 *  - every `catch` runs {@link scrub}, which replaces the secret with a marker
 *    before the message reaches a log. Playwright does not normally echo a
 *    `fill()` value, but "normally" is not a security property.
 *  - nothing here calls `audit()`. The audit layer redacts by key name, and the
 *    right way to never leak a secret is to never hand it over.
 *
 * Storage is `site_credentials`, one row per site, secret encrypted with
 * `src/integrations/crypto.ts` (AES-256-GCM under `APP_SECRET`).
 */
import { eq } from 'drizzle-orm'
import type { Locator, Page } from 'playwright'
import { getDb, schema } from '../db/client.js'
import { decrypt, encrypt } from '../integrations/crypto.js'
import { logger } from '../logger.js'
import { checkUrl, redactUrl } from './allowlist.js'
import { BrowserError, errorText, firstVisible, openAllowed, pageText } from './worker.js'

const log = logger.child({ mod: 'browser/credentials' })

/** What replaces the secret anywhere text could escape this module. */
const REDACTED = '[redacted]'

/** How long to wait for a login form field to appear. */
const FIELD_TIMEOUT_MS = 8_000
/** How long to wait for the page to settle after submitting. */
const SETTLE_TIMEOUT_MS = 15_000

/** A site key is a bare lowercase hostname: `amazon.com`. */
export function normalizeSite(site: string): string {
  let s = String(site ?? '')
    .trim()
    .toLowerCase()
  // Tolerate someone pasting a URL.
  if (s.includes('://')) {
    try {
      s = new URL(s).hostname.toLowerCase()
    } catch {
      /* fall through to the string cleanup below */
    }
  }
  s = s.replace(/^www\./, '')
  while (s.endsWith('.')) s = s.slice(0, -1)
  return s
}

/**
 * Remove the secret from any text on its way to a log or an error.
 *
 * Also strips the URL-encoded form, because a failed POST can surface a request
 * body in a Playwright error string.
 */
function scrub(text: string, secret: string): string {
  if (secret === '') return text
  let out = text
  const forms = [secret, encodeURIComponent(secret)]
  for (const form of forms) {
    if (form === '') continue
    out = out.split(form).join(REDACTED)
  }
  return out
}

/* ─────────────────────────────── storage ─────────────────────────────────── */

/**
 * Store (or replace) the credential for one site. The secret is encrypted
 * before it reaches Postgres and is never logged.
 */
export async function saveSiteCredential(
  site: string,
  username: string,
  secret: string,
): Promise<void> {
  const key = normalizeSite(site)
  const user = String(username ?? '').trim()
  if (key === '') throw new Error('saveSiteCredential needs a site, e.g. "amazon.com".')
  if (user === '') throw new Error('saveSiteCredential needs a username.')
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('saveSiteCredential needs a non-empty secret.')
  }

  const secretEncrypted = encrypt(secret)
  const now = new Date()

  await getDb()
    .insert(schema.siteCredentials)
    .values({ site: key, username: user, secretEncrypted, createdAt: now })
    .onConflictDoUpdate({
      target: schema.siteCredentials.site,
      set: { username: user, secretEncrypted },
    })

  // Site and username only. The secret is not a thing this line knows about.
  log.info({ site: key }, 'site credential stored')
}

/* ─────────────────────────────── login flow ──────────────────────────────── */

interface LoginProfile {
  /** Where to go when the page is not already on a sign-in form. */
  loginUrl: string
  usernameSelectors: string[]
  /** Two-step forms: a "continue" button between the username and the password. */
  continueSelectors: string[]
  passwordSelectors: string[]
  submitSelectors: string[]
  /** A second factor we cannot satisfy from a stored secret. */
  mfaSelectors: string[]
  /** URL fragments that mean "still inside the sign-in flow". */
  signinUrlMarkers: string[]
}

const GENERIC: Omit<LoginProfile, 'loginUrl'> = {
  usernameSelectors: [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[autocomplete="username"]',
    'input[id*="email" i]',
  ],
  continueSelectors: ['#continue', 'input#continue', 'button[type="submit"]'],
  passwordSelectors: ['input[type="password"]', 'input[name="password"]'],
  submitSelectors: ['#signInSubmit', 'button[type="submit"]', 'input[type="submit"]'],
  mfaSelectors: [
    '#auth-mfa-otpcode',
    'input[name="otpCode"]',
    'input[autocomplete="one-time-code"]',
    'input[name*="otp" i]',
  ],
  signinUrlMarkers: ['/signin', '/sign-in', '/login', '/ap/challenge', '/ap/mfa', '/ap/cvf'],
}

/** Amazon's flow is email, continue, password, sign in — with a captcha risk at each step. */
const PROFILES: Record<string, LoginProfile> = {
  'amazon.com': {
    loginUrl: 'https://www.amazon.com/gp/sign-in.html',
    usernameSelectors: ['#ap_email_login', '#ap_email', 'input[name="email"]', 'input[type="email"]'],
    continueSelectors: ['#continue', 'input#continue', '.a-button-input[type="submit"]'],
    passwordSelectors: ['#ap_password', 'input[type="password"]'],
    submitSelectors: ['#signInSubmit', 'input#signInSubmit', 'input[type="submit"]'],
    mfaSelectors: GENERIC.mfaSelectors,
    signinUrlMarkers: ['/ap/signin', '/ap/challenge', '/ap/mfa', '/ap/cvf', '/gp/sign-in'],
  },
}

function profileFor(site: string): LoginProfile {
  const known = PROFILES[site]
  if (known) return known
  return { loginUrl: `https://${site}/`, ...GENERIC }
}

/** Text that means Amazon (or anyone) has decided we are a robot. */
const BOT_WALL_MARKERS = [
  'enter the characters you see below',
  'type the characters you see in this image',
  'not a robot',
  'automated access to amazon data',
  'sorry, we just need to make sure',
]

async function looksLikeBotWall(page: Page): Promise<boolean> {
  if (page.url().includes('/errors/validateCaptcha')) return true
  const text = (await pageText(page, 4_000)).toLowerCase()
  return BOT_WALL_MARKERS.some((marker) => text.includes(marker))
}

function onSigninPage(url: string, profile: LoginProfile): boolean {
  const lower = url.toLowerCase()
  return profile.signinUrlMarkers.some((marker) => lower.includes(marker))
}

/** Type into a field without Playwright's auto-clearing surprises. Never logs the value. */
async function typeSecret(field: Locator, value: string): Promise<void> {
  await field.click({ timeout: FIELD_TIMEOUT_MS })
  await field.fill('', { timeout: FIELD_TIMEOUT_MS })
  await field.fill(value, { timeout: FIELD_TIMEOUT_MS })
}

/**
 * Sign `page` into `site` using the stored credential.
 *
 * Returns true only when the sign-in visibly succeeded. Returns false — never
 * throws for an ordinary failure — when there is no credential, the form was
 * not where we expected it, a bot wall appeared, or a second factor is required
 * that a stored password cannot answer. Every one of those cases logs the site
 * and the reason, and none of them logs the secret.
 */
export async function loginToSite(page: Page, site: string): Promise<boolean> {
  const key = normalizeSite(site)
  if (key === '') {
    log.warn('loginToSite called without a site')
    return false
  }

  const rows = await getDb()
    .select({
      username: schema.siteCredentials.username,
      secretEncrypted: schema.siteCredentials.secretEncrypted,
    })
    .from(schema.siteCredentials)
    .where(eq(schema.siteCredentials.site, key))
    .limit(1)

  const row = rows[0]
  if (!row) {
    log.warn({ site: key }, 'no stored credential for this site, cannot sign in')
    return false
  }

  let secret: string
  try {
    secret = decrypt(row.secretEncrypted)
  } catch (err) {
    // errorText here cannot contain the plaintext: decryption never produced it.
    log.error({ site: key, err: errorText(err) }, 'stored credential will not decrypt')
    return false
  }
  if (secret === '') {
    log.error({ site: key }, 'stored credential decrypted to an empty secret')
    return false
  }

  const profile = profileFor(key)

  /**
   * The page URL, made safe for a log line. `redactUrl` drops the query and
   * hash — which is where a GET-submitting login form leaves the password —
   * and `scrub` removes the secret from whatever survives, in case a site
   * puts it somewhere stranger.
   */
  const atUrl = (): string => scrub(redactUrl(page.url()), secret)

  try {
    // Only navigate when we are not already looking at the form. A caller that
    // hit a sign-in wall mid-flow wants to finish on the page it is on, so the
    // return_to lands it back where it was.
    if (!onSigninPage(page.url(), profile)) {
      const check = checkUrl(profile.loginUrl)
      if (!check.ok) {
        log.error({ site: key, reason: check.reason }, 'login URL is not on the browser allowlist')
        return false
      }
      await openAllowed(page, profile.loginUrl)
    }

    if (await looksLikeBotWall(page)) {
      log.error({ site: key, url: atUrl() }, 'sign-in blocked by a bot check')
      return false
    }

    const emailField = await firstVisible(page, profile.usernameSelectors, FIELD_TIMEOUT_MS)
    if (emailField) {
      await typeSecret(emailField, row.username)
      // Two-step forms need the continue click; one-step forms already show the
      // password box, so only click when the password field is not there yet.
      const passwordAlreadyThere = await firstVisible(page, profile.passwordSelectors, 750)
      if (!passwordAlreadyThere) {
        const next = await firstVisible(page, profile.continueSelectors, 3_000)
        if (next) {
          await next.click({ timeout: FIELD_TIMEOUT_MS })
          await page.waitForLoadState('domcontentloaded', { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined)
        }
      }
    }

    if (await looksLikeBotWall(page)) {
      log.error({ site: key, url: atUrl() }, 'sign-in blocked by a bot check after the username step')
      return false
    }

    const passwordField = await firstVisible(page, profile.passwordSelectors, FIELD_TIMEOUT_MS)
    if (!passwordField) {
      log.error(
        { site: key, url: atUrl() },
        'no password field on the sign-in page, the form has changed or we were already redirected',
      )
      return false
    }

    await typeSecret(passwordField, secret)

    const submit = await firstVisible(page, profile.submitSelectors, 5_000)
    if (submit) {
      await submit.click({ timeout: FIELD_TIMEOUT_MS })
    } else {
      await passwordField.press('Enter', { timeout: FIELD_TIMEOUT_MS })
    }
    await page.waitForLoadState('domcontentloaded', { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined)

    // A second factor is where an automated sign-in stops being possible. Say so
    // plainly rather than retrying and tripping a lockout.
    const mfa = await firstVisible(page, profile.mfaSelectors, 2_000)
    if (mfa) {
      log.error(
        { site: key, url: atUrl() },
        'sign-in needs a one-time code, so it cannot be completed automatically. ' +
          'Sign in once by hand in the browser profile.',
      )
      return false
    }

    if (await looksLikeBotWall(page)) {
      log.error({ site: key, url: atUrl() }, 'sign-in blocked by a bot check after submitting')
      return false
    }

    const stillOnForm = await firstVisible(page, profile.passwordSelectors, 1_500)
    const stillInFlow = onSigninPage(page.url(), profile)
    if (stillOnForm || stillInFlow) {
      log.error(
        { site: key, url: atUrl() },
        'still on the sign-in flow after submitting, treating the sign-in as failed',
      )
      return false
    }

    log.info({ site: key }, 'signed in')
    return true
  } catch (err) {
    if (err instanceof BrowserError) {
      log.error({ site: key, code: err.code, err: scrub(err.message, secret) }, 'sign-in failed')
      return false
    }
    log.error({ site: key, err: scrub(errorText(err), secret) }, 'sign-in failed')
    return false
  }
}
