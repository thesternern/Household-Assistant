# Shopping List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One standing shopping list that ad-hoc requests, "we're out of X", and the weekly meal plan all feed, ending in a paste-ready block the household drops into Instacart's own Shopping List import.

**Architecture:** A single domain type, `ShoppingList`, sits at the seam. Producers (the standing list table, the meal plan's `GroceryListData`) map into it; a pure formatter maps it out to plain text. No provider interface, no HTTP client, no browser — the consumer today is a formatter, and an API client can replace it later without disturbing anything upstream.

**Tech Stack:** TypeScript on Node 22, Drizzle on Postgres, Zod tool schemas, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-02-shopping-list-design.md`

## Global Constraints

- **No new npm dependencies.** Everything here is plain TypeScript over what is installed.
- **Never invent a quantity.** A quantity that will not parse degrades to a named line with the original phrasing preserved. `2` from `"2 lb"` is worse than no number.
- **The paste block carries no markdown, no section headers, and no recipe provenance.** Those help a person and confuse a store's matcher.
- **`MAX_PASTE_ITEMS = 200`**, matching Instacart's documented paste limit. Over that, split into multiple blocks — never truncate.
- **`shopping_order` is category `read`.** It spends nothing, commits nothing, and contacts nobody. Follows the precedent in `docs/AMAZON.md` for cart-and-handoff.
- **The meal planner is not modified.** `src/workflows/mealprep.ts` and `grocery_list_generate` keep working exactly as they do; the fold-in happens on the shopping side.
- Existing suite must stay green: `npm test` is 899 tests across 57 files at the time of writing.

---

### Task 1: The shopping list type and the grocery-list mapper

**Files:**
- Create: `src/shopping/list.ts`
- Test: `tests/shopping-list-mapper.test.ts`

**Interfaces:**
- Consumes: `GroceryItem`, `GroceryListData` from `src/recipes/types.ts`; `parseIngredient` from `src/recipes/grocery/parser.ts`
- Produces:
  - `interface ShoppingLine { name: string; quantity?: number; unit?: string; displayText?: string; note?: string }`
  - `interface ShoppingList { title: string; lines: ShoppingLine[] }`
  - `function lineFromGroceryItem(item: GroceryItem): ShoppingLine`
  - `function groceryDataToLines(data: GroceryListData): ShoppingLine[]`

- [ ] **Step 1: Write the failing test**

Create `tests/shopping-list-mapper.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shopping-list-mapper.test.ts`
Expected: FAIL with `Cannot find module '../src/shopping/list.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/shopping/list.ts`:

```typescript
/**
 * The shopping list, and the one type at the seam.
 *
 * Producers map into `ShoppingList`; consumers map out of it. The seam is
 * deliberately the list rather than a provider interface: Amazon's flow is
 * "pick this product from these search results" and a grocery service's is
 * "here are names, you match them". Forcing both through one interface gives
 * an Amazon-shaped interface with the other faking half of it. What they
 * genuinely share is the ending — a list a human turns into a shop.
 */
import { parseIngredient } from '../recipes/grocery/parser.js'
import type { GroceryItem, GroceryListData } from '../recipes/types.js'

export interface ShoppingLine {
  /** What a store matches on. Never carries provenance or a quantity. */
  name: string
  /** Omitted whenever the source text will not parse to a single number. */
  quantity?: number
  unit?: string
  /** The original human phrasing, kept whether or not it parsed. */
  displayText?: string
  /** Which recipe wanted it. For the household's eyes only. */
  note?: string
}

export interface ShoppingList {
  title: string
  lines: ShoppingLine[]
}

/**
 * A quantity is only structured when the whole string is one amount and unit.
 *
 * `parseIngredient` is lenient by design — it is built to rescue something from
 * a messy recipe line — so its output is checked here rather than trusted. A
 * compound like "2 lb + 3 cups" would otherwise silently become 2 lb, and the
 * household would find out at the till.
 */
function structuredQuantity(text: string): { quantity: number; unit: string } | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  // One leading number, then an optional single unit word. Anything else —
  // a '+', a range, a word like "as needed" — is not structured.
  if (!/^\d+(\.\d+)?\s*[a-z]*$/i.test(trimmed)) return null

  const parsed = parseIngredient(`${trimmed} x`)
  if (!Number.isFinite(parsed.amount) || parsed.amount <= 0) return null
  return { quantity: parsed.amount, unit: parsed.unit }
}

/** One grocery item becomes one shopping line. */
export function lineFromGroceryItem(item: GroceryItem): ShoppingLine {
  const name = item.item.trim()
  const quantityText = (item.quantity ?? '').trim()
  const line: ShoppingLine = { name }

  if (quantityText !== '') {
    line.displayText = quantityText
    const structured = structuredQuantity(quantityText)
    if (structured) {
      line.quantity = structured.quantity
      if (structured.unit !== '') line.unit = structured.unit
    }
  }

  const recipe = item.recipes?.[0]?.trim()
  if (recipe) line.note = recipe

  return line
}

/** Every section, flattened in order. Section headers do not survive. */
export function groceryDataToLines(data: GroceryListData): ShoppingLine[] {
  const lines: ShoppingLine[] = []
  for (const items of Object.values(data)) {
    for (const item of items ?? []) {
      if (item.item.trim() === '') continue
      lines.push(lineFromGroceryItem(item))
    }
  }
  return lines
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shopping-list-mapper.test.ts`
Expected: PASS, 8 tests

Then run `npm run typecheck` — expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/shopping/list.ts tests/shopping-list-mapper.test.ts
git commit -m "Map the grocery list onto one shopping-list type"
```

---

### Task 2: The paste-ready formatter

**Files:**
- Create: `src/shopping/paste.ts`
- Test: `tests/shopping-paste.test.ts`

**Interfaces:**
- Consumes: `ShoppingLine`, `ShoppingList` from `src/shopping/list.ts` (Task 1)
- Produces:
  - `const MAX_PASTE_ITEMS = 200`
  - `function formatLine(line: ShoppingLine): string`
  - `function formatPasteBlocks(list: ShoppingList): string[]`

- [ ] **Step 1: Write the failing test**

Create `tests/shopping-paste.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { MAX_PASTE_ITEMS, formatLine, formatPasteBlocks } from '../src/shopping/paste.js'
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

  it('drops a line that would be blank rather than emitting an empty row', () => {
    const blocks = formatPasteBlocks(list([{ name: '  ' }, { name: 'salt' }]))
    expect(blocks[0]).toBe('salt')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shopping-paste.test.ts`
Expected: FAIL with `Cannot find module '../src/shopping/paste.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/shopping/paste.ts`:

```typescript
/**
 * The block the household pastes into a store's list importer.
 *
 * Instacart's Shopping List takes a pasted list of up to 200 items and parses
 * them without separators. Everything that makes a list readable to a person —
 * store sections, which recipe wanted it, markdown — makes it harder for a
 * matcher, so none of it appears here. The readable version is a separate
 * message.
 */
import type { ShoppingLine, ShoppingList } from './list.js'

/** Instacart's documented paste ceiling. */
export const MAX_PASTE_ITEMS = 200

/** `2 lb chicken thighs`, or just `olive oil` when there is no number. */
export function formatLine(line: ShoppingLine): string {
  const name = line.name.trim()
  if (name === '') return ''
  if (line.quantity === undefined) return name
  const unit = line.unit?.trim()
  return unit ? `${line.quantity} ${unit} ${name}` : `${line.quantity} ${name}`
}

/**
 * One block per 200 items.
 *
 * Splitting rather than truncating matters: a silently shortened list is
 * discovered at the till, and by then the shop is done.
 */
export function formatPasteBlocks(list: ShoppingList): string[] {
  const rows = list.lines.map(formatLine).filter((row) => row !== '')
  if (rows.length === 0) return []

  const blocks: string[] = []
  for (let i = 0; i < rows.length; i += MAX_PASTE_ITEMS) {
    blocks.push(rows.slice(i, i + MAX_PASTE_ITEMS).join('\n'))
  }
  return blocks
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shopping-paste.test.ts`
Expected: PASS, 10 tests

Then `npm run typecheck` — expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/shopping/paste.ts tests/shopping-paste.test.ts
git commit -m "Format a shopping list as a block you can paste into a store"
```

---

### Task 3: The standing list table and storage

**Files:**
- Modify: `src/db/schema.ts` (append a new table after `contacts`)
- Create: `src/shopping/standing-list.ts`
- Create: migration via `npx drizzle-kit generate`
- Test: `tests/shopping-standing-list.test.ts`

**Interfaces:**
- Consumes: `ShoppingLine` from `src/shopping/list.ts` (Task 1)
- Produces:
  - `schema.shoppingListItems` table
  - `type StandingStatus = 'pending' | 'sent' | 'dropped'`
  - `type StandingItem = typeof schema.shoppingListItems.$inferSelect`
  - `function standingToLines(items: StandingItem[]): ShoppingLine[]`
  - `async function addItems(input: { names: string[]; urgent?: boolean; addedBy: string }): Promise<StandingItem[]>`
  - `async function pendingItems(): Promise<StandingItem[]>` — the urgent filter is applied by the caller, so storage stays a plain read
  - `async function markSent(ids: number[]): Promise<number>`
  - `async function setStatus(id: number, status: StandingStatus): Promise<StandingItem | undefined>`

- [ ] **Step 1: Add the table to the schema**

In `src/db/schema.ts`, after the `contacts` table definition, add:

```typescript
/**
 * The standing shopping list.
 *
 * "We're out of dish soap" and "order me coffee" are the same act — the
 * difference was only in what prompted it — so both land here. Items batch
 * until the household asks for a list, because nobody should send a shopper
 * out for one bottle of hand soap.
 */
export const shoppingListItems = pgTable(
  'shopping_list_items',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    /** Free text as the household said it: "2 lb", "a big one", "". */
    quantityText: text('quantity_text'),
    note: text('note'),
    /** pending | sent | dropped */
    status: text('status').notNull().default('pending'),
    /**
     * Skips batching. Stated out loud by the household, never inferred —
     * without an escape hatch they open the store's app instead and the
     * feature loses everything.
     */
    urgent: boolean('urgent').notNull().default(false),
    addedBy: text('added_by'),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [index('shopping_list_items_status_idx').on(t.status)],
)
```

- [ ] **Step 2: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new `drizzle/00NN_*.sql` creating `shopping_list_items` and its index.

Read the generated SQL and confirm it only creates the new table and index — it must not drop or alter anything else.

- [ ] **Step 3: Write the failing test**

Create `tests/shopping-standing-list.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The standing list's storage. The behaviour that matters is that items batch
 * until asked for, that marking them sent is what consumes them, and that a
 * sent item can be put back — because nothing reads back from the store, so
 * "sent" is a guess the household must be able to correct.
 */

const H = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  nextId: 1,
}))

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const l: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop }
  l.child = () => l
  return { logger: l, child: () => l }
})

