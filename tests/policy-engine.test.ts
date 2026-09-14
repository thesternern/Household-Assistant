import { beforeEach, describe, expect, it, vi } from 'vitest'
import { POLICY_CATEGORIES, POLICY_MODES } from '../src/db/schema.js'
import type { PolicyCategory, PolicyMode } from '../src/db/schema.js'
import type { ToolContext, ToolDef, ToolOrigin } from '../src/tools/types.js'

/* ─────────────────────────────────── mocks ───────────────────────────────── */

const H = vi.hoisted(() => ({
  /** Rows the fake `select()` returns, keyed by table. */
  selectResults: {} as Record<string, Array<Record<string, unknown>>>,
  /** Every `insert()` the engine issued. */
  inserts: [] as Array<{ table: string; values: unknown; conflict: string; arg: unknown }>,
  /** Registry contents for getTool(). */
  tools: new Map<string, unknown>(),
  /** getTool() throws this when set — used for the fail-closed test. */
  registryError: null as Error | null,
  config: {
    HOUSEHOLD_TIMEZONE: 'America/Los_Angeles',
    PURCHASE_MONTHLY_CAP: 200,
  } as Record<string, unknown>,
  audits: [] as Array<Record<string, unknown>>,
}))

vi.mock('../src/config.js', () => ({ getConfig: () => H.config }))

vi.mock('../src/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return { logger, child: () => logger }
})

vi.mock('../src/audit/log.js', () => ({
  audit: async (entry: Record<string, unknown>) => {
    H.audits.push(entry)
  },
}))

vi.mock('../src/tools/registry.js', () => ({
  getTool: (name: string) => {
    if (H.registryError) throw H.registryError
    return H.tools.get(name)
  },
  allTools: () => [...H.tools.values()],
  toolNamesForCategories: () => [],
  buildHouseholdMcpServer: () => ({}),
}))

vi.mock('../src/db/client.js', async () => {
  const realSchema = await vi.importActual<typeof import('../src/db/schema.js')>(
    '../src/db/schema.js',
  )
  const nameOf = new Map<unknown, string>([
    [realSchema.policies, 'policies'],
    [realSchema.auditLog, 'auditLog'],
  ])

  const makeSelect = () => {
    let key = 'unknown'
    const builder = {
      from(table: unknown) {
        key = nameOf.get(table) ?? 'unknown'
        return builder
      },
      where: () => builder,
      limit: () => builder,
      orderBy: () => builder,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(H.selectResults[key] ?? []).then(resolve, reject),
    }
    return builder
  }

  const db = {
    select: () => makeSelect(),
    insert: (table: unknown) => ({
      values(values: unknown) {
        const name = nameOf.get(table) ?? 'unknown'
        const record = (conflict: string, arg: unknown) => {
          H.inserts.push({ table: name, values, conflict, arg })
          return Promise.resolve([])
        }
        return {
          onConflictDoNothing: (arg: unknown) => record('doNothing', arg),
          onConflictDoUpdate: (arg: unknown) => record('doUpdate', arg),
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            record('none', undefined).then(resolve, reject),
        }
      },
    }),
  }

  return {
    getDb: () => db,
    schema: realSchema,
    getPool: () => {
      throw new Error('no pool in tests')
    },
    closeDb: async () => {},
  }
})

import {
  CATEGORY_CONSEQUENTIAL,
  CATEGORY_LABELS,
  SEEDED_DEFAULTS,
  INBOUND_DENIED_CATEGORIES,
  WATCHER_ALLOWED_CATEGORIES,
} from '../src/policy/categories.js'
import {
  decide,
  getPolicyMode,
  listPolicies,
  monthlySpendUsd,
  seedPolicies,
  setPolicyMode,
} from '../src/policy/engine.js'

/* ────────────────────────────────── helpers ──────────────────────────────── */

const toolNameFor = (category: PolicyCategory): string => `t_${category}`

function registerTool(category: PolicyCategory): ToolDef {
  const def: ToolDef = {
    name: toolNameFor(category),
    description: `test tool for ${category}`,
    schema: {},
    category,
    consequential: CATEGORY_CONSEQUENTIAL[category],
    summarize: () => `does ${category}`,
    handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  }
  H.tools.set(def.name, def)
  return def
}

