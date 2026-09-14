import { describe, expect, it, vi } from 'vitest'

/**
 * The grocery list is read on a phone, one-handed, in a supermarket aisle. Three
 * properties make that work, and all three are easy to break silently:
 *
 *  1. items are grouped under their store section, in walk-the-store order;
 *  2. the weekend shop and the midweek pickup stay visibly separate, so nobody
 *     buys Thursday's fish on Saturday;
 *  3. every payload is MarkdownV2-escaped, because Telegram rejects the whole
 *     message when one unescaped `-` or `.` slips through — and a rejected
 *     message means no list at all.
 *
 * Pure rendering only: no database, no network, no Telegram.
 */

vi.mock('../src/logger.js', () => {
  const noop = (): void => {}
  const l: Record<string, unknown> = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  }
  l['child'] = () => l
  return { logger: l, child: () => l }
})

vi.mock('../src/config.js', () => ({
  getConfig: () => ({ HOUSEHOLD_TIMEZONE: 'America/Los_Angeles' }),
}))

import {
  SECTION_LABELS,
  SECTION_ORDER,
  formatGroceryList,
  formatGroceryListPlain,
  groceryItemLabel,
  orderedSections,
} from '../src/tools/recipes.js'
import { escapeMd } from '../src/telegram/send.js'
import type {
  GroceryItem,
  GroceryListData,
  GroceryListResponse,
  GrocerySection,
} from '../src/recipes/types.js'

/* ────────────────────────────────  fixtures  ─────────────────────────────── */

function item(
  name: string,
  quantity: string,
  recipes: string[],
  day?: 'Thu' | 'Fri',
): GroceryItem {
  return day === undefined
    ? { item: name, quantity, recipes }
    : { item: name, quantity, recipes, day }
}

/**
 * One realistic week. `gluten-free penne no. 2` is the escaping canary: it
 * carries both a hyphen and a period, the two MarkdownV2 specials most likely
 * to appear in a real ingredient name.
 */
function sampleList(): GroceryListResponse {
  return {
    weekendItems: {
      // Alphabetical within a section, the way the consolidator emits them.
      produce: [
        item('flat leaf parsley', '1 bunch', ['Sheet-pan chicken thighs']),
        item('yellow onion', '3', ['Sheet-pan chicken thighs']),
      ],
      grains_pasta_rice: [item('gluten-free penne no. 2', '1 lb', ['Baked ziti'])],
      pantry_staples: [item('olive oil', 'as needed', ['Baked ziti'])],
    },
    midweekItems: {
      produce: [item('baby spinach', '5 oz', ['Salmon traybake'], 'Thu')],
      meat_seafood: [item('salmon fillet', '1.5 lb', ['Salmon traybake'], 'Thu')],
    },
    hasMidweek: true,
    checkedItems: [],
  }
}

const WEEK_START = '2026-08-31'

/* ─────────────────────────────  parsing helpers  ─────────────────────────── */

interface Trip {
  header: string
  sections: Array<{ label: string; items: string[] }>
}

/**
 * Re-read the rendered message the way a human does: trip headers in bold,
 * section headers in italics, bulleted item lines beneath them. A trailing
 * italic line with no items under it is the trip's subtitle, not a section.
 */
function parseRendered(text: string): Trip[] {
  const trips: Trip[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('*') && line.endsWith('*') && /(SHOP|PICKUP)/.test(line)) {
      trips.push({ header: line.slice(1, -1), sections: [] })
      continue
    }
    const trip = trips[trips.length - 1]
    if (trip === undefined) continue

    if (line.startsWith('_') && line.endsWith('_') && line.length > 2) {
      trip.sections.push({ label: line.slice(1, -1), items: [] })
      continue
    }
    if (line.startsWith('• ')) {
      const section = trip.sections[trip.sections.length - 1]
      if (section) section.items.push(line.slice(2))
    }
  }
  // Drop the subtitle line, which parses as a section that never got any items.
  return trips.map((trip) => ({
    header: trip.header,
    sections: trip.sections.filter((s) => s.items.length > 0),
  }))
}

