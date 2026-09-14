/**
 * The Sunday-evening review.
 *
 * Same shape as the morning brief — gather cheap facts, run one turn — with one
 * addition that makes it more than a report: the **approval retro**.
 *
 * Every week the workflow looks at what the household actually said no to. When
 * a pattern is there in the data (not in the model's impression of the data), it
 * writes a concrete behaviour rule and offers it as a single tap.
 *
 * ## Why the rule is computed here rather than asked for
 *
 * A rule the model invents is a rule nobody can check. This one is derived from
 * `pending_actions` by `proposeRule()` below: which category was rejected, how
 * often, out of how many, and — for calendar rejections — at what hour and on
 * what day. The household sees the rule and the evidence for it side by side,
 * and one tap writes it.
 *
 * ## Why the button is an approval card in disguise
 *
 * `[＋ Add rule]` carries the callback data of an approve tap on a pending
 * `rule_add`. That is deliberate reuse: the tap goes through the same atomic
 * approve-then-replay path as every other consequential action, so it is
 * double-tap safe, audited, expiring, and replayed from stored arguments rather
 * than re-derived. No new trust path, no second button vocabulary.
 */
import { and, eq, gte, inArray } from 'drizzle-orm'
import { InlineKeyboard } from 'grammy'
import { DateTime } from 'luxon'
import { runTurn } from '../agent/run-turn.js'
import { getDb, schema } from '../db/client.js'
import type { PolicyCategory } from '../db/schema.js'
import { approvalRetro, costReport } from '../ops/cost.js'
import { CATEGORY_LABELS } from '../policy/categories.js'
import { createPendingAction } from '../policy/pending.js'
import { CB } from '../telegram/approvals.js'
import { md, sendToChat } from '../telegram/send.js'
import {
  FACTS_HEADER,
  type WorkflowTrigger,
  completedSince,
  describeError,
  factsBlock,
  fanOut,
  householdChatIds,
  log,
  longDate,
  nowLocal,
  openFollowups,
  renderFollowup,
  renderTodo,
  runWorkflow,
  section,
  staleTodos,
  turnTrigger,
  waitingApprovals,
  workflowChatId,
  zone,
} from './common.js'

/** The window every figure in the review is measured over. */
const WINDOW_DAYS = 7

/** One calendar lookup for the week ahead, plus the write-up. */
const MAX_TURNS = 12

/** A rule offer sits through the week rather than expiring in half an hour. */
const RULE_OFFER_MINUTES = 60 * 48

/** Statuses that mean a human actually decided, as opposed to letting it lapse. */
const DECIDED = ['rejected', 'approved', 'executed', 'failed'] as const

/** Below this many rejections, a "pattern" is just noise. */
const MIN_REJECTIONS = 2
/** And it has to be most of what was asked, not a handful out of fifty. */
const MIN_REJECTION_SHARE = 0.5

/** `rule_add` caps its text at 300 characters. */
const MAX_RULE_CHARS = 300

const REVIEW_STYLE = [
  'You are writing the household weekly review. It is read on a phone on a Sunday evening.',
  '',
  'FORMAT — follow exactly:',
  '- No greeting, no preamble, no sign-off. Under 300 words.',
  '- Short paragraphs or lines, in this order, skipping anything with nothing in it:',
  '  what got done, what is still open, the week ahead, the cost line, one honest observation.',
  '- The cost line is one sentence, taken from the figures supplied below. Do not recompute it.',
  '- The observation is about you, not them: where you helped least this week, and the one thing',
  '  you would like standing permission to handle without asking.',
  '',
  'HONESTY:',
  '- Every number comes from the figures below. Never estimate one, never round one up.',
  '- Never invent an event or a task. If the calendar lookup fails, say so in a short line.',
  '',
  'SCOPE — the review is read-only. Do not create, change, send, or book anything, and do not',
  'add a rule yourself: a separate one-tap offer handles that.',
].join('\n')

const LOOKUP = [
  'One thing is NOT in the facts below and you must fetch it yourself, once:',
  'calendar_list_events for the seven days starting tomorrow — the week ahead.',
  'Make that one lookup, then write the review. Do not make a second round of tool calls.',
].join('\n')

/* ────────────────────────────── the rule retro ───────────────────────────── */

export interface RuleProposal {
  /** The rule as it would be stored, one imperative sentence. */
  text: string
  /** The counted evidence, shown under the rule so the household can check it. */
  evidence: string
}

interface Decision {
  category: string
  rejected: boolean
  args: Record<string, unknown>
}

function argsOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function label(category: string): string {
  return CATEGORY_LABELS[category as PolicyCategory] ?? category
}

/**
 * The start time on a rejected calendar request, in the household zone.
 * All-day requests (`YYYY-MM-DD`, no clock) carry no hour and are skipped.
 */
function startOf(args: Record<string, unknown>): DateTime | null {
  const raw = args.start
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const text = raw.trim()
  if (!/\d\d:\d\d/.test(text)) return null
  const parsed = DateTime.fromISO(text, { zone: zone() })
  return parsed.isValid ? parsed : null
}