const ctxFor = (origin: ToolOrigin = 'agent'): ToolContext => ({
  chatId: '4242',
  actor: origin === 'agent' ? 'Alex' : 'system',
  origin,
})

/** Make getPolicyMode() answer with `mode` for whatever category it is asked about. */
function setStoredMode(category: PolicyCategory, mode: PolicyMode): void {
  H.selectResults['policies'] = [{ category, mode }]
}

/** Seed the audit rows monthlySpendUsd() reads. */
function setSpendRows(rows: Array<Record<string, unknown> | null>): void {
  H.selectResults['auditLog'] = rows.map((argsJson) => ({ argsJson }))
}

const WATCHER_OK = new Set<string>(WATCHER_ALLOWED_CATEGORIES)

/**
 * The watcher calendar path only keeps its own (cheap) policy when a watcher is
 * driving. Every other origin is asking for a plain calendar write and is
 * judged as `calendar_write`.
 */
const effectiveFor = (category: PolicyCategory, origin: ToolOrigin): PolicyCategory =>
  category === 'calendar_write_from_watcher' && origin !== 'watcher' ? 'calendar_write' : category

beforeEach(() => {
  H.selectResults = {}
  H.inserts = []
  H.audits = []
  H.registryError = null
  H.tools = new Map<string, unknown>()
  H.config = { HOUSEHOLD_TIMEZONE: 'America/Los_Angeles', PURCHASE_MONTHLY_CAP: 200 }
  for (const category of POLICY_CATEGORIES) registerTool(category)
  setSpendRows([])
})

/* ─────────────────────────────── decision table ──────────────────────────── */

describe('decide: category x mode table (agent origin)', () => {
  for (const category of POLICY_CATEGORIES) {
    for (const mode of POLICY_MODES) {
      it(`${category} at ${mode} -> ${mode === 'require_approval' ? 'require_approval' : mode}`, async () => {
        setStoredMode(category, mode)
        const result = await decide(toolNameFor(category), { amountUsd: 10 }, ctxFor('agent'))
        expect(result.decision).toBe(mode)
        expect(result.reason).toContain(CATEGORY_LABELS[effectiveFor(category, 'agent')])
      })
    }
  }

  it('falls back to the seeded default when no policy row exists', async () => {
    for (const category of POLICY_CATEGORIES) {
      H.selectResults['policies'] = []
      const result = await decide(toolNameFor(category), { amountUsd: 1 }, ctxFor('agent'))
      expect(result.decision, category).toBe(SEEDED_DEFAULTS[effectiveFor(category, 'agent')])
    }
  })

  it('denies a tool whose declared category is not a real policy category', async () => {
    H.tools.set('t_bogus', {
      name: 't_bogus',
      description: 'tool with a typo in its category',
      schema: {},
      category: 'calendar_wrte' as PolicyCategory,
      consequential: true,
      summarize: () => 'bogus',
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    })
    setStoredMode('read', 'allow')
    const result = await decide('t_bogus', {}, ctxFor('agent'))
    expect(result.decision).toBe('deny')
    expect(result.reason).toContain('unknown policy category')
  })

  it('accepts the qualified-or-bare name the registry resolves', async () => {
    H.tools.set('mcp__household__t_read', H.tools.get('t_read'))
    setStoredMode('read', 'allow')
    const result = await decide('mcp__household__t_read', {}, ctxFor('agent'))
    expect(result.decision).toBe('allow')
  })
})

/* ────────────────────────────── watcher containment ──────────────────────── */

