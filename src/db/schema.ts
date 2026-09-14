import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  date,
  jsonb,
  doublePrecision,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core'

/* ────────────────────────────── household & people ───────────────────────── */

export const households = pgTable('households', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().default('Household'),
  /**
   * What the assistant calls itself. One row, one name, so Telegram, the phone
   * and the standing brief cannot drift into three different assistants.
   * Household-authored through /setup, so every consumer flattens it before it
   * reaches a prompt.
   */
  assistantName: text('assistant_name').notNull().default('Chessy'),
  timezone: text('timezone').notNull().default('America/Los_Angeles'),
  familyCalendarId: text('family_calendar_id'),
  quietHoursStart: integer('quiet_hours_start').notNull().default(21),
  quietHoursEnd: integer('quiet_hours_end').notNull().default(7),
  briefHour: integer('brief_hour').notNull().default(7),
  setupCompletedAt: timestamp('setup_completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    telegramUserId: text('telegram_user_id').notNull(),
    displayName: text('display_name').notNull(),
    googleConnected: boolean('google_connected').notNull().default(false),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_telegram_user_id_uq').on(t.telegramUserId)],
)

export const conversations = pgTable(
  'conversations',
  {
    id: serial('id').primaryKey(),
    telegramChatId: text('telegram_chat_id').notNull(),
    agentSessionId: text('agent_session_id'),
    summary: text('summary'),
    lastTurnAt: timestamp('last_turn_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('conversations_chat_uq').on(t.telegramChatId)],
)

/* ─────────────────────────────── policy & approvals ──────────────────────── */

/** Every tool declares one of these. The policy engine maps category -> mode. */
export const POLICY_CATEGORIES = [
  'read',
  'memory_write',
  'todo_write',
  'reminder_write',
  'recipe_write',
  'calendar_write',
  'calendar_write_from_watcher',
  'email_send',
  'phone_call',
  'sms_send',
  'purchase',
  'booking_cancel',
  'browser_task',
] as const
export type PolicyCategory = (typeof POLICY_CATEGORIES)[number]

export const POLICY_MODES = ['allow', 'require_approval', 'deny'] as const
export type PolicyMode = (typeof POLICY_MODES)[number]

export const policies = pgTable(
  'policies',
  {
    id: serial('id').primaryKey(),
    category: text('category').notNull(),
    mode: text('mode').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by'),
  },
  (t) => [uniqueIndex('policies_category_uq').on(t.category)],
)

export const PENDING_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'executed',
  'failed',
] as const

export const pendingActions = pgTable(
  'pending_actions',
  {
    id: serial('id').primaryKey(),
    toolName: text('tool_name').notNull(),
    /** Byte-for-byte the args the human approved. The executor replays THESE. */
    argsJson: jsonb('args_json').notNull(),
    category: text('category').notNull(),
    humanSummary: text('human_summary').notNull(),
    status: text('status').notNull().default('pending'),
    requestedBy: text('requested_by'),
    resolvedBy: text('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    executionResult: jsonb('execution_result'),
    telegramChatId: text('telegram_chat_id'),
    telegramMessageIds: jsonb('telegram_message_ids'),
    conversationId: integer('conversation_id'),
    agentSessionId: text('agent_session_id'),
    /** Set when a watcher/subagent, not the orchestrator, requested it. */
    origin: text('origin').notNull().default('agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('pending_actions_status_idx').on(t.status),
    index('pending_actions_expires_idx').on(t.expiresAt),
  ],
)

export const auditLog = pgTable(
  'audit_log',
  {
    id: serial('id').primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    actor: text('actor').notNull(),
    event: text('event').notNull(),
    category: text('category'),
    toolName: text('tool_name'),
    argsJson: jsonb('args_json'),
    resultSummary: text('result_summary'),
    ok: boolean('ok').notNull().default(true),
    pendingActionId: integer('pending_action_id'),
  },
  (t) => [index('audit_log_ts_idx').on(t.ts), index('audit_log_event_idx').on(t.event)],
)

/* ────────────────────────────── household state ──────────────────────────── */

export const todos = pgTable(
  'todos',
  {
    id: serial('id').primaryKey(),
    title: text('title').notNull(),
    notes: text('notes'),
    status: text('status').notNull().default('open'),
    assignee: text('assignee'),
    dueDate: text('due_date'),
    source: text('source').notNull().default('chat'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [index('todos_status_idx').on(t.status)],
)

export const reminders = pgTable(
  'reminders',
  {
    id: serial('id').primaryKey(),
    text: text('text').notNull(),
    fireAt: timestamp('fire_at', { withTimezone: true }).notNull(),
    recurrence: text('recurrence'),
    bossJobId: text('boss_job_id'),
    telegramChatId: text('telegram_chat_id').notNull(),
    status: text('status').notNull().default('scheduled'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('reminders_fire_at_idx').on(t.fireAt), index('reminders_status_idx').on(t.status)],
)

export const followups = pgTable(
  'followups',
  {
    id: serial('id').primaryKey(),
    description: text('description').notNull(),
    nextNagAt: timestamp('next_nag_at', { withTimezone: true }),
    nagCount: integer('nag_count').notNull().default(0),
    status: text('status').notNull().default('open'),
    relatedTodoId: integer('related_todo_id'),
    telegramChatId: text('telegram_chat_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [index('followups_next_nag_idx').on(t.nextNagAt), index('followups_status_idx').on(t.status)],
)

export const memoryFacts = pgTable(
  'memory_facts',
  {
    id: serial('id').primaryKey(),
    subject: text('subject').notNull(),
    category: text('category').notNull().default('general'),
    fact: text('fact').notNull(),
    active: boolean('active').notNull().default(true),
    source: text('source').notNull().default('chat'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('memory_facts_subject_idx').on(t.subject), index('memory_facts_active_idx').on(t.active)],
)

/** Behaviour rules injected into every system prompt. Managed via /rules. */
export const rules = pgTable(
  'rules',
  {
    id: serial('id').primaryKey(),
    text: text('text').notNull(),
    active: boolean('active').notNull().default(true),
    source: text('source').notNull().default('manual'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rules_active_idx').on(t.active)],
)

export const contacts = pgTable(
  'contacts',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    role: text('role'),
    phone: text('phone'),
    email: text('email'),
    address: text('address'),
    notes: text('notes'),
    /**
     * A calendar day, never a timestamp: giving a birthday a time invites a
     * timezone to shift it across midnight. Age is derived from this at read
     * time and is never stored, because a stored age is wrong within a year
     * and nothing would notice.
     */
    birthday: date('birthday'),
    /**
     * The people who live here. A household contact is reference data — their
     * number exists so Chessy can give it to a doctor's office — and is never
     * a valid target for a call or a text.
     *
     * Explicit rather than inferred from `role`, which is free text: "wife"
     * and "spouse" are one person to the household and two strings to a LIKE,
     * and a guardrail that depends on spelling is not a guardrail.
     */
    household: boolean('household').notNull().default(false),
    /**
     * Set when Twilio reports this number has replied STOP (error 21610).
     *
     * Twilio enforces the opt-out itself and will refuse every later send, so
     * this column is not the enforcement — it is the memory of it, which is
     * what lets Chessy refuse before spending a request and tell the household
     * why. It is never cleared by the assistant: only the person who opted out
     * can undo it, by texting START to the number.
     */
    smsOptedOutAt: timestamp('sms_opted_out_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('contacts_role_idx').on(t.role)],
)

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

/**
 * Standing instructions that ride along with every shopping list.
 *
 * The list is pasted into a grocery app whose importer is an AI assistant, not
 * a parser — it reads the whole message, so instructions in it are obeyed. That
 * makes brand and quality preferences a matter of text the household owns
 * rather than a matter of code, which is the point: these change when a
 * household's taste changes, and that must never need a deploy.
 *
 * Stored as separate rows rather than one blob so a single preference can be
 * dropped without restating the rest.
 */
export const shoppingPreferences = pgTable(
  'shopping_preferences',
  {
    id: serial('id').primaryKey(),
    /** One instruction, in the household's own words. */
    text: text('text').notNull(),
    /** Lower numbers are stated first. The ordering is part of the instruction. */
    position: integer('position').notNull().default(100),
    active: boolean('active').notNull().default(true),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('shopping_preferences_active_idx').on(t.active)],
)

/**
 * One approved errand, conducted by text.
 *
 * A thread is the unit of bounded autonomy. An approved `sms_send` opens one
 * carrying the goal it was approved for; inside the cap and the window Chessy
 * replies without asking again, the way the voice agent converses freely inside
 * one approved call. Outside them the thread closes and inbound messages are
 * relayed to the household instead of answered.
 *
 * That boundary is the safety property of the whole feature. A call ends when
 * someone hangs up; a text thread would otherwise stay open for days, and an
 * errand approved on Tuesday would become a standing licence to correspond.
 */
export const smsThreads = pgTable(
  'sms_threads',
  {
    id: serial('id').primaryKey(),
    contactId: integer('contact_id').notNull(),
    /** E.164, denormalised so an inbound message can find its thread by number. */
    phone: text('phone').notNull(),
    /** What this exchange was approved to accomplish. Never widened afterwards. */
    goal: text('goal').notNull(),
    /** open | closed */
    status: text('status').notNull().default('open'),
    /** Why it closed, for the household and the audit trail. */
    closedReason: text('closed_reason'),
    /** The approval that opened it. */
    pendingActionId: integer('pending_action_id'),
    /** Telegram chat to report back to. */
    telegramChatId: text('telegram_chat_id'),
    /** Both directions count against the cap. */
    messageCount: integer('message_count').notNull().default(0),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [index('sms_threads_phone_idx').on(t.phone), index('sms_threads_status_idx').on(t.status)],
)

/** Every message either way. The record is always complete, even when nobody was notified. */
export const smsMessages = pgTable(
  'sms_messages',
  {
    id: serial('id').primaryKey(),
    threadId: integer('thread_id').notNull(),
    /** inbound | outbound */
    direction: text('direction').notNull(),
    body: text('body').notNull(),
    /** Twilio's message id. Also the idempotency key for a redelivered webhook. */
    twilioSid: text('twilio_sid'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sms_messages_thread_idx').on(t.threadId),
    uniqueIndex('sms_messages_sid_uq').on(t.twilioSid),
  ],
)

/* ─────────────────────────────────── watchers ────────────────────────────── */

export const watchers = pgTable(
  'watchers',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    config: jsonb('config').notNull(),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastError: text('last_error'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('watchers_active_idx').on(t.active)],
)

export const extractedEvents = pgTable(
  'extracted_events',
  {
    id: serial('id').primaryKey(),
    watcherId: integer('watcher_id').notNull(),
    sourceRef: text('source_ref').notNull(),
    contentHash: text('content_hash').notNull(),
    title: text('title').notNull(),
    eventDate: text('event_date'),
    eventTime: text('event_time'),
    kind: text('kind').notNull().default('event'),
    calendarEventId: text('calendar_event_id'),
    todoId: integer('todo_id'),
    reminderId: integer('reminder_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('extracted_events_hash_uq').on(t.contentHash)],
)

/* ──────────────────────────── integrations & secrets ─────────────────────── */

/**
 * Two connected Google accounts, distinguished by role:
 *
 *  - `personal`  — Alex's own Gmail. Read-mostly: the daycare watchers, inbox
 *    triage and the morning brief all need to see what actually arrives.
 *  - `assistant` — the assistant's own Workspace mailbox on the family domain.
 *    This is what it sends as, and where replies to its mail come back, so its
 *    correspondence never drowns in a human's inbox.
 *
 * Unique on role, not on user: the household has exactly one of each.
 */
export const GOOGLE_ACCOUNT_ROLES = ['personal', 'assistant'] as const
export type GoogleAccountRole = (typeof GOOGLE_ACCOUNT_ROLES)[number]

export const googleTokens = pgTable(
  'google_tokens',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull(),
    role: text('role').notNull().default('personal'),
    email: text('email'),
    refreshTokenEncrypted: text('refresh_token_encrypted').notNull(),
    scope: text('scope'),
    invalid: boolean('invalid').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('google_tokens_role_uq').on(t.role)],
)

export const oauthStates = pgTable('oauth_states', {
  id: serial('id').primaryKey(),
  state: text('state').notNull(),
  telegramUserId: text('telegram_user_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const siteCredentials = pgTable(
  'site_credentials',
  {
    id: serial('id').primaryKey(),
    site: text('site').notNull(),
    username: text('username').notNull(),
    secretEncrypted: text('secret_encrypted').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('site_credentials_site_uq').on(t.site)],
)

/* ───────────────────────────────── phone calls ───────────────────────────── */

export const callRecords = pgTable(
  'call_records',
  {
    id: serial('id').primaryKey(),
    vapiCallId: text('vapi_call_id'),
    goal: text('goal').notNull(),
    calleeName: text('callee_name'),
    calleeNumber: text('callee_number').notNull(),
    status: text('status').notNull().default('queued'),
    transcript: text('transcript'),
    summary: text('summary'),
    structuredData: jsonb('structured_data'),
    success: boolean('success'),
    costUsd: doublePrecision('cost_usd'),
    dryRun: boolean('dry_run').notNull().default(false),
    conversationId: integer('conversation_id'),
    agentSessionId: text('agent_session_id'),
    pendingActionId: integer('pending_action_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('call_records_vapi_id_uq').on(t.vapiCallId)],
)

/* ──────────────────────────────── observability ──────────────────────────── */

export const turnMetrics = pgTable(
  'turn_metrics',
  {
    id: serial('id').primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    model: text('model'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    numTurns: integer('num_turns').notNull().default(0),
    trigger: text('trigger').notNull().default('chat'),
    ok: boolean('ok').notNull().default(true),
  },
  (t) => [index('turn_metrics_ts_idx').on(t.ts)],
)

/* ───────────────────────── setup wizard (state machine) ──────────────────── */

export const setupState = pgTable(
  'setup_state',
  {
    id: serial('id').primaryKey(),
    telegramChatId: text('telegram_chat_id').notNull(),
    stepId: text('step_id').notNull(),
    answers: jsonb('answers').notNull().default({}),
    active: boolean('active').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('setup_state_chat_uq').on(t.telegramChatId)],
)

/* ──────────────────── recipes / meal plans (ported in-house) ─────────────── */

export const recipes = pgTable(
  'recipes',
  {
    id: serial('id').primaryKey(),
    title: text('title').notNull(),
    source: text('source').notNull().default('manual'),
    sourceUrl: text('source_url').notNull(),
    author: text('author'),
    description: text('description'),
    totalTimeMinutes: integer('total_time_minutes'),
    activeTimeMinutes: integer('active_time_minutes'),
    servings: text('servings'),
    difficulty: text('difficulty'),
    ingredients: jsonb('ingredients').notNull().default([]),
    steps: jsonb('steps').notNull().default([]),
    familyScore: integer('family_score'),
    familyNotes: text('family_notes'),
    tags: jsonb('tags').notNull().default([]),
    groceryCategories: jsonb('grocery_categories'),
    imageUrl: text('image_url'),
    scrapedAt: timestamp('scraped_at', { withTimezone: true }).notNull().defaultNow(),
    timesPlanned: integer('times_planned').notNull().default(0),
    lastPlannedDate: text('last_planned_date'),
    isArchived: boolean('is_archived').notNull().default(false),
    freshnessCategory: text('freshness_category').notNull().default('moderate'),
    freezerFriendly: boolean('freezer_friendly').notNull().default(false),
  },
  (t) => [
    uniqueIndex('recipes_source_url_uq').on(t.sourceUrl),
    index('recipes_family_score_idx').on(t.familyScore),
    index('recipes_archived_idx').on(t.isArchived),
  ],
)

export const mealPlans = pgTable(
  'meal_plans',
  {
    id: serial('id').primaryKey(),
    weekStart: text('week_start').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('meal_plans_week_idx').on(t.weekStart)],
)

export const mealPlanItems = pgTable(
  'meal_plan_items',
  {
    id: serial('id').primaryKey(),
    planId: integer('plan_id').notNull(),
    recipeId: integer('recipe_id').notNull(),
    dayOfWeek: integer('day_of_week').notNull(),
    mealType: text('meal_type').notNull().default('dinner'),
    servingsOverride: text('servings_override'),
    notes: text('notes'),
  },
  (t) => [uniqueIndex('meal_plan_items_slot_uq').on(t.planId, t.dayOfWeek, t.mealType)],
)

export const groceryLists = pgTable(
  'grocery_lists',
  {
    id: serial('id').primaryKey(),
    planId: integer('plan_id').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    items: jsonb('items').notNull().default({}),
    checkedItems: jsonb('checked_items').notNull().default([]),
    /** SHA-256 of the consolidated rows the Claude pass was run on. */
    sourceHash: text('source_hash'),
    /**
     * The two trips as the Claude pass returned them, `{ weekend, midweek,
     * refined: true }`, or null when the pass was skipped. Read back only when
     * `source_hash` still matches, so a tap on the card never pays for a call.
     */
    refined: jsonb('refined'),
  },
  (t) => [index('grocery_lists_plan_idx').on(t.planId)],
)