vi.mock('../src/db/client.js', async () => {
  const schema = await import('../src/db/schema.js')
  const db = {
    insert: () => ({
      values: (vals: Array<Record<string, unknown>>) => ({
        returning: async () => {
          const stored = vals.map((v) => ({
            id: H.nextId++,
            status: 'pending',
            urgent: false,
            quantityText: null,
            note: null,
            addedBy: null,
            addedAt: new Date(),
            sentAt: null,
            ...v,
          }))
          H.rows.push(...stored)
          return stored
        },
      }),
    }),
    select: () => ({
      from: () => {
        const api = {
          where: () => api,
          orderBy: async () => H.rows.filter((r) => r.status === 'pending').map((r) => ({ ...r })),
        }
        return api
      },
    }),
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            // The fake applies to whatever the test staged in H.targetIds.
            const hit = H.rows.filter((r) => (H.targetIds as number[]).includes(r.id as number))
            for (const row of hit) Object.assign(row, vals)
            return hit.map((r) => ({ ...r }))
          },
        }),
      }),
    }),
  }
  return { getDb: () => db as unknown as never, schema }
})

// Which ids the faked `where` should match on the next update.
;(H as unknown as { targetIds: number[] }).targetIds = []

const { addItems, markSent, pendingItems, setStatus, standingToLines } = await import(
  '../src/shopping/standing-list.js'
)

