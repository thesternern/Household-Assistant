import { logger } from '../logger.js'
import { isPrivateHost, resolvesToPrivate } from '../net/public-host.js'
import { formatAmount, parseIngredient } from './grocery/parser.js'
import { categorizeIngredient } from './grocery/categories.js'
import type { RecipeInput, RecipeSource, Difficulty, Ingredient } from './types.js'

/**
 * Recipe importer, ported from the recipe-planner app.
 *
 * Error protocol — callers branch on the prefix, so never reword these:
 *   BLOCKED:     the site refused the request (401/403); the user should paste text instead
 *   NO_SCHEMA:   the page loaded but carries no JSON-LD Recipe node
 *   TIMEOUT:     the request exceeded FETCH_TIMEOUT_MS (headers OR body stream)
 *   HTTP_ERROR:  any other non-2xx response
 *   NETWORK:     DNS/TLS/socket failure, or a URL we refuse to fetch (see assertPublicHttpUrl)
 *
 * The scraped strings this module returns are UNTRUSTED. Nothing here calls
 * `wrapUntrusted` — a fenced title would be stored verbatim in Postgres. Whoever
 * renders a recipe title/description/step into a model prompt MUST wrap it first
 * (`src/tools/untrusted.ts`); the spec requires it for every scraped page.
 */

const FETCH_TIMEOUT_MS = 15_000

/** Whole-page byte cap. The page is streamed, so nothing beyond this is buffered. */
const MAX_HTML_BYTES = 5 * 1024 * 1024

/** Redirect hops we will follow ourselves; every hop is re-validated. */
const MAX_REDIRECTS = 5

/**
 * Caps on the values a scraped page can push into Postgres and, from there, into
 * every later model prompt. Generous for real recipes, fatal to a hostile page
 * that tries to spend our token budget or bloat a jsonb column.
 */
const MAX_TITLE_CHARS = 300
const MAX_AUTHOR_CHARS = 200
const MAX_DESCRIPTION_CHARS = 2_000
const MAX_SERVINGS_CHARS = 60
const MAX_SOURCE_CHARS = 60
const MAX_URL_CHARS = 2_048
const MAX_STEPS = 200
const MAX_STEP_CHARS = 4_000
const MAX_INGREDIENTS = 300
const MAX_INGREDIENT_CHARS = 500

/** ~69 days. Above this the value is junk, and `integer` columns overflow at 2^31. */
const MAX_DURATION_MINUTES = 100_000

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

function clampText(s: string, max: number): string {
  return s.length > max ? s.slice(0, max).trim() : s
}

function clampOptional(s: string | undefined, max: number): string | undefined {
  return s === undefined ? undefined : clampText(s, max)
}

/** Non-finite or absurd durations become 0 rather than overflowing an int4 column. */
function clampMinutes(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(Math.round(n), MAX_DURATION_MINUTES)
}

/**
 * Minutes from an ISO-8601 duration such as `PT1H30M`, `PT45M`, or `P1DT2H`.
 * Anything unparseable is 0 — schema.org durations in the wild are frequently junk.
 *
 * Faithful to the original: the `T` separator is required, so a date-only `P1D`
 * yields 0 while `P1DT2H` yields 1560.
 */
export function parseIsoDuration(iso: string): number {
  if (!iso) return 0
  const match = iso.match(/P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?/)
  if (!match) return 0
  const days = Number(match[1] ?? 0)
  const hours = Number(match[2] ?? 0)
  const minutes = Number(match[3] ?? 0)
  return clampMinutes(days * 1440 + hours * 60 + minutes)
}

/** First JSON-LD block on the page that contains a Recipe node, or null. */
export function extractJsonLd(html: string): Record<string, unknown> | null {
  const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(html)) !== null) {
    const body = match[1]
    if (!body) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      continue
    }
    const found = findRecipe(parsed)
    if (found) return found
  }
  return null
}

/** Depth-first search for a `@type: Recipe` node, following arrays and `@graph`. */
export function findRecipe(obj: unknown): Record<string, unknown> | null {
  if (!obj || typeof obj !== 'object') return null
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findRecipe(item)
      if (found) return found
    }
    return null
  }
  const o = obj as Record<string, unknown>
  const type = o['@type']
  if (type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))) {
    return o
  }
  if (Array.isArray(o['@graph'])) {
    return findRecipe(o['@graph'])
  }
  return null
}

