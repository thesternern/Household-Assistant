/**
 * `recipe_import_urls` — the bulk import behind "here is my NYT recipe box".
 *
 * The single-URL tool already exists; this one exists because a recipe box is
 * a hundred-odd links and a hundred separate tool calls is a slow, expensive
 * way to run a flat loop. That difference is the whole reason for the tests
 * below — the properties that only matter in bulk:
 *
 *  - one bad link must not abandon the other twenty-four
 *  - the batch is capped, so a paste of 500 URLs cannot stall a Telegram turn
 *  - imports run a few at a time, not all at once, so we neither hammer the
 *    site nor open 25 sockets in one tick
 *  - the result names the failures, because a bare count gives the model
 *    nothing to retry or report
 *
 * The store is mocked: nothing here fetches a page or touches Postgres.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext, ToolDef } from '../src/tools/types.js'

const H = vi.hoisted(() => ({
  audits: [] as Array<Record<string, unknown>>,
  /** Import calls in flight right now, and the high-water mark across the run. */
  inFlight: 0,
  peakInFlight: 0,
}))

vi.mock('../src/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
  return { logger: { ...logger, child: () => logger }, child: () => logger }
})

vi.mock('../src/config.js', () => ({
  getConfig: () => ({ HOUSEHOLD_TIMEZONE: 'America/Los_Angeles' }),
}))

vi.mock('../src/audit/log.js', () => ({
  audit: async (entry: Record<string, unknown>) => {
    H.audits.push(entry)
  },
}))

vi.mock('../src/db/client.js', async () => {
  const schema = await vi.importActual<typeof import('../src/db/schema.js')>('../src/db/schema.js')
  return { getDb: () => ({}), getPool: () => ({}), closeDb: async () => undefined, schema }
})

vi.mock('../src/recipes/store.js', () => ({
  addPlanItem: vi.fn(),
  autofillPlan: vi.fn(),
  createPlan: vi.fn(),
  generateGroceryList: vi.fn(),
  getPlan: vi.fn(),
  getPlanByWeek: vi.fn(),
  getRecipe: vi.fn(),
  rateRecipe: vi.fn(),
  removePlanItem: vi.fn(),
  saveParsedRecipe: vi.fn(),
  searchRecipes: vi.fn(),
  upsertRecipeFromUrl: vi.fn(),
}))

import { upsertRecipeFromUrl } from '../src/recipes/store.js'
import { MAX_IMPORT_BATCH, recipeTools } from '../src/tools/recipes.js'

const ctx: ToolContext = { chatId: '1', actor: 'Alex', origin: 'agent' }

function tool(name: string): ToolDef {
  const def = recipeTools.find((t) => t.name === name)
  if (!def) throw new Error(`tool ${name} is not registered`)
  return def
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content[0]?.text ?? ''
}

function urls(n: number, start = 1): string[] {
  return Array.from({ length: n }, (_, i) => `https://cooking.nytimes.com/recipes/${start + i}-r${start + i}`)
}

/**
 * Resolve after a real macrotask so overlapping imports actually overlap; a
 * bare async return would settle before the scheduler ever ran a sibling.
 */
function slowSuccess(): void {
  vi.mocked(upsertRecipeFromUrl).mockImplementation(async (url: string) => {
    H.inFlight++
    H.peakInFlight = Math.max(H.peakInFlight, H.inFlight)
    await new Promise((resolve) => setTimeout(resolve, 5))
    H.inFlight--
    const id = Number(url.match(/recipes\/(\d+)-/)?.[1] ?? 0)
    return { id, created: true, title: `Recipe ${id}` }
  })
}

beforeEach(() => {
  H.audits.length = 0
  H.inFlight = 0
  H.peakInFlight = 0
  vi.mocked(upsertRecipeFromUrl).mockReset()
})