/**
 * Look for a rule worth proposing in the week's rejections.
 *
 * @returns the proposal, or null when nothing rose above noise. Never throws:
 * a broken retro must not cost the household its review.
 */
export async function proposeRule(since: Date): Promise<RuleProposal | null> {
  let decisions: Decision[]
  try {
    const rows = await getDb()
      .select({
        category: schema.pendingActions.category,
        status: schema.pendingActions.status,
        argsJson: schema.pendingActions.argsJson,
      })
      .from(schema.pendingActions)
      .where(
        and(
          gte(schema.pendingActions.resolvedAt, since),
          inArray(schema.pendingActions.status, [...DECIDED]),
        ),
      )
    decisions = rows.map((row) => ({
      category: row.category,
      rejected: row.status === 'rejected',
      args: argsOf(row.argsJson),
    }))
  } catch (err) {
    log.error({ err: describeError(err) }, 'could not read the approval retro')
    return null
  }

  // Which category did they say no to, and how consistently?
  const tally = new Map<string, { rejected: number; total: number }>()
  for (const d of decisions) {
    const entry = tally.get(d.category) ?? { rejected: 0, total: 0 }
    entry.total += 1
    if (d.rejected) entry.rejected += 1
    tally.set(d.category, entry)
  }

  let worst: { category: string; rejected: number; total: number } | null = null
  for (const [category, entry] of tally) {
    if (entry.rejected < MIN_REJECTIONS) continue
    if (entry.rejected / entry.total < MIN_REJECTION_SHARE) continue
    if (worst === null || entry.rejected > worst.rejected) {
      worst = { category, rejected: entry.rejected, total: entry.total }
    }
  }
  if (!worst) return null

  const evidence =
    `${worst.rejected} of the last ${worst.total} ${label(worst.category)} requests were rejected ` +
    `in the past ${WINDOW_DAYS} days.`

  const specific = calendarPattern(decisions, worst.category)
  const text =
    specific ??
    `Before you put another ${label(worst.category)} up for approval, check the details with me ` +
      `in chat first.`

  return { text: text.slice(0, MAX_RULE_CHARS), evidence }
}

/**
 * Calendar rejections carry a timestamp, so they can say something sharper than
 * "ask first". If every rejected event was early, or every one was at a weekend,
 * that is the rule.
 */
function calendarPattern(decisions: Decision[], category: string): string | null {
  if (category !== 'calendar_write' && category !== 'calendar_write_from_watcher') return null

  const starts = decisions
    .filter((d) => d.rejected && d.category === category)
    .map((d) => startOf(d.args))
    .filter((dt): dt is DateTime => dt !== null)

  if (starts.length < MIN_REJECTIONS) return null

  const allEarly = starts.every((dt) => dt.hour < 9)
  const allWeekend = starts.every((dt) => dt.weekday >= 6)

  if (allEarly && allWeekend) {
    return 'Never put a weekend event on the family calendar before 9am. Ask me in chat first if one is unavoidable.'
  }
  if (allEarly) {
    return 'Never put anything on the family calendar before 9am. Ask me in chat first if an early start is unavoidable.'
  }
  if (allWeekend) {
    return 'Do not add weekend events to the family calendar without checking with me in chat first.'
  }
  return null
}

