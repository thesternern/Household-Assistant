import { and, asc, eq, gt, lt, sql } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { audit } from '../audit/log.js'
import { getDb, schema } from '../db/client.js'
import type { PolicyCategory } from '../db/schema.js'
import { logger } from '../logger.js'
import { bareName } from '../tools/types.js'
import type { ToolContext } from '../tools/types.js'

export type PendingRow = typeof schema.pendingActions.$inferSelect

/** How long an approval card stays actionable when the caller does not say. */
const DEFAULT_EXPIRY_MINUTES = 30
const MIN_EXPIRY_MINUTES = 1
const MAX_EXPIRY_MINUTES = 60 * 24 * 7

const log = logger.child({ mod: 'pending' })

/** `now()` evaluated by Postgres, so expiry never depends on app-server clock skew. */
const dbNow = () => sql`now()`

/**
 * Coerce an arbitrary value into something a `jsonb` column accepts.
 * Never throws: a result we cannot serialise is still worth recording.
 */
function toJsonValue(value: unknown): unknown {
  if (value === undefined) return null
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) return null
    return JSON.parse(encoded) as unknown
  } catch {
    return { unserializable: String(value) }
  }
}

export async function createPendingAction(input: {
  toolName: string
  args: Record<string, unknown>
  category: PolicyCategory
  humanSummary: string
  ctx: ToolContext
  /** Default 30. */
  expiresInMinutes?: number
}): Promise<{ id: number }> {
  const requested = input.expiresInMinutes ?? DEFAULT_EXPIRY_MINUTES
  const minutes = Number.isFinite(requested)
    ? Math.min(MAX_EXPIRY_MINUTES, Math.max(MIN_EXPIRY_MINUTES, Math.round(requested)))
    : DEFAULT_EXPIRY_MINUTES
  const expiresAt = DateTime.now().plus({ minutes }).toJSDate()
  const tool = bareName(input.toolName)

  const inserted = await getDb()
    .insert(schema.pendingActions)
    .values({
      toolName: tool,
      // Stored byte-for-byte. The executor replays exactly this object.
      argsJson: input.args,
      category: input.category,
      humanSummary: input.humanSummary,
      status: 'pending',
      requestedBy: input.ctx.actor,
      telegramChatId: input.ctx.chatId || null,
      conversationId: input.ctx.conversationId ?? null,
      agentSessionId: input.ctx.agentSessionId ?? null,
      origin: input.ctx.origin,
      expiresAt,
    })
    .returning({ id: schema.pendingActions.id })

  const row = inserted[0]
  if (!row) throw new Error(`failed to create pending action for ${tool}`)

  log.info({ pendingActionId: row.id, tool, category: input.category }, 'pending action created')
  await audit({
    actor: input.ctx.actor,
    event: 'action.pending',
    category: input.category,
    toolName: tool,
    args: input.args,
    resultSummary: input.humanSummary,
    ok: true,
    pendingActionId: row.id,
  })

  return { id: row.id }
}

/**
 * Atomic `pending` -> `approved`.
 * Returns null when the row was already resolved or has expired, so a second
 * tap on the same Telegram button is a no-op rather than a second execution.
 */
export async function approvePending(id: number, actor: string): Promise<PendingRow | null> {
  return resolvePending(id, actor, 'approved')
}

/** Atomic `pending` -> `rejected`. Returns null if it was already resolved. */
export async function rejectPending(id: number, actor: string): Promise<PendingRow | null> {
  return resolvePending(id, actor, 'rejected')
}

/**
 * Atomic `approved` -> `executed`. The executor MUST call this before it runs a
 * handler: it is the only thing standing between a duplicated pg-boss delivery
 * and a second real email, phone call, or charge. Returns null when another
 * worker already holds the row.
 *
 * Claiming by moving straight to `executed` is deliberate. `markExecuted` walks
 * it back to `failed` if the handler reports one; if the process dies mid-call
 * the row stays `executed` with no result, which is the fail-safe direction for
 * a side effect that may already have happened. `hasApprovedAction` accepts
 * `executed` for exactly this reason, so a handler's own defence-in-depth check
 * still passes while it runs under this claim.
 */
