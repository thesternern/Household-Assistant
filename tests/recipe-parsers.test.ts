import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  detectSource,
  extractJsonLd,
  fetchAndParseRecipe,
  findRecipe,
  parseIsoDuration,
  parseRecipeHtml,
} from '../src/recipes/scraper.js'
import { parseRecipeText, rawStringsToRecipeInput } from '../src/recipes/text-parser.js'

const SOURCE_URL = 'https://www.example-cooking.com/recipes/sheet-pan-lemon-chicken'

/**
 * A deliberately awkward page: a non-Recipe block first, then a malformed block,
 * then the real Recipe buried in an @graph with a multi-valued @type.
 */
const RECIPE_HTML = `<!doctype html>
<html>
<head>
  <title>Sheet-Pan Lemon Chicken Thighs</title>
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"WebSite","name":"Example Cooking"}
  </script>
  <script type="application/ld+json">{ "@type": "Recipe", "name": }</script>
  <script type='application/ld+json'>
  {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebPage", "name": "Not the recipe" },
      {
        "@type": ["Recipe", "NewsArticle"],
        "name": "  Sheet-Pan Lemon Chicken Thighs  ",
        "author": { "@type": "Person", "name": "Jane Cook" },
        "description": "<p>A bright weeknight dinner.</p>",
        "image": ["https://img.example.com/lemon-chicken.jpg"],
        "totalTime": "PT45M",
        "prepTime": "PT15M",
        "cookTime": "PT30M",
        "recipeYield": ["4 servings", "4"],
        "keywords": "sheet pan, weeknight, kid friendly",
        "recipeIngredient": [
          "1 pound chicken thighs",
          "2 tablespoons olive oil",
          "4 cloves garlic, minced",
          "1 lemon",
          "Salt and pepper to taste"
        ],
        "recipeInstructions": [
          { "@type": "HowToStep", "text": "Heat the oven to 425 degrees." },
          "Toss the chicken with the oil and garlic.",
          {
            "@type": "HowToSection",
            "itemListElement": [
              { "@type": "HowToStep", "text": "Roast for 30 minutes." },
              { "@type": "HowToStep", "text": "Squeeze the lemon over the top." }
            ]
          },
          { "@type": "HowToStep", "text": "   " }
        ]
      }
    ]
  }
  </script>
</head>
<body><h1>Sheet-Pan Lemon Chicken Thighs</h1></body>
</html>`

const NO_SCHEMA_HTML = `<!doctype html>
<html><head><title>Sheet-Pan Lemon Chicken</title></head>
<body><h1>Sheet-Pan Lemon Chicken</h1><p>1 pound chicken thighs</p></body></html>`

const WRONG_SCHEMA_HTML = `<!doctype html>
<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"How to roast a chicken"}</script>
</head><body></body></html>`

const PASTED_TEXT = [
  'Sheet-Pan Lemon Chicken',
  'By Jane Cook',
  'Total Time: 45 minutes | Prep Time: 15 minutes | Serves 4',
  'The brightest, easiest weeknight chicken dinner, roasted on a single sheet pan with lemon and garlic.',
  'Jump to Recipe',
  'Ingredients',
  '1 pound chicken thighs',
  '2 tablespoons olive oil',
  '4 cloves garlic, minced',
  '1 lemon',
  'Instructions',
  '1. Heat the oven to 425 degrees.',
  '2. Toss the chicken with the oil, garlic, and lemon.',
  '3. Roast for 30 minutes until cooked through.',
  'Notes',
  'Leftovers keep for three days.',
].join('\n')

describe('parseIsoDuration', () => {
  it('reads hours and minutes', () => {
    expect(parseIsoDuration('PT1H30M')).toBe(90)
    expect(parseIsoDuration('PT45M')).toBe(45)
  })

  it('reads days', () => {
    expect(parseIsoDuration('P1DT2H')).toBe(1560)
    expect(parseIsoDuration('P1DT2H30M')).toBe(1590)
  })

  it('returns 0 for empty or unparseable input', () => {
    expect(parseIsoDuration('')).toBe(0)
    expect(parseIsoDuration('45 minutes')).toBe(0)
    expect(parseIsoDuration('PT')).toBe(0)
  })
})

