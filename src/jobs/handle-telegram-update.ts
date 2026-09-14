import type { Update } from 'grammy/types'
import { logger } from '../logger.js'
import { getBot } from '../telegram/send.js'

/**
 * The `tg-update` worker.
 *
 * The HTTP handler does nothing but authenticate the webhook and enqueue the
 * raw update. All of grammY's machinery — session middleware, the command
 * handlers, the approval callback handlers, the model turn — runs here, in the
 * worker, so a slow turn can never make Telegram time out the webhook and
 * redeliver the same message.
 */

const log = logger.child({ mod: 'tg-update' })

/**
 * The chat an update belongs to, as a string, or null when it has no chat
 * (an inline query, a poll answer). Used as the per-chat singleton key that
 * serialises turns for one conversation.
 */
export function telegramChatIdOf(update: Update): string | null {
  const chat =
    update.message?.chat ??
    update.edited_message?.chat ??
    update.channel_post?.chat ??
    update.edited_channel_post?.chat ??
    update.callback_query?.message?.chat ??
    update.my_chat_member?.chat ??
    update.chat_member?.chat ??
    update.chat_join_request?.chat ??
    update.message_reaction?.chat ??
    update.message_reaction_count?.chat ??
    null
  if (chat) return String(chat.id)

  // Callback queries from inline messages, and inline queries, carry no chat.
  // The sender is still the right serialisation key for them.
  const from = update.callback_query?.from ?? update.inline_query?.from ?? update.poll_answer?.user
  return from ? String(from.id) : null
}

/** A short label for logs — what kind of update this is. */
function updateKind(update: Update): string {
  const keys = Object.keys(update).filter((k) => k !== 'update_id')
  return keys[0] ?? 'unknown'
}

/**
 * grammY needs `botInfo` before it can dispatch, and in webhook mode nothing
 * has fetched it yet when the first update lands. This worker runs several
 * jobs at once, so the `getMe` call is shared rather than made once per job.
 */
let initialising: Promise<void> | null = null

async function ensureInited(bot: ReturnType<typeof getBot>): Promise<void> {
  if (bot.isInited()) return
  if (!initialising) {
    initialising = bot
      .init()
      .catch((err: unknown) => {
        // Clear the latch so the next job retries instead of inheriting a
        // permanently rejected promise.
        initialising = null
        throw err
      })
      .then(() => {
        initialising = null
      })
  }
  await initialising
}

/**
 * Runs one Telegram update through the grammY bot.
 *
 * grammY needs `botInfo` before it can dispatch, so an uninitialised singleton
 * is initialised here rather than at import time — a network call at module
 * load would make the process unstartable whenever Telegram is briefly down.
 *
 * `buildBot()` is what installs the whitelist middleware, the command handlers
 * and the approval callbacks, and it must have run in THIS process before any
 * update is dispatched: a bot with no middleware silently drops every update.
 * Boot order alone does not guarantee it — `src/index.ts` calls `startQueue()`
 * before `registerWebhook()`, so on a redeploy this worker can pick up queued
 * updates while the transport that would have called `buildBot()` has not run
 * yet, and a worker-only process never calls it at all. `buildBot()` is
 * idempotent, so calling it per update costs nothing after the first. It is
 * imported lazily because src/telegram/bot.ts pulls in the command handlers,
 * which reach back into the job queue, which imports this module.
 */
export async function handleTelegramUpdate(update: Update | undefined): Promise<void> {
  if (!update || typeof update !== 'object') {
    log.warn('discarding a telegram job with no update payload')
    return
  }

  const { buildBot } = await import('../telegram/bot.js')
  const bot = buildBot()
  await ensureInited(bot)

  const chatId = telegramChatIdOf(update)
  const kind = updateKind(update)
  const started = Date.now()

  log.debug({ updateId: update.update_id, chatId, kind }, 'handling telegram update')

  // grammY routes handler errors to `bot.catch` when one is installed. If it is
  // not, the throw propagates and pg-boss retries the update — which is the
  // behaviour we want for a transient database or API failure.
  await bot.handleUpdate(update)

  log.info(
    { updateId: update.update_id, chatId, kind, durationMs: Date.now() - started },
    'telegram update handled',
  )
}
