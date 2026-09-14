import { describe, expect, it } from 'vitest'
import { MAX_PREAMBLE_CHARS, renderPreamble } from '../src/shopping/preferences.js'
import type { PreferenceRow } from '../src/shopping/preferences.js'
import { formatPasteBlocks } from '../src/shopping/paste.js'
import type { ShoppingList } from '../src/shopping/list.js'

/**
 * The standing instructions that ride on a pasted list.
 *
 * These exist because the importer on the other side is an assistant, not a
 * parser: it reads the whole message and shops to it. Left to its defaults it
 * fills the cart with store brands, so the preamble is the household's taste
 * expressed as text they can change without a deploy.
 */

function prefs(...texts: string[]): PreferenceRow[] {
  return texts.map((text, i) => ({ id: i + 1, text, position: (i + 1) * 10 })) as PreferenceRow[]
}

describe('renderPreamble', () => {
  it('is empty when the household has set nothing', () => {
    expect(renderPreamble([])).toBe('')
  })

  it('numbers the instructions and ends by naming what follows', () => {
    const text = renderPreamble(prefs('No store brands.', 'Price is not a factor.'))

    expect(text).toMatch(/^STOP\./)
    expect(text).toContain('1. No store brands.')
    expect(text).toContain('2. Price is not a factor.')
    // Without this the assistant has no boundary between rules and groceries.
    expect(text.trimEnd().endsWith('Items:')).toBe(true)
  })

  it('drops blank instructions rather than numbering nothing', () => {
    const text = renderPreamble(prefs('No store brands.', '   ', 'Organic dairy.'))
    expect(text).toContain('1. No store brands.')
    expect(text).toContain('2. Organic dairy.')
    expect(text).not.toContain('3.')
  })

  it('drops whole instructions, never half of one, when it runs long', () => {
    const long = prefs(...Array.from({ length: 40 }, (_, i) => `Rule ${i} ${'x'.repeat(180)}`))
    const text = renderPreamble(long)

    expect(text.length).toBeLessThanOrEqual(MAX_PREAMBLE_CHARS)
    // A truncated rule would ship half an instruction to something that obeys
    // instructions. Every rule present must be present in full.
    for (const row of long) {
      if (text.includes(row.text.slice(0, 20))) expect(text).toContain(row.text)
    }
    expect(text.trimEnd().endsWith('Items:')).toBe(true)
  })
})

describe('the preamble on a paste block', () => {
  const list: ShoppingList = {
    title: 'Shopping list',
    lines: [
      { name: 'oat milk' },
      { name: 'chicken stock', quantity: 2, unit: 'L' },
    ],
  }

  it('sits above the items, separated from them', () => {
    const [block] = formatPasteBlocks(list, { preamble: 'STOP.\n\n1. No store brands.\n\nItems:' })

    expect(block).toBe('STOP.\n\n1. No store brands.\n\nItems:\noat milk\n2 L chicken stock')
  })

  it('is omitted entirely when there is none', () => {
    expect(formatPasteBlocks(list, { preamble: '' })[0]).toBe('oat milk\n2 L chicken stock')
    expect(formatPasteBlocks(list)[0]).toBe('oat milk\n2 L chicken stock')
  })

  it('repeats on every block, because each one is pasted on its own', () => {
    const many: ShoppingList = {
      title: 'Shopping list',
      lines: Array.from({ length: 205 }, (_, i) => ({ name: `item ${i}` })),
    }
    const blocks = formatPasteBlocks(many, { preamble: 'STOP.\n\n1. No store brands.\n\nItems:' })

    expect(blocks).toHaveLength(2)
    // A second paste without the rules is shopped under the defaults the rules
    // exist to override.
    expect(blocks[0]).toMatch(/^STOP\./)
    expect(blocks[1]).toMatch(/^STOP\./)
    expect(blocks[1]).toContain('item 204')
  })

  it('still produces nothing for an empty list, preamble or not', () => {
    expect(formatPasteBlocks({ title: 'x', lines: [] }, { preamble: 'STOP.' })).toEqual([])
  })
})