export async function claimForExecution(id: number): Promise<PendingRow | null> {
  if (!Number.isInteger(id)) return null
  const claimed = await getDb()
    .update(schema.pendingActions)
    .set({ status: 'executed' })
    .where(and(eq(schema.pendingActions.id, id), eq(schema.pendingActions.status, 'approved')))
    .returning()

  const row = claimed[0]
  if (!row) {
    log.info({ pendingActionId: id }, 'pending action not claimable for execution')
    return null
  }
  log.info({ pendingActionId: id, tool: row.toolName }, 'claimed approved action')
  return row
}

async function resolvePending(
  id: number,
  actor: string,
  status: 'approved' | 'rejected',
): Promise<PendingRow | null> {
  if (!Number.isInteger(id)) {
    log.warn({ pendingActionId: id, status }, 'ignoring non-integer pending action id')
    return null
  }
  const updated = await getDb()
    .update(schema.pendingActions)
    .set({ status, resolvedBy: actor, resolvedAt: new Date() })
    .where(
      and(
        eq(schema.pendingActions.id, id),
        eq(schema.pendingActions.status, 'pending'),
        gt(schema.pendingActions.expiresAt, dbNow()),
      ),
    )
    .returning()

  const row = updated[0]
  if (!row) {
    log.info({ pendingActionId: id, actor, status }, 'pending action already resolved or expired')
    return null
  }

  log.info({ pendingActionId: id, actor, status, tool: row.toolName }, 'pending action resolved')
  await audit({
    actor,
    event: status === 'approved' ? 'action.approved' : 'action.rejected',
    category: row.category,
    toolName: row.toolName,
    args: row.argsJson,
    resultSummary: row.humanSummary,
    ok: true,
    pendingActionId: row.id,
  })

  return row
}

/** Flips every still-pending row past its `expires_at` to `expired`. Returns the count. */
export async function expireStale(): Promise<number> {
  const expired = await getDb()
    .update(schema.pendingActions)
    .set({ status: 'expired', resolvedAt: new Date() })
    .where(
      and(
        eq(schema.pendingActions.status, 'pending'),
        lt(schema.pendingActions.expiresAt, dbNow()),
      ),
    )
    .returning({
      id: schema.pendingActions.id,
      toolName: schema.pendingActions.toolName,
      category: schema.pendingActions.category,
      humanSummary: schema.pendingActions.humanSummary,
    })

  for (const row of expired) {
    await audit({
      actor: 'system',
      event: 'action.expired',
      category: row.category,
      toolName: row.toolName,
      resultSummary: row.humanSummary,
      ok: true,
      pendingActionId: row.id,
    })
  }

  if (expired.length > 0) log.info({ count: expired.length }, 'expired stale pending actions')
  return expired.length
}

/** Still-actionable approvals, oldest first. */
export async function listPending(): Promise<PendingRow[]> {
  return getDb()
    .select()
    .from(schema.pendingActions)
    .where(
      and(
        eq(schema.pendingActions.status, 'pending'),
        gt(schema.pendingActions.expiresAt, dbNow()),
      ),
    )
    .orderBy(asc(schema.pendingActions.createdAt))
}

export async function getPending(id: number): Promise<PendingRow | undefined> {
  if (!Number.isInteger(id)) return undefined
  const rows = await getDb()
    .select()
    .from(schema.pendingActions)
    .where(eq(schema.pendingActions.id, id))
    .limit(1)
  return rows[0]
}

/** Records the outcome of a replay. `ok` decides `executed` vs `failed`. */
export async function markExecuted(id: number, result: unknown, ok: boolean): Promise<void> {
  if (!Number.isInteger(id)) {
    log.warn({ pendingActionId: id }, 'ignoring markExecuted for a non-integer id')
    return
  }
  await getDb()
    .update(schema.pendingActions)
    .set({ status: ok ? 'executed' : 'failed', executionResult: toJsonValue(result) })
    .where(eq(schema.pendingActions.id, id))
}

/**
 * Defence in depth for consequential handlers: true only when the row exists,
 * names this tool, and a human actually approved it.
 */
export async function hasApprovedAction(
  id: number | undefined,
  toolName: string,
): Promise<boolean> {
  if (id === undefined || id === null || !Number.isInteger(id)) return false
  const row = await getPending(id)
  if (!row) return false
  if (bareName(row.toolName) !== bareName(toolName)) return false
  return row.status === 'approved' || row.status === 'executed'
}