function extractImage(image: unknown): string | undefined {
  if (!image) return undefined
  if (typeof image === 'string') return safeImageUrl(image)
  if (Array.isArray(image)) return extractImage(image[0])
  if (typeof image === 'object') {
    const obj = image as Record<string, unknown>
    return typeof obj['url'] === 'string' ? safeImageUrl(obj['url']) : undefined
  }
  return undefined
}

/**
 * Keep only http(s) image URLs of sane length. A scraped page can otherwise hand
 * us `javascript:`, `file:`, or a multi-megabyte `data:` URI, and this value is
 * persisted and later handed to Telegram as a photo URL.
 */
function safeImageUrl(raw: string): string | undefined {
  const candidate = raw.trim()
  if (!candidate || candidate.length > MAX_URL_CHARS) return undefined
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return candidate
  } catch {
    return undefined
  }
}

function extractAuthor(author: unknown): string | undefined {
  if (!author) return undefined
  if (typeof author === 'string') return author
  if (Array.isArray(author)) return extractAuthor(author[0])
  if (typeof author === 'object') {
    const obj = author as Record<string, unknown>
    return typeof obj['name'] === 'string' ? obj['name'] : undefined
  }
  return undefined
}

function extractSteps(instructions: unknown): string[] {
  if (!instructions) return []
  const arr = Array.isArray(instructions) ? instructions : [instructions]
  return arr
    .flatMap((step) => {
      if (typeof step === 'string') return [step]
      if (typeof step === 'object' && step !== null) {
        const s = step as Record<string, unknown>
        if (typeof s['text'] === 'string') return [s['text']]
        // HowToSection with itemListElement
        if (Array.isArray(s['itemListElement'])) return extractSteps(s['itemListElement'])
      }
      return []
    })
    .filter((s) => s.trim().length > 0)
}

function extractTags(schema: Record<string, unknown>): string[] {
  const raw: string[] = []
  for (const field of ['keywords', 'recipeCategory', 'recipeCuisine']) {
    const val = schema[field]
    if (typeof val === 'string') raw.push(...val.split(',').map((s) => s.trim()))
    else if (Array.isArray(val)) raw.push(...val.map(String))
  }
  // Map to known tag vocabulary
  const knownTags = [
    'sheet-pan',
    'one-pot',
    'quick',
    'kid-friendly',
    'make-ahead',
    'pasta',
    'soup-stew',
    'stir-fry',
    'slow-cooker',
    'grill',
    'salad',
  ]
  const normalized = raw.map((t) => t.toLowerCase().replace(/\s+/g, '-'))
  return knownTags.filter((tag) => normalized.some((n) => n.includes(tag.replace('-', '')) || n.includes(tag)))
}

function detectTagsFromContent(title: string, ingredients: Ingredient[]): string[] {
  const text = (title + ' ' + ingredients.map((i) => i.item).join(' ')).toLowerCase()
  const tags: string[] = []
  if (/sheet.pan|sheet pan/.test(text)) tags.push('sheet-pan')
  if (/one.pot|one pot|one.pan/.test(text)) tags.push('one-pot')
  if (/stir.fry|stir fry/.test(text)) tags.push('stir-fry')
  if (/\bpasta\b|\bnoodle\b/.test(text)) tags.push('pasta')
  if (/\bsoup\b|\bstew\b|\bbraise\b/.test(text)) tags.push('soup-stew')
  if (/slow.cooker|crockpot/.test(text)) tags.push('slow-cooker')
  return tags
}