describe('decide: watcher containment', () => {
  it('denies phone_call from a watcher even when policy says allow', async () => {
    setStoredMode('phone_call', 'allow')
    const result = await decide(toolNameFor('phone_call'), {}, ctxFor('watcher'))
    expect(result.decision).toBe('deny')
    expect(result.reason).toContain('watchers may not use')
    expect(result.reason).toContain('phone_call')
  })

  it('denies email_send from a watcher even when policy says allow', async () => {
    setStoredMode('email_send', 'allow')
    const result = await decide(toolNameFor('email_send'), {}, ctxFor('watcher'))
    expect(result.decision).toBe('deny')
    expect(result.reason).toContain('email_send')
  })

  it('denies every non-contained category from a watcher, at every mode', async () => {
    for (const category of POLICY_CATEGORIES) {
      if (WATCHER_OK.has(category)) continue
      for (const mode of POLICY_MODES) {
        setStoredMode(category, mode)
        const result = await decide(toolNameFor(category), { amountUsd: 1 }, ctxFor('watcher'))
        expect(result.decision, `${category} @ ${mode}`).toBe('deny')
      }
    }
  })

  it('lets the five contained categories through when policy allows them', async () => {
    for (const category of WATCHER_ALLOWED_CATEGORIES) {
      setStoredMode(category, 'allow')
      const result = await decide(toolNameFor(category), {}, ctxFor('watcher'))
      expect(result.decision, category).toBe('allow')
    }
  })

  it('still applies policy inside the contained set', async () => {
    setStoredMode('todo_write', 'deny')
    expect((await decide(toolNameFor('todo_write'), {}, ctxFor('watcher'))).decision).toBe('deny')

    setStoredMode('calendar_write_from_watcher', 'require_approval')
    expect(
      (await decide(toolNameFor('calendar_write_from_watcher'), {}, ctxFor('watcher'))).decision,
    ).toBe('require_approval')
  })

  it('keeps the watcher calendar path cheap for watchers only', async () => {
    // Seeded state: calendar_write_from_watcher allow, calendar_write require_approval.
    H.selectResults['policies'] = []
    const tool = toolNameFor('calendar_write_from_watcher')

    expect((await decide(tool, {}, ctxFor('watcher'))).decision).toBe('allow')

    // A prompt injection in a mail body must not reach the calendar unapproved
    // just by naming the watcher tool.
    for (const origin of ['agent', 'workflow'] as const) {
      const result = await decide(tool, {}, ctxFor(origin))
      expect(result.decision, origin).toBe('require_approval')
      expect(result.reason).toContain(CATEGORY_LABELS.calendar_write)
    }
  })

  it('contains the daycare-email escalation: watcher cannot buy or cancel', async () => {
    for (const category of ['purchase', 'booking_cancel', 'browser_task'] as const) {
      setStoredMode(category, 'allow')
      const result = await decide(toolNameFor(category), { amountUsd: 5 }, ctxFor('watcher'))
      expect(result.decision, category).toBe('deny')
    }
  })
})

/* ─────────────────────────────── inbound origin ──────────────────────────── */

describe('decide: inbound containment', () => {
  // An inbound turn is a model reading a stranger's words: an email reply, a
  // text on an open thread, a call transcript. It may look and it may propose;
  // it may not write anything later turns read back as the household's own.

  it('refuses the categories that shape later turns or spend money, whatever the policy says', async () => {
    for (const category of INBOUND_DENIED_CATEGORIES) {
      setStoredMode(category, 'allow')
      const result = await decide(toolNameFor(category), { amountUsd: 5 }, ctxFor('inbound'))
      expect(result.decision, category).toBe('deny')
      expect(result.reason).toContain('outside message')
    }
  })

  it('turns an allow-mode write into an approval card', async () => {
    for (const category of ['todo_write', 'reminder_write', 'recipe_write'] as const) {
      setStoredMode(category, 'allow')
      const result = await decide(toolNameFor(category), {}, ctxFor('inbound'))
      expect(result.decision, category).toBe('require_approval')
    }
  })

  it('still lets an inbound turn read, and lets the sms tool apply its own thread deadbolt', async () => {
    for (const category of ['read', 'sms_send'] as const) {
      setStoredMode(category, 'allow')
      const result = await decide(toolNameFor(category), {}, ctxFor('inbound'))
      expect(result.decision, category).toBe('allow')
    }
  })

  it('leaves deny and require_approval modes as they are', async () => {
    setStoredMode('email_send', 'require_approval')
    expect((await decide(toolNameFor('email_send'), {}, ctxFor('inbound'))).decision).toBe(
      'require_approval',
    )
    setStoredMode('phone_call', 'deny')
    expect((await decide(toolNameFor('phone_call'), {}, ctxFor('inbound'))).decision).toBe('deny')
  })

  it('does not give an inbound turn the cheap watcher calendar path', async () => {
    H.selectResults['policies'] = []
    const result = await decide(toolNameFor('calendar_write_from_watcher'), {}, ctxFor('inbound'))
    expect(result.decision).toBe('require_approval')
    expect(result.reason).toContain(CATEGORY_LABELS.calendar_write)
  })
})

