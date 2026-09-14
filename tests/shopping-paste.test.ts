import { describe, expect, it } from 'vitest'
import { MAX_PASTE_CHARS, MAX_PASTE_ITEMS, formatLine, formatPasteBlocks } from '../src/shopping/paste.js'
import type { ShoppingList } from '../src/shopping/list.js'

/**
 * What gets pasted into a store's importer. Everything that helps a person
 * read a list — sections, provenance, markdown — hurts a matcher, so this
 * formatter's job is to leave all of it out.
 */

function list(lines: ShoppingList['lines']): ShoppingList {
  return { title: 'Weekend shop', lines }
}

describe('formatLine', () => {
  it('puts the quantity in front of the name', () => {
    expect(formatLine({ name: 'chicken thighs', quantity: 2, unit: 'lb' })).toBe('2 lb chicken thighs')
  })

  it('writes a bare name when there is no quantity', () => {
    expect(formatLine({ name: 'olive oil', displayText: 'as needed' })).toBe('olive oil')
  })

  it('omits the unit when there is only a count', () => {
    expect(formatLine({ name: 'onions', quantity: 3 })).toBe('3 onions')
  })

  it('never emits the note', () => {
    const text = formatLine({ name: 'coconut milk', quantity: 1, unit: 'can', note: 'Thai curry' })
    expect(text).toBe('1 can coconut milk')
    expect(text).not.toMatch(/curry/i)
  })
})

describe('formatPasteBlocks', () => {
  it('is one line per item, newline separated, nothing else', () => {
    const blocks = formatPasteBlocks(
      list([
        { name: 'onions', quantity: 3 },
        { name: 'butter', quantity: 1, unit: 'lb' },
      ]),
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toBe('3 onions\n1 lb butter')
  })

  it('carries no markdown, headers, or bullets', () => {
    const blocks = formatPasteBlocks(list([{ name: 'kale', quantity: 1, unit: 'bunch' }]))
    expect(blocks[0]).not.toMatch(/[*_`#]/)
    expect(blocks[0]).not.toMatch(/^[-•]/m)
  })

  it('returns no blocks for an empty list', () => {
    expect(formatPasteBlocks(list([]))).toEqual([])
  })

  it('splits rather than truncates past the paste limit', () => {
    const many = Array.from({ length: MAX_PASTE_ITEMS + 5 }, (_, i) => ({ name: `item ${i}` }))
    const blocks = formatPasteBlocks(list(many))

    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.split('\n')).toHaveLength(MAX_PASTE_ITEMS)
    expect(blocks[1]?.split('\n')).toHaveLength(5)
    // Nothing was dropped on the way.
    const all = blocks.join('\n').split('\n')
    expect(all).toHaveLength(MAX_PASTE_ITEMS + 5)
    expect(all.at(-1)).toBe(`item ${MAX_PASTE_ITEMS + 4}`)
  })

  it('splits on characters as well as items, so a block always fits one Telegram message', () => {
    // 200 long rows is ~8000 characters. Sent as one code block that would be
    // chunked mid-fence and rejected by Telegram; the fallback delivers it as
    // plain text with the literal backticks.
    const many = Array.from({ length: MAX_PASTE_ITEMS }, (_, i) => ({
      name: `item number ${i} with a longish descriptive name`,
      quantity: 2,
      unit: 'lb',
    }))
    const preamble = 'Prefer organic where it costs under 20% more.\nNo store brands.'
    const blocks = formatPasteBlocks(list(many), { preamble })

    expect(blocks.length).toBeGreaterThan(1)
    for (const block of blocks) {
      expect(block.length).toBeLessThanOrEqual(MAX_PASTE_CHARS)
      expect(block.startsWith(preamble)).toBe(true)
    }
    const rows = blocks.flatMap((b) => b.split('\n').slice(preamble.split('\n').length))
    expect(rows).toHaveLength(MAX_PASTE_ITEMS)
    expect(rows.at(-1)).toBe(`2 lb item number ${MAX_PASTE_ITEMS - 1} with a longish descriptive name`)
  })

  it('drops a line that would be blank rather than emitting an empty row', () => {
    const blocks = formatPasteBlocks(list([{ name: '  ' }, { name: 'salt' }]))
    expect(blocks[0]).toBe('salt')
  })
})