beforeEach(() => {
  H.rows.length = 0
  H.nextId = 1
  ;(H as unknown as { targetIds: number[] }).targetIds = []
})

describe('addItems', () => {
  it('adds each name as its own pending item', async () => {
    const added = await addItems({ names: ['dish soap', 'coffee'], addedBy: 'Alex' })

    expect(added).toHaveLength(2)
    expect(added.map((i) => i.name)).toEqual(['dish soap', 'coffee'])
    expect(added.every((i) => i.status === 'pending')).toBe(true)
    expect(added.every((i) => i.urgent === false)).toBe(true)
  })

  it('marks urgent only when asked', async () => {
    const added = await addItems({ names: ['infant paracetamol'], urgent: true, addedBy: 'Sam' })
    expect(added[0]?.urgent).toBe(true)
  })

  it('ignores blank names', async () => {
    const added = await addItems({ names: ['  ', 'salt'], addedBy: 'Alex' })
    expect(added.map((i) => i.name)).toEqual(['salt'])
  })

  it('adds nothing when every name is blank', async () => {
    expect(await addItems({ names: ['', '   '], addedBy: 'Alex' })).toEqual([])
  })
})

describe('pendingItems', () => {
  it('returns what is waiting', async () => {
    await addItems({ names: ['dish soap', 'coffee'], addedBy: 'Alex' })
    const pending = await pendingItems()
    expect(pending.map((i) => i.name)).toEqual(['dish soap', 'coffee'])
  })
})

describe('markSent', () => {
  it('consumes the items it is given', async () => {
    const added = await addItems({ names: ['dish soap', 'coffee'], addedBy: 'Alex' })
    ;(H as unknown as { targetIds: number[] }).targetIds = added.map((i) => i.id)

    const count = await markSent(added.map((i) => i.id))

    expect(count).toBe(2)
    expect(H.rows.every((r) => r.status === 'sent')).toBe(true)
    expect(H.rows.every((r) => r.sentAt instanceof Date)).toBe(true)
    expect(await pendingItems()).toEqual([])
  })

  it('does nothing when given no ids', async () => {
    expect(await markSent([])).toBe(0)
  })
})

