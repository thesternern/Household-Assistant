import { logger } from '../logger.js'

/**
 * Lists the recipes bookmarked in a NYT Cooking account's recipe box.
 *
 * This is the one piece of the NYT import that needs the household's own
 * session: the recipe pages are public and go through `fetchAndParseRecipe`
 * like any other site, but the *list* of what you saved is behind your login.
 *
 * Scope, deliberately: this module returns URLs and nothing else. It does not
 * fetch recipes, touch the database, or read the environment. The credentials
 * arrive as an argument so the only place they can live is the caller's — in
 * practice `scripts/nyt-recipe-box.ts`, run on a laptop, never on the server.
 *
 * The endpoint is undocumented and is NYT's to change. When it does, this
 * throws a plain sentence rather than returning a short list, because a short
 * list is indistinguishable from "that is all of them" and would silently drop
 * bookmarks.
 */

const log = logger.child({ mod: 'recipes/nyt-box' })

/** NYT's own recipe-box page size. Larger values are ignored by the API. */
export const PAGE_SIZE = 48

/** Termination guard: PAGE_SIZE * MAX_PAGES = 1,920 bookmarks. */
export const MAX_PAGES = 40

const ORIGIN = 'https://cooking.nytimes.com'

export interface NytAuth {
  /** The numeric NYT user id, as it appears in the recipe-box API path. */
  userId: string
  /** The whole `cookie` request header copied from a signed-in browser. */
  cookie: string
}

/**
 * A collectable is whatever the API decided to put in the box: recipes, but
 * also guides and collections. Only `url` is ever read.
 */
interface Collectable {
  url?: unknown
}

/**
 * Keep only absolute `https://cooking.nytimes.com/recipes/...` URLs.
 *
 * Relative paths are resolved against the cooking origin — the API has returned
 * both shapes. Anything else is dropped: these URLs are handed straight to the
 * scraper, so an off-origin or non-http entry here would turn "import my recipe
 * box" into a request for a page NYT never served us.
 */
function toRecipeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let parsed: URL
  try {
    parsed = new URL(raw, ORIGIN)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.hostname !== 'cooking.nytimes.com') return null
  if (!parsed.pathname.startsWith('/recipes/')) return null
  return parsed.toString()
}

function boxPageUrl(userId: string, page: number): string {
  const params = new URLSearchParams({
    q: '',
    per_page: String(PAGE_SIZE),
    page: String(page),
  })
  return `${ORIGIN}/api/v2/users/${userId}/search/recipe_box_search?${params}`
}

/**
 * `x-cooking-api` is not optional — without it the endpoint answers 403 even
 * with a valid cookie.
 */
function headers(cookie: string): Record<string, string> {
  return {
    accept: 'application/json',
    'x-cooking-api': 'cooking-frontend',
    cookie,
    referer: `${ORIGIN}/recipe-box`,
  }
}

/** One page of bookmarks, or a thrown error. Never a partial page. */
async function fetchPage(auth: NytAuth, page: number): Promise<string[]> {
  const res = await fetch(boxPageUrl(auth.userId, page), { headers: headers(auth.cookie) })

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `NYT rejected the session on page ${page} (${res.status}). The cookie has expired — sign in at ` +
        `${ORIGIN}/recipe-box and copy a fresh one, then log in again.`,
    )
  }
  if (!res.ok) {
    throw new Error(`Could not read recipe box page ${page}: NYT returned ${res.status}`)
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error(
      `Recipe box page ${page} was not JSON. NYT most likely served a sign-in page, which means the ` +
        'cookie is no longer valid.',
    )
  }

  const collectables = (body as { collectables?: unknown })?.collectables
  if (!Array.isArray(collectables)) return []
  return collectables.map((c) => toRecipeUrl((c as Collectable | null)?.url)).filter((u): u is string => u !== null)
}

/**
 * Every recipe URL in the account's box, in the order NYT returns them, with
 * duplicates removed.
 *
 * Throws — rather than returning what it has — on any page failure.
 */
export async function fetchRecipeBoxLinks(auth: NytAuth): Promise<string[]> {
  // The user id is interpolated into a URL path, so anything but digits could
  // reshape the request into a call on a different endpoint.
  if (!/^\d+$/.test(auth.userId)) {
    throw new Error(`Invalid NYT user id "${auth.userId}" — it should be digits only, e.g. 12345678`)
  }
  if (auth.cookie.trim() === '') {
    throw new Error('No NYT cookie supplied; an anonymous request would return somebody else’s empty box')
  }

  const seen = new Set<string>()
  const links: string[] = []

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageLinks = await fetchPage(auth, page)
    for (const url of pageLinks) {
      if (seen.has(url)) continue
      seen.add(url)
      links.push(url)
    }
    log.debug({ page, onPage: pageLinks.length, total: links.length }, 'recipe box page read')

    // A page NYT did not fill is the last page. An empty one ends it too.
    if (pageLinks.length < PAGE_SIZE) return links
  }

  log.warn({ cap: MAX_PAGES, total: links.length }, 'recipe box page cap reached, list may be truncated')
  return links
}
