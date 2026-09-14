import { and, asc, eq, ilike, ne, sql } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { audit } from '../audit/log.js'
import { getConfig } from '../config.js'
import type { PolicyCategory } from '../db/schema.js'
import { getDb, schema } from '../db/client.js'
import { POLICY_CATEGORIES, POLICY_MODES } from '../db/schema.js'
import { googleStartUrl, START_LINK_TTL_MS } from '../http/google-oauth.js'
import { encrypt } from '../integrations/crypto.js'
import {
  GOOGLE_ROLE_PURPOSE,
  isGoogleAccountRole,
} from '../integrations/google.js'
import { logger } from '../logger.js'
import { fileImprovement } from '../ops/improve.js'
import { statusReport } from '../ops/watchdog.js'
import {
  CATEGORY_DESCRIPTIONS,
  CATEGORY_LABELS,
  isPolicyCategory,
  isPolicyMode,
} from '../policy/categories.js'
import { listPolicies, setPolicyMode } from '../policy/engine.js'
import { listPending } from '../policy/pending.js'
import { cancelSetup, isSetupActive, startSetup } from '../setup/wizard.js'
import { bookSomething } from '../workflows/book.js'
import { callSomeone, splitCallRequest } from '../workflows/call.js'
import { mealPrep } from '../workflows/mealprep.js'
import { morningBrief } from '../workflows/morning-brief.js'
import { weeklyReview } from '../workflows/weekly-review.js'
import { approveAction, enqueueAgentTurn, rejectAction } from './approvals.js'
import { md, sendToChat } from './send.js'

const log = logger.child({ mod: 'telegram/commands' })

export interface CommandCtx {
  chatId: string
  actor: string
}

type Handler = (args: string, ctx: CommandCtx) => Promise<void>

/**
 * Commands whose text carries a secret. `bot.ts` deletes the originating
 * message after these run so a password does not sit in the chat history.
 */
export const SECRET_COMMANDS: ReadonlySet<string> = new Set(['connect_site'])

/* ─────────────────────────────────── helpers ─────────────────────────────── */

