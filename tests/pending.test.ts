import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakePendingDb } from './helpers/pending-fake-db.js'
import type { ToolContext } from '../src/tools/types.js'

const { dbRef, auditMock } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  auditMock: vi.fn(async () => {}),
}))

vi.mock('../src/db/client.js', async () => {
  const schema = await import('../src/db/schema.js')
  return { getDb: () => dbRef.current, schema }
})
vi.mock('../src/audit/log.js', () => ({ audit: auditMock }))
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

const {
  createPendingAction,
  approvePending,
  rejectPending,
  claimForExecution,
  expireStale,
  listPending,
  getPending,
  markExecuted,
  hasApprovedAction,
} = await import('../src/policy/pending.js')

let fake: FakePendingDb

const ctx: ToolContext = {
  chatId: '4242',
  actor: 'Alex',
  origin: 'agent',
  conversationId: 7,
  agentSessionId: 'sess-1',
}

async function makePending(over: Partial<{ toolName: string; humanSummary: string }> = {}) {
  return createPendingAction({
    toolName: over.toolName ?? 'email_send',
    args: { to: 'a@b.com', subject: 'Hi' },
    category: 'email_send',
    humanSummary: over.humanSummary ?? 'Send an email to a@b.com',
    ctx,
  })
}

beforeEach(() => {
  fake = new FakePendingDb()
  dbRef.current = fake
  auditMock.mockClear()
})

describe('createPendingAction', () => {
  it('stores the args verbatim and starts life as pending', async () => {
    const { id } = await makePending()
    const row = fake.find(id)

    expect(row).toBeDefined()
    expect(row?.status).toBe('pending')
    expect(row?.toolName).toBe('email_send')
    expect(row?.argsJson).toStrictEqual({ to: 'a@b.com', subject: 'Hi' })
    expect(row?.requestedBy).toBe('Alex')
    expect(row?.origin).toBe('agent')
    expect(row?.telegramChatId).toBe('4242')
    expect(row?.conversationId).toBe(7)
    expect(row?.agentSessionId).toBe('sess-1')
  })

  it('normalises a qualified tool name to its bare form', async () => {
    const { id } = await makePending({ toolName: 'mcp__household__email_send' })
    expect(fake.find(id)?.toolName).toBe('email_send')
  })

  it('defaults the expiry to 30 minutes out', async () => {
    const before = Date.now()
    const { id } = await makePending()
    const expiresAt = fake.find(id)?.expiresAt as Date
    const minutes = (expiresAt.getTime() - before) / 60_000
    expect(minutes).toBeGreaterThan(29)
    expect(minutes).toBeLessThanOrEqual(30.5)
  })

  it('honours an explicit expiry window', async () => {
    const before = Date.now()
    const { id } = await createPendingAction({
      toolName: 'purchase_item',
      args: {},
      category: 'purchase',
      humanSummary: 'Buy nappies',
      ctx,
      expiresInMinutes: 5,
    })
    const expiresAt = fake.find(id)?.expiresAt as Date
    expect((expiresAt.getTime() - before) / 60_000).toBeLessThanOrEqual(5.5)
  })

  it('writes an audit row', async () => {
    const { id } = await makePending()
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'action.pending', pendingActionId: id, actor: 'Alex' }),
    )
  })
})