describe('setStatus', () => {
  it('puts a sent item back, because nothing reads back from the store', async () => {
    const added = await addItems({ names: ['dish soap'], addedBy: 'Alex' })
    const id = added[0]!.id
    ;(H as unknown as { targetIds: number[] }).targetIds = [id]

    await markSent([id])
    expect(await pendingItems()).toEqual([])

    const restored = await setStatus(id, 'pending')
    expect(restored?.status).toBe('pending')
    expect((await pendingItems()).map((i) => i.name)).toEqual(['dish soap'])
  })
})

describe('standingToLines', () => {
  it('carries a parseable quantity through and degrades the rest', () => {
    const lines = standingToLines([
      { name: 'chicken thighs', quantityText: '2 lb' },
      { name: 'olive oil', quantityText: 'a big one' },
      { name: 'salt', quantityText: null },
    ] as never)

    expect(lines[0]).toMatchObject({ name: 'chicken thighs', quantity: 2, unit: 'lb' })
    expect(lines[1]).toMatchObject({ name: 'olive oil', displayText: 'a big one' })
    expect(lines[1]?.quantity).toBeUndefined()
    expect(lines[2]).toMatchObject({ name: 'salt' })
    expect(lines[2]?.displayText).toBeUndefined()
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/shopping-standing-list.test.ts`
Expected: FAIL with `Cannot find module '../src/shopping/standing-list.js'`

- [ ] **Step 5: Write minimal implementation**

Create `src/shopping/standing-list.ts`:

```typescript
/**
 * The standing shopping list.
 *
 * Items accumulate here until the household asks for a list. That batching is
 * the point: a shopper sent out for one bottle of hand soap is a bad errand,
 * and a household that has to remember to batch will not. Urgency is the
 * escape hatch, and it has to be said out loud.
 */
import { eq, inArray } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { lineFromGroceryItem } from './list.js'
import type { ShoppingLine } from './list.js'

const log = logger.child({ mod: 'shopping/standing-list' })

export type StandingStatus = 'pending' | 'sent' | 'dropped'
export type StandingItem = typeof schema.shoppingListItems.$inferSelect

export interface AddItemsInput {
  names: string[]
  urgent?: boolean
  addedBy: string
}

/** Add each name as its own pending item. Blank names are dropped, not stored. */
export async function addItems(input: AddItemsInput): Promise<StandingItem[]> {
  const names = input.names.map((n) => n.trim()).filter((n) => n !== '')
  if (names.length === 0) return []

  const inserted = await getDb()
    .insert(schema.shoppingListItems)
    .values(
      names.map((name) => ({
        name,
        status: 'pending',
        urgent: input.urgent === true,
        addedBy: input.addedBy,
      })),
    )
    .returning()

  log.info({ count: inserted.length, urgent: input.urgent === true }, 'items added to the list')
  return inserted
}

/** What is waiting, oldest first. */
export async function pendingItems(): Promise<StandingItem[]> {
  return getDb()
    .select()
    .from(schema.shoppingListItems)
    .where(eq(schema.shoppingListItems.status, 'pending'))
    .orderBy(schema.shoppingListItems.addedAt)
}

/**
 * Consume items into a shop. Returns how many were actually moved.
 *
 * Nothing reads back from the store, so this is a guess that they were bought.
 * `setStatus(id, 'pending')` is how the household corrects it.
 */
export async function markSent(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0
  const updated = await getDb()
    .update(schema.shoppingListItems)
    .set({ status: 'sent', sentAt: new Date() })
    .where(inArray(schema.shoppingListItems.id, ids))
    .returning()
  return updated.length
}

/** Drop an item, or put a sent one back. */
export async function setStatus(
  id: number,
  status: StandingStatus,
): Promise<StandingItem | undefined> {
  const updated = await getDb()
    .update(schema.shoppingListItems)
    .set({ status, ...(status === 'pending' ? { sentAt: null } : {}) })
    .where(eq(schema.shoppingListItems.id, id))
    .returning()
  return updated[0]
}

/** Standing items as shopping lines, reusing the same quantity discipline. */
export function standingToLines(items: readonly StandingItem[]): ShoppingLine[] {
  return items.map((item) =>
    lineFromGroceryItem({
      item: item.name,
      quantity: item.quantityText ?? '',
      recipes: item.note ? [item.note] : [],
    }),
  )
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/shopping-standing-list.test.ts`
Expected: PASS, 9 tests

Then `npm run typecheck` — expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/shopping/standing-list.ts drizzle/ tests/shopping-standing-list.test.ts
git commit -m "Hold the shopping list until there is a shop worth doing"
```

---

### Task 4: The tools, and a Telegram block you can tap to copy

**Files:**
- Modify: `src/telegram/send.ts:41-47` (add `pre` to the `md` helper)
- Create: `src/tools/shopping.ts`
- Modify: `src/tools/registry.ts` (import and register `shoppingTools`)
- Test: `tests/shopping-tools.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3
- Produces: `shoppingTools: ToolDef[]` containing `shopping_add`, `shopping_list`, `shopping_remove`, `shopping_order`; and `md.pre(s: string): string`

- [ ] **Step 1: Add the pre-block helper**

In `src/telegram/send.ts`, inside the `md` object (currently lines 41–47), add after `code`:

```typescript
  /**
   * A fenced block. Telegram renders these with a tap-to-copy button on
   * mobile, which is the entire delivery mechanism for a paste-ready list.
   * Only backticks and backslashes need escaping inside a pre block.
   */
  pre: (s: string): string => `\`\`\`\n${String(s ?? '').replace(/[`\\]/g, (c) => `\\${c}`)}\n\`\`\``,
```

- [ ] **Step 2: Write the failing test**

Create `tests/shopping-tools.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The tools. The behaviour worth pinning: adding says it will batch rather
 * than producing a list, ordering consumes what it showed, and an order that
 * shows nothing consumes nothing.
 */

const H = vi.hoisted(() => ({
  pending: [] as Array<Record<string, unknown>>,
  added: [] as Array<Record<string, unknown>>,
  sentIds: [] as number[],
  statusCalls: [] as Array<{ id: number; status: string }>,
}))

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const l: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop }
  l.child = () => l
  return { logger: l, child: () => l }
})

