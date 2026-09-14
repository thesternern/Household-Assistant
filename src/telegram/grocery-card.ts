/**
 * The card the household taps to choose how they want the week's shopping.
 *
 * Asking for "the grocery list" used to be ambiguous, and the assistant guessed
 * — handing over an aisle-grouped list while calling it ready to paste into a
 * grocery app, which it emphatically is not. So the choice moves to a button
 * and stops being a guess.
 *
 * Both lists are rendered HERE, on a tap, not by the model:
 *
 *  - a paste block has to be byte-exact, and routing one through a language
 *    model asked to reproduce it verbatim is the one design guaranteed to
 *    corrupt it eventually;
 *  - a tap costs no agent turn, so the list arrives immediately.
 *
 * The two buttons are deliberately not symmetrical. The in-store list is a pure
 * render and can be tapped all day. The Instacart list *spends* the standing
 * items — it is what stops "hand soap" being offered every week — so once
 * tapped that button is removed and only the in-store one remains.
 */
import type { Bot, CallbackQueryContext, Context } from 'grammy'
import { audit } from '../audit/log.js'
import { logger } from '../logger.js'
import { generateGroceryList, getPlan } from '../recipes/store.js'
import { buildShopList } from '../shopping/order.js'
import { formatGroceryList } from '../tools/recipes.js'
import { GROCERY_CB, groceryKeyboard } from './grocery-keyboard.js'
import { md, resolveActorName, sendToChat } from './send.js'

const log = logger.child({ mod: 'telegram/grocery-card' })

type CbCtx = CallbackQueryContext<Context>

/** `ctx.match` is a string for a plain trigger and an array for a regex one. */
function groups(ctx: CbCtx): string[] {
  const m = ctx.match
  if (typeof m === 'string') return [m]
  if (Array.isArray(m)) return m.map((part) => (typeof part === 'string' ? part : ''))
  return []
}

function chatOf(ctx: CbCtx): string | null {
  const id = ctx.chat?.id ?? ctx.from?.id
  return id === undefined ? null : String(id)
}

async function actorOf(ctx: CbCtx): Promise<string> {
  const id = ctx.from?.id
  if (id === undefined) return 'someone'
  return resolveActorName(String(id), ctx.from?.first_name)
}

/**
 * Retire the Instacart button after it fires, leaving the in-store one live.
 *
 * Editing rather than dropping the whole keyboard is the point: the household
 * may well want both lists, and only one of the two buttons is spent.
 */
async function retireCartButton(ctx: CbCtx, planId: number): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: groceryKeyboard(planId, { cartSpent: true }) })
  } catch (err) {
    // A message too old to edit is not a failure worth surfacing; the list went out.
    log.debug({ err, planId }, 'could not retire the cart button')
  }
}

/** The aisle-grouped list, rendered from the stored plan. */
async function sendAisleList(ctx: CbCtx, planId: number): Promise<string | undefined> {
  const chatId = chatOf(ctx)
  if (chatId === null) return 'I could not tell which chat that came from.'

  const plan = await getPlan(planId)
  if (!plan) return 'That meal plan is gone, so there is nothing to shop for.'

  const list = await generateGroceryList(planId)
  const text = formatGroceryList(list, { weekStart: plan.weekStart })
  const sent = await sendToChat(chatId, text, { markdown: true })
  if (sent.length === 0) return 'I could not send the list. Try again in a moment.'

  await audit({
    actor: await actorOf(ctx),
    event: 'grocery.list_viewed',
    category: 'read',
    toolName: 'grocery_card',
    args: { planId, choice: 'aisle' },
    resultSummary: 'sent the in-store list',
    ok: true,
  })
  return 'In-store list sent.'
}

/** The paste block, with the household's standing rules on top. */
async function sendCartList(ctx: CbCtx, planId: number): Promise<string | undefined> {
  const chatId = chatOf(ctx)
  if (chatId === null) return 'I could not tell which chat that came from.'

  const plan = await getPlan(planId)
  if (!plan) return 'That meal plan is gone, so there is nothing to shop for.'

  const result = await buildShopList({ week: plan.weekStart })
  if (!result.ok) {
    return result.foldNote === '' ? result.reason : `${result.reason} ${result.foldNote}`
  }

  const { blocks, pasted, standingItems, foldedCount, consumed } = result.build

  // One block per message and nothing else in it: what the household pastes has
  // to be exactly the lines, with no header above or note below.
  const sends = await Promise.all(
    blocks.map((block) => sendToChat(chatId, md.pre(block), { markdown: true })),
  )
  if (!sends.every((ids) => ids.length > 0)) {
    return 'I could not send the whole list. Try again in a moment.'
  }

  await retireCartButton(ctx, planId)

  await audit({
    actor: await actorOf(ctx),
    event: 'shopping.ordered',
    category: 'read',
    toolName: 'grocery_card',
    args: { planId, choice: 'cart' },
    resultSummary: `built a paste list of ${pasted} lines from ${standingItems.length} standing items`,
    ok: true,
  })
  log.info({ planId, pasted, standing: standingItems.length, foldedCount, consumed }, 'cart list sent')

  if (!consumed) return `Instacart list sent — ${pasted} items. I could not tick your standing items off.`
  return standingItems.length === 0
    ? `Instacart list sent — ${pasted} items.`
    : `Instacart list sent — ${pasted} items, including ${standingItems.length} from your list.`
}

/**
 * Handle a tap. The return value becomes the little toast on the button; the
 * lists themselves arrive as their own messages.
 */
export async function onGroceryChoice(ctx: CbCtx): Promise<string | undefined> {
  const parts = groups(ctx)
  const planId = Number(parts[1])
  const choice = parts[2]
  if (!Number.isInteger(planId) || planId <= 0) return 'That button is malformed.'

  if (choice === 'aisle') return sendAisleList(ctx, planId)
  if (choice === 'cart') return sendCartList(ctx, planId)
  return 'That button is malformed.'
}

/**
 * Wire the handler up.
 *
 * This is called from `registerCallbackHandlers`, and it has to run before the
 * catch-all `callback_query:data` listener there — grammY dispatches in
 * registration order, so anything added after the catch-all never fires.
 */
export function registerGroceryCallbacks(bot: Bot, wrap: (name: string, fn: (ctx: CbCtx) => Promise<string | undefined>) => (ctx: CbCtx) => Promise<void>): void {
  bot.callbackQuery(GROCERY_CB.pattern, wrap('grocery-choice', onGroceryChoice))
}
