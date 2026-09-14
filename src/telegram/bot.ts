import type { Context } from 'grammy'
import { Bot } from 'grammy'
import { getConfig } from '../config.js'
import { logger } from '../logger.js'
import { handleSetupReply } from '../setup/wizard.js'
import { enqueueAgentTurn, registerCallbackHandlers } from './approvals.js'
import { COMMAND_MENU, COMMAND_NAMES, SECRET_COMMANDS, handleCommand } from './commands.js'
import { getBot, resolveActorName, sendToChat } from './send.js'

const log = logger.child({ mod: 'telegram/bot' })

/**
 * The only two update types this assistant acts on. Narrowing here keeps
 * Telegram from delivering edits, reactions, and member churn we would ignore.
 */
const ALLOWED_UPDATES = ['message', 'callback_query'] as const

const COMMAND_RE = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/

function describe(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

/**
 * A throwable that carries the failure's text and nothing else.
 *
 * grammY's `GrammyError` keeps the request it failed on as an own enumerable
 * `payload` property, and pino's standard error serializer copies every own
 * property onto the log line. For `setWebhook` that payload holds
 * `{ url, secret_token }` — the webhook secret twice over, once in the URL
 * path — so rethrowing the original object writes the secret into the logs of
 * whichever caller catches it (`src/index.ts` logs `{ err }` on a failed boot,
 * and the watchdog's `step()` logs `{ err }` every ten minutes). The message
 * alone is `Call to setWebhook failed! (400: Bad Request)`, which says
 * everything an operator needs and carries no secret.
 */
function redactedError(err: unknown, context: string): Error {
  return new Error(`${context}: ${describe(err)}`)
}

function parseCommand(text: string): { cmd: string; args: string } | null {
  const m = COMMAND_RE.exec(text.trim())
  if (!m) return null
  return { cmd: (m[1] ?? '').toLowerCase(), args: (m[3] ?? '').trim() }
}

function chatIdOf(ctx: Context): string {
  const id = ctx.chat?.id ?? ctx.from?.id
  return id === undefined ? '' : String(id)
}

async function actorOf(ctx: Context): Promise<string> {
  const id = ctx.from?.id
  if (id === undefined) return 'someone'
  return resolveActorName(String(id), ctx.from?.first_name)
}

/* ────────────────────────────────── assembly ─────────────────────────────── */

let configured = false

/**
 * Returns the configured grammY bot, installing middleware the first time.
 *
 * Idempotent on purpose: the HTTP webhook worker, the long-polling entry point,
 * and the watchdog all reach for the same bot, and middleware must not stack.
 */
export function buildBot(): Bot {
  const bot = getBot()
  if (configured) return bot

  // A middleware that throws must not kill the update loop.
  bot.catch((err) => {
    log.error(
      { updateId: err.ctx?.update?.update_id, err: describe(err.error) },
      'unhandled error in a telegram handler',
    )
  })

  /*
   * Access control, first and unconditional.
   *
   * Two rules, both silent. A sender who is not on the whitelist gets nothing
   * back — not an error, not a "you are not authorised" — because a reply
   * confirms a bot lives at this token. And only private chats are served:
   * every downstream assumption (chat id == user id, approval cards to both
   * spouses) holds only there, and answering in a group would spill household
   * data to whoever else is in it.
   */
  bot.use(async (ctx, next) => {
    let allowed: readonly string[]
    try {
      allowed = getConfig().telegramUserIds
    } catch (err) {
      log.error({ err: describe(err) }, 'no whitelist available, dropping the update')
      return
    }

    const fromId = ctx.from?.id
    const from = fromId === undefined ? '' : String(fromId)
    if (!from || !allowed.includes(from)) {
      log.warn(
        { from: from || 'unknown', updateId: ctx.update.update_id },
        'dropped an update from a sender who is not whitelisted',
      )
      return
    }

    const chatType = ctx.chat?.type
    if (chatType !== undefined && chatType !== 'private') {
      log.warn({ from, chatType }, 'dropped an update from a non-private chat')
      return
    }

    await next()
  })

  // Buttons. Registered above the message handlers, and after the whitelist.
  registerCallbackHandlers(bot)

  bot.command([...COMMAND_NAMES], async (ctx) => {
    // A command can arrive as a caption on a photo as well as a plain message.
    const text = ctx.message?.text ?? ctx.message?.caption ?? ''
    const parsed = parseCommand(text)
    if (!parsed) return

    const chatId = chatIdOf(ctx)
    const actor = await actorOf(ctx)

    // Delete before doing anything else: /connect_site carries a password.
    if (SECRET_COMMANDS.has(parsed.cmd) && parsed.args.length > 0) {
      try {
        await ctx.deleteMessage()
      } catch (err) {
        log.warn({ err: describe(err) }, 'could not delete a message carrying a secret')
      }
    }

    const handled = await handleCommand(parsed.cmd, parsed.args, { chatId, actor })
    if (!handled) await routeFreeText(chatId, actor, text)
  })

  bot.on('message:text', async (ctx) => {
    const chatId = chatIdOf(ctx)
    const actor = await actorOf(ctx)
    await routeFreeText(chatId, actor, ctx.message.text)
  })

  // A photo or document sent with a caption still carries a sentence worth
  // reading, so treat the caption as if it had been typed.
  bot.on('message:caption', async (ctx) => {
    const chatId = chatIdOf(ctx)
    const actor = await actorOf(ctx)
    await routeFreeText(chatId, actor, ctx.message.caption)
  })

  // Photos, voice notes, documents with nothing written on them. Say so rather
  // than swallowing them.
  bot.on('message', async (ctx) => {
    const chatId = chatIdOf(ctx)
    if (!chatId) return
    await sendToChat(
      chatId,
      "I can only read text at the moment. Type it out and I'll take it from there.",
      { markdown: false },
    )
  })

  // Latched last, not first. This function is synchronous, so nothing can
  // re-enter it midway and double-install; latching at the top would instead
  // mean that a throw partway through left the flag set and every later call
  // handing back a half-wired bot — one that might, for instance, have the
  // whitelist but not the handlers, or the handlers but not the whitelist.
  configured = true
  log.info('telegram bot configured')
  return bot
}

/**
 * Free text: the setup wizard gets first refusal, because it is a deterministic
 * interview and must not be interpreted by the model. Everything else becomes a
 * queued agent turn — never an inline one, because Telegram will not wait.
 */
async function routeFreeText(chatId: string, actor: string, text: string): Promise<void> {
  if (!chatId || !text.trim()) return

  try {
    if (await handleSetupReply(chatId, actor, text)) return
  } catch (err) {
    log.error({ err: describe(err) }, 'the setup wizard failed, falling through to chat')
  }

  await enqueueAgentTurn({ chatId, actor, prompt: text, trigger: 'chat' })
}

/* ──────────────────────────────── transports ─────────────────────────────── */

/** Publishing the slash menu is a nicety; a failure must never block startup. */
async function publishCommandMenu(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands(COMMAND_MENU.map((c) => ({ ...c })))
  } catch (err) {
    log.warn({ err: describe(err) }, 'could not publish the command menu')
  }
}

