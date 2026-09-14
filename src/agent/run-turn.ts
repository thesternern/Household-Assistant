import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { ModelUsage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { eq } from 'drizzle-orm'
import { getConfig } from '../config.js'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { getBot, sendToChat } from '../telegram/send.js'
import { allTools, buildHouseholdMcpServer } from '../tools/registry.js'
import { qualifiedName } from '../tools/types.js'
import type { ToolContext, ToolDef, ToolOrigin } from '../tools/types.js'
import { MODEL_DRIVEN_ORIGINS, buildHooks } from './hooks.js'
import { buildContextPreamble, buildSystemPrompt } from './orchestrator.js'

/**
 * The one and only place in this codebase that calls `query()`.
 *
 * Everything a turn needs is assembled here — system prompt, Postgres context
 * preamble, household MCP server, the policy hooks — and everything
 * a turn produces is recorded here: the resumable session id, a `turn_metrics`
 * row, and the reply on Telegram.
 *
 * The contract with its callers is that it does not throw. A turn that blows up
 * writes a failed metrics row, tells the household plainly, and returns
 * `ok: false`. The worker keeps running.
 */

const log = logger.child({ mod: 'run-turn' })

export interface TurnInput {
  chatId: string
  actor: string
  prompt: string
  trigger?: 'chat' | 'cron' | 'approval' | 'watcher' | 'call' | 'workflow'
  systemAppend?: string
  resume?: boolean
  maxTurns?: number
  origin?: ToolOrigin
}

export interface TurnResult {
  text: string
  sessionId: string | null
  costUsd: number
  ok: boolean
}

/**
 * Tools removed from the model's context entirely. This is a household
 * assistant, not a coding agent: it has no business with a shell or a
 * filesystem, and its own to-do list lives in Postgres, not in TodoWrite.
 */
export const DISALLOWED_TOOLS = [
  // Delegation. There are no subagent definitions to delegate TO: the only
  // thing `Agent` could still spawn is a built-in general-purpose agent, which
  // is a turn whose prompt and tool list nobody here chose. `Task` is the
  // legacy alias; both are named because it is not documented which one this
  // CLI matches against, and the PreToolUse hook denies both as well.
  'Agent',
  'Bash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'TodoWrite',
  'KillShell',
  'BashOutput',
  'Task',
] as const

/** Non-household tools the orchestrator may use. Both are read-only web lookups. */
export const WEB_TOOLS = ['WebSearch', 'WebFetch'] as const

/**
 * Process environment variables never handed to the agent subprocess.
 *
 * The child is the Claude Code CLI. It needs `PATH`, `HOME`, and the Anthropic
 * credentials; it has no use for this application's database URL, its
 * encryption key, or the tokens that let it speak as the household. Passing
 * them costs nothing and buys nothing, so it does not happen.
 */
const WITHHELD_ENV_KEYS: ReadonlySet<string> = new Set([
  'APP_SECRET',
  'DATABASE_URL',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'VAPI_API_KEY',
  'VAPI_WEBHOOK_SECRET',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_ACCOUNT_SID',
  'GITHUB_TOKEN',
])

/**
 * The shape of a secret's name. A denylist has to be extended by hand every
 * time a credential is added, and it fell behind once (the Twilio token). This
 * catches the next one by its name; the set above still documents the known
 * ones. The one key the CLI genuinely needs is exempted by name.
 */
const SECRET_SHAPED_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|_KEY$|DATABASE_URL|_DSN$)/i
const CHILD_NEEDS: ReadonlySet<string> = new Set(['ANTHROPIC_API_KEY'])

/** True when this environment variable stays with the parent process. */
export function isWithheldEnvKey(key: string): boolean {
  if (CHILD_NEEDS.has(key)) return false
  return WITHHELD_ENV_KEYS.has(key) || SECRET_SHAPED_KEY.test(key)
}

const DEFAULT_MAX_TURNS = 24
/** A caller that asks for no turns has asked for a broken turn. */
const MIN_MAX_TURNS = 1
const MAX_MAX_TURNS = 100
/** Telegram clears a chat action after ~5s, so refresh just inside that. */
const TYPING_INTERVAL_MS = 4500

