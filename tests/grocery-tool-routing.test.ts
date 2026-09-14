/**
 * Which tool answers "the grocery list" — as the orchestrator sees it.
 *
 * Every chat turn runs in the orchestrator itself. It always did: the chef
 * subagent that carried the shopping-list rule was never spawned in the whole
 * history of the audit log, and the router that would have sent a meal message
 * to the mealprep playbook was never called by anything. Both have since been
 * deleted and their rules moved into the standing brief. What the orchestrator
 * reads at the moment it picks a tool is that brief plus a list of deferred
 * tool NAMES; a description arrives only after a ToolSearch by name.
 *
 * So on 2026-09-07 "Yes" to "want me to generate the grocery list?" became
 * `ToolSearch select:grocery_list_generate`, one call, and the aisle list
 * pasted into the chat — reflowed, with no buttons — after every `mealplan_*`
 * result that turn had told the model to "call grocery_list_generate again".
 * `grocery_list_offer` had never been called, by anything, ever.
 *
 * Three things have to hold for the buttons to arrive:
 *  1. the standing brief names grocery_list_offer as the shopping-list tool;
 *  2. the two grocery tools are never deferred, so their descriptions are in
 *     front of the model before it chooses;
 *  3. nothing the orchestrator reads points it at grocery_list_generate for an
 *     unqualified "the list" — not a description, not a tool result.
 */
import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../src/db/schema.js'

/* ─────────────────────────── the fake database ───────────────────────────── */

type Row = Record<string, unknown>
type AnyTable = Parameters<typeof getTableName>[0]

const tables: Record<string, Row[]> = { households: [], users: [], rules: [] }

function rowsFor(table: AnyTable): Row[] {
  return tables[getTableName(table)] ?? []
}

// biome-ignore lint/suspicious/noExplicitAny: a query-builder stand-in is structurally any
function chain(data: Row[]): any {
  // biome-ignore lint/suspicious/noExplicitAny: same
  const self: any = {
    from: (t: AnyTable) => chain(rowsFor(t)),
    where: () => self,
    orderBy: () => self,
    limit: (n: number) => chain(data.slice(0, n)),
    then: (resolve: (v: Row[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(data).then(resolve, reject),
  }
  return self
}

const db = { select: () => chain([]) }

const H = vi.hoisted(() => ({
  /** Every household tool handed to the SDK, with the extras it was given. */
  registered: [] as Array<{ name: string; extras: Record<string, unknown> | undefined }>,
}))

vi.mock('../src/config.js', () => ({
  getConfig: () => ({ HOUSEHOLD_TIMEZONE: 'America/Vancouver' }),
}))

vi.mock('../src/db/client.js', async () => {
  const realSchema = await vi.importActual<typeof import('../src/db/schema.js')>(
    '../src/db/schema.js',
  )
  return { getDb: () => db, getPool: () => ({}), closeDb: async () => {}, schema: realSchema }
})

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const l: Record<string, unknown> = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  }
  l.child = () => l
  return { logger: l, child: () => l }
})

vi.mock('../src/policy/pending.js', () => ({ listPending: async () => [] }))

/**
 * The real `tool()` folds `alwaysLoad` into `_meta` and the real server hides
 * it inside an McpServer instance, so record what the registry *asked for*.
 */
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return {
    ...real,
    tool: (
      name: string,
      description: string,
      inputSchema: unknown,
      handler: unknown,
      extras?: Record<string, unknown>,
    ) => {
      H.registered.push({ name, extras })
      return { name, description, inputSchema, handler }
    },
    createSdkMcpServer: (cfg: { name: string }) => ({ type: 'sdk', name: cfg.name, instance: {} }),
  }
})

const { buildSystemPrompt } = await import('../src/agent/orchestrator.js')
const { allTools, buildHouseholdMcpServer } = await import('../src/tools/registry.js')
const { recipeTools } = await import('../src/tools/recipes.js')

beforeEach(() => {
  tables.households = [
    {
      id: 1,
      name: 'the Smith household',
      timezone: 'America/Vancouver',
      assistantName: 'Chessy',
      quietHoursStart: 21,
      quietHoursEnd: 7,
      briefHour: 7,
    },
  ]
  tables.users = [{ displayName: 'Alex', isPrimary: true }]
  tables.rules = []
  H.registered.length = 0
})

/* ─────────────────────────── 1. the standing brief ───────────────────────── */

describe('the standing brief settles which tool the shopping list is', () => {
  it('names grocery_list_offer as the answer to "the grocery list"', async () => {
    const prompt = await buildSystemPrompt({ actor: 'Alex' })

    expect(prompt).toContain('grocery_list_offer')
    expect(prompt).toMatch(/grocery list.*grocery_list_offer|grocery_list_offer.*grocery list/is)
  })

  it('confines grocery_list_generate to the in-store list asked for by name', async () => {
    const prompt = await buildSystemPrompt({ actor: 'Alex' })

    expect(prompt).toContain('grocery_list_generate')
    expect(prompt).toMatch(/grocery_list_generate[^\n]*in-store/i)
  })

  it('forbids retyping a shopping list in its own words', async () => {
    const prompt = await buildSystemPrompt({ actor: 'Alex' })

    expect(prompt).toMatch(/never retype/i)
  })
})

/* ──────────────────────── 2. never behind tool search ────────────────────── */

describe('the grocery tools are never deferred', () => {
  it('marks both grocery tools alwaysLoad in the registry', () => {
    const byName = new Map(allTools().map((t) => [t.name, t]))

    expect(byName.get('grocery_list_offer')?.alwaysLoad).toBe(true)
    expect(byName.get('grocery_list_generate')?.alwaysLoad).toBe(true)
  })

  it('hands alwaysLoad to the SDK for exactly the tools that ask for it', () => {
    buildHouseholdMcpServer({ chatId: '1', actor: 'Alex', origin: 'agent' })

    const loaded = H.registered.filter((r) => r.extras?.['alwaysLoad'] === true).map((r) => r.name)
    expect(loaded).toContain('grocery_list_offer')
    expect(loaded).toContain('grocery_list_generate')

    // The whole point of deferral is a short prompt; a flag that leaks onto
    // every tool would silently undo it.
    const flagged = allTools().filter((t) => t.alwaysLoad === true).map((t) => t.name)
    expect(loaded.sort()).toEqual(flagged.sort())
    expect(flagged.length).toBeLessThan(allTools().length / 4)
  })
})

/* ─────────────────── 3. nothing points at the wrong tool ─────────────────── */

describe('no recipe tool sends the model to grocery_list_generate for "the list"', () => {
  it.each(['mealplan_add_item', 'mealplan_remove_item', 'grocery_list_to_todos'])(
    '%s does not name grocery_list_generate in its description',
    (name) => {
      const def = recipeTools.find((t) => t.name === name)
      if (!def) throw new Error(`${name} is not registered`)

      expect(def.description).not.toContain('grocery_list_generate')
    },
  )

  it('every recipe tool that mentions the shopping list points at grocery_list_offer', () => {
    for (const def of recipeTools) {
      if (def.name.startsWith('grocery_')) continue
      if (!/grocery list|shopping list/i.test(def.description)) continue

      expect(def.description, def.name).toContain('grocery_list_offer')
    }
  })
})