/** The webhook URL this deployment should be registered at. */
export function expectedWebhookUrl(): string {
  const cfg = getConfig()
  const base = cfg.APP_URL.replace(/\/+$/, '')
  return `${base}/webhooks/telegram/${cfg.TELEGRAM_WEBHOOK_SECRET}`
}

/**
 * Development transport: no public URL, no tunnel. Resolves once polling is up
 * rather than when it stops, so a caller can await startup and move on.
 */
export async function startLongPolling(): Promise<void> {
  const bot = buildBot()

  try {
    await bot.api.deleteWebhook({ drop_pending_updates: false })
  } catch (err) {
    log.warn({ err: describe(err) }, 'could not clear an existing webhook')
  }

  await publishCommandMenu(bot)

  await new Promise<void>((resolve, reject) => {
    let started = false
    void bot
      .start({
        allowed_updates: ALLOWED_UPDATES,
        onStart: (info) => {
          started = true
          log.info({ bot: info.username }, 'long polling started')
          resolve()
        },
      })
      .catch((err: unknown) => {
        if (started) {
          log.error({ err: describe(err) }, 'long polling stopped with an error')
          return
        }
        reject(redactedError(err, 'could not start long polling'))
      })
  })
}

/**
 * Stops the long-polling loop so a SIGTERM drains cleanly instead of leaving a
 * getUpdates call open against a process that is closing its database pool.
 *
 * Safe to call when polling was never started, when the bot was never built,
 * and twice in a row — `src/index.ts` runs it as the first shutdown step in
 * every mode, including production, where there is no poller to stop.
 */
export async function stopLongPolling(): Promise<void> {
  let bot: Bot
  try {
    bot = getBot()
  } catch {
    // No token, so no bot was ever constructed. Nothing to stop.
    return
  }
  if (!bot.isRunning()) return
  try {
    await bot.stop()
    log.info('long polling stopped')
  } catch (err) {
    log.warn({ err: describe(err) }, 'could not stop long polling cleanly')
  }
}

/**
 * Production transport. The secret appears twice on purpose: once in the path,
 * so a wrong URL never reaches the handler, and once as `secret_token`, which
 * Telegram echoes in a header the handler compares in constant time.
 */
export async function registerWebhook(): Promise<void> {
  const cfg = getConfig()
  const url = expectedWebhookUrl()
  const bot = buildBot()

  try {
    await bot.api.setWebhook(url, {
      secret_token: cfg.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ALLOWED_UPDATES,
      drop_pending_updates: false,
      max_connections: 40,
    })
  } catch (err) {
    // Never log the URL, and never rethrow grammY's own error object: both
    // carry the webhook secret. See `redactedError`.
    log.error({ err: describe(err) }, 'could not register the telegram webhook')
    throw redactedError(err, 'could not register the telegram webhook')
  }

  log.info({ host: cfg.APP_URL }, 'telegram webhook registered')
  await publishCommandMenu(bot)
}