const MARKDOWN_V2_SPECIALS = '_*[]()~`>#+-=|{}.!\\'

/**
 * The first MarkdownV2 special that Telegram would choke on, or null.
 * A backslash consumes the character after it, which is exactly how `escapeMd`
 * neutralises a special.
 */
function firstUnescapedSpecial(payload: string): string | null {
  for (let i = 0; i < payload.length; i++) {
    const ch = payload[i]
    if (ch === undefined) continue
    if (ch === '\\') {
      i++
      continue
    }
    if (MARKDOWN_V2_SPECIALS.includes(ch)) return ch
  }
  return null
}

/** Strip the markup this renderer emits, leaving only escaped payload text. */
function payloadOf(line: string): string {
  if (line.startsWith('• ')) return line.slice(2)
  if (line.startsWith('*') && line.endsWith('*') && line.length > 2) return line.slice(1, -1)
  if (line.startsWith('_') && line.endsWith('_') && line.length > 2) return line.slice(1, -1)
  return line
}

/* ────────────────────────────── grouping by section ──────────────────────── */

describe('formatGroceryList — grouping by store section', () => {
  it('puts every item under its own section header', () => {
    const trips = parseRendered(formatGroceryList(sampleList(), { weekStart: WEEK_START }))
    const weekend = trips[0]
    expect(weekend).toBeDefined()

    const bySection = new Map(
      (weekend?.sections ?? []).map((s) => [s.label, s.items] as const),
    )
    expect(bySection.get(escapeMd(SECTION_LABELS.produce))).toEqual([
      escapeMd('1 bunch flat leaf parsley'),
      escapeMd('3 yellow onion'),
    ])
    expect(bySection.get(escapeMd(SECTION_LABELS.grains_pasta_rice))).toEqual([
      escapeMd('1 lb gluten-free penne no. 2'),
    ])
  })

  it('orders sections the way you walk a supermarket, produce first and staples last', () => {
    const trips = parseRendered(formatGroceryList(sampleList(), { weekStart: WEEK_START }))
    expect((trips[0]?.sections ?? []).map((s) => s.label)).toEqual([
      escapeMd(SECTION_LABELS.produce),
      escapeMd(SECTION_LABELS.grains_pasta_rice),
      escapeMd(SECTION_LABELS.pantry_staples),
    ])
  })

  it('keeps each item on its own line with the quantity first', () => {
    const text = formatGroceryList(sampleList(), { weekStart: WEEK_START })
    const bulleted = text.split('\n').filter((l) => l.startsWith('• '))
    expect(bulleted).toHaveLength(6) // 4 weekend + 2 midweek
    for (const line of bulleted) {
      expect(line).not.toContain('\n')
    }
    expect(bulleted).toContain(`• ${escapeMd('3 yellow onion')}`)
  })

  it('drops a placeholder quantity rather than printing "as needed olive oil"', () => {
    expect(groceryItemLabel(item('olive oil', 'as needed', []))).toBe('olive oil')
    expect(groceryItemLabel(item('olive oil', '', []))).toBe('olive oil')
    expect(groceryItemLabel(item('yellow onion', '3', []))).toBe('3 yellow onion')
  })

  it('never loses an ingredient: every populated section renders, in walk order', () => {
    // A lost section is a missed dinner, so populate all of them and demand
    // all of them back. This holds whether a section is reached by the walk
    // order or by the drift-append fallback in `orderedSections`.
    const data: GroceryListData = {}
    for (const section of Object.keys(SECTION_LABELS) as GrocerySection[]) {
      data[section] = [item(`${section} thing`, '1', [])]
    }
    const sections = orderedSections(data)
    expect(sections.map(([section]) => section)).toEqual([...SECTION_ORDER])
    expect(sections).toHaveLength(Object.keys(SECTION_LABELS).length)
  })

  it('drops a hostile or unknown key instead of rendering a phantom section', () => {
    // `__proto__` as a real own key is the crash case the isGrocerySection
    // guard exists for; `aisle_99` is ordinary jsonb drift.
    const data = {
      produce: [item('lemon', '2', [])],
      ['__proto__']: [item('bottles of gin', '40', [])],
      aisle_99: [item('smuggled item', '1', [])],
    } as unknown as GroceryListData
    expect(orderedSections(data).map(([section]) => section)).toEqual(['produce'])
  })

  it('renders nothing for an absent list', () => {
    expect(orderedSections(undefined)).toEqual([])
  })

  it('says so plainly when the plan has no recipes on it', () => {
    const empty: GroceryListResponse = {
      weekendItems: {},
      midweekItems: {},
      hasMidweek: false,
      checkedItems: [],
    }
    const text = formatGroceryList(empty, { weekStart: WEEK_START })
    expect(text).toContain(escapeMd('Nothing to buy'))
    expect(text).not.toContain('WEEKEND SHOP')
  })
})