vi.mock('../src/audit/log.js', () => ({ audit: async () => {} }))

vi.mock('../src/shopping/standing-list.js', async () => {
  const actual = await vi.importActual<typeof import('../src/shopping/standing-list.js')>(
    '../src/shopping/standing-list.js',
  )
  return {
    standingToLines: actual.standingToLines,
    addItems: async (input: { names: string[]; urgent?: boolean }) => {
      const rows = input.names
        .map((n) => n.trim())
        .filter((n) => n !== '')
        .map((name, i) => ({
          id: 100 + i,
          name,
          quantityText: null,
          note: null,
          status: 'pending',
          urgent: input.urgent === true,
        }))
      H.added.push(...rows)
      return rows
    },
    pendingItems: async () => H.pending.map((p) => ({ ...p })),
    markSent: async (ids: number[]) => {
      H.sentIds.push(...ids)
      return ids.length
    },
    setStatus: async (id: number, status: string) => {
      H.statusCalls.push({ id, status })
      return { id, name: 'dish soap', status }
    },
  }
})

vi.mock('../src/recipes/store.js', () => ({
  getPlanByWeek: async () => undefined,
  generateGroceryList: async () => ({
    weekendItems: {},
    midweekItems: {},
    hasMidweek: false,
    checkedItems: [],
  }),
}))

const { shoppingTools } = await import('../src/tools/shopping.js')

const CTX = { chatId: 'chat-1', actor: 'Alex', origin: 'agent' as const }
const tool = (name: string) => {
  const found = shoppingTools.find((t) => t.name === name)
  if (!found) throw new Error(`no tool named ${name}`)
  return found
}
const textOf = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join('\n')

beforeEach(() => {
  H.pending.length = 0
  H.added.length = 0
  H.sentIds.length = 0
  H.statusCalls.length = 0
})

describe('shopping_add', () => {
  it('says the item will go with the next shop, and produces no list', async () => {
    const out = await tool('shopping_add').handler({ items: ['hand soap'] }, CTX)

    expect(out.isError).toBeUndefined()
    expect(H.added.map((a) => a.name)).toEqual(['hand soap'])
    expect(textOf(out)).toMatch(/next shop|with the/i)
    // Batching is the point: adding must not hand back something to paste.
    expect(textOf(out)).not.toContain('```')
  })

  it('takes several items at once', async () => {
    await tool('shopping_add').handler({ items: ['coffee', 'bin bags'] }, CTX)
    expect(H.added.map((a) => a.name)).toEqual(['coffee', 'bin bags'])
  })

  it('refuses an empty request rather than storing nothing quietly', async () => {
    const out = await tool('shopping_add').handler({ items: [] }, CTX)
    expect(out.isError).toBe(true)
  })
})