const GENERIC_FAILURE =
  'Something broke on my end and I could not finish that. Nothing was changed. ' +
  'Try again in a moment.'

type QueryOptions = NonNullable<Parameters<typeof query>[0]['options']>

interface Usage {
  model: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

const EMPTY_USAGE: Usage = {
  model: null,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
}

interface Attempt {
  ok: boolean
  text: string
  sessionId: string | null
  costUsd: number
  numTurns: number
  usage: Usage
  /** Null on success; a short machine-ish reason otherwise. */
  failure: string | null
}

/* ────────────────────────────────── helpers ──────────────────────────────── */

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err) ?? String(err)
  } catch {
    return String(err)
  }
}

function intOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

function floatOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Fold per-model usage into one row. The reported model is whichever model did
 * the most token work, which is the one worth seeing on a cost breakdown.
 */
function sumUsage(modelUsage: Record<string, ModelUsage> | undefined): Usage {
  if (!modelUsage) return { ...EMPTY_USAGE }
  const total: Usage = { ...EMPTY_USAGE }
  let dominantTokens = -1

  for (const [model, usage] of Object.entries(modelUsage)) {
    if (!usage) continue
    const input = intOf(usage.inputTokens)
    const output = intOf(usage.outputTokens)
    total.inputTokens += input
    total.outputTokens += output
    total.cacheReadTokens += intOf(usage.cacheReadInputTokens)
    total.cacheCreationTokens += intOf(usage.cacheCreationInputTokens)
    if (input + output > dominantTokens) {
      dominantTokens = input + output
      total.model = model
    }
  }
  return total
}

/**
 * A stored session the CLI can no longer find. Worth exactly one retry.
 *
 * The bar is deliberately high. A retry re-runs the whole prompt, so anything
 * the first attempt already did — a to-do added, a fact saved, an approval card
 * put out — happens a second time. Only a start-up failure qualifies: the
 * attempt must have completed zero turns (so it can have done nothing), and the
 * message must name the session lookup rather than merely contain the word
 * "session" somewhere in a model-authored error string.
 *
 * The failure text is examined wherever it arrived: a rejected `query()` puts
 * it on `failure` directly, and a success-subtype result with `is_error` puts
 * the error text in `result`, which `applyResult` copies onto `failure`. An
 * earlier version also required `attempt.text === ''`, which silently refused
 * the retry in that second shape — and because `resumeLost` then stayed false,
 * the stale session id was never cleared and every later turn for the chat
 * failed the same way.
 *
 * Exported for tests only.
 */
export const LOST_SESSION_RE =
  /(no conversation found|session .{0,40}not found|not found.{0,40}session|could not (?:find|resume|load)|failed to (?:find|resume|load)|invalid session|unknown session|no such session|--resume)/i

/** Exported for tests only. */
export function looksLikeLostSession(attempt: {
  failure: string | null
  numTurns: number
}): boolean {
  if (attempt.failure === null) return false
  if (attempt.numTurns > 0) return false
  return LOST_SESSION_RE.test(attempt.failure)
}

function clampTurns(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_MAX_TURNS
  return Math.min(MAX_MAX_TURNS, Math.max(MIN_MAX_TURNS, Math.round(requested)))
}

/** `process.env` with this application's own secrets removed. */
function childEnv(configDir: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (isWithheldEnvKey(key)) continue
    out[key] = value
  }
  // Keep the SDK's session store on the mounted volume so `resume` survives a
  // redeploy alongside the Postgres state.
  out['CLAUDE_CONFIG_DIR'] = configDir
  return out
}

/** Plain English for a turn that did not produce an answer. */
function failureReply(failure: string | null): string {
  if (failure && /max_turns/i.test(failure)) {
    return 'I ran out of steps before I finished that. Ask me again and I will pick it up.'
  }
  if (failure && /max_budget/i.test(failure)) {
    return 'I hit the spend limit for this turn before finishing. Nothing was changed.'
  }
  return GENERIC_FAILURE
}

