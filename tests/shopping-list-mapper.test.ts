import { describe, expect, it } from 'vitest'
import { groceryDataToLines, lineFromGroceryItem } from '../src/shopping/list.js'
import type { GroceryListData } from '../src/recipes/types.js'

/**
 * The mapper's whole job is refusing to guess. `grocery_list_generate`
 * produces a free-text quantity — "2 lb", "as needed", and "2 lb + 3 cups"
 * when the consolidator cannot merge units. A store matches on the name; a
 * wrong number is worse than no number.
 */

describe('lineFromGroceryItem', () => {
  it('carries a parseable quantity through as structure', () => {
    const line = lineFromGroceryItem({ item: 'chicken thighs', quantity: '2 lb', recipes: [] })
    expect(line.name).toBe('chicken thighs')
    expect(line.quantity).toBe(2)
    expect(line.unit).toBe('lb')
    expect(line.displayText).toBe('2 lb')
  })

  it('degrades to a named line when the quantity is not a number', () => {
    const line = lineFromGroceryItem({ item: 'olive oil', quantity: 'as needed', recipes: [] })
    expect(line.name).toBe('olive oil')
    expect(line.quantity).toBeUndefined()
    expect(line.unit).toBeUndefined()
    // The phrasing survives even though the number does not.
    expect(line.displayText).toBe('as needed')
  })

  it('degrades on an unmerged compound quantity rather than picking one half', () => {
    const line = lineFromGroceryItem({ item: 'butter', quantity: '2 lb + 3 cups', recipes: [] })
    expect(line.name).toBe('butter')
    expect(line.quantity).toBeUndefined()
    expect(line.displayText).toBe('2 lb + 3 cups')
  })

  it('keeps a decimal amount, which the recipe parser cannot read on its own', () => {
    const line = lineFromGroceryItem({ item: 'carrots', quantity: '1.5 lb', recipes: [] })
    expect(line.quantity).toBe(1.5)
    expect(line.unit).toBe('lb')
  })

  it('keeps a unit the recipe parser does not know, rather than dropping it', () => {
    // "2 L" once became "2 chicken stock" — the number survived and the unit
    // did not, which reads as two cartons. A wrong quantity is the one thing
    // this mapper exists to prevent.
    const litres = lineFromGroceryItem({ item: 'chicken stock', quantity: '2 L', recipes: [] })
    expect(litres.quantity).toBe(2)
    expect(litres.unit).toBe('L')

    const box = lineFromGroceryItem({ item: 'dishwasher pods', quantity: '1 box', recipes: [] })
    expect(box.quantity).toBe(1)
    expect(box.unit).toBe('box')
  })

  it('normalises a unit the parser does know', () => {
    const line = lineFromGroceryItem({ item: 'flour', quantity: '2 pounds', recipes: [] })
    expect(line.quantity).toBe(2)
    expect(line.unit).toBe('lb')
  })

  it('keeps recipe provenance in note, never in name', () => {
    const line = lineFromGroceryItem({
      item: 'coconut milk',
      quantity: '1 can',
      recipes: ['Thai green curry'],
    })
    expect(line.name).toBe('coconut milk')
    expect(line.note).toBe('Thai green curry')
  })

  it('handles a missing quantity at all', () => {
    const line = lineFromGroceryItem({ item: 'bay leaves', quantity: '', recipes: [] })
    expect(line.name).toBe('bay leaves')
    expect(line.quantity).toBeUndefined()
    expect(line.displayText).toBeUndefined()
  })
})

describe('groceryDataToLines', () => {
  it('flattens every section in order and drops the section headers', () => {
    const data: GroceryListData = {
      Produce: [{ item: 'onions', quantity: '3', recipes: [] }],
      Dairy: [{ item: 'butter', quantity: '1 lb', recipes: [] }],
    }
    const lines = groceryDataToLines(data)
    expect(lines.map((l) => l.name)).toEqual(['onions', 'butter'])
  })

  it('is empty for an empty list', () => {
    expect(groceryDataToLines({})).toEqual([])
  })

  it('skips items with no usable name', () => {
    const data: GroceryListData = {
      Produce: [
        { item: '   ', quantity: '1', recipes: [] },
        { item: 'kale', quantity: '1 bunch', recipes: [] },
      ],
    }
    expect(groceryDataToLines(data).map((l) => l.name)).toEqual(['kale'])
  })
})