describe('shopping_order', () => {
  it('produces a paste block and consumes exactly what it showed', async () => {
    H.pending.push(
      { id: 1, name: 'dish soap', quantityText: null, note: null },
      { id: 2, name: 'chicken thighs', quantityText: '2 lb', note: null },
    )

    const out = await tool('shopping_order').handler({}, CTX)
    const text = textOf(out)

    expect(text).toContain('dish soap')
    expect(text).toContain('2 lb chicken thighs')
    expect(H.sentIds).toEqual([1, 2])
  })

  it('still shows the list when ticking items off fails, and says so', async () => {
    H.pending.push({ id: 1, name: 'dish soap', quantityText: null, note: null })
    const storage = await import('../src/shopping/standing-list.js')
    vi.spyOn(storage, 'markSent').mockRejectedValue(new Error('db down'))

    const out = await tool('shopping_order').handler({}, CTX)

    expect(out.isError).toBeUndefined()
    expect(textOf(out)).toContain('dish soap')
    expect(textOf(out)).toMatch(/may be offered again/i)
  })

  it('consumes nothing when there is nothing pending', async () => {
    const out = await tool('shopping_order').handler({}, CTX)

    expect(textOf(out)).toMatch(/nothing on the list/i)
    expect(H.sentIds).toEqual([])
  })
})

describe('shopping_remove', () => {
  it('drops an item', async () => {
    await tool('shopping_remove').handler({ id: 7 }, CTX)
    expect(H.statusCalls).toEqual([{ id: 7, status: 'dropped' }])
  })

  it('puts a sent item back', async () => {
    await tool('shopping_remove').handler({ id: 7, restore: true }, CTX)
    expect(H.statusCalls).toEqual([{ id: 7, status: 'pending' }])
  })
})