/** True when this exact rule is already active, so the offer is not repeated. */
async function alreadyARule(text: string): Promise<boolean> {
  const key = normalise(text)
  try {
    const rows = await getDb()
      .select({ text: schema.rules.text })
      .from(schema.rules)
      .where(eq(schema.rules.active, true))
    return rows.some((row) => normalise(row.text) === key)
  } catch (err) {
    // Fail toward not nagging: an unreadable rules table is not a reason to
    // offer a rule the household may already have.
    log.warn({ err: describeError(err) }, 'could not check the existing rules')
    return true
  }
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Park the rule as a pending `rule_add` and send the one-tap offer.
 *
 * The message ids go back onto the pending row so the existing approval
 * plumbing can retire every copy of the card once one spouse taps.
 */
async function offerRule(proposal: RuleProposal, chatId: string): Promise<void> {
  if (await alreadyARule(proposal.text)) {
    log.info({ rule: proposal.text }, 'the proposed rule is already active; not offering it')
    return
  }

  const { id } = await createPendingAction({
    toolName: 'rule_add',
    args: { text: proposal.text },
    category: 'memory_write',
    humanSummary: `Add a standing rule: "${proposal.text}"`,
    ctx: { chatId, actor: 'system', origin: 'workflow' },
    expiresInMinutes: RULE_OFFER_MINUTES,
  })

  const body = [
    md.bold('Rule I would like to adopt'),
    '',
    md.escape(`“${proposal.text}”`),
    '',
    md.italic(proposal.evidence),
    '',
    md.escape('Tap to adopt it, or ignore this and it lapses in two days.'),
  ].join('\n')

  const keyboard = new InlineKeyboard().text('＋ Add rule', CB.approve(id))

  const refs: Array<{ chatId: string; messageId: number }> = []
  for (const recipient of householdChatIds()) {
    const ids = await sendToChat(recipient, body, { markdown: true, replyMarkup: keyboard })
    for (const messageId of ids) refs.push({ chatId: recipient, messageId })
  }

  if (refs.length === 0) {
    log.error({ pendingActionId: id }, 'the rule offer could not be delivered to anyone')
    return
  }

  try {
    await getDb()
      .update(schema.pendingActions)
      .set({ telegramMessageIds: refs })
      .where(eq(schema.pendingActions.id, id))
  } catch (err) {
    // The offer is out; losing the ids only costs the tidy-up edit on tap.
    log.warn({ err: describeError(err), pendingActionId: id }, 'could not record the offer ids')
  }

  log.info({ pendingActionId: id, rule: proposal.text }, 'offered a behaviour rule')
}

/* ─────────────────────────────── the workflow ────────────────────────────── */

/**
 * The week in review, sent to both spouses, followed by a one-tap rule offer
 * when the week's rejections show a pattern.
 *
 * @param trigger `'cron'` for the Sunday run, `'command'` for `/review`.
 */
export async function weeklyReview(trigger: 'cron' | 'command'): Promise<void> {
  await runWorkflow('weekly review', () => review(trigger))
}

async function review(trigger: WorkflowTrigger): Promise<void> {
  const chatId = await workflowChatId()
  if (!chatId) {
    log.warn('no chat is configured; skipping the weekly review')
    return
  }

  const since = nowLocal().minus({ days: WINDOW_DAYS }).toJSDate()

  const [done, stale, followups, approvals, cost, retro, rawProposal] = await Promise.all([
    completedSince(since),
    staleTodos(),
    openFollowups(),
    waitingApprovals(),
    safely('cost report', () => costReport(WINDOW_DAYS)),
    safely('approval retro', () => approvalRetro(WINDOW_DAYS)),
    proposeRule(since),
  ])

  // Decide NOW whether the offer will actually go out. The review text below
  // promises a one-tap button; deciding after the turn (as offerRule's own
  // duplicate check would) lets the review mention a button that never arrives
  // when the rule is already active.
  const proposal = rawProposal && !(await alreadyARule(rawProposal.text)) ? rawProposal : null
  if (rawProposal && !proposal) {
    log.info({ rule: rawProposal.text }, 'the proposed rule is already active; not offering it')
  }

  const facts = factsBlock([
    FACTS_HEADER,
    `Today is ${longDate()} in ${zone()}. The window below is the last ${WINDOW_DAYS} days.`,
    section(
      'Closed this week',
      done.map((t) => `- ${t.title}`),
    ),
    section('Open and going stale (no movement in two weeks)', stale.map(renderTodo)),
    section('Follow-ups still open', followups.map(renderFollowup)),
    section(
      'Approvals still waiting on a tap',
      approvals.map((a) => `- #${a.id} ${a.summary}`),
    ),
    cost ? `Cost report:\n${cost}` : null,
    retro ? `Approval retro:\n${retro}` : null,
    proposal
      ? [
          'Rule offer: a separate message right after this review offers this rule as a one-tap button —',
          `“${proposal.text}” (${proposal.evidence})`,
          'Mention it in one line at the end of the review. Do NOT call rule_add yourself.',
        ].join('\n')
      : null,
  ])

  const systemAppend = [REVIEW_STYLE, '', LOOKUP, '', facts].join('\n')

  const result = await runTurn({
    chatId,
    actor: 'system',
    prompt: `Write the household weekly review for the seven days ending ${longDate()}.`,
    systemAppend,
    trigger: turnTrigger(trigger),
    origin: 'agent',
    // Self-contained, like the brief: never re-bill a week of chat.
    resume: false,
    maxTurns: MAX_TURNS,
  })

  if (result.ok) {
    await fanOut(result.text, chatId)
  } else {
    // `runTurn` already apologised in the chat; do not apologise twice. The
    // rule offer is still worth sending — it is independent of the write-up.
    log.error({ trigger }, 'the weekly review turn did not succeed')
  }

  if (proposal) {
    try {
      await offerRule(proposal, chatId)
    } catch (err) {
      // The review itself is already delivered. A failed offer must not turn
      // into a "couldn't finish the weekly review" notice on top of it.
      log.error({ err: describeError(err) }, 'could not send the rule offer')
    }
  }
  log.info({ trigger, costUsd: result.costUsd, proposedRule: proposal !== null }, 'weekly review sent')
}

/**
 * Run one of the ops reports without letting it take the review down with it.
 * A missing cost line is a smaller loss than a missing review.
 */
async function safely(what: string, fn: () => Promise<string>): Promise<string | null> {
  try {
    const text = await fn()
    return text.trim() === '' ? null : text.trim()
  } catch (err) {
    log.warn({ err: describeError(err), what }, 'a weekly review input failed')
    return null
  }
}