describe('extractJsonLd', () => {
  it('skips non-Recipe and malformed blocks and finds the Recipe in an @graph', () => {
    const node = extractJsonLd(RECIPE_HTML)
    expect(node).not.toBeNull()
    expect(node?.['name']).toBe('  Sheet-Pan Lemon Chicken Thighs  ')
  })

  it('returns null when no block holds a Recipe', () => {
    expect(extractJsonLd(WRONG_SCHEMA_HTML)).toBeNull()
    expect(extractJsonLd(NO_SCHEMA_HTML)).toBeNull()
  })

  it('finds a Recipe nested in an array', () => {
    const found = findRecipe([{ '@type': 'Person' }, [{ '@type': 'Recipe', name: 'Nested' }]])
    expect(found?.['name']).toBe('Nested')
  })
})

describe('detectSource', () => {
  it('labels the hand-tuned sources', () => {
    expect(detectSource('https://cooking.nytimes.com/recipes/1234')).toBe('nyt_cooking')
    expect(detectSource('https://www.foodandwine.com/recipes/abc')).toBe('food_and_wine')
  })

  it('falls back to the bare domain, or manual', () => {
    expect(detectSource('https://www.allrecipes.com/recipe/1')).toBe('allrecipes')
    expect(detectSource('')).toBe('manual')
    expect(detectSource('manual:1712345678')).toBe('manual')
    expect(detectSource('not a url')).toBe('manual')
  })
})

describe('parseRecipeHtml', () => {
  const recipe = parseRecipeHtml(RECIPE_HTML, SOURCE_URL)

  it('pulls the headline fields off the JSON-LD node', () => {
    expect(recipe.title).toBe('Sheet-Pan Lemon Chicken Thighs')
    expect(recipe.author).toBe('Jane Cook')
    expect(recipe.description).toBe('A bright weeknight dinner.')
    expect(recipe.imageUrl).toBe('https://img.example.com/lemon-chicken.jpg')
    expect(recipe.servings).toBe('4 servings')
    expect(recipe.source).toBe('example-cooking')
    expect(recipe.sourceUrl).toBe(SOURCE_URL)
  })

  it('converts ISO-8601 times to minutes', () => {
    expect(recipe.totalTimeMinutes).toBe(45)
    expect(recipe.activeTimeMinutes).toBe(15)
  })

  it('parses every ingredient into item, quantity, and grocery section', () => {
    expect(recipe.ingredients).toHaveLength(5)
    expect(recipe.ingredients.map((i) => i.item)).toEqual([
      'chicken thighs',
      'olive oil',
      'garlic',
      'lemon',
      'salt and pepper',
    ])
    expect(recipe.ingredients.map((i) => i.quantity)).toEqual(['1 lb', '2 tbsp', '4 clove', '1', ''])
    expect(recipe.ingredients[0]?.section).toBe('meat_seafood')
    expect(recipe.ingredients[3]?.section).toBe('produce')
  })

  it('flattens HowToStep, plain-string, and HowToSection instructions', () => {
    expect(recipe.steps).toEqual([
      'Heat the oven to 425 degrees.',
      'Toss the chicken with the oil and garlic.',
      'Roast for 30 minutes.',
      'Squeeze the lemon over the top.',
    ])
  })

  it('scores and tags the recipe', () => {
    expect(recipe.familyScore).toBe(9)
    expect(recipe.familyNotes).toContain('Easy cleanup')
    expect(recipe.difficulty).toBe('easy')
    expect(recipe.tags).toEqual(['sheet-pan', 'kid-friendly'])
  })

  it('throws NO_SCHEMA: when the page carries no Recipe node', () => {
    expect(() => parseRecipeHtml(NO_SCHEMA_HTML, SOURCE_URL)).toThrow(/^NO_SCHEMA:/)
    expect(() => parseRecipeHtml(WRONG_SCHEMA_HTML, SOURCE_URL)).toThrow(/^NO_SCHEMA:/)
  })

  it('throws when the Recipe node has no name', () => {
    const html = `<script type="application/ld+json">{"@type":"Recipe","recipeIngredient":["1 lemon"]}</script>`
    expect(() => parseRecipeHtml(html, SOURCE_URL)).toThrow(/missing required field/)
  })
})