describe('categories', () => {
  it('never reaches purchase — nothing here can spend money', () => {
    for (const t of shoppingTools) {
      expect(t.category).not.toBe('purchase')
    }
    expect(tool('shopping_order').category).toBe('read')
    expect(tool('shopping_list').category).toBe('read')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/shopping-tools.test.ts`
Expected: FAIL with `Cannot find module '../src/tools/shopping.js'`

- [ ] **Step 4: Write minimal implementation**

Create `src/tools/shopping.ts`:

```typescript
/**
 * The shopping list tools.
 *
 * Nothing here spends money, contacts anyone, or leaves the building. The list
 * is text this household already owns, and `shopping_order` turns it into more
 * text. That is why it is `read` — the same reasoning `docs/AMAZON.md` gives
 * for cart-and-handoff running ungated.
 */
import { z } from 'zod'
import { audit } from '../audit/log.js'
import { logger } from '../logger.js'
import { groceryDataToLines } from '../shopping/list.js'
import type { ShoppingLine } from '../shopping/list.js'
import { formatPasteBlocks } from '../shopping/paste.js'
import { addItems, markSent, pendingItems, setStatus, standingToLines } from '../shopping/standing-list.js'
import { fail, ok } from './types.js'
import type { ToolDef } from './types.js'

const log = logger.child({ mod: 'tools/shopping' })

const addShape = {
  items: z
    .array(z.string().trim().min(1).max(200))
    .min(1)
    .max(50)
    .describe('The things to add. One entry per item, as the household said it.'),
  urgent: z
    .boolean()
    .optional()
    .describe(
      'Only when the household actually said it is needed today. Urgent items skip the batching ' +
        'and can be ordered on their own; everything else waits for the next shop.',
    ),
}

const removeShape = {
  id: z.coerce.number().int().positive().describe('The item id, from shopping_list.'),
  restore: z
    .boolean()
    .optional()
    .describe('True to put a sent item back on the list, when it did not make it into the shop.'),
}

const shoppingAdd: ToolDef = {
  name: 'shopping_add',
  description:
    'Add one or more things to the household shopping list. Use this for "we are out of X" and for ' +
    '"order me Y" alike — both wait for the next shop rather than going out on their own. Say so ' +
    'plainly: the household is told it will go with the next shop, not handed a list.',
  schema: addShape,
  category: 'todo_write',
  consequential: false,
  summarize: (args) => {
    const items = Array.isArray(args.items) ? args.items : []
    return `Add ${items.length} item${items.length === 1 ? '' : 's'} to the shopping list`
  },
  handler: async (args, ctx) => {
    const parsed = z.object(addShape).safeParse(args)
    if (!parsed.success) return fail('shopping_add: tell me what to add.')

    const added = await addItems({
      names: parsed.data.items,
      ...(parsed.data.urgent === undefined ? {} : { urgent: parsed.data.urgent }),
      addedBy: ctx.actor,
    })
    if (added.length === 0) return fail('shopping_add: nothing in that was an item I could add.')

    await audit({
      actor: ctx.actor,
      event: 'shopping.added',
      category: 'todo_write',
      toolName: 'shopping_add',
      args: { items: parsed.data.items },
      resultSummary: `added ${added.length} to the shopping list`,
      ok: true,
    })

    const names = added.map((i) => i.name).join(', ')
    return ok(
      parsed.data.urgent === true
        ? `Added ${names} and marked it urgent, so it can go on its own.`
        : `Added ${names} — it'll go with the next shop.`,
      { added: added.map((i) => ({ id: i.id, name: i.name })) },
    )
  },
}

const shoppingList: ToolDef = {
  name: 'shopping_list',
  description: 'What is waiting on the household shopping list, with the id of each item.',
  schema: {},
  category: 'read',
  consequential: false,
  readOnly: true,
  summarize: () => 'Read the shopping list',
  handler: async () => {
    const items = await pendingItems()
    if (items.length === 0) return ok('Nothing on the shopping list.')
    const lines = items.map(
      (i) => `#${i.id} ${i.name}${i.quantityText ? ` (${i.quantityText})` : ''}${i.urgent ? ' — urgent' : ''}`,
    )
    return ok(`${items.length} waiting:\n${lines.join('\n')}`, { count: items.length })
  },
}

const shoppingRemove: ToolDef = {
  name: 'shopping_remove',
  description:
    'Drop an item from the shopping list, or put a sent one back when it did not make it into the shop.',
  schema: removeShape,
  category: 'todo_write',
  consequential: false,
  summarize: (args) => `Remove item #${String(args.id ?? '?')} from the shopping list`,
  handler: async (args, ctx) => {
    const parsed = z.object(removeShape).safeParse(args)
    if (!parsed.success) return fail('shopping_remove: which item id?')

    const status = parsed.data.restore === true ? 'pending' : 'dropped'
    const row = await setStatus(parsed.data.id, status)
    if (!row) return fail(`shopping_remove: there is no item #${parsed.data.id}.`)

    await audit({
      actor: ctx.actor,
      event: 'shopping.removed',
      category: 'todo_write',
      toolName: 'shopping_remove',
      args: { id: parsed.data.id, status },
      resultSummary: `${row.name} -> ${status}`,
      ok: true,
    })

    return ok(status === 'pending' ? `Put ${row.name} back on the list.` : `Dropped ${row.name}.`)
  },
}

const orderShape = {
  urgent_only: z
    .boolean()
    .optional()
    .describe('Only the items marked urgent. Use when the household needs something today.'),
}

const shoppingOrder: ToolDef = {
  name: 'shopping_order',
  description:
    'Turn the shopping list into a block the household can paste into their grocery app. Produces the ' +
    'text and marks those items sent. Send the block to the household exactly as returned. It spends ' +
    'nothing and orders nothing — a person still does the shop.',
  schema: orderShape,
  category: 'read',
  consequential: false,
  readOnly: true,
  summarize: () => 'Build the shopping list to paste',
  handler: async (args, ctx) => {
    const parsed = z.object(orderShape).safeParse(args)
    const urgentOnly = parsed.success && parsed.data.urgent_only === true

    const items = (await pendingItems()).filter((i) => (urgentOnly ? i.urgent : true))
    const lines: ShoppingLine[] = standingToLines(items)

    if (lines.length === 0) {
      return ok(
        urgentOnly
          ? 'Nothing on the list is marked urgent.'
          : 'Nothing on the list right now.',
      )
    }

    const blocks = formatPasteBlocks({ title: 'Shopping list', lines })

    // Consume only after a block actually exists, and never let a failed
    // write swallow the list: the household has already been shown these
    // items, so a repeat next week is a far better failure than a loss.
    let consumed = true
    try {
      await markSent(items.map((i) => i.id))
    } catch (err) {
      consumed = false
      log.error({ err, items: items.length }, 'could not mark the shopping items sent')
    }
    log.info({ items: items.length, blocks: blocks.length, consumed }, 'shopping list built')

    await audit({
      actor: ctx.actor,
      event: 'shopping.ordered',
      category: 'read',
      toolName: 'shopping_order',
      args: { urgentOnly },
      resultSummary: `built a paste list of ${items.length} items`,
      ok: true,
    })

    const body = blocks.join('\n\n')
    const tail = consumed
      ? `Included ${items.length} item${items.length === 1 ? '' : 's'} — tell me if any didn't ` +
        "make it and I'll put them back."
      : `Included ${items.length} item${items.length === 1 ? '' : 's'}, but I could not tick them ` +
        'off the list, so they may be offered again next time.'
    return ok(`${body}\n\n${tail}`, {
      count: items.length,
      blocks: blocks.length,
      consumed,
    })
  },
}

export const shoppingTools: ToolDef[] = [shoppingAdd, shoppingList, shoppingRemove, shoppingOrder]
```

- [ ] **Step 5: Register the tools**

In `src/tools/registry.ts`, add the import next to the others:

```typescript
import { shoppingTools } from './shopping.js'
```

and add `shoppingTools,` to the array returned by `toolModules()`, after `recipeTools,`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/shopping-tools.test.ts`
Expected: PASS, 9 tests

Run: `npm test`
Expected: all files pass, including `tests/registry-import-order.test.ts` and `tests/workflow-registry.test.ts`.

Run: `npm run typecheck` — expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/tools/shopping.ts src/tools/registry.ts src/telegram/send.ts tests/shopping-tools.test.ts
git commit -m "Add the shopping list tools, and a block you can tap to copy"
```

---

### Task 5: Fold the week's groceries into the shop

**Files:**
- Modify: `src/tools/shopping.ts` (extend `shoppingOrder`)
- Test: `tests/shopping-tools.test.ts` (extend)

**Interfaces:**
- Consumes: `getPlanByWeek`, `generateGroceryList` from `src/recipes/store.js`; `groceryDataToLines` from Task 1
- Produces: `shopping_order` gains an optional `week` argument

The meal planner is not touched. `grocery_list_generate` keeps behaving exactly as it does; the fold-in happens here, so the planner never learns that a shopping list exists.

- [ ] **Step 1: Write the failing test**

Append to `tests/shopping-tools.test.ts`:

```typescript
describe('folding the week into the shop', () => {
  it('puts the weekend groceries and the standing list in one block', async () => {
    H.pending.push({ id: 1, name: 'dish soap', quantityText: null, note: null })

    const store = await import('../src/recipes/store.js')
    vi.spyOn(store, 'getPlanByWeek').mockResolvedValue({ id: 9 } as never)
    vi.spyOn(store, 'generateGroceryList').mockResolvedValue({
      weekendItems: { Produce: [{ item: 'onions', quantity: '3', recipes: [] }] },
      midweekItems: { Produce: [{ item: 'basil', quantity: '1 bunch', recipes: [] }] },
      hasMidweek: true,
      checkedItems: [],
    } as never)

    const out = await tool('shopping_order').handler({ week: '2026-09-07' }, CTX)
    const text = textOf(out)

    expect(text).toContain('dish soap')
    expect(text).toContain('3 onions')
    // Midweek is the freshness top-up and stays its own trip.
    expect(text).not.toContain('basil')
    // The standing items were consumed; the recipe items were never ours to consume.
    expect(H.sentIds).toEqual([1])
  })

  it('still works when there is no plan for that week', async () => {
    H.pending.push({ id: 1, name: 'dish soap', quantityText: null, note: null })

    const store = await import('../src/recipes/store.js')
    vi.spyOn(store, 'getPlanByWeek').mockResolvedValue(undefined as never)

    const out = await tool('shopping_order').handler({ week: '2026-09-07' }, CTX)
    expect(textOf(out)).toContain('dish soap')
    expect(H.sentIds).toEqual([1])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shopping-tools.test.ts -t "folding"`
Expected: FAIL — `3 onions` is not in the output, because `week` is ignored.

- [ ] **Step 3: Write minimal implementation**

In `src/tools/shopping.ts`, add to `orderShape`:

```typescript
  week: z
    .string()
    .trim()
    .optional()
    .describe(
      'A week start date (YYYY-MM-DD) to fold that week\'s weekend groceries into the same list. ' +
        'Use it when the household is doing the big shop. The midweek top-up stays its own trip.',
    ),
```

and in `shoppingOrder.handler`, after the `standingToLines` call and before the empty check, replace the `lines` construction with:

```typescript
    const lines: ShoppingLine[] = standingToLines(items)

    // The weekend shop is the big one, so that is where the standing list
    // joins. Midweek is the freshness-driven top-up and stays separate.
    if (parsed.success && parsed.data.week && !urgentOnly) {
      try {
        const { getPlanByWeek, generateGroceryList } = await import('../recipes/store.js')
        const plan = await getPlanByWeek(parsed.data.week)
        if (plan) {
          const groceries = await generateGroceryList(plan.id)
          lines.push(...groceryDataToLines(groceries.weekendItems))
        }
      } catch (err) {
        // A missing plan costs the fold-in, never the standing list.
        log.error({ err, week: parsed.data.week }, 'could not fold the week into the shop')
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/shopping-tools.test.ts`
Expected: PASS, 11 tests

Run: `npm test` — expected: all green.
Run: `npm run typecheck` — expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/tools/shopping.ts tests/shopping-tools.test.ts
git commit -m "Fold the week's groceries into the same shop"
```

---

## Verification

After Task 5, before deploying:

```bash
npm run typecheck   # no output
npm test            # all files pass
npm run build       # build ok
```

Then push. The migration runs on boot; watch for `migrations complete` in the Railway deploy log, and confirm the new deployment's `/healthz` reports the pushed commit.

Manual check in Telegram, in order:

1. `we're out of dish soap` → *"Added dish soap — it'll go with the next shop."* No list.
2. `order me coffee and bin bags` → same batching answer, three items now pending.
3. `what's on the shopping list` → three items with ids.
4. `send me the shopping list` → a tap-to-copy block of three bare lines, plus the correction offer.
5. Paste into Instacart's Shopping List on iOS and confirm it parses all three.
6. `put dish soap back on the list` → it returns to pending.