export function autoScore(
  input: Partial<RecipeInput> & { title: string; ingredients: Ingredient[]; steps: string[] },
): {
  familyScore: number
  familyNotes: string
  difficulty: Difficulty
  tags: string[]
} {
  let score = 5
  const notes: string[] = []
  const title = input.title.toLowerCase()
  const ingredientText = input.ingredients.map((i) => i.item).join(' ').toLowerCase()
  const allText = title + ' ' + ingredientText

  // Time scoring
  const time = input.totalTimeMinutes ?? 0
  if (time > 0) {
    if (time <= 30) {
      score += 3
      notes.push('Quick cook time (≤30 min)')
    } else if (time <= 45) {
      score += 2
      notes.push('Good cook time (≤45 min)')
    } else if (time <= 60) {
      score += 1
      notes.push('Moderate cook time')
    } else if (time > 90) {
      score -= 2
      notes.push('Long cook time may be tough on weeknights')
    }
  }

  // Spice/acquired taste penalties
  if (/jalapeño|habanero|ghost pepper|serrano/.test(allText)) {
    score -= 2
    notes.push('Hot peppers — too spicy for young kids')
  } else if (/chili flakes|red pepper flakes|cayenne|sriracha|gochujang/.test(allText)) {
    score -= 1
    notes.push('Reduce spicy elements for kids')
  }
  if (/anchovy|blue cheese|\bliver\b/.test(allText)) {
    score -= 1
    notes.push('Acquired taste ingredients')
  }

  // Kid-friendly bonuses
  if (/sheet.pan|one.pot|one.pan/.test(allText)) {
    score += 1
    notes.push('Easy cleanup')
  }
  if (/\bpasta\b|\bchicken\b|\brice\b|\bnoodle\b/.test(allText)) {
    score += 1
    notes.push('Kid-friendly base')
  }
  if (/quick|weeknight|easy|simple/.test(allText)) score += 0.5

  const familyScore = Math.round(Math.max(1, Math.min(10, score)))

  // Difficulty
  const stepCount = input.steps.length
  let difficulty: Difficulty = 'medium'
  if (stepCount <= 5 || time <= 25) difficulty = 'easy'
  else if (stepCount >= 12 || time >= 75) difficulty = 'hard'

  // Tags from schema + content detection
  const contentTags = detectTagsFromContent(input.title, input.ingredients)
  if (time > 0 && time <= 30) contentTags.push('quick')
  const tags = [...new Set([...(input.tags ?? []), ...contentTags])]

  return {
    familyScore,
    familyNotes: notes.length > 0 ? notes.join('. ') : 'Standard weeknight meal',
    difficulty,
    tags,
  }
}

/**
 * Per-source label: the two hand-tuned sites, otherwise the bare domain name.
 *
 * Matching is on the parsed hostname, not on the raw URL string. The original
 * used `url.includes('cooking.nytimes.com')`, which let any page spoof its
 * provenance with a query string (`https://evil.test/?r=cooking.nytimes.com`)
 * — and the stored `source` is exactly what the model reads to decide how much
 * to trust a recipe.
 */
export function detectSource(url: string): RecipeSource {
  if (!url || url.startsWith('manual:')) return 'manual'
  let hostname: string
  try {
    hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return 'manual'
  }
  if (hostname === 'cooking.nytimes.com') return 'nyt_cooking'
  if (hostname === 'foodandwine.com' || hostname.endsWith('.foodandwine.com')) return 'food_and_wine'
  // Return just the base domain name (e.g. "allrecipes.com" → "allrecipes")
  return clampText(hostname.split('.')[0] || 'manual', MAX_SOURCE_CHARS)
}

