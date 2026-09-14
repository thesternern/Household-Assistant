// Ported verbatim from thesternern/recipe-planner tests/grocery/freshness.test.ts.
import { describe, it, expect } from 'vitest'
import { classifyFreshness, classifyCuisine, detectFrozenIngredients } from '../../src/recipes/grocery/freshness.js'
import type { Ingredient } from '../../src/recipes/types.js'

const ing = (item: string, quantity = '1'): Ingredient => ({ item, quantity })

describe('classifyFreshness', () => {
  it('returns very_perishable for salmon', () => {
    expect(classifyFreshness([ing('salmon fillets')])).toBe('very_perishable')
  })
  it('returns very_perishable for shrimp', () => {
    expect(classifyFreshness([ing('shrimp, peeled')])).toBe('very_perishable')
  })
  it('returns perishable for chicken thighs', () => {
    expect(classifyFreshness([ing('chicken thighs')])).toBe('perishable')
  })
  it('returns perishable for fresh cilantro', () => {
    expect(classifyFreshness([ing('fresh cilantro')])).toBe('perishable')
  })
  it('returns moderate for bell pepper', () => {
    expect(classifyFreshness([ing('red bell pepper')])).toBe('moderate')
  })
  it('returns shelf_stable for pasta', () => {
    expect(classifyFreshness([ing('penne pasta')])).toBe('shelf_stable')
  })
  it('returns worst category across all ingredients', () => {
    expect(classifyFreshness([ing('penne pasta'), ing('salmon fillets')])).toBe('very_perishable')
  })
  it('returns shelf_stable for empty ingredient list', () => {
    expect(classifyFreshness([])).toBe('shelf_stable')
  })
  it('does NOT treat frozen peas (shelf_stable item) as very_perishable', () => {
    expect(classifyFreshness([ing('frozen peas')])).toBe('shelf_stable')
  })
  it('returns perishable (not moderate) when mixing perishable and moderate ingredients', () => {
    expect(classifyFreshness([ing('chicken thighs'), ing('bell pepper')])).toBe('perishable')
  })
})

describe('classifyCuisine', () => {
  it('detects italian from title', () => {
    expect(classifyCuisine('Pasta Carbonara', '', [])).toBe('italian')
  })
  it('detects asian from title', () => {
    expect(classifyCuisine('Chicken Stir-fry', '', [])).toBe('asian')
  })
  it('detects mexican from existing tag', () => {
    expect(classifyCuisine('Spicy Dinner', '', ['mexican'])).toBe('mexican')
  })
  it('returns null when no match', () => {
    expect(classifyCuisine('Sunday Roast', '', [])).toBeNull()
  })
  it('prefers tags over title', () => {
    expect(classifyCuisine('Pasta Dish', '', ['asian'])).toBe('asian')
  })
})

describe('detectFrozenIngredients', () => {
  it('returns true when item contains frozen', () => {
    expect(detectFrozenIngredients([ing('frozen salmon fillets')])).toBe(true)
  })
  it('returns false when no item contains frozen', () => {
    expect(detectFrozenIngredients([ing('salmon fillets')])).toBe(false)
  })
  it('is case-insensitive', () => {
    expect(detectFrozenIngredients([ing('Frozen Ground Beef')])).toBe(true)
  })
  it('does NOT flag ingredients whose section is frozen — only checks item field', () => {
    const ingWithFrozenSection: Ingredient = { item: 'peas', quantity: '1 cup', section: 'frozen' }
    expect(detectFrozenIngredients([ingWithFrozenSection])).toBe(false)
  })
  it('returns true when only one of several items is frozen', () => {
    expect(detectFrozenIngredients([ing('peas'), ing('frozen corn')])).toBe(true)
  })
})