function describe(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

/** Plain text, no markup. The safe default for anything containing user data. */
async function reply(chatId: string, text: string): Promise<void> {
  await sendToChat(chatId, text, { markdown: false })
}

/** Pre-composed MarkdownV2. Every interpolated value must already be escaped. */
async function replyMd(chatId: string, body: string): Promise<void> {
  await sendToChat(chatId, body, { markdown: true })
}

const B = md.bold
const E = md.escape

function zone(): string {
  try {
    return getConfig().HOUSEHOLD_TIMEZONE
  } catch {
    return 'UTC'
  }
}

function today(): string {
  return DateTime.now().setZone(zone()).toISODate() ?? ''
}

function whenText(at: Date): string {
  const dt = DateTime.fromJSDate(at).setZone(zone())
  const now = DateTime.now().setZone(zone())
  if (dt.hasSame(now, 'day')) return `today ${dt.toFormat('h:mm a')}`
  if (dt.hasSame(now.plus({ days: 1 }), 'day')) return `tomorrow ${dt.toFormat('h:mm a')}`
  return dt.toFormat('ccc d LLL, h:mm a')
}

/** `/todo@household_bot` → `todo`. Accepts the name with or without the slash. */
function normalizeCommand(cmd: string): string {
  const raw = (cmd ?? '').trim()
  const noSlash = raw.startsWith('/') ? raw.slice(1) : raw
  const noMention = noSlash.split('@')[0] ?? ''
  return noMention.trim().toLowerCase()
}

async function householdRow() {
  const rows = await getDb().select().from(schema.households).limit(1)
  return rows[0]
}

/** Records the sender so `primaryChatId()` and the wizard have someone to name. */
async function rememberUser(ctx: CommandCtx): Promise<void> {
  try {
    const cfg = getConfig()
    await getDb()
      .insert(schema.users)
      .values({
        telegramUserId: ctx.chatId,
        displayName: ctx.actor,
        isPrimary: ctx.chatId === cfg.TELEGRAM_USER_ID_1,
      })
      .onConflictDoNothing({ target: schema.users.telegramUserId })
  } catch (err) {
    log.warn({ err: describe(err) }, 'could not record the sender')
  }
}

/* ──────────────────────────── deterministic commands ─────────────────────── */

const cmdStart: Handler = async (_args, ctx) => {
  await rememberUser(ctx)
  const household = await householdRow()
  const done = Boolean(household?.setupCompletedAt)

  const lines = [
    B('👋 I run the household.'),
    '',
    E(
      'Calendar, email, to-dos, reminders, phone calls, meal plans and the shopping list. ' +
        'Just talk to me in plain language.',
    ),
    '',
    E('Anything that touches the outside world comes back to you as an approval card first.'),
    '',
    done
      ? E('Setup is done. Try "what does tomorrow look like?" or /help.')
      : E('Setup is not finished. Run /setup — it takes about ten minutes.'),
  ]
  await replyMd(ctx.chatId, lines.join('\n'))
}

const cmdHelp: Handler = async (_args, ctx) => {
  const lines = [
    B('What I answer to'),
    '',
    B('Every day'),
    E('/brief — today at a glance'),
    E('/todos — open to-dos · /todo <text> — add one · /done <id> — finish one'),
    E('/reminders — what is scheduled · /remind <text> — set one'),
    '',
    B('Bigger jobs'),
    E('/review — the weekly review'),
    E('/mealprep — plan the week and build the grocery list'),
    E('/book <what> — find it, confirm it, book it by phone'),
    E('/call <who> <goal> — place a call'),
    '',
    B('Control'),
    E('/approve — pending approvals · /approve <id> — approve one'),
    E('/cancel [id] — cancel the wizard or a pending approval'),
    E('/policy — what I may do unattended · /policy <category> <mode> — change it'),
    E('/rules — standing instructions · /rules add <text> · /rules remove <id>'),
    E('/status — what is connected and healthy'),
    '',
    B('Setup'),
    E('/setup — the onboarding interview'),
    E('/connect_google — link Gmail and Calendar'),
    E('/connect_site — store a site login for browser tasks'),
    E('/improve <idea> — file a change request for a human to build'),
    '',
    E('Anything else: just say it.'),
  ]
  await replyMd(ctx.chatId, lines.join('\n'))
}

const cmdStatus: Handler = async (_args, ctx) => {
  const text = await statusReport()
  await reply(ctx.chatId, text)
}

const cmdTodos: Handler = async (_args, ctx) => {
  const rows = await getDb()
    .select()
    .from(schema.todos)
    .where(eq(schema.todos.status, 'open'))
    .orderBy(sql`${schema.todos.dueDate} asc nulls last`, asc(schema.todos.createdAt))
    .limit(40)

  if (rows.length === 0) {
    await replyMd(ctx.chatId, E('📋 Nothing open. The list is clear.'))
    return
  }

  const now = today()
  const lines = [B(`📋 Open to-dos (${rows.length})`), '']
  for (const row of rows) {
    const bits: string[] = []
    if (row.dueDate) bits.push(row.dueDate < now ? `overdue ${row.dueDate}` : `due ${row.dueDate}`)
    if (row.assignee) bits.push(row.assignee)
    const tail = bits.length > 0 ? ` — ${bits.join(' · ')}` : ''
    lines.push(E(`#${row.id} ${row.title}${tail}`))
  }
  lines.push('')
  lines.push(E('Finish one with /done <id>.'))
  await replyMd(ctx.chatId, lines.join('\n'))
}

async function completeTodo(id: number): Promise<string | null> {
  const updated = await getDb()
    .update(schema.todos)
    .set({ status: 'done', completedAt: new Date() })
    .where(and(eq(schema.todos.id, id), ne(schema.todos.status, 'done')))
    .returning({ id: schema.todos.id, title: schema.todos.title })
  return updated[0]?.title ?? null
}

const cmdDone: Handler = async (args, ctx) => {
  if (!args) {
    await cmdTodos('', ctx)
    return
  }

  const asId = Number.parseInt(args.replace(/^#/, ''), 10)
  if (Number.isInteger(asId) && /^#?\d+$/.test(args.trim())) {
    const title = await completeTodo(asId)
    await reply(
      ctx.chatId,
      title ? `✅ Done: ${title}` : `Nothing open with id ${asId} — it may already be done.`,
    )
    return
  }

  const matches = await getDb()
    .select({ id: schema.todos.id, title: schema.todos.title })
    .from(schema.todos)
    .where(and(eq(schema.todos.status, 'open'), ilike(schema.todos.title, `%${args}%`)))
    .limit(10)

  if (matches.length === 0) {
    await reply(ctx.chatId, `Nothing open matches "${args}".`)
    return
  }
  if (matches.length === 1) {
    const only = matches[0]
    if (!only) return
    const title = await completeTodo(only.id)
    await reply(ctx.chatId, title ? `✅ Done: ${title}` : `"${only.title}" was already done.`)
    return
  }

  const list = matches.map((m) => `#${m.id} ${m.title}`).join('\n')
  await reply(ctx.chatId, `Several match "${args}":\n${list}\n\nFinish one with /done <id>.`)
}

const cmdReminders: Handler = async (_args, ctx) => {
  const rows = await getDb()
    .select()
    .from(schema.reminders)
    .where(eq(schema.reminders.status, 'scheduled'))
    .orderBy(asc(schema.reminders.fireAt))
    .limit(30)

  if (rows.length === 0) {
    await replyMd(ctx.chatId, E('⏰ No reminders scheduled.'))
    return
  }

  const lines = [B(`⏰ Scheduled reminders (${rows.length})`), '']
  for (const row of rows) {
    const repeat = row.recurrence ? ' · repeats' : ''
    lines.push(E(`#${row.id} ${whenText(row.fireAt)} — ${row.text}${repeat}`))
  }
  await replyMd(ctx.chatId, lines.join('\n'))
}

const cmdApprove: Handler = async (args, ctx) => {
  const pending = await listPending()

  if (!args) {
    if (pending.length === 0) {
      await replyMd(ctx.chatId, E('Nothing is waiting on you.'))
      return
    }
    const lines = [B(`🔐 Waiting on you (${pending.length})`), '']
    for (const row of pending) {
      lines.push(E(`#${row.id} ${row.humanSummary}`))
      const label = isPolicyCategory(row.category) ? CATEGORY_LABELS[row.category] : row.category
      lines.push(E(`     ${label} · asked by ${row.requestedBy ?? 'the assistant'}`))
    }
    lines.push('')
    lines.push(E('Approve with /approve <id>, or /approve all. Reject with /cancel <id>.'))
    await replyMd(ctx.chatId, lines.join('\n'))
    return
  }

  if (args.toLowerCase() === 'all') {
    if (pending.length === 0) {
      await reply(ctx.chatId, 'Nothing is waiting on you.')
      return
    }
    const results: string[] = []
    for (const row of pending) {
      results.push(`#${row.id}: ${await approveAction(row.id, ctx.actor)}`)
    }
    await reply(ctx.chatId, results.join('\n'))
    return
  }

  const id = Number.parseInt(args.replace(/^#/, ''), 10)
  if (!Number.isInteger(id)) {
    await reply(ctx.chatId, 'Give me a request number, for example /approve 12.')
    return
  }
  await reply(ctx.chatId, await approveAction(id, ctx.actor))
}

const cmdCancel: Handler = async (args, ctx) => {
  if (await isSetupActive(ctx.chatId)) {
    await cancelSetup(ctx.chatId)
    await reply(ctx.chatId, 'Setup cancelled. Run /setup again whenever you like.')
    return
  }

  const id = Number.parseInt(args.replace(/^#/, ''), 10)
  if (Number.isInteger(id)) {
    await reply(ctx.chatId, await rejectAction(id, ctx.actor))
    return
  }

  const pending = await listPending()
  if (pending.length === 0) {
    await reply(ctx.chatId, 'Nothing to cancel.')
    return
  }
  const only = pending.length === 1 ? pending[0] : undefined
  if (only) {
    await reply(ctx.chatId, await rejectAction(only.id, ctx.actor))
    return
  }
  const list = pending.map((row) => `#${row.id} ${row.humanSummary}`).join('\n')
  await reply(ctx.chatId, `Which one?\n${list}\n\nCancel with /cancel <id>.`)
}

/**
 * Categories whose tool handlers hold their own approval deadbolt and do not
 * honour an `allow` policy. Calendar writes are the one consequential category
 * whose handler does (see `categoryIsUngated` in tools/calendar.ts), and SMS
 * has a bounded in-thread exception, so neither is listed.
 */
const DEADBOLTED_CATEGORIES: ReadonlySet<PolicyCategory> = new Set<PolicyCategory>([
  'email_send',
  'phone_call',
  'purchase',
  'browser_task',
])

const cmdPolicy: Handler = async (args, ctx) => {
  const parts = args.split(/\s+/).filter(Boolean)

  if (parts.length === 0) {
    const modes = await listPolicies()
    const lines = [B('🔐 What I may do unattended'), '']
    for (const entry of modes) {
      const mark = entry.mode === 'allow' ? '🟢' : entry.mode === 'deny' ? '🔴' : '🟡'
      lines.push(`${mark} ${B(entry.category)} — ${E(entry.mode.replace('_', ' '))}`)
      lines.push(E(`     ${CATEGORY_DESCRIPTIONS[entry.category]}`))
    }
    lines.push('')
    lines.push(E('Change one: /policy <category> allow|require_approval|deny'))
    await replyMd(ctx.chatId, lines.join('\n'))
    return
  }

  const category = (parts[0] ?? '').toLowerCase()
  const mode = (parts[1] ?? '').toLowerCase()

  if (!isPolicyCategory(category)) {
    await reply(
      ctx.chatId,
      `"${category}" is not a category. Pick one of:\n${POLICY_CATEGORIES.join(', ')}`,
    )
    return
  }
  if (!isPolicyMode(mode)) {
    await reply(ctx.chatId, `Set it to one of: ${POLICY_MODES.join(', ')}`)
    return
  }

  // These handlers refuse to run without an approved pending row, whatever
  // the policy says: `allow` would only skip the card and make every call
  // fail with "not approved". Say so instead of recording a setting that
  // silently breaks the feature.
  if (mode === 'allow' && DEADBOLTED_CATEGORIES.has(category)) {
    await reply(
      ctx.chatId,
      `${CATEGORY_LABELS[category]} always needs a tapped approval — the tool itself refuses to run ` +
        `without one, so "allow" would not let it run unattended, it would make it fail every time. ` +
        `Leaving it as it is. Use require_approval or deny.`,
    )
    return
  }

  await setPolicyMode(category, mode, ctx.actor)
  await reply(
    ctx.chatId,
    `${CATEGORY_LABELS[category]} is now "${mode.replace('_', ' ')}".`,
  )
}

const cmdRules: Handler = async (args, ctx) => {
  const [verbRaw, ...rest] = args.split(/\s+/)
  const verb = (verbRaw ?? '').toLowerCase()
  const tail = rest.join(' ').trim()

  if (verb === 'add') {
    if (!tail) {
      await reply(ctx.chatId, 'Tell me the rule: /rules add never book anything before 9am.')
      return
    }
    const inserted = await getDb()
      .insert(schema.rules)
      .values({ text: tail, source: 'manual', createdBy: ctx.actor, active: true })
      .returning({ id: schema.rules.id })
    await reply(ctx.chatId, `Rule #${inserted[0]?.id ?? '?'} added. I will follow it from now on.`)
    return
  }

  if (verb === 'remove' || verb === 'rm' || verb === 'delete') {
    const id = Number.parseInt(tail.replace(/^#/, ''), 10)
    if (!Number.isInteger(id)) {
      await reply(ctx.chatId, 'Which one? /rules remove <id>')
      return
    }
    const updated = await getDb()
      .update(schema.rules)
      .set({ active: false })
      .where(and(eq(schema.rules.id, id), eq(schema.rules.active, true)))
      .returning({ text: schema.rules.text })
    await reply(
      ctx.chatId,
      updated[0] ? `Dropped: ${updated[0].text}` : `No active rule with id ${id}.`,
    )
    return
  }

  const rows = await getDb()
    .select()
    .from(schema.rules)
    .where(eq(schema.rules.active, true))
    .orderBy(asc(schema.rules.id))
    .limit(50)

  if (rows.length === 0) {
    await replyMd(
      ctx.chatId,
      [E('No standing rules yet.'), '', E('Add one: /rules add <text>')].join('\n'),
    )
    return
  }

  const lines = [B(`📜 Standing rules (${rows.length})`), '']
  for (const row of rows) lines.push(E(`#${row.id} ${row.text}`))
  lines.push('')
  lines.push(E('/rules add <text> · /rules remove <id>'))
  await replyMd(ctx.chatId, lines.join('\n'))
}

const cmdConnectGoogle: Handler = async (args, ctx) => {
  const cfg = getConfig()
  if (!cfg.googleConfigured) {
    await reply(
      ctx.chatId,
      'Google is not configured yet. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, ' +
        'then run this again. docs/SETUP.md stage 3 has the walkthrough.',
    )
    return
  }

  /*
   * The role decides which grant the callback overwrites, so an unrecognised
   * one is refused rather than defaulted. Falling back to `personal` here would
   * mean a typo'd `/connect_google assistnat` hands over a link that files the
   * assistant's mailbox as the family's own — replacing the household's real
   * Gmail grant, which is the single mistake the two-account split exists to
   * prevent.
   */
  const asked = args.trim().toLowerCase()
  const role = asked === '' ? 'personal' : asked
  if (!isGoogleAccountRole(role)) {
    await reply(
      ctx.chatId,
      `I have no "${asked.slice(0, 40)}" account. Say /connect_google personal for ` +
        `${GOOGLE_ROLE_PURPOSE.personal} Say /connect_google assistant for ` +
        `${GOOGLE_ROLE_PURPOSE.assistant}`,
    )
    return
  }

  // The link is signed with APP_SECRET and bound to this Telegram user id AND
  // this role, so a stranger who guesses the URL cannot start a flow that
  // replaces our tokens, and a link for one account cannot be edited into the
  // other.
  const url = googleStartUrl(ctx.chatId, role)
  await reply(
    ctx.chatId,
    `Open this to link the ${role} account — ${GOOGLE_ROLE_PURPOSE[role]}\n\n` +
      `Sign in as that account and no other. The link is tied to you and stops working in ` +
      `${Math.round(START_LINK_TTL_MS / 60_000)} minutes, so do not forward it.\n\n${url}`,
  )
}

const cmdConnectSite: Handler = async (args, ctx) => {
  const cfg = getConfig()
  if (!cfg.BROWSER_ENABLED) {
    await reply(
      ctx.chatId,
      'Browser automation is off. Set BROWSER_ENABLED=true first — see docs/SETUP.md stage 5.',
    )
    return
  }

  const parts = args.split(/\s+/).filter(Boolean)
  if (parts.length < 3) {
    await reply(
      ctx.chatId,
      'Send it as one message:\n\n/connect_site <site> <username> <password>\n\n' +
        `Allowed sites: ${cfg.BROWSER_ALLOWED_DOMAINS.join(', ')}\n\n` +
        'I delete your message straight away and store the password encrypted. ' +
        'It is never echoed back and never enters the model context.',
    )
    return
  }

  const site = (parts[0] ?? '').toLowerCase()
  const username = parts[1] ?? ''
  const secret = parts.slice(2).join(' ')

  const allowed = cfg.BROWSER_ALLOWED_DOMAINS.some(
    (domain) => site === domain || site.endsWith(`.${domain}`),
  )
  if (!allowed) {
    await reply(
      ctx.chatId,
      `"${site}" is not on the allowlist. Allowed: ${cfg.BROWSER_ALLOWED_DOMAINS.join(', ')}`,
    )
    return
  }

  // Encrypt once. Two calls would mint two ciphertexts under two IVs, and only
  // one of them would ever be stored.
  const secretEncrypted = encrypt(secret)

  await getDb()
    .insert(schema.siteCredentials)
    .values({
      site,
      username,
      secretEncrypted,
      notes: `stored by ${ctx.actor}`,
    })
    .onConflictDoUpdate({
      target: schema.siteCredentials.site,
      set: {
        username,
        secretEncrypted,
        notes: `updated by ${ctx.actor}`,
      },
    })

  await reply(
    ctx.chatId,
    `Stored the ${site} login for ${username}, encrypted. I deleted your message.`,
  )
}

/* ─────────────────────── commands that need the model ────────────────────── */

const cmdSetup: Handler = async (_args, ctx) => {
  await rememberUser(ctx)
  await startSetup(ctx.chatId, ctx.actor)
}

const cmdTodo: Handler = async (args, ctx) => {
  if (!args) {
    await cmdTodos('', ctx)
    return
  }
  await enqueueAgentTurn({
    chatId: ctx.chatId,
    actor: ctx.actor,
    trigger: 'chat',
    maxTurns: 8,
    prompt:
      `Add this to the household to-do list: "${args}". Pull any due date, assignee or note out ` +
      `of the wording, add it with the to-do tool, then confirm in one short line.`,
  })
}

const cmdRemind: Handler = async (args, ctx) => {
  if (!args) {
    await cmdReminders('', ctx)
    return
  }
  await enqueueAgentTurn({
    chatId: ctx.chatId,
    actor: ctx.actor,
    trigger: 'chat',
    maxTurns: 8,
    prompt:
      `Set a reminder from this: "${args}". Resolve the time against the household timezone, ` +
      `set it up, then confirm in one short line with the exact time you scheduled.`,
  })
}

const cmdBrief: Handler = async (_args, ctx) => {
  await morningBrief('command')
}

const cmdReview: Handler = async (_args, ctx) => {
  await weeklyReview('command')
}

const cmdMealprep: Handler = async (args, ctx) => {
  const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(args.trim()) ? args.trim() : undefined
  await mealPrep('command', weekStart === undefined ? undefined : { weekStart })
}

const cmdBook: Handler = async (args, ctx) => {
  if (!args) {
    await reply(
      ctx.chatId,
      'What should I book? For example: /book a table for four at Nopa on Friday at 7.',
    )
    return
  }
  await bookSomething(args)
}

const cmdCall: Handler = async (args, ctx) => {
  if (!args) {
    await reply(ctx.chatId, 'Who should I call, and what for? /call dentist reschedule Thursday')
    return
  }

  // "dentist: move Thursday" and "dentist move Thursday" both work. The split
  // lives in the workflow so the slash command and the router agree on it.
  const { who, goal } = splitCallRequest(args)

  if (!goal) {
    await reply(ctx.chatId, `What should I say to ${who}? /call ${who}: <what you want>`)
    return
  }
  await callSomeone(who, goal)
}

const cmdImprove: Handler = async (args, ctx) => {
  if (!args) {
    await reply(
      ctx.chatId,
      'What should change? /improve remind me about bin day the night before',
    )
    return
  }

  const context =
    `Requested by ${ctx.actor} over Telegram on ${DateTime.now().setZone(zone()).toISO() ?? ''}. ` +
    `The assistant files this for a human to build; it never edits its own running code.`

  const result = await fileImprovement(args, context)
  if ('url' in result) {
    await reply(ctx.chatId, `Filed it. A human picks it up from here.\n\n${result.url}`)
    return
  }
  await reply(ctx.chatId, `I could not file that: ${result.error}`)
}

/* ───────────────────────────────── dispatch ──────────────────────────────── */

/**
 * Start a fresh agent session for this chat.
 *
 * The turn runner resumes `conversations.agent_session_id` on every turn, which
 * is what lets either spouse pick up where the other left off. The cost is that
 * a wrong conclusion sticks: after a spell of genuine tool failures the model
 * kept telling the household "the tool layer is down" and stopped calling any
 * tool to check — long after the cause was fixed and deployed. Nothing in the
 * transcript ever contradicted it, because it never tried again.
 *
 * Dropping the session id is the whole fix. The next turn starts clean, and
 * everything that actually matters — memories, to-dos, reminders, contacts,
 * policies, rules, approvals — lives in Postgres and is untouched.
 */
const cmdReset: Handler = async (_args, ctx) => {
  const cleared = await getDb()
    .update(schema.conversations)
    .set({ agentSessionId: null })
    .where(eq(schema.conversations.telegramChatId, ctx.chatId))
    .returning({ id: schema.conversations.id })

  if (cleared.length === 0) {
    await reply(ctx.chatId, 'Nothing to reset — this chat has no conversation on file yet.')
    return
  }

  await audit({
    actor: ctx.actor,
    event: 'conversation.reset',
    category: 'read',
    resultSummary: `chat ${ctx.chatId}: agent session cleared`,
    ok: true,
  })

  await reply(
    ctx.chatId,
    'Fresh start. I have dropped this conversation\'s history, so I am no longer carrying ' +
      'anything I concluded earlier. Your to-dos, reminders, contacts, memories and rules are ' +
      'all untouched — those live in the database, not in the conversation.',
  )
}

const HANDLERS: Record<string, Handler> = {
  start: cmdStart,
  help: cmdHelp,
  setup: cmdSetup,
  status: cmdStatus,
  brief: cmdBrief,
  review: cmdReview,
  todo: cmdTodo,
  todos: cmdTodos,
  done: cmdDone,
  remind: cmdRemind,
  reminders: cmdReminders,
  mealprep: cmdMealprep,
  book: cmdBook,
  call: cmdCall,
  approve: cmdApprove,
  policy: cmdPolicy,
  rules: cmdRules,
  improve: cmdImprove,
  connect_google: cmdConnectGoogle,
  connect_site: cmdConnectSite,
  cancel: cmdCancel,
  reset: cmdReset,
}

/** Every command name the bot answers to, in menu order. */
export const COMMAND_NAMES: readonly string[] = Object.keys(HANDLERS)

/** What Telegram shows in the slash menu. */
export const COMMAND_MENU: ReadonlyArray<{ command: string; description: string }> = [
  { command: 'brief', description: 'Today at a glance' },
  { command: 'todos', description: 'Open to-dos' },
  { command: 'todo', description: 'Add a to-do' },
  { command: 'done', description: 'Finish a to-do' },
  { command: 'remind', description: 'Set a reminder' },
  { command: 'reminders', description: 'Scheduled reminders' },
  { command: 'review', description: 'The weekly review' },
  { command: 'mealprep', description: 'Plan the week and the groceries' },
  { command: 'book', description: 'Find it, confirm it, book it' },
  { command: 'call', description: 'Place a phone call' },
  { command: 'approve', description: 'Approvals waiting on you' },
  { command: 'cancel', description: 'Cancel the wizard or an approval' },
  { command: 'policy', description: 'What I may do unattended' },
  { command: 'rules', description: 'Standing instructions' },
  { command: 'status', description: 'What is connected and healthy' },
  { command: 'setup', description: 'The onboarding interview' },
  { command: 'connect_google', description: 'Link Gmail and Calendar' },
  { command: 'connect_site', description: 'Store a site login' },
  { command: 'improve', description: 'File a change request' },
  { command: 'reset', description: 'Start a fresh conversation' },
  { command: 'help', description: 'Everything I answer to' },
]

/**
 * Runs one slash command.
 *
 * Returns true when the command was recognised and handled — including when it
 * failed, because the user has already been told. Returns false only for an
 * unknown command, which the caller turns into an ordinary chat turn.
 */
export async function handleCommand(
  cmd: string,
  args: string,
  ctx: { chatId: string; actor: string },
): Promise<boolean> {
  const name = normalizeCommand(cmd)
  const handler = HANDLERS[name]
  if (!handler) return false

  const trimmed = (args ?? '').trim()
  try {
    await handler(trimmed, ctx)
  } catch (err) {
    log.error({ cmd: name, actor: ctx.actor, err: describe(err) }, 'command failed')
    // Never echo the failure of a command that carried a secret. A driver or
    // validation error can quote the statement it choked on, and for
    // /connect_site that statement holds the password we just promised to
    // store encrypted and never repeat. The detail is in the log either way.
    const detail = SECRET_COMMANDS.has(name)
      ? 'something went wrong. Nothing was stored. The detail is in the server log.'
      : describe(err).slice(0, 300)
    await reply(ctx.chatId, `/${name} failed: ${detail}`)
  }
  return true
}
