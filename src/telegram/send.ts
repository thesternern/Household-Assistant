import { eq } from 'drizzle-orm'
import { Bot, GrammyError } from 'grammy'
import type {
  ForceReply,
  InlineKeyboardMarkup,
  ReplyKeyboardMarkup,
  ReplyKeyboardRemove,
} from 'grammy/types'
import { getConfig } from '../config.js'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'

const log = logger.child({ mod: 'telegram/send' })

/**
 * Telegram's hard ceiling is 4096 characters. We chunk at 4000 so an escaped
 * MarkdownV2 body plus a little card chrome always fits.
 */
export const MAX_MESSAGE_CHARS = 4000

/**
 * Every character MarkdownV2 treats as markup. Telegram rejects a message that
 * contains any of these unescaped, so `escapeMd` escapes all of them.
 * The backslash is escaped too: it starts an escape sequence, so an unescaped
 * one in user text would swallow the character after it.
 */
export const MARKDOWN_V2_SPECIALS = '_*[]()~`>#+-=|{}.!' as const

const ESCAPE_RE = /[_*[\]()~`>#+\-=|{}.!\\]/g

/** Escapes text so Telegram renders it literally under `parse_mode: 'MarkdownV2'`. */
export function escapeMd(s: string): string {
  if (typeof s !== 'string') return String(s ?? '').replace(ESCAPE_RE, (c) => `\\${c}`)
  return s.replace(ESCAPE_RE, (c) => `\\${c}`)
}

/**
 * Small MarkdownV2 composers. Each escapes its payload, then adds the markup
 * characters, so callers never hand-escape and never leak stray markup.
 */
export const md = {
  escape: escapeMd,
  bold: (s: string): string => `*${escapeMd(s)}*`,
  italic: (s: string): string => `_${escapeMd(s)}_`,
  /** Inline code. Backticks and backslashes are the only things code spans escape. */
  code: (s: string): string => `\`${String(s ?? '').replace(/[`\\]/g, (c) => `\\${c}`)}\``,
  /**
   * A fenced block. Telegram renders these with a tap-to-copy button on
   * mobile, which is the entire delivery mechanism for a paste-ready list.
   * Only backticks and backslashes need escaping inside a pre block.
   */
  pre: (s: string): string => `\`\`\`\n${String(s ?? '').replace(/[`\\]/g, (c) => `\\${c}`)}\n\`\`\``,
}

/* ─────────────────────────────────── chunking ────────────────────────────── */

/** Number of backslashes immediately before `index`. */
function trailingBackslashes(text: string, index: number): number {
  let n = 0
  let i = index - 1
  while (i >= 0 && text.charCodeAt(i) === 0x5c) {
    n += 1
    i -= 1
  }
  return n
}

/**
 * Nudges a proposed split point left until it is safe: never between a
 * MarkdownV2 backslash and the character it escapes, and never inside a
 * surrogate pair.
 */
function safeBoundary(text: string, start: number, proposed: number): number {
  let end = proposed
  const min = start + 1
  for (let guard = 0; guard < 4 && end > min; guard += 1) {
    const prev = text.charCodeAt(end - 1)
    const cur = text.charCodeAt(end)
    if (prev >= 0xd800 && prev <= 0xdbff && cur >= 0xdc00 && cur <= 0xdfff) {
      end -= 1
      continue
    }
    if (trailingBackslashes(text, end) % 2 === 1) {
      end -= 1
      continue
    }
    break
  }
  return Math.max(end, min)
}

/**
 * Last resort: cut a single oversized run. Prefers a nearby space so words stay
 * whole, and always lands on a safe boundary. Lossless — the whitespace it
 * breaks after stays on the left-hand piece.
 */
function hardSplit(text: string, limit: number): string[] {
  const out: string[] = []
  const lookBack = Math.max(1, Math.min(200, Math.floor(limit / 4)))
  let start = 0

  while (start < text.length) {
    if (text.length - start <= limit) {
      out.push(text.slice(start))
      break
    }
    const cap = start + limit
    let end = -1
    for (let i = cap; i > cap - lookBack && i > start + 1; i -= 1) {
      const ch = text.charCodeAt(i - 1)
      if (ch === 0x20 || ch === 0x0a || ch === 0x09) {
        end = i
        break
      }
    }
    if (end < 0) end = safeBoundary(text, start, cap)
    out.push(text.slice(start, end))
    start = end
  }
  return out
}

/**
 * Splits on `re`, keeping each separator attached to the unit before it, so
 * concatenating the units reproduces the input exactly.
 */
function unitsKeepingSeparators(text: string, re: RegExp): string[] {
  const units: string[] = []
  const scanner = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  let last = 0
  let m = scanner.exec(text)
  while (m !== null) {
    if (m[0].length === 0) {
      scanner.lastIndex += 1
    } else {
      const cut = m.index + m[0].length
      units.push(text.slice(last, cut))
      last = cut
    }
    m = scanner.exec(text)
  }
  if (last < text.length) units.push(text.slice(last))
  return units
}