/**
 * Working directory for the agent process. Never the repository: a household
 * turn has no business anywhere near this source tree.
 */
async function scratchDir(configDir: string): Promise<string> {
  const preferred = join(configDir, 'scratch')
  try {
    await mkdir(preferred, { recursive: true })
    return preferred
  } catch (err) {
    const fallback = join(tmpdir(), 'home-assistant-scratch')
    log.warn({ err, preferred, fallback }, 'scratch directory unavailable, using a temp dir')
    await mkdir(fallback, { recursive: true })
    return fallback
  }
}

/**
 * Telegram's "typing…" indicator. It expires on its own after about five
 * seconds, so "clearing" it is simply ceasing to refresh it — which the
 * returned stop function does.
 */
function startTyping(chatId: string): () => void {
  let stopped = false

  const ping = async (): Promise<void> => {
    if (stopped) return
    try {
      await getBot().api.sendChatAction(chatId, 'typing')
    } catch (err) {
      log.debug({ err, chatId }, 'typing indicator failed')
    }
  }

  void ping()
  const timer = setInterval(() => void ping(), TYPING_INTERVAL_MS)
  // Never hold the process open for a chat action.
  if (typeof timer.unref === 'function') timer.unref()

  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }
}

/* ───────────────────────────────── persistence ───────────────────────────── */

type ConversationRow = typeof schema.conversations.$inferSelect

async function loadOrCreateConversation(chatId: string): Promise<ConversationRow> {
  const db = getDb()

  const existing = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.telegramChatId, chatId))
    .limit(1)
  const found = existing[0]
  if (found) return found

  // onConflictDoUpdate rather than DoNothing so a concurrent insert still
  // returns the row instead of an empty result.
  const inserted = await db
    .insert(schema.conversations)
    .values({ telegramChatId: chatId })
    .onConflictDoUpdate({
      target: schema.conversations.telegramChatId,
      set: { telegramChatId: chatId },
    })
    .returning()

  const created = inserted[0]
  if (created) return created
  throw new Error(`could not load or create the conversation row for chat ${chatId}`)
}

/**
 * @param clearStale drop the stored session id when this turn produced no
 * replacement. Set after a resume failure, so the next turn does not spend
 * another attempt on a session the SDK no longer has.
 */
async function persistSession(
  conversationId: number,
  sessionId: string | null,
  clearStale = false,
): Promise<void> {
  try {
    const session = sessionId ? { agentSessionId: sessionId } : clearStale ? { agentSessionId: null } : {}
    await getDb()
      .update(schema.conversations)
      .set({ ...session, lastTurnAt: new Date() })
      .where(eq(schema.conversations.id, conversationId))
  } catch (err) {
    log.error({ err, conversationId }, 'failed to persist the agent session id')
  }
}

async function writeMetrics(row: {
  usage: Usage
  costUsd: number
  durationMs: number
  numTurns: number
  trigger: string
  ok: boolean
  fallbackModel: string | null
}): Promise<void> {
  try {
    await getDb()
      .insert(schema.turnMetrics)
      .values({
        model: row.usage.model ?? row.fallbackModel,
        inputTokens: row.usage.inputTokens,
        outputTokens: row.usage.outputTokens,
        cacheReadTokens: row.usage.cacheReadTokens,
        cacheCreationTokens: row.usage.cacheCreationTokens,
        costUsd: row.costUsd,
        durationMs: intOf(row.durationMs),
        numTurns: row.numTurns,
        trigger: row.trigger,
        ok: row.ok,
      })
  } catch (err) {
    // Losing a metrics row must not lose the turn it was describing.
    log.error({ err, trigger: row.trigger }, 'failed to write turn metrics')
  }
}

/* ──────────────────────────────── the query call ─────────────────────────── */

