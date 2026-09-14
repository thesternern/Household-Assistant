import { describe, expect, it } from 'vitest'
import { contacts } from '../src/db/schema.js'

/**
 * The two columns Phase 1 adds. A guardrail that depends on `household` is
 * only as good as the column being there, so its absence should fail loudly
 * rather than surface later as "the block just did not apply to Sam".
 */
describe('contacts schema', () => {
  it('has a birthday column', () => {
    expect(contacts.birthday).toBeDefined()
    expect(contacts.birthday.name).toBe('birthday')
  })

  it('has a household column that defaults to false and is not null', () => {
    expect(contacts.household).toBeDefined()
    expect(contacts.household.name).toBe('household')
    expect(contacts.household.notNull).toBe(true)
    expect(contacts.household.default).toBe(false)
  })
})
