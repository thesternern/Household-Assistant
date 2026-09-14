import { audit } from '../audit/log.js'
import { logger } from '../logger.js'
import { claimForExecution, getPending, markExecuted } from '../policy/pending.js'
import type { PendingRow } from '../policy/pending.js'
import { getTool } from '../tools/registry.js'
import type { ToolContext, ToolDef, ToolResult } from '../tools/types.js'

const log = logger.child({ mod: 'executor' })

/** Telegram tops out at 4096 characters; leave room for the card chrome. */
const MAX_SUMMARY_CHARS = 3500

function clamp(text: string): string {
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…` : text
}

function summarizeResult(result: ToolResult, ok: boolean): string {
  const parts = Array.isArray(result?.content) ? result.content : []
  const text = parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim()
  if (text) return clamp(text)
  return ok ? 'Done.' : 'The tool reported an error.'
}

/**
 * Never throws. A `throw` from the error path itself would escape
 * `executeApprovedAction` after the side effect had already happened, and the
 * queue would retry it — so every fallback here is itself guarded.
 */
function errorMessage(err: unknown): string {
  try {
    if (err instanceof Error) return err.message || err.name
    if (typeof err === 'string') return err
    // Cyclic or BigInt-bearing throw values make JSON.stringify throw; a
    // function or symbol makes it return undefined.
    const encoded = JSON.stringify(err)
    return encoded ?? String(err)
  } catch {
    try {
      return String(err)
    } catch {
      return 'unknown error'
    }
  }
}

/** The args a human approved, handed to the handler untouched. */
function storedArgs(row: PendingRow): Record<string, unknown> | null {
  const args = row.argsJson
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
  return args as Record<string, unknown>
}

function contextFor(row: PendingRow): ToolContext {
  return {
    chatId: row.telegramChatId ?? '',
    actor: row.resolvedBy ?? row.requestedBy ?? 'system',
    origin: 'executor',
    conversationId: row.conversationId ?? undefined,
    agentSessionId: row.agentSessionId ?? undefined,
    pendingActionId: row.id,
  }
}

/**
 * Replays the STORED args of an approved action through its tool handler.
 * The model never re-issues the call, and the args are never re-derived —
 * what the human saw on the approval card is exactly what runs.
 */
export async function executeApprovedAction(
  pendingId: number,
): Promise<{ ok: boolean; summary: string }> {
  // Claim first. Reading the row and then checking `status === 'approved'` is a
  // read-then-act: two overlapping deliveries of the same queue job both pass it
  // and the side effect happens twice. This single UPDATE ... WHERE
  // status='approved' is the exactly-once guard.
  let row: PendingRow | null
  try {
    row = await claimForExecution(pendingId)
  } catch (err) {
    const summary = `Could not claim pending action ${pendingId}: ${errorMessage(err)}`
    log.error({ pendingActionId: pendingId, err }, 'failed to claim pending action')
    await audit({
      actor: 'system',
      event: 'action.failed',
      resultSummary: clamp(summary),
      ok: false,
      pendingActionId: pendingId,
    })
    return { ok: false, summary: clamp(summary) }
  }

  if (!row) return refuseUnclaimed(pendingId)

  const actor = row.resolvedBy ?? row.requestedBy ?? 'system'

  let tool: ToolDef | undefined
  try {
    tool = getTool(row.toolName)
  } catch (err) {
    const summary = `Tool lookup for "${row.toolName}" failed: ${errorMessage(err)}`
    log.error({ pendingActionId: row.id, tool: row.toolName, err }, 'registry lookup threw')
    await recordFailure(row, actor, clamp(summary), { error: errorMessage(err) })
    return { ok: false, summary: clamp(summary) }
  }

  if (!tool) {
    const summary = `Unknown tool "${row.toolName}" — the approved action cannot be replayed.`
    log.error({ pendingActionId: row.id, tool: row.toolName }, 'tool not in registry')
    await recordFailure(row, actor, summary, { error: summary })
    return { ok: false, summary }
  }

  const args = storedArgs(row)
  if (!args) {
    const summary = `Stored arguments for action ${pendingId} are not an object — refusing to guess.`
    log.error({ pendingActionId: row.id, tool: row.toolName }, 'corrupt stored args')
    await recordFailure(row, actor, summary, { error: summary })
    return { ok: false, summary }
  }

  const ctx = contextFor(row)

  let result: ToolResult
  try {
    // Verbatim replay: no re-validation, no reshaping, no model in the loop.
    result = await tool.handler(args, ctx)
  } catch (err) {
    const summary = `${tool.name} threw: ${errorMessage(err)}`
    log.error({ pendingActionId: row.id, tool: tool.name, err }, 'tool handler threw')
    await recordFailure(row, actor, clamp(summary), {
      error: errorMessage(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
    return { ok: false, summary: clamp(summary) }
  }

  // A handler that returns nothing is a bug, not a success. `result?.isError`
  // alone would record an executed action and tell the household "Done."
  if (result === null || typeof result !== 'object') {
    const summary = `${tool.name} returned no result — recording it as failed; check whether it ran.`
    log.error({ pendingActionId: row.id, tool: tool.name }, 'handler returned a non-result')
    await recordFailure(row, actor, summary, { error: summary })
    return { ok: false, summary }
  }

  const ok = result.isError !== true
  const summary = summarizeResult(result, ok)

  try {
    await markExecuted(row.id, result, ok)
  } catch (err) {
    // The side effect already happened; losing the bookkeeping must not crash the worker.
    log.error({ pendingActionId: row.id, err }, 'failed to record execution result')
  }

  await audit({
    actor,
    event: ok ? 'action.executed' : 'action.failed',
    category: row.category,
    toolName: tool.name,
    args,
    resultSummary: summary,
    ok,
    pendingActionId: row.id,
  })

  log.info({ pendingActionId: row.id, tool: tool.name, ok }, 'approved action replayed')
  return { ok, summary }
}

/**
 * The claim found no `approved` row. Report why without ever running anything:
 * the row is gone, or someone else already holds it, or it was rejected/expired.
 */
async function refuseUnclaimed(pendingId: number): Promise<{ ok: boolean; summary: string }> {
  let existing: PendingRow | undefined
  try {
    existing = await getPending(pendingId)
  } catch (err) {
    log.error({ pendingActionId: pendingId, err }, 'failed to load unclaimable pending action')
  }

  if (!existing) {
    const summary = `Pending action ${pendingId} no longer exists.`
    log.warn({ pendingActionId: pendingId }, 'pending action not found')
    await audit({
      actor: 'system',
      event: 'action.failed',
      resultSummary: summary,
      ok: false,
      pendingActionId: pendingId,
    })
    return { ok: false, summary }
  }

  const summary = `Pending action ${pendingId} is ${existing.status}, not approved — nothing was executed.`
  log.warn({ pendingActionId: pendingId, status: existing.status }, 'refusing to execute')
  await audit({
    actor: existing.resolvedBy ?? existing.requestedBy ?? 'system',
    event: 'action.failed',
    category: existing.category,
    toolName: existing.toolName,
    resultSummary: summary,
    ok: false,
    pendingActionId: existing.id,
  })
  return { ok: false, summary }
}

async function recordFailure(
  row: PendingRow,
  actor: string,
  summary: string,
  result: unknown,
): Promise<void> {
  try {
    await markExecuted(row.id, result, false)
  } catch (err) {
    log.error({ pendingActionId: row.id, err }, 'failed to record failure result')
  }
  await audit({
    actor,
    event: 'action.failed',
    category: row.category,
    toolName: row.toolName,
    args: row.argsJson,
    resultSummary: summary,
    ok: false,
    pendingActionId: row.id,
  })
}