function applyResult(attempt: Attempt, message: SDKResultMessage): void {
  attempt.sessionId = message.session_id ?? attempt.sessionId
  attempt.costUsd = floatOf(message.total_cost_usd)
  attempt.numTurns = intOf(message.num_turns)
  attempt.usage = sumUsage(message.modelUsage)

  if (message.subtype === 'success') {
    attempt.ok = message.is_error !== true
    attempt.text = (message.result ?? '').trim()
    attempt.failure = attempt.ok ? null : attempt.text || 'the model reported an error'
    return
  }

  const errors = Array.isArray(message.errors) ? message.errors.filter(Boolean).join('; ') : ''
  attempt.ok = false
  attempt.text = ''
  attempt.failure = errors ? `${message.subtype}: ${errors}` : message.subtype
}

/** One pass through the agent loop. Never throws; failures come back on `failure`. */
async function runQuery(
  prompt: string,
  base: QueryOptions,
  resume: string | undefined,
): Promise<Attempt> {
  const options: QueryOptions = resume === undefined ? { ...base } : { ...base, resume }
  const attempt: Attempt = {
    ok: false,
    text: '',
    sessionId: null,
    costUsd: 0,
    numTurns: 0,
    usage: { ...EMPTY_USAGE },
    failure: 'the agent produced no result message',
  }

  try {
    for await (const message of query({ prompt, options })) {
      if (message.type === 'result') applyResult(attempt, message)
    }
  } catch (err) {
    attempt.ok = false
    attempt.failure = errorMessage(err)
    log.error({ err, resumed: resume !== undefined }, 'agent query threw')
  }

  return attempt
}