/* ────────────────────────── weekend / midweek split ──────────────────────── */

describe('formatGroceryList — the weekend/midweek split stays visible', () => {
  it('renders two labelled trips, weekend first, each with its own item count', () => {
    const text = formatGroceryList(sampleList(), { weekStart: WEEK_START })
    const trips = parseRendered(text)

    expect(trips).toHaveLength(2)
    expect(trips[0]?.header).toBe(escapeMd('WEEKEND SHOP · 4 items'))
    expect(trips[1]?.header).toBe(escapeMd('MIDWEEK PICKUP · 2 items'))
    expect(text.indexOf('WEEKEND SHOP')).toBeLessThan(text.indexOf('MIDWEEK PICKUP'))
  })

  it('keeps the perishable Thursday buys under the midweek header, not the weekend one', () => {
    const text = formatGroceryList(sampleList(), { weekStart: WEEK_START })
    const trips = parseRendered(text)

    const weekendItems = (trips[0]?.sections ?? []).flatMap((s) => s.items)
    const midweekItems = (trips[1]?.sections ?? []).flatMap((s) => s.items)

    expect(weekendItems.some((l) => l.includes('yellow onion'))).toBe(true)
    expect(weekendItems.some((l) => l.includes('salmon'))).toBe(false)
    expect(midweekItems.some((l) => l.includes('salmon fillet'))).toBe(true)
    expect(text.indexOf('salmon fillet')).toBeGreaterThan(text.indexOf('MIDWEEK PICKUP'))
  })

  it('tags each midweek line with the day it is needed', () => {
    const text = formatGroceryList(sampleList(), { weekStart: WEEK_START })
    expect(text).toContain(`• ${escapeMd('1.5 lb salmon fillet (Thu)')}`)
  })

  it('explains why the second trip exists', () => {
    const text = formatGroceryList(sampleList(), { weekStart: WEEK_START })
    const subtitle = text.split('\n').find((l) => l.includes('Thu/Fri so the fish'))
    expect(subtitle).toBeDefined()
    expect(subtitle?.startsWith('_')).toBe(true)
  })

  it('shows only the weekend trip when nothing needs a midweek run', () => {
    const list = sampleList()
    const weekendOnly: GroceryListResponse = {
      weekendItems: list.weekendItems,
      midweekItems: {},
      hasMidweek: false,
      checkedItems: [],
    }
    const text = formatGroceryList(weekendOnly, { weekStart: WEEK_START })
    expect(text).toContain('WEEKEND SHOP')
    expect(text).not.toContain('MIDWEEK PICKUP')
  })

  it('ignores midweek data when the split says there is no midweek run', () => {
    const list = sampleList()
    const text = formatGroceryList(
      { ...list, hasMidweek: false },
      { weekStart: WEEK_START },
    )
    expect(text).not.toContain('salmon fillet')
  })

  it('keeps the split in the plain-text rendering used for to-do notes', () => {
    const plain = formatGroceryListPlain(sampleList(), { weekStart: WEEK_START })
    expect(plain).toContain('WEEKEND SHOP (4 items)')
    expect(plain).toContain('MIDWEEK PICKUP (Thu/Fri) (2 items)')
    // Plain text is for a to-do note, so it carries no MarkdownV2 escapes.
    expect(plain).toContain('gluten-free penne no. 2')
    expect(plain).not.toContain('\\')
  })
})