export function mapSchemaToRecipeInput(schema: Record<string, unknown>, sourceUrl: string): RecipeInput {
  const rawTitle = typeof schema['name'] === 'string' ? schema['name'].trim() : ''
  if (!rawTitle) throw new Error('Recipe schema found but missing required field: name/title')
  const title = clampText(rawTitle, MAX_TITLE_CHARS)

  const rawIngredients = Array.isArray(schema['recipeIngredient'])
    ? (schema['recipeIngredient'] as string[]).slice(0, MAX_INGREDIENTS)
    : []

  const ingredients: Ingredient[] = rawIngredients.map((entry) => {
    const raw = clampText(String(entry), MAX_INGREDIENT_CHARS)
    const parsed = parseIngredient(raw)
    const quantity = parsed.amount > 0 ? `${formatAmount(parsed.amount)}${parsed.unit ? ' ' + parsed.unit : ''}`.trim() : parsed.unit || ''
    return {
      item: parsed.item || raw.toLowerCase(),
      quantity,
      section: categorizeIngredient(parsed.item || raw, parsed.unit),
    }
  })

  const steps = extractSteps(schema['recipeInstructions'])
    .slice(0, MAX_STEPS)
    .map((step) => clampText(step, MAX_STEP_CHARS))

  const totalTime = parseIsoDuration(String(schema['totalTime'] ?? ''))
  const prepTime = parseIsoDuration(String(schema['prepTime'] ?? ''))
  const cookTime = parseIsoDuration(String(schema['cookTime'] ?? schema['cookingTime'] ?? ''))
  const totalTimeMinutes = totalTime || prepTime + cookTime || undefined
  const activeTimeMinutes = prepTime || cookTime || undefined

  const recipeYield = schema['recipeYield']
  const rawServings = Array.isArray(recipeYield)
    ? String(recipeYield[0])
    : typeof recipeYield === 'string'
      ? recipeYield
      : undefined
  const servings = rawServings === undefined ? undefined : clampText(rawServings, MAX_SERVINGS_CHARS)

  const schemaTags = extractTags(schema)

  const partial: Partial<RecipeInput> & { title: string; ingredients: Ingredient[]; steps: string[] } = {
    title,
    source: detectSource(sourceUrl),
    sourceUrl,
    author: clampOptional(extractAuthor(schema['author']), MAX_AUTHOR_CHARS),
    description:
      typeof schema['description'] === 'string'
        ? clampText(schema['description'].replace(/<[^>]+>/g, '').trim(), MAX_DESCRIPTION_CHARS)
        : undefined,
    totalTimeMinutes,
    activeTimeMinutes,
    servings,
    ingredients,
    steps,
    imageUrl: extractImage(schema['image']),
    tags: schemaTags,
  }

  const scored = autoScore(partial)

  return {
    ...partial,
    source: detectSource(sourceUrl),
    familyScore: scored.familyScore,
    familyNotes: scored.familyNotes,
    difficulty: scored.difficulty,
    tags: scored.tags,
  } as RecipeInput
}

/**
 * Parse already-fetched HTML. Split out from the fetch so tests (and any caller
 * that already holds the markup) never touch the network.
 * Throws `NO_SCHEMA: ...` when the page carries no Recipe node.
 */
export function parseRecipeHtml(html: string, sourceUrl: string): RecipeInput {
  const schema = extractJsonLd(html)
  if (!schema) {
    throw new Error('NO_SCHEMA: No Recipe structured data found on this page. The site may not support recipe imports.')
  }
  return mapSchemaToRecipeInput(schema, sourceUrl)
}

/**
 * Refuse anything that is not a public http(s) address.
 *
 * This entry point is reachable from an LLM tool call, and the URL can come from
 * content we do not control (an email body, a scraped page). Without this guard
 * "import this recipe" is a server-side request forgery primitive: cloud metadata
 * at 169.254.169.254, the Postgres box, anything on the LAN. The status codes we
 * report back (BLOCKED / HTTP_ERROR / NETWORK) also make it an internal port scanner.
 *
 * This checks the literal host; `assertPublicDestination` then asks the resolver
 * where a public-looking name points, which closes an attacker's own A record.
 * A true rebinding race (a record that flips between that lookup and the
 * socket's own) needs a connect-time check inside the HTTP client, which Node's
 * `fetch` does not expose; it is not done here.
 */