/* ─────────────────────────────── executor origin ─────────────────────────── */

describe('decide: executor replay', () => {
  it('allows any known tool, including one whose policy is deny', async () => {
    for (const category of POLICY_CATEGORIES) {
      setStoredMode(category, 'deny')
      const result = await decide(toolNameFor(category), { amountUsd: 9_999 }, ctxFor('executor'))
      expect(result.decision, category).toBe('allow')
      expect(result.reason).toContain('executor')
    }
  })

  it('does not consult the spend cap on replay', async () => {
    setSpendRows([{ amountUsd: 1_000 }])
    setStoredMode('purchase', 'require_approval')
    const result = await decide(toolNameFor('purchase'), { amountUsd: 500 }, ctxFor('executor'))
    expect(result.decision).toBe('allow')
  })

  it('still denies an unknown tool', async () => {
    const result = await decide('t_nope', {}, ctxFor('executor'))
    expect(result).toEqual({ decision: 'deny', reason: 'unknown tool' })
  })
})

/* ──────────────────────────────── unknown tool ───────────────────────────── */

describe('decide: unknown tool', () => {
  it('denies with the exact contract reason', async () => {
    const result = await decide('does_not_exist', {}, ctxFor('agent'))
    expect(result).toEqual({ decision: 'deny', reason: 'unknown tool' })
  })

  it('denies unknown tools from a watcher too', async () => {
    const result = await decide('does_not_exist', {}, ctxFor('watcher'))
    expect(result.decision).toBe('deny')
  })
})

/* ───────────────────────────────── spend cap ─────────────────────────────── */

describe('decide: purchase monthly cap', () => {
  beforeEach(() => {
    setStoredMode('purchase', 'require_approval')
    // $150.00 already spent this month, one numeric row and one string row.
    setSpendRows([{ amountUsd: 100 }, { amountUsd: '$50.00' }])
  })

  it('allows the request that lands exactly on the cap', async () => {
    const result = await decide(toolNameFor('purchase'), { amountUsd: 50 }, ctxFor('agent'))
    expect(result.decision).toBe('require_approval')
  })

  it('allows the request just under the cap', async () => {
    const result = await decide(toolNameFor('purchase'), { amountUsd: 49.99 }, ctxFor('agent'))
    expect(result.decision).toBe('require_approval')
  })

  it('denies the request one cent over the cap, naming both numbers', async () => {
    const result = await decide(toolNameFor('purchase'), { amountUsd: 50.01 }, ctxFor('agent'))
    expect(result.decision).toBe('deny')
    expect(result.reason).toContain('$200.01')
    expect(result.reason).toContain('$200.00')
    expect(result.reason).toContain('$150.00')
  })

  it('reads alternate total keys and money-formatted strings', async () => {
    expect((await decide(toolNameFor('purchase'), { totalUsd: '$60.00' }, ctxFor('agent'))).decision).toBe('deny')
    expect((await decide(toolNameFor('purchase'), { total: '1,200' }, ctxFor('agent'))).decision).toBe('deny')
    expect((await decide(toolNameFor('purchase'), { priceUsd: 10 }, ctxFor('agent'))).decision).toBe(
      'require_approval',
    )
  })

  it('clamps a negative declared total so a credit cannot buy headroom', async () => {
    const result = await decide(toolNameFor('purchase'), { amountUsd: -500 }, ctxFor('agent'))
    expect(result.decision).toBe('require_approval')
  })

  it('denies an undeclared purchase once the month is already over cap', async () => {
    setSpendRows([{ amountUsd: 250 }])
    const result = await decide(toolNameFor('purchase'), {}, ctxFor('agent'))
    expect(result.decision).toBe('deny')
  })

  it('a deny policy still wins under the cap', async () => {
    setStoredMode('purchase', 'deny')
    const result = await decide(toolNameFor('purchase'), { amountUsd: 1 }, ctxFor('agent'))
    expect(result.decision).toBe('deny')
  })

  it('honours a different cap from config', async () => {
    H.config['PURCHASE_MONTHLY_CAP'] = 160
    expect((await decide(toolNameFor('purchase'), { amountUsd: 10 }, ctxFor('agent'))).decision).toBe(
      'require_approval',
    )
    expect((await decide(toolNameFor('purchase'), { amountUsd: 11 }, ctxFor('agent'))).decision).toBe(
      'deny',
    )
  })

  it('denies when a declared amount is present but unreadable', async () => {
    for (const args of [{ amountUsd: 'about five hundred' }, { total: {} }, { priceUsd: Number.NaN }]) {
      const result = await decide(toolNameFor('purchase'), args, ctxFor('agent'))
      expect(result.decision, JSON.stringify(args)).toBe('deny')
      expect(result.reason).toContain('could not read a dollar amount')
    }
  })

  it('treats a missing or empty amount as undeclared, not unreadable', async () => {
    setSpendRows([])
    for (const args of [{}, { amountUsd: null }, { amountUsd: '' }]) {
      const result = await decide(toolNameFor('purchase'), args, ctxFor('agent'))
      expect(result.decision, JSON.stringify(args)).toBe('require_approval')
    }
  })

  it('denies when the cap itself is misconfigured', async () => {
    for (const cap of [Number.NaN, 'lots', undefined, -5]) {
      H.config['PURCHASE_MONTHLY_CAP'] = cap
      const result = await decide(toolNameFor('purchase'), { amountUsd: 1 }, ctxFor('agent'))
      expect(result.decision, String(cap)).toBe('deny')
      expect(result.reason).toContain('misconfigured')
    }
  })

  it('leaves non-purchase categories untouched by the cap', async () => {
    setSpendRows([{ amountUsd: 10_000 }])
    setStoredMode('calendar_write', 'allow')
    const result = await decide(toolNameFor('calendar_write'), { amountUsd: 500 }, ctxFor('agent'))
    expect(result.decision).toBe('allow')
  })
})