/** Greedily packs units into pieces of at most `limit`, decomposing oversized units. */
function pack(units: string[], limit: number, decompose: (u: string) => string[]): string[] {
  const out: string[] = []
  let buf = ''
  for (const unit of units) {
    if (unit.length > limit) {
      if (buf.length > 0) {
        out.push(buf)
        buf = ''
      }
      for (const part of decompose(unit)) out.push(part)
      continue
    }
    if (buf.length + unit.length > limit) {
      if (buf.length > 0) out.push(buf)
      buf = unit
    } else {
      buf += unit
    }
  }
  if (buf.length > 0) out.push(buf)
  return out
}

/**
 * Splits a long message into Telegram-sized pieces: paragraph boundaries first,
 * then line boundaries, then a hard cut at `max` that never lands inside a
 * MarkdownV2 escape sequence or a surrogate pair.
 *
 * Lossless by construction: `chunk(s).join('') === s` for every input, because
 * each separator stays attached to the piece it followed.
 */
export function chunk(s: string, max: number = MAX_MESSAGE_CHARS): string[] {
  const text = typeof s === 'string' ? s : String(s ?? '')
  const limit =
    Number.isFinite(max) && max >= 1 ? Math.floor(max) : MAX_MESSAGE_CHARS
  if (text.length === 0) return []
  if (text.length <= limit) return [text]

  const byLine = (paragraph: string): string[] =>
    pack(unitsKeepingSeparators(paragraph, /\n/g), limit, (line) => hardSplit(line, limit))

  return pack(unitsKeepingSeparators(text, /\n{2,}/g), limit, byLine)
}

/* ──────────────────────────────── the bot itself ─────────────────────────── */

let bot: Bot | null = null

/** Lazily-constructed grammY singleton. Built from `TELEGRAM_BOT_TOKEN`. */
export function getBot(): Bot {
  if (!bot) bot = new Bot(getConfig().TELEGRAM_BOT_TOKEN)
  return bot
}

/* ─────────────────────────────────── sending ─────────────────────────────── */

export interface SendOpts {
  markdown?: boolean
  replyMarkup?: unknown
}

type AnyReplyMarkup =
  | InlineKeyboardMarkup
  | ReplyKeyboardMarkup
  | ReplyKeyboardRemove
  | ForceReply

function asReplyMarkup(value: unknown): AnyReplyMarkup | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'object') return undefined
  return value as AnyReplyMarkup
}

/** `editMessageText` only accepts an inline keyboard — anything else is dropped. */
function asInlineMarkup(value: unknown): InlineKeyboardMarkup | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'object') return undefined
  if (!Array.isArray((value as { inline_keyboard?: unknown }).inline_keyboard)) return undefined
  return value as InlineKeyboardMarkup
}

function describe(err: unknown): string {
  if (err instanceof GrammyError) return `${err.error_code} ${err.description}`
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

/** True when Telegram rejected the text because our MarkdownV2 was malformed. */
function isParseError(err: unknown): boolean {
  return err instanceof GrammyError && /parse entities|parse_mode|entity/i.test(err.description)
}

/** True when an edit changed nothing — a normal, ignorable outcome. */
function isNotModified(err: unknown): boolean {
  return err instanceof GrammyError && /message is not modified/i.test(err.description)
}

/**
 * Sends `text` to one chat, splitting it when it is too long.
 * Returns the message ids that were actually delivered — empty when the send
 * failed. Never throws: a Telegram outage must not take down a worker.
 */
export async function sendToChat(
  chatId: string,
  text: string,
  opts?: SendOpts,
): Promise<number[]> {
  const ids: number[] = []
  const parts = chunk(text)
  if (parts.length === 0) return ids

  let api: Bot['api']
  try {
    api = getBot().api
  } catch (err) {
    log.error({ err: describe(err) }, 'cannot send: bot is not configured')
    return ids
  }

  const markup = asReplyMarkup(opts?.replyMarkup)

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]
    if (part === undefined || part.length === 0) continue
    // The keyboard belongs on the last piece, where the reader ends up.
    const isLast = i === parts.length - 1
    const other = {
      parse_mode: opts?.markdown ? ('MarkdownV2' as const) : undefined,
      link_preview_options: { is_disabled: true },
      reply_markup: isLast ? markup : undefined,
    }

    try {
      const sent = await api.sendMessage(chatId, part, other)
      ids.push(sent.message_id)
    } catch (err) {
      if (opts?.markdown && isParseError(err)) {
        // Better a plain-text message than no message. Log it loudly — a parse
        // failure means something escaped the escaper.
        log.warn({ chatId, err: describe(err) }, 'markdown rejected, retrying as plain text')
        try {
          const sent = await api.sendMessage(chatId, part, {
            link_preview_options: { is_disabled: true },
            reply_markup: isLast ? markup : undefined,
          })
          ids.push(sent.message_id)
          continue
        } catch (retryErr) {
          log.error({ chatId, err: describe(retryErr) }, 'plain-text retry failed')
          continue
        }
      }
      log.error({ chatId, err: describe(err) }, 'telegram send failed')
    }
  }

  return ids
}