function assertPublicHttpUrl(raw: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`NETWORK: Not a valid URL: ${clampText(raw, 200)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`NETWORK: Refusing to fetch a non-http(s) URL (${parsed.protocol})`)
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error(`NETWORK: Refusing to fetch a non-public address (${clampText(parsed.hostname, 100)})`)
  }
  return parsed
}

/** The literal-host check, then the resolver: a public name pointed at a private address is refused too. */
async function assertPublicDestination(raw: string): Promise<URL> {
  const parsed = assertPublicHttpUrl(raw)
  const privateAddress = await resolvesToPrivate(parsed.hostname)
  if (privateAddress !== null) {
    logger.warn(
      { host: clampText(parsed.hostname, 100), address: privateAddress },
      'recipe URL resolves to a private address, refusing',
    )
    throw new Error(`NETWORK: Refusing to fetch ${clampText(parsed.hostname, 100)}: it resolves to a non-public address`)
  }
  return parsed
}

/**
 * Follow redirects ourselves so every hop is re-validated. `redirect: 'follow'`
 * would let a public URL bounce us straight to 127.0.0.1. One shared abort signal
 * keeps the whole chain inside a single FETCH_TIMEOUT_MS budget rather than
 * granting each hop its own.
 *
 * Returns the URL the chain ended at alongside the response. The caller stores
 * that as `sourceUrl`, which is the de-duplication key in `recipes` — see
 * `fetchAndParseRecipe`.
 */
async function fetchWithCheckedRedirects(
  url: string,
  signal: AbortSignal,
): Promise<{ res: Response; finalUrl: string }> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicDestination(current)
    const res = await fetch(current, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal,
      redirect: 'manual',
    })

    const location = res.headers.get('location')
    if (![301, 302, 303, 307, 308].includes(res.status) || !location) return { res, finalUrl: current }

    // Free the socket before the next hop; a 3xx body is never used.
    await res.body?.cancel().catch(() => undefined)
    try {
      current = new URL(location, current).toString()
    } catch {
      throw new Error('NETWORK: Server sent an unusable redirect target')
    }
  }
  throw new Error(`NETWORK: Too many redirects (over ${MAX_REDIRECTS})`)
}

/**
 * Read the body as text, stopping at MAX_HTML_BYTES. Streaming means a hostile or
 * merely enormous page never lands in memory whole; truncating rather than throwing
 * keeps the error protocol intact, and since JSON-LD lives in `<head>` a truncated
 * page normally still parses (worst case it degrades to `NO_SCHEMA:`).
 */
async function readCappedText(res: Response, url: string): Promise<string> {
  const body = res.body
  if (!body) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let out = ''
  let seen = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      seen += value.byteLength
      if (seen > MAX_HTML_BYTES) {
        const keep = Math.max(0, value.byteLength - (seen - MAX_HTML_BYTES))
        out += decoder.decode(value.subarray(0, keep))
        await reader.cancel().catch(() => undefined)
        logger.warn({ url, cap: MAX_HTML_BYTES }, 'recipe page truncated at byte cap')
        return out
      }
      out += decoder.decode(value, { stream: true })
    }
    out += decoder.decode()
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* already released by cancel() */
    }
  }
  return out
}

export async function fetchAndParseRecipe(url: string): Promise<RecipeInput> {
  // Guard before the first request so a bad scheme/host never opens a socket.
  assertPublicHttpUrl(url)

  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)

  let res: Response
  // The URL the redirect chain ended at, not the one we were handed. This
  // becomes `sourceUrl`, the de-duplication key in `recipes`: NYT Cooking (and
  // others) 308 to a canonical slug and rewrite those slugs over time, so
  // keeping the pre-redirect URL would file the same recipe twice and split its
  // family rating across the two rows.
  let finalUrl: string
  try {
    ;({ res, finalUrl } = await fetchWithCheckedRedirects(url, signal))
  } catch (err) {
    throw toProtocolError(err)
  }

  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => undefined)
    throw new Error('BLOCKED: This site blocks direct imports. Try the Paste Text tab instead.')
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    throw new Error(`HTTP_ERROR: Server returned ${res.status}`)
  }

  // The body read is inside the try as well: the abort signal is still armed here,
  // so a page that stalls mid-stream throws a bare TimeoutError that would
  // otherwise escape the documented prefixes.
  let html: string
  try {
    html = await readCappedText(res, finalUrl)
  } catch (err) {
    throw toProtocolError(err)
  }

  const recipe = parseRecipeHtml(html, finalUrl)
  logger.debug(
    { url, finalUrl, source: recipe.source, ingredients: recipe.ingredients.length },
    'recipe scraped',
  )
  return recipe
}

/** Map a transport-layer failure onto the documented prefixes, never swallowing one we already tagged. */
function toProtocolError(err: unknown): Error {
  if (err instanceof Error && /^(BLOCKED|NO_SCHEMA|TIMEOUT|HTTP_ERROR|NETWORK):/.test(err.message)) return err
  const name = (err as { name?: string }).name
  if (name === 'TimeoutError') return new Error('TIMEOUT: Request timed out after 15 seconds')
  if (name === 'AbortError') return new Error('TIMEOUT: Request timed out after 15 seconds')
  return new Error(`NETWORK: ${String(err)}`)
}