describe('monthlySpendUsd', () => {
  it('sums amountUsd across purchase.executed rows and ignores junk', async () => {
    setSpendRows([
      { amountUsd: 12.5 },
      { amountUsd: '$7.25' },
      { amountUsd: 'not a number' },
      { somethingElse: 99 },
      null,
      { amountUsd: 0.25 },
    ])
    expect(await monthlySpendUsd()).toBe(20)
  })

  it('is zero with no rows', async () => {
    setSpendRows([])
    expect(await monthlySpendUsd()).toBe(0)
  })

  it('rounds float drift to cents', async () => {
    setSpendRows([{ amountUsd: 0.1 }, { amountUsd: 0.2 }])
    expect(await monthlySpendUsd()).toBe(0.3)
  })

  it('reads the same alternate keys the pre-check reads', async () => {
    // A purchase tool that names its field `totalUsd` must not make the cap inert.
    setSpendRows([{ totalUsd: 40 }, { total: '$10.00' }, { estimatedTotalUsd: 5 }])
    expect(await monthlySpendUsd()).toBe(55)
  })

  it('clamps a negative audited amount so a refund row cannot mint headroom', async () => {
    setSpendRows([{ amountUsd: 100 }, { amountUsd: -80 }])
    expect(await monthlySpendUsd()).toBe(100)
  })

  it('an unreadable audited amount does not reduce the total', async () => {
    setSpendRows([{ amountUsd: 30 }, { amountUsd: 'gift card' }])
    expect(await monthlySpendUsd()).toBe(30)
  })
})

/* ───────────────────────────── storage operations ────────────────────────── */