describe('approvePending', () => {
  it('flips pending to approved and returns the row', async () => {
    const { id } = await makePending()
    const row = await approvePending(id, 'Robin')

    expect(row).not.toBeNull()
    expect(row?.status).toBe('approved')
    expect(row?.resolvedBy).toBe('Robin')
    expect(row?.resolvedAt).toBeInstanceOf(Date)
    expect(fake.find(id)?.status).toBe('approved')
  })

  it('guards on status and expiry in a single statement', async () => {
    const { id } = await makePending()
    await approvePending(id, 'Robin')

    const update = fake.statements.find((s) => s.kind === 'update')
    expect(update).toBeDefined()
    expect(update?.sql).toContain('"pending_actions"."id" = $')
    expect(update?.sql).toContain('"pending_actions"."status" = $')
    expect(update?.sql).toContain('"pending_actions"."expires_at" > now()')
    expect(update?.params).toContain('pending')
    // One statement, not a read-then-write.
    expect(fake.statements.filter((s) => s.kind !== 'insert')).toHaveLength(1)
  })

  it('is double-tap safe: the second approve is a no-op', async () => {
    const { id } = await makePending()

    const first = await approvePending(id, 'Robin')
    const second = await approvePending(id, 'Robin')

    expect(first?.status).toBe('approved')
    expect(second).toBeNull()
    expect(fake.find(id)?.resolvedBy).toBe('Robin')
  })

  it('is safe under a concurrent double tap', async () => {
    const { id } = await makePending()

    const [a, b] = await Promise.all([approvePending(id, 'Robin'), approvePending(id, 'Alex')])
    const winners = [a, b].filter((r) => r !== null)

    expect(winners).toHaveLength(1)
  })

  it('cannot approve a rejected action', async () => {
    const { id } = await makePending()
    expect(await rejectPending(id, 'Robin')).not.toBeNull()
    expect(await approvePending(id, 'Alex')).toBeNull()
    expect(fake.find(id)?.status).toBe('rejected')
  })

  it('cannot approve an expired action', async () => {
    const { id } = await makePending()
    const row = fake.find(id)
    if (row) row.expiresAt = new Date(Date.now() - 1_000)

    expect(await approvePending(id, 'Robin')).toBeNull()
    expect(fake.find(id)?.status).toBe('pending')
  })

  it('returns null for an id that does not exist', async () => {
    expect(await approvePending(9999, 'Robin')).toBeNull()
  })

  it('audits the approval', async () => {
    const { id } = await makePending()
    auditMock.mockClear()
    await approvePending(id, 'Robin')
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'action.approved', pendingActionId: id, actor: 'Robin' }),
    )
  })
})

describe('rejectPending', () => {
  it('flips pending to rejected once', async () => {
    const { id } = await makePending()

    const first = await rejectPending(id, 'Robin')
    const second = await rejectPending(id, 'Robin')

    expect(first?.status).toBe('rejected')
    expect(second).toBeNull()
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'action.rejected', pendingActionId: id }),
    )
  })
})

describe('expireStale', () => {
  it('expires only pending rows past their deadline', async () => {
    const stale = fake.seed({ status: 'pending', expiresAt: new Date(Date.now() - 60_000) })
    const fresh = fake.seed({ status: 'pending', expiresAt: new Date(Date.now() + 60_000) })
    const approved = fake.seed({ status: 'approved', expiresAt: new Date(Date.now() - 60_000) })

    const count = await expireStale()

    expect(count).toBe(1)
    expect(fake.find(stale.id as number)?.status).toBe('expired')
    expect(fake.find(fresh.id as number)?.status).toBe('pending')
    expect(fake.find(approved.id as number)?.status).toBe('approved')
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'action.expired', pendingActionId: stale.id }),
    )
  })

  it('returns 0 when nothing is stale', async () => {
    fake.seed({ status: 'pending', expiresAt: new Date(Date.now() + 60_000) })
    expect(await expireStale()).toBe(0)
  })
})

describe('listPending', () => {
  it('lists only live pending rows, oldest first', async () => {
    const older = fake.seed({
      status: 'pending',
      humanSummary: 'older',
      createdAt: new Date(Date.now() - 10_000),
    })
    const newer = fake.seed({
      status: 'pending',
      humanSummary: 'newer',
      createdAt: new Date(Date.now() - 1_000),
    })
    fake.seed({ status: 'pending', expiresAt: new Date(Date.now() - 1) })
    fake.seed({ status: 'approved' })

    const rows = await listPending()

    expect(rows.map((r) => r.id)).toStrictEqual([older.id, newer.id])
  })
})

describe('getPending', () => {
  it('returns the row or undefined', async () => {
    const { id } = await makePending()
    expect((await getPending(id))?.id).toBe(id)
    expect(await getPending(9999)).toBeUndefined()
    expect(await getPending(Number.NaN)).toBeUndefined()
  })
})

