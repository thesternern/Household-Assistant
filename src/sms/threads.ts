/**
 * SMS threads — the bounded autonomy of the texting feature.
 *
 * An approved `sms_send` opens a thread carrying the goal it was approved for.
 * Inside that thread Chessy may reply without asking again, the way the voice
 * agent converses freely inside one approved call. The bounds are a message cap
 * and a time window, and they exist because a call and a text end differently:
 * a call is over when someone hangs up, while a text thread would otherwise
 * stay open for days, quietly turning an errand approved on Tuesday into a
 * standing licence to correspond.
 *
 * Everything in this module is written so the boundary is decidable from stored
 * state alone. `autonomyVerdict` is pure and takes the row, so the rule can be
 * tested without a database and cannot drift between the webhook path and the
 * agent path.
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'

const log = logger.child({ mod: 'sms/threads' })

/** Messages, both directions, before a thread closes itself. */
export const MAX_THREAD_MESSAGES = 10

/** How long an approved errand stays live. */
export const THREAD_WINDOW_HOURS = 24

export type ThreadRow = typeof schema.smsThreads.$inferSelect
export type MessageRow = typeof schema.smsMessages.$inferSelect

export type CloseReason =
  | 'goal_met'
  | 'message_cap'
  | 'window_expired'
  | 'opted_out'
  | 'household_closed'

/** Why a thread may or may not answer for itself right now. */
export type AutonomyVerdict =
  | { autonomous: true; remaining: number }
  | { autonomous: false; reason: CloseReason | 'closed'; detail: string }

/**
 * Whether this thread may still answer without a fresh approval.
 *
 * Pure, and takes the row rather than an id, because this is the rule the whole
 * feature rests on and it must be testable exhaustively without a database.
 */
export function autonomyVerdict(thread: ThreadRow, now: Date = new Date()): AutonomyVerdict {
  if (thread.status !== 'open') {
    return {
      autonomous: false,
      reason: 'closed',
      detail: thread.closedReason ?? 'the thread is closed',
    }
  }

  if (now.getTime() >= thread.expiresAt.getTime()) {
    return {
      autonomous: false,
      reason: 'window_expired',
      detail: `the ${THREAD_WINDOW_HOURS}-hour window for this errand has passed`,
    }
  }

  // The inbound message that triggers this check is already counted, so the
  // comparison is >= : a thread at the cap has no reply left in it.
  if (thread.messageCount >= MAX_THREAD_MESSAGES) {
    return {
      autonomous: false,
      reason: 'message_cap',
      detail: `this exchange has reached its ${MAX_THREAD_MESSAGES}-message limit`,
    }
  }

  return { autonomous: true, remaining: MAX_THREAD_MESSAGES - thread.messageCount }
}

/** The live thread for a number, if there is one. */
export async function openThreadFor(phone: string): Promise<ThreadRow | undefined> {
  const rows = await getDb()
    .select()
    .from(schema.smsThreads)
    .where(and(eq(schema.smsThreads.phone, phone), eq(schema.smsThreads.status, 'open')))
    .orderBy(desc(schema.smsThreads.openedAt))
    .limit(1)
  return rows[0]
}

/** The most recent thread for a number, open or not. Used to explain a late reply. */
export async function latestThreadFor(phone: string): Promise<ThreadRow | undefined> {
  const rows = await getDb()
    .select()
    .from(schema.smsThreads)
    .where(eq(schema.smsThreads.phone, phone))
    .orderBy(desc(schema.smsThreads.openedAt))
    .limit(1)
  return rows[0]
}

export interface OpenThreadInput {
  contactId: number
  phone: string
  goal: string
  pendingActionId?: number | undefined
  telegramChatId?: string | undefined
  now?: Date
}

/**
 * Open a thread for an approved errand.
 *
 * Called after the first message actually goes out, so a thread never exists
 * for a send that failed.
 */
export async function openThread(input: OpenThreadInput): Promise<ThreadRow> {
  const now = input.now ?? new Date()
  const expiresAt = new Date(now.getTime() + THREAD_WINDOW_HOURS * 3600_000)

  const inserted = await getDb()
    .insert(schema.smsThreads)
    .values({
      contactId: input.contactId,
      phone: input.phone,
      goal: input.goal,
      status: 'open',
      pendingActionId: input.pendingActionId ?? null,
      telegramChatId: input.telegramChatId ?? null,
      messageCount: 0,
      openedAt: now,
      expiresAt,
    })
    .returning()

  const row = inserted[0]
  if (!row) throw new Error('the SMS thread could not be opened')
  log.info({ threadId: row.id, phone: input.phone, expiresAt }, 'sms thread opened')
  return row
}

/**
 * Record a message and count it against the cap.
 *
 * The count is incremented in SQL rather than read-then-written: the webhook and
 * an agent turn can both be appending, and a lost update here would hand the
 * thread extra messages it was never approved for.
 *
 * Returns `undefined` when the Twilio sid has been seen before, which is how a
 * redelivered webhook becomes a no-op rather than a second reply.
 */
export async function appendMessage(input: {
  threadId: number
  direction: 'inbound' | 'outbound'
  body: string
  twilioSid?: string | null
  now?: Date
}): Promise<MessageRow | undefined> {
  const now = input.now ?? new Date()

  const inserted = await getDb()
    .insert(schema.smsMessages)
    .values({
      threadId: input.threadId,
      direction: input.direction,
      body: input.body,
      twilioSid: input.twilioSid ?? null,
      createdAt: now,
    })
    .onConflictDoNothing({ target: schema.smsMessages.twilioSid })
    .returning()

  const row = inserted[0]
  if (!row) {
    log.info({ sid: input.twilioSid }, 'duplicate sms message ignored')
    return undefined
  }

  await getDb()
    .update(schema.smsThreads)
    .set({
      messageCount: sql`${schema.smsThreads.messageCount} + 1`,
      lastMessageAt: now,
    })
    .where(eq(schema.smsThreads.id, input.threadId))

  return row
}

/** Close a thread, once. Returns the row as it now stands. */
export async function closeThread(
  threadId: number,
  reason: CloseReason,
  detail?: string,
): Promise<ThreadRow | undefined> {
  const updated = await getDb()
    .update(schema.smsThreads)
    .set({
      status: 'closed',
      closedReason: detail ?? reason,
      closedAt: new Date(),
    })
    .where(and(eq(schema.smsThreads.id, threadId), eq(schema.smsThreads.status, 'open')))
    .returning()

  const row = updated[0]
  if (row) log.info({ threadId, reason }, 'sms thread closed')
  return row
}

/** Every message on a thread, oldest first. The record is always complete. */
export async function threadMessages(threadId: number, limit = 50): Promise<MessageRow[]> {
  return getDb()
    .select()
    .from(schema.smsMessages)
    .where(eq(schema.smsMessages.threadId, threadId))
    .orderBy(schema.smsMessages.createdAt)
    .limit(limit)
}

/**
 * Mark a contact as having opted out, and close anything still open to them.
 *
 * Never reversed by the assistant. Twilio owns the opt-out state and only the
 * person who sent STOP can undo it, by texting START.
 */
export async function markOptedOut(phone: string): Promise<void> {
  await getDb()
    .update(schema.contacts)
    .set({ smsOptedOutAt: new Date() })
    .where(eq(schema.contacts.phone, phone))

  const open = await openThreadFor(phone)
  if (open) await closeThread(open.id, 'opted_out', 'they replied STOP to this number')
  log.warn({ phone }, 'contact opted out of texts')
}