/* ────────────────────────────── MarkdownV2 escaping ──────────────────────── */

describe('formatGroceryList — MarkdownV2 escaping', () => {
  it('escapes both the hyphen and the period in an ingredient name', () => {
    const text = formatGroceryList(sampleList(), { weekStart: WEEK_START })

    // What escapeMd must have produced, spelled out rather than round-tripped.
    expect(text).toContain('• 1 lb gluten\\-free penne no\\. 2')
    expect(text).toContain(`• ${escapeMd('1 lb gluten-free penne no. 2')}`)

    // And the raw, Telegram-rejecting form is nowhere in the message.
    expect(text).not.toContain('gluten-free')
    expect(text).not.toContain('no. 2')
  })

  it('escapes the parentheses around a midweek day tag and the decimal point before it', () => {
    const text = formatGroceryList(sampleList(), { weekStart: WEEK_START })
    expect(text).toContain('• 1\\.5 lb salmon fillet \\(Thu\\)')
    expect(text).not.toContain('(Thu)')
  })

  it('leaves no unescaped MarkdownV2 special anywhere in the message', () => {
    const text = formatGroceryList(sampleList(), { weekStart: WEEK_START })
    for (const line of text.split('\n')) {
      if (line === '') continue
      const offender = firstUnescapedSpecial(payloadOf(line))
      expect(offender, `unescaped "${offender}" in: ${line}`).toBeNull()
    }
  })

  it('escapes hostile ingredient text instead of letting it forge markup', () => {
    const nasty: GroceryListResponse = {
      weekendItems: {
        other: [
          item('*bold* _italic_ [link](http://x.example)', '1', ['Hostile page']),
          item('back`tick` and #hash!', '2', ['Hostile page']),
        ],
      },
      midweekItems: {},
      hasMidweek: false,
      checkedItems: [],
    }
    const text = formatGroceryList(nasty)
    for (const line of text.split('\n').filter((l) => l.startsWith('• '))) {
      expect(firstUnescapedSpecial(payloadOf(line))).toBeNull()
    }
    expect(text).toContain(escapeMd('1 *bold* _italic_ [link](http://x.example)'))
  })

  it('flattens a newline smuggled into an ingredient name so it cannot forge a row', () => {
    const smuggled: GroceryListResponse = {
      weekendItems: {
        other: [item('onions\n• 40 bottles of gin', '2', ['Hostile page'])],
      },
      midweekItems: {},
      hasMidweek: false,
      checkedItems: [],
    }
    const text = formatGroceryList(smuggled)
    expect(text.split('\n').filter((l) => l.startsWith('• '))).toHaveLength(1)
    expect(text).toContain(escapeMd('2 onions • 40 bottles of gin'))
  })

  it('escapes the week label in the title', () => {
    const text = formatGroceryList(sampleList(), { weekStart: WEEK_START })
    const title = text.split('\n')[0] ?? ''
    expect(title).toBe(`*${escapeMd('Groceries — week of Mon 31 Aug')}*`)
    expect(firstUnescapedSpecial(payloadOf(title))).toBeNull()
  })
})

/* ───────────────────── when the tidying pass did not run ────────────────── */

describe('formatGroceryList — saying when the list was not tidied', () => {
  /**
   * The Claude pass can fail (timeout, refusal, a malformed reply) and the
   * list then arrives exactly as the parser built it. That is fine, but the
   * household should know it is looking at the rougher version.
   */
  it('adds one quiet line when refinement was skipped, in both renderings', () => {
    const list: GroceryListResponse = { ...sampleList(), refined: false }

    expect(formatGroceryList(list)).toMatch(/not tidied/i)
    expect(formatGroceryListPlain(list)).toMatch(/not tidied/i)
  })

  it('says nothing about it when the list was refined, or when the flag is absent', () => {
    expect(formatGroceryList({ ...sampleList(), refined: true })).not.toMatch(/not tidied/i)
    expect(formatGroceryList(sampleList())).not.toMatch(/not tidied/i)
    expect(formatGroceryListPlain(sampleList())).not.toMatch(/not tidied/i)
  })
})