describe('recipe_import_urls', () => {
  it('is registered as a recipe_write tool', () => {
    expect(tool('recipe_import_urls').category).toBe('recipe_write')
  })

  it('imports every URL and separates new recipes from refreshed ones', async () => {
    vi.mocked(upsertRecipeFromUrl).mockImplementation(async (url: string) => {
      const id = Number(url.match(/recipes\/(\d+)-/)?.[1] ?? 0)
      return { id, created: id !== 2, title: `Recipe ${id}` }
    })

    const result = await tool('recipe_import_urls').handler({ urls: urls(3) }, ctx)

    expect(vi.mocked(upsertRecipeFromUrl)).toHaveBeenCalledTimes(3)
    const text = textOf(result)
    expect(text).toMatch(/2 new/)
    expect(text).toMatch(/1 (already in the library|refreshed)/)
    expect(result.structuredContent).toMatchObject({ imported: 3, created: 2, refreshed: 1, failed: 0 })
  })

  it('keeps going after a failed URL and names the one that failed', async () => {
    const bad = 'https://cooking.nytimes.com/recipes/2-r2'
    vi.mocked(upsertRecipeFromUrl).mockImplementation(async (url: string) => {
      if (url === bad) throw new Error('NO_SCHEMA: No Recipe structured data found on this page.')
      const id = Number(url.match(/recipes\/(\d+)-/)?.[1] ?? 0)
      return { id, created: true, title: `Recipe ${id}` }
    })

    const result = await tool('recipe_import_urls').handler({ urls: urls(3) }, ctx)

    expect(vi.mocked(upsertRecipeFromUrl)).toHaveBeenCalledTimes(3)
    expect(result.structuredContent).toMatchObject({ imported: 2, failed: 1 })
    expect(textOf(result)).toContain(bad)
    expect(result.structuredContent).toHaveProperty('failures')
  })

  it('still reports a result when every URL fails', async () => {
    vi.mocked(upsertRecipeFromUrl).mockRejectedValue(new Error('BLOCKED: site refused'))

    const result = await tool('recipe_import_urls').handler({ urls: urls(2) }, ctx)

    expect(result.structuredContent).toMatchObject({ imported: 0, failed: 2 })
    expect(textOf(result)).toMatch(/none|0 /i)
  })

  it('refuses a batch larger than the cap without importing anything', async () => {
    const result = await tool('recipe_import_urls').handler(
      { urls: urls(MAX_IMPORT_BATCH + 1) },
      ctx,
    )

    expect(vi.mocked(upsertRecipeFromUrl)).not.toHaveBeenCalled()
    expect(textOf(result)).toMatch(new RegExp(String(MAX_IMPORT_BATCH)))
  })

  it('imports a full batch at the cap', async () => {
    slowSuccess()

    const result = await tool('recipe_import_urls').handler({ urls: urls(MAX_IMPORT_BATCH) }, ctx)

    expect(result.structuredContent).toMatchObject({ imported: MAX_IMPORT_BATCH, failed: 0 })
  })

  it('imports a repeated URL only once', async () => {
    slowSuccess()
    const dupe = 'https://cooking.nytimes.com/recipes/1-r1'

    const result = await tool('recipe_import_urls').handler({ urls: [dupe, dupe, ...urls(1, 2)] }, ctx)

    expect(vi.mocked(upsertRecipeFromUrl)).toHaveBeenCalledTimes(2)
    expect(result.structuredContent).toMatchObject({ imported: 2 })
  })

  it('imports a few at a time rather than opening the whole batch at once', async () => {
    slowSuccess()

    await tool('recipe_import_urls').handler({ urls: urls(MAX_IMPORT_BATCH) }, ctx)

    expect(H.peakInFlight).toBeGreaterThan(1)
    expect(H.peakInFlight).toBeLessThanOrEqual(4)
  })

  it('writes one audit entry for the batch', async () => {
    slowSuccess()

    await tool('recipe_import_urls').handler({ urls: urls(3) }, ctx)

    const entries = H.audits.filter((a) => a['toolName'] === 'recipe_import_urls')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ category: 'recipe_write', actor: 'Alex', ok: true })
  })

  it('rejects an empty list', async () => {
    const result = await tool('recipe_import_urls').handler({ urls: [] }, ctx)

    expect(vi.mocked(upsertRecipeFromUrl)).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
  })

  it('rejects a non-http URL before importing anything', async () => {
    const result = await tool('recipe_import_urls').handler(
      { urls: ['https://cooking.nytimes.com/recipes/1-r1', 'file:///etc/passwd'] },
      ctx,
    )

    expect(vi.mocked(upsertRecipeFromUrl)).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
  })
})