/* ───────────────────────────────── the turn ──────────────────────────────── */

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const startedAt = Date.now()
  const trigger = input.trigger ?? 'chat'
  const turnLog = log.child({ chatId: input.chatId, actor: input.actor, trigger })

  let stopTyping: () => void = () => {}
  let fallbackModel: string | null = null

  try {
    const cfg = getConfig()
    fallbackModel = cfg.DEFAULT_MODEL

    // Start the indicator before the context reads, so the household sees
    // "typing…" while the preamble is still being assembled.
    stopTyping = startTyping(input.chatId)

    const conversation = await loadOrCreateConversation(input.chatId)

    const ctx: ToolContext = {
      chatId: input.chatId,
      actor: input.actor,
      origin: input.origin ?? 'agent',
      conversationId: conversation.id,
      agentSessionId: conversation.agentSessionId ?? undefined,
    }

    const systemPrompt = [
      await buildSystemPrompt({ actor: input.actor }),
      await buildContextPreamble(),
      input.systemAppend?.trim() ? input.systemAppend.trim() : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join('\n\n')

    /*
     * `allowedTools` is the SDK's AUTO-APPROVE list, not a restriction on what
     * exists — the doc comment on the option says so, and `disallowedTools` is
     * what removes a tool. So a consequential tool listed here would execute
     * without a permission check on any path where the PreToolUse hook fails to
     * answer: a hook timeout, an SDK-side hook error, a future refactor. That is
     * an email sent, a call placed, or money spent with nobody's consent.
     *
     * Only harmless tools are auto-approved. Consequential tools stay fully
     * reachable — the gate's own `permissionDecision: 'allow'` outranks the
     * permission system — but the gate is the ONLY thing that can let one run.
     *
     * `calendar_write_from_watcher` is the one category where "harmless" depends
     * on who is asking. It is seeded to `allow` because a watcher needs a cheap
     * write path; `decide()` re-reads it as `calendar_write` for anybody else,
     * precisely so a prompt injection in a mail body cannot name the watcher
     * tool to skip the calendar approval. Auto-approving it for a non-watcher
     * turn would hand that bypass back on any path where the gate is silent.
     */
    const autoApprovable = (tool: ToolDef): boolean => {
      if (tool.consequential === true) return false
      if (tool.category === 'calendar_write_from_watcher') return ctx.origin === 'watcher'
      return true
    }

    /*
     * Web containment, second layer. The PreToolUse gate refuses WebSearch and
     * WebFetch to non-model-driven origins, because a turn reasoning over
     * attacker-controllable text must not hold a URL-shaped channel out of the
     * house. A watcher-TRIGGERED turn is that same turn even when its origin is
     * model-driven — its prompt was built from an inbound email — so it gets
     * the same treatment, and in both cases the tools are removed from the
     * model's context entirely rather than left in view to be denied call by
     * call. Two independent layers: the hook denies, and the context never
     * offers.
     */
    const webAllowed = MODEL_DRIVEN_ORIGINS.has(ctx.origin) && trigger !== 'watcher'

    const allowedTools = [
      ...allTools()
        .filter(autoApprovable)
        .map((tool: ToolDef) => qualifiedName(tool.name)),
      ...(webAllowed ? WEB_TOOLS : []),
    ]

    const baseOptions: QueryOptions = {
      model: cfg.DEFAULT_MODEL,
      systemPrompt,
      mcpServers: { household: buildHouseholdMcpServer(ctx) },
      hooks: buildHooks(ctx),
      disallowedTools: webAllowed ? [...DISALLOWED_TOOLS] : [...DISALLOWED_TOOLS, ...WEB_TOOLS],
      allowedTools,
      settingSources: [],
      permissionMode: 'default',
      maxTurns: clampTurns(input.maxTurns),
      cwd: await scratchDir(cfg.CLAUDE_CONFIG_DIR),
      env: childEnv(cfg.CLAUDE_CONFIG_DIR),
    }

    const storedSession =
      input.resume === false ? undefined : (conversation.agentSessionId ?? undefined)

    let outcome = await runQuery(input.prompt, baseOptions, storedSession)
    let resumeLost = false
    // A discarded attempt still cost money. Carry its spend forward, or the
    // metrics row and the daily budget alert both understate the day.
    let spentBefore = 0

    // The stored session lives in the SDK's own store, which a fresh container
    // may not have. The Postgres preamble already carries the context, so one
    // clean retry is enough.
    if (!outcome.ok && storedSession !== undefined && looksLikeLostSession(outcome)) {
      resumeLost = true
      spentBefore = outcome.costUsd
      turnLog.warn(
        { sessionId: storedSession, failure: outcome.failure },
        'resume failed, retrying once without the stored session',
      )
      outcome = await runQuery(input.prompt, baseOptions, undefined)
    }

    stopTyping()

    const costUsd = spentBefore + outcome.costUsd

    await persistSession(conversation.id, outcome.sessionId, resumeLost)

    await writeMetrics({
      usage: outcome.usage,
      costUsd,
      durationMs: Date.now() - startedAt,
      numTurns: outcome.numTurns,
      trigger,
      ok: outcome.ok,
      fallbackModel,
    })

    const replyText = outcome.ok ? outcome.text : failureReply(outcome.failure)

    if (replyText) {
      try {
        await sendToChat(input.chatId, replyText)
      } catch (err) {
        turnLog.error({ err }, 'failed to deliver the turn reply to Telegram')
      }
    } else {
      turnLog.info('turn finished with no text to send')
    }

    if (outcome.ok) {
      turnLog.info(
        { costUsd, numTurns: outcome.numTurns, durationMs: Date.now() - startedAt },
        'turn complete',
      )
    } else {
      turnLog.error({ failure: outcome.failure, costUsd }, 'turn failed')
    }

    return {
      text: replyText,
      sessionId: outcome.sessionId,
      costUsd,
      ok: outcome.ok,
    }
  } catch (err) {
    stopTyping()
    turnLog.error({ err }, 'turn crashed')

    await writeMetrics({
      usage: { ...EMPTY_USAGE },
      costUsd: 0,
      durationMs: Date.now() - startedAt,
      numTurns: 0,
      trigger,
      ok: false,
      fallbackModel,
    })

    try {
      await sendToChat(input.chatId, GENERIC_FAILURE)
    } catch (sendErr) {
      turnLog.error({ err: sendErr }, 'failed to deliver the failure notice to Telegram')
    }

    return { text: GENERIC_FAILURE, sessionId: null, costUsd: 0, ok: false }
  }
}