/** Sends the same message to every whitelisted spouse. Private chat id == user id. */
export async function sendToAll(text: string, opts?: SendOpts): Promise<void> {
  let chatIds: string[]
  try {
    chatIds = getConfig().telegramUserIds
  } catch (err) {
    log.error({ err: describe(err) }, 'cannot broadcast: config unavailable')
    return
  }
  for (const chatId of chatIds) {
    await sendToChat(chatId, text, opts)
  }
}

/**
 * Rewrites an already-sent message in place. Used to retire approval cards once
 * one spouse has tapped. Never throws; "not modified" is treated as success.
 */
export async function editMessage(
  chatId: string,
  messageId: number,
  text: string,
  opts?: SendOpts,
): Promise<void> {
  const parts = chunk(text)
  let body = parts[0] ?? ''
  if (parts.length > 1) body = `${body}…`
  if (body.length === 0) return

  let api: Bot['api']
  try {
    api = getBot().api
  } catch (err) {
    log.error({ err: describe(err) }, 'cannot edit: bot is not configured')
    return
  }

  const markup = asInlineMarkup(opts?.replyMarkup)
  const other = {
    parse_mode: opts?.markdown ? ('MarkdownV2' as const) : undefined,
    link_preview_options: { is_disabled: true },
    // An empty `inline_keyboard` clears the buttons, which is what a resolved
    // card wants; omitting the field entirely also drops them.
    reply_markup: markup,
  }

  try {
    await api.editMessageText(chatId, messageId, body, other)
  } catch (err) {
    if (isNotModified(err)) return
    if (opts?.markdown && isParseError(err)) {
      try {
        await api.editMessageText(chatId, messageId, body, {
          link_preview_options: { is_disabled: true },
          reply_markup: markup,
        })
        return
      } catch (retryErr) {
        if (isNotModified(retryErr)) return
        log.error({ chatId, messageId, err: describe(retryErr) }, 'plain-text edit retry failed')
        return
      }
    }
    log.error({ chatId, messageId, err: describe(err) }, 'telegram edit failed')
  }
}

/* ──────────────────────────────── who to talk to ─────────────────────────── */

/**
 * The chat to use when a message has no natural recipient — a cron, a watcher,
 * a job failure. Prefers the user flagged primary, falls back to the first
 * whitelisted id, and returns null only when nothing is configured.
 */
export async function primaryChatId(): Promise<string | null> {
  // The whitelist is the authority on who may be spoken to. Read it first so
  // the database answer below can be checked against it.
  let allowed: readonly string[] = []
  try {
    allowed = getConfig().telegramUserIds
  } catch (err) {
    log.error({ err: describe(err) }, 'no telegram user ids configured')
  }

  try {
    const rows = await getDb()
      .select({ telegramUserId: schema.users.telegramUserId })
      .from(schema.users)
      .where(eq(schema.users.isPrimary, true))
      .limit(1)
    const row = rows[0]
    // `users` outlives the environment. A row still flagged primary for someone
    // who has since been taken off TELEGRAM_USER_ID_* must not keep receiving
    // the household's briefings, reminders, and failure notices — so it is only
    // trusted while the whitelist still names them. With no whitelist readable
    // at all, the database is the best answer there is.
    if (row?.telegramUserId && (allowed.length === 0 || allowed.includes(row.telegramUserId))) {
      return row.telegramUserId
    }
    if (row?.telegramUserId) {
      log.warn('the primary user row is no longer on the telegram whitelist; using the whitelist')
    }
  } catch (err) {
    log.warn({ err: describe(err) }, 'could not read the primary user, falling back to config')
  }

  return allowed[0] ?? null
}

/**
 * Display name for a Telegram user id: the household's chosen name when the
 * setup wizard has stored one, otherwise whatever Telegram gave us.
 */
export async function resolveActorName(
  telegramUserId: string,
  fallback?: string,
): Promise<string> {
  try {
    const rows = await getDb()
      .select({ displayName: schema.users.displayName })
      .from(schema.users)
      .where(eq(schema.users.telegramUserId, telegramUserId))
      .limit(1)
    const name = rows[0]?.displayName
    if (name) return name
  } catch (err) {
    log.debug({ err: describe(err) }, 'could not resolve an actor name')
  }
  return fallback && fallback.trim() ? fallback.trim() : telegramUserId
}