describe('claimForExecution', () => {
  it('claims an approved row exactly once', async () => {
    const { id } = await makePending()
    await approvePending(id, 'Robin')

    const first = await claimForExecution(id)
    const second = await claimForExecution(id)

    expect(first?.id).toBe(id)
    expect(second).toBeNull()
    expect(fake.find(id)?.status).toBe('executed')
  })

  it('claims in one statement guarded on the approved status', async () => {
    const { id } = await makePending()
    await approvePending(id, 'Robin')
    fake.statements.length = 0

    await claimForExecution(id)

    const [claim, ...rest] = fake.statements
    expect(rest).toHaveLength(0)
    expect(claim?.kind).toBe('update')
    expect(claim?.sql).toContain('"pending_actions"."status" = $')
    expect(claim?.params).toContain('approved')
  })

  it('refuses a pending, rejected, expired, or missing row', async () => {
    const { id } = await makePending()
    expect(await claimForExecution(id)).toBeNull() // never approved
    expect(fake.find(id)?.status).toBe('pending')

    const rejected = fake.seed({ status: 'rejected' })
    expect(await claimForExecution(rejected.id as number)).toBeNull()

    const expired = fake.seed({ status: 'expired' })
    expect(await claimForExecution(expired.id as number)).toBeNull()

    expect(await claimForExecution(9999)).toBeNull()
    expect(await claimForExecution(Number.NaN)).toBeNull()
  })

  it('lets a handler still see the approval while it runs', async () => {
    const { id } = await makePending()
    await approvePending(id, 'Robin')
    await claimForExecution(id)
    // hasApprovedAction must accept the claimed row, or every consequential
    // handler's defence-in-depth check would fail mid-execution.
    expect(await hasApprovedAction(id, 'email_send')).toBe(true)
  })
})

describe('id validation', () => {
  it('returns null rather than throwing on a garbage id', async () => {
    expect(await approvePending(Number.NaN, 'Robin')).toBeNull()
    expect(await rejectPending(1.5, 'Robin')).toBeNull()
    await expect(markExecuted(Number.NaN, {}, true)).resolves.toBeUndefined()
  })
})

describe('markExecuted', () => {
  it('records success and the result payload', async () => {
    const { id } = await makePending()
    await markExecuted(id, { content: [{ type: 'text', text: 'sent' }] }, true)

    const row = fake.find(id)
    expect(row?.status).toBe('executed')
    expect(row?.executionResult).toStrictEqual({ content: [{ type: 'text', text: 'sent' }] })
  })

  it('records failure and tolerates an undefined result', async () => {
    const { id } = await makePending()
    await markExecuted(id, undefined, false)

    expect(fake.find(id)?.status).toBe('failed')
    expect(fake.find(id)?.executionResult).toBeNull()
  })

  it('does not throw on an unserialisable result', async () => {
    const { id } = await makePending()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(markExecuted(id, cyclic, false)).resolves.toBeUndefined()
    expect(fake.find(id)?.status).toBe('failed')
  })
})

describe('hasApprovedAction', () => {
  it('is true only for an approved or executed row naming that tool', async () => {
    const { id } = await makePending()

    expect(await hasApprovedAction(id, 'email_send')).toBe(false) // still pending
    await approvePending(id, 'Robin')
    expect(await hasApprovedAction(id, 'email_send')).toBe(true)
    expect(await hasApprovedAction(id, 'mcp__household__email_send')).toBe(true)
    expect(await hasApprovedAction(id, 'purchase_item')).toBe(false)

    await markExecuted(id, { ok: true }, true)
    expect(await hasApprovedAction(id, 'email_send')).toBe(true)
  })

  it('is false for a missing id, a rejected row, or an expired row', async () => {
    expect(await hasApprovedAction(undefined, 'email_send')).toBe(false)
    expect(await hasApprovedAction(9999, 'email_send')).toBe(false)

    const rejected = fake.seed({ status: 'rejected', toolName: 'email_send' })
    expect(await hasApprovedAction(rejected.id as number, 'email_send')).toBe(false)

    const expired = fake.seed({ status: 'expired', toolName: 'email_send' })
    expect(await hasApprovedAction(expired.id as number, 'email_send')).toBe(false)
  })
})