describe('seedPolicies', () => {
  it('inserts every category at its default and never overwrites', async () => {
    await seedPolicies()
    expect(H.inserts).toHaveLength(1)
    const insert = H.inserts[0]!
    expect(insert.table).toBe('policies')
    expect(insert.conflict).toBe('doNothing')

    const rows = insert.values as Array<{ category: PolicyCategory; mode: PolicyMode }>
    expect(rows).toHaveLength(POLICY_CATEGORIES.length)
    for (const row of rows) expect(row.mode).toBe(SEEDED_DEFAULTS[row.category])
    expect(rows.map((r) => r.category).sort()).toEqual([...POLICY_CATEGORIES].sort())
  })

  it('seeds the documented defaults', async () => {
    expect(SEEDED_DEFAULTS.read).toBe('allow')
    expect(SEEDED_DEFAULTS.memory_write).toBe('allow')
    expect(SEEDED_DEFAULTS.todo_write).toBe('allow')
    expect(SEEDED_DEFAULTS.reminder_write).toBe('allow')
    expect(SEEDED_DEFAULTS.recipe_write).toBe('allow')
    expect(SEEDED_DEFAULTS.calendar_write_from_watcher).toBe('allow')
    expect(SEEDED_DEFAULTS.calendar_write).toBe('require_approval')
    expect(SEEDED_DEFAULTS.email_send).toBe('require_approval')
    expect(SEEDED_DEFAULTS.phone_call).toBe('require_approval')
    expect(SEEDED_DEFAULTS.purchase).toBe('require_approval')
    expect(SEEDED_DEFAULTS.booking_cancel).toBe('require_approval')
    expect(SEEDED_DEFAULTS.browser_task).toBe('require_approval')
  })
})

describe('getPolicyMode', () => {
  it('returns the stored mode', async () => {
    setStoredMode('email_send', 'allow')
    expect(await getPolicyMode('email_send')).toBe('allow')
  })

  it('returns the default when the row is missing', async () => {
    H.selectResults['policies'] = []
    expect(await getPolicyMode('email_send')).toBe('require_approval')
  })

  it('returns the default when the stored mode is garbage', async () => {
    H.selectResults['policies'] = [{ category: 'email_send', mode: 'yolo' }]
    expect(await getPolicyMode('email_send')).toBe('require_approval')
  })
})

describe('setPolicyMode', () => {
  it('upserts and records who changed it', async () => {
    await setPolicyMode('phone_call', 'allow', 'Alex')
    const insert = H.inserts[0]!
    expect(insert.table).toBe('policies')
    expect(insert.conflict).toBe('doUpdate')
    expect(insert.values).toMatchObject({ category: 'phone_call', mode: 'allow', updatedBy: 'Alex' })
    expect(H.audits[0]).toMatchObject({ actor: 'Alex', event: 'policy.changed', category: 'phone_call' })
  })

  it('rejects an unknown mode or category without writing', async () => {
    await expect(setPolicyMode('phone_call', 'maybe' as PolicyMode, 'Alex')).rejects.toThrow()
    await expect(setPolicyMode('nope' as PolicyCategory, 'allow', 'Alex')).rejects.toThrow()
    expect(H.inserts).toHaveLength(0)
  })
})

describe('listPolicies', () => {
  it('merges stored rows over defaults and returns every category in order', async () => {
    H.selectResults['policies'] = [
      { category: 'phone_call', mode: 'deny' },
      { category: 'unknown_category', mode: 'allow' },
      { category: 'read', mode: 'sideways' },
    ]
    const list = await listPolicies()
    expect(list.map((p) => p.category)).toEqual([...POLICY_CATEGORIES])
    expect(list.find((p) => p.category === 'phone_call')?.mode).toBe('deny')
    // Garbage rows fall back to the default rather than propagating.
    expect(list.find((p) => p.category === 'read')?.mode).toBe('allow')
  })
})

/* ───────────────────────────────── fail closed ───────────────────────────── */

describe('decide: unexpected failure', () => {
  it('denies when the registry throws', async () => {
    H.registryError = new Error('registry exploded')
    const result = await decide(toolNameFor('read'), {}, ctxFor('agent'))
    expect(result.decision).toBe('deny')
    expect(result.reason).toContain('policy engine error')
  })

  it('denies when the policy read throws', async () => {
    Object.defineProperty(H.selectResults, 'policies', {
      get() {
        throw new Error('database is down')
      },
      configurable: true,
    })
    const result = await decide(toolNameFor('read'), {}, ctxFor('agent'))
    expect(result.decision).toBe('deny')
    expect(result.reason).toContain('policy engine error')
  })
})