describe('parseRecipeText', () => {
  const preview = parseRecipeText(PASTED_TEXT, 'https://img.example.com/pasted.jpg')

  it('reads title, author, description, times, and servings', () => {
    expect(preview.title).toBe('Sheet-Pan Lemon Chicken')
    expect(preview.author).toBe('Jane Cook')
    expect(preview.description).toBe(
      'The brightest, easiest weeknight chicken dinner, roasted on a single sheet pan with lemon and garlic.',
    )
    expect(preview.totalTimeMinutes).toBe(45)
    expect(preview.activeTimeMinutes).toBe(15)
    expect(preview.servings).toBe('4')
    expect(preview.imageUrl).toBe('https://img.example.com/pasted.jpg')
    expect(preview.source).toBe('manual')
  })

  it('splits ingredients from steps, drops boilerplate, and ignores notes', () => {
    expect(preview.ingredientsRaw).toEqual([
      '1 pound chicken thighs',
      '2 tablespoons olive oil',
      '4 cloves garlic, minced',
      '1 lemon',
    ])
    expect(preview.stepsRaw).toEqual([
      'Heat the oven to 425 degrees.',
      'Toss the chicken with the oil, garlic, and lemon.',
      'Roast for 30 minutes until cooked through.',
    ])
    expect(preview.ingredientsRaw.join(' ')).not.toContain('Jump to Recipe')
    expect(preview.stepsRaw.join(' ')).not.toContain('Leftovers')
  })

  it('scores the pasted recipe the same way the scraper does', () => {
    expect(preview.familyScore).toBe(9)
    expect(preview.difficulty).toBe('easy')
    expect(preview.tags).toEqual(['sheet-pan'])
  })

  it('falls back to a placeholder title on empty input', () => {
    expect(parseRecipeText('').title).toBe('Untitled Recipe')
  })
})

describe('rawStringsToRecipeInput', () => {
  const preview = parseRecipeText(PASTED_TEXT)

  const input = rawStringsToRecipeInput(preview, {
    title: 'Sheet-Pan Lemon Chicken',
    author: 'Jane Cook',
    source: 'manual',
    sourceUrl: '',
    difficulty: 'easy',
    totalTimeMinutes: 45,
    activeTimeMinutes: 15,
    servings: '4',
    ingredientsRaw: '1 pound chicken thighs\n2 tablespoons olive oil\n\n  1 lemon  ',
    stepsRaw: 'Heat the oven to 425 degrees.\nRoast for 30 minutes.',
    tags: ['sheet-pan'],
  })

  it('re-parses the edited textareas into structured ingredients and steps', () => {
    expect(input.ingredients).toEqual([
      { item: 'chicken thighs', quantity: '1 lb', section: 'meat_seafood' },
      { item: 'olive oil', quantity: '2 tbsp', section: 'pantry_staples' },
      { item: 'lemon', quantity: '1', section: 'produce' },
    ])
    expect(input.steps).toEqual(['Heat the oven to 425 degrees.', 'Roast for 30 minutes.'])
  })

  it('mints a manual: sourceUrl when none is supplied and keeps the edited tags', () => {
    expect(input.sourceUrl).toMatch(/^manual:\d+$/)
    expect(input.source).toBe('manual')
    expect(input.tags).toEqual(['sheet-pan'])
    expect(input.familyScore).toBe(9)
  })
})

/* ───────────────── hardening regressions (added in review) ───────────────── */

describe('detectSource provenance spoofing', () => {
  it('matches on the hostname, not on the raw URL string', () => {
    // The original substring check let any page claim to be NYT Cooking.
    expect(detectSource('https://evil.test/recipe?ref=cooking.nytimes.com')).toBe('evil')
    expect(detectSource('https://cooking.nytimes.com.evil.test/x')).toBe('cooking')
    expect(detectSource('https://foodandwine.com.evil.test/x')).toBe('foodandwine')
    // Genuine hosts still resolve to their hand-tuned labels.
    expect(detectSource('https://cooking.nytimes.com/recipes/1')).toBe('nyt_cooking')
    expect(detectSource('https://www.foodandwine.com/x')).toBe('food_and_wine')
  })
})

