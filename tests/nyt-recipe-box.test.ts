/**
 * The NYT Cooking recipe-box pager (`src/recipes/nyt-box.ts`).
 *
 * This is the only part of the NYT import that needs the household's own
 * session cookie: the recipe pages themselves are public and go through the
 * ordinary scraper. So the properties worth pinning here are the ones that
 * decide whether the *list* is trustworthy:
 *
 *  - a failed page aborts, because a silently short list looks exactly like
 *    "you have finished importing" and would quietly drop bookmarks
 *  - the user id is interpolated into a URL path, so it must be digits only
 *  - the pager must terminate even if the server keeps returning full pages
 *  - only cooking.nytimes.com recipe URLs come back, whatever the API returns
 *
 * Every test stubs `fetch`; nothing here touches the network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PAGE_SIZE, MAX_PAGES, fetchRecipeBoxLinks } from '../src/recipes/nyt-box.js'

const AUTH = { userId: '12345678', cookie: 'nyt-a=abc; NYT-S=def' }

/** `n` distinct collectables, numbered from `start`. */
function collectables(n: number, start = 0): Array<{ url: string }> {
  return Array.from({ length: n }, (_, i) => ({
    url: `https://cooking.nytimes.com/recipes/${start + i}-recipe-${start + i}`,
  }))
}

function jsonPage(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Stub `fetch` with one canned response per call, in order. */
function stubPages(pages: Response[]): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => {
    const next = pages.shift()
    if (!next) throw new Error('fetch called more times than the test expected')
    return next
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchRecipeBoxLinks', () => {
  it('keeps paging until a short page and returns every bookmark', async () => {
    stubPages([
      jsonPage({ collectables: collectables(PAGE_SIZE, 0) }),
      jsonPage({ collectables: collectables(PAGE_SIZE, PAGE_SIZE) }),
      jsonPage({ collectables: collectables(5, PAGE_SIZE * 2) }),
    ])

    const links = await fetchRecipeBoxLinks(AUTH)

    expect(links).toHaveLength(PAGE_SIZE * 2 + 5)
    expect(links[0]).toBe('https://cooking.nytimes.com/recipes/0-recipe-0')
    expect(links.at(-1)).toBe(
      `https://cooking.nytimes.com/recipes/${PAGE_SIZE * 2 + 4}-recipe-${PAGE_SIZE * 2 + 4}`,
    )
  })

  it('stops on an empty page without asking for another', async () => {
    const spy = stubPages([
      jsonPage({ collectables: collectables(PAGE_SIZE, 0) }),
      jsonPage({ collectables: [] }),
    ])

    const links = await fetchRecipeBoxLinks(AUTH)

    expect(links).toHaveLength(PAGE_SIZE)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('drops a bookmark that appears on two pages', async () => {
    stubPages([
      jsonPage({ collectables: collectables(PAGE_SIZE, 0) }),
      // The last entry of page 1 repeated as the first of page 2.
      jsonPage({ collectables: [...collectables(1, PAGE_SIZE - 1), ...collectables(2, PAGE_SIZE)] }),
    ])

    const links = await fetchRecipeBoxLinks(AUTH)

    expect(links).toHaveLength(PAGE_SIZE + 2)
    expect(new Set(links).size).toBe(links.length)
  })

  it('throws rather than returning a partial list when a page fails', async () => {
    stubPages([
      jsonPage({ collectables: collectables(PAGE_SIZE, 0) }),
      new Response('nope', { status: 403 }),
    ])

    await expect(fetchRecipeBoxLinks(AUTH)).rejects.toThrow(/page 2.*403/i)
  })

  it('says the session has expired when NYT answers 401', async () => {
    stubPages([new Response('', { status: 401 })])

    await expect(fetchRecipeBoxLinks(AUTH)).rejects.toThrow(/expired|log in again/i)
  })

  it('throws when a page is not JSON', async () => {
    stubPages([new Response('<html>signin</html>', { status: 200 })])

    await expect(fetchRecipeBoxLinks(AUTH)).rejects.toThrow(/json/i)
  })

  it('refuses a user id that is not digits', async () => {
    const spy = stubPages([])

    await expect(fetchRecipeBoxLinks({ ...AUTH, userId: '123/../../admin' })).rejects.toThrow(
      /user id/i,
    )
    expect(spy).not.toHaveBeenCalled()
  })

  it('refuses an empty cookie instead of fetching an anonymous box', async () => {
    const spy = stubPages([])

    await expect(fetchRecipeBoxLinks({ ...AUTH, cookie: '   ' })).rejects.toThrow(/cookie/i)
    expect(spy).not.toHaveBeenCalled()
  })

  it('stops at the page cap when the server never returns a short page', async () => {
    const spy = vi.fn(async () => jsonPage({ collectables: collectables(PAGE_SIZE, 0) }))
    vi.stubGlobal('fetch', spy)

    const links = await fetchRecipeBoxLinks(AUTH)

    expect(spy).toHaveBeenCalledTimes(MAX_PAGES)
    // Every page was identical, so dedupe leaves exactly one page's worth.
    expect(links).toHaveLength(PAGE_SIZE)
  })

  it('resolves a relative bookmark path against cooking.nytimes.com', async () => {
    stubPages([jsonPage({ collectables: [{ url: '/recipes/1234-braised-short-ribs' }] })])

    const links = await fetchRecipeBoxLinks(AUTH)

    expect(links).toEqual(['https://cooking.nytimes.com/recipes/1234-braised-short-ribs'])
  })

  it('skips collectables that are not recipe URLs', async () => {
    stubPages([
      jsonPage({
        collectables: [
          { url: 'https://cooking.nytimes.com/recipes/1-keep-me' },
          { url: 'https://cooking.nytimes.com/guides/12-how-to-roast' },
          { url: 'https://evil.test/recipes/1-not-nyt' },
          { url: 'javascript:alert(1)' },
          { url: '' },
          { title: 'no url at all' },
          null,
        ],
      }),
    ])

    const links = await fetchRecipeBoxLinks(AUTH)

    expect(links).toEqual(['https://cooking.nytimes.com/recipes/1-keep-me'])
  })

  it('returns an empty list for an empty recipe box', async () => {
    stubPages([jsonPage({ collectables: [] })])

    await expect(fetchRecipeBoxLinks(AUTH)).resolves.toEqual([])
  })

  it('sends the cookie and the x-cooking-api header NYT requires', async () => {
    const spy = stubPages([jsonPage({ collectables: [] })])

    await fetchRecipeBoxLinks(AUTH)

    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toContain(`/api/v2/users/${AUTH.userId}/search/recipe_box_search`)
    expect(url).toContain(`per_page=${PAGE_SIZE}`)
    expect(url).toContain('page=1')
    const headers = init.headers as Record<string, string>
    expect(headers['cookie']).toBe(AUTH.cookie)
    expect(headers['x-cooking-api']).toBe('cooking-frontend')
  })
})