describe('hostile page limits', () => {
  const hostile = (over: Record<string, unknown>) =>
    `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Recipe',
      name: 'A recipe',
      recipeIngredient: ['1 lemon'],
      ...over,
    })}</script>`

  it('clamps absurd ISO durations instead of overflowing an int4 column', () => {
    expect(parseIsoDuration('P9999999DT0H')).toBe(100_000)
    expect(parseIsoDuration('PT99999999999H')).toBe(100_000)
  })

  it('caps title, description, steps, and ingredients', () => {
    const recipe = parseRecipeHtml(
      hostile({
        name: 'T'.repeat(10_000),
        description: 'D'.repeat(50_000),
        recipeInstructions: Array.from({ length: 5_000 }, (_, i) => `step ${i} ${'x'.repeat(9_000)}`),
        recipeIngredient: Array.from({ length: 5_000 }, () => '1 lemon'),
      }),
      SOURCE_URL,
    )
    expect(recipe.title.length).toBeLessThanOrEqual(300)
    expect((recipe.description ?? '').length).toBeLessThanOrEqual(2_000)
    expect(recipe.steps.length).toBe(200)
    expect(Math.max(...recipe.steps.map((s) => s.length))).toBeLessThanOrEqual(4_000)
    expect(recipe.ingredients.length).toBe(300)
  })

  it('drops non-http image URLs', () => {
    expect(parseRecipeHtml(hostile({ image: 'javascript:alert(1)' }), SOURCE_URL).imageUrl).toBeUndefined()
    expect(parseRecipeHtml(hostile({ image: 'data:image/png;base64,AAAA' }), SOURCE_URL).imageUrl).toBeUndefined()
    expect(parseRecipeHtml(hostile({ image: 'https://img.test/a.jpg' }), SOURCE_URL).imageUrl).toBe(
      'https://img.test/a.jpg',
    )
  })
})

describe('fetchAndParseRecipe transport guards', () => {
  const PAGE = `<script type="application/ld+json">{"@type":"Recipe","name":"Stub","recipeIngredient":["1 lemon"],"recipeInstructions":[{"@type":"HowToStep","text":"Cook."}]}</script>`

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('refuses non-public and non-http targets without opening a socket', async () => {
    const spy = vi.fn(() => {
      throw new Error('fetch must not be called')
    })
    vi.stubGlobal('fetch', spy)

    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:5432/',
      'http://127.0.0.1/',
      'http://10.0.0.1/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://[::1]/',
      'http://2130706433/',
      'http://db.internal/',
      'file:///etc/passwd',
      'not-a-url',
    ]) {
      await expect(fetchAndParseRecipe(url)).rejects.toThrow(/^NETWORK:/)
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('re-validates every redirect hop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) =>
        String(input).includes('recipes.test')
          ? new Response('', { status: 302, headers: { location: 'http://169.254.169.254/meta' } })
          : new Response('SECRET', { status: 200 }),
      ),
    )
    await expect(fetchAndParseRecipe('https://recipes.test/x')).rejects.toThrow(/non-public address/)
  })

  it('bounds a redirect loop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://recipes.test/loop' } })),
    )
    await expect(fetchAndParseRecipe('https://recipes.test/loop')).rejects.toThrow(/Too many redirects/)
  })

  it('maps an abort during the body stream to TIMEOUT:', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('<html>'))
                controller.error(new DOMException('aborted', 'TimeoutError'))
              },
            }),
            { status: 200 },
          ),
      ),
    )
    await expect(fetchAndParseRecipe('https://recipes.test/x')).rejects.toThrow(/^TIMEOUT:/)
  })

  it('keeps the 401/403 and non-2xx branches', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })))
    await expect(fetchAndParseRecipe('https://recipes.test/x')).rejects.toThrow(/^BLOCKED:/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    await expect(fetchAndParseRecipe('https://recipes.test/x')).rejects.toThrow('HTTP_ERROR: Server returned 503')
  })

  it('still imports a normal public page, following a public redirect', async () => {
    const spy = vi.fn(async (input: unknown) =>
      String(input).endsWith('/x')
        ? new Response('', { status: 302, headers: { location: '/final' } })
        : new Response(PAGE, { status: 200 }),
    )
    vi.stubGlobal('fetch', spy)
    const recipe = await fetchAndParseRecipe('https://recipes.test/x')
    expect(recipe.title).toBe('Stub')
    expect(recipe.source).toBe('recipes')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  /**
   * `sourceUrl` is the de-duplication key in `recipes`, so it has to be the URL
   * the recipe actually lives at. NYT Cooking 308s its recipes to a canonical
   * slug and rewrites those slugs over time: keeping the pre-redirect URL means
   * the same recipe imported before and after a rename lands as two rows and
   * splits its family rating between them.
   */
  it('records the post-redirect URL, so a renamed slug does not create a second row', async () => {
    const canonical = 'https://cooking.nytimes.com/recipes/787756197-flatiron-steak'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) =>
        String(input).includes('-steak-a-lechalote')
          ? new Response('', { status: 308, headers: { location: canonical } })
          : new Response(PAGE, { status: 200 }),
      ),
    )

    const recipe = await fetchAndParseRecipe(
      'https://cooking.nytimes.com/recipes/787756197-steak-a-lechalote-seared-flatiron',
    )

    expect(recipe.sourceUrl).toBe(canonical)
  })
})
