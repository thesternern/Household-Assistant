/**
 * The buttons under a grocery summary, and the callback data behind them.
 *
 * Deliberately its own module with grammY as its only import. The tool that
 * *sends* the card lives in `src/tools/recipes.ts`, and the handler that
 * answers a tap needs that file's list renderer — so if the keyboard sat with
 * the handler, those two would import each other in a cycle.
 */
import { InlineKeyboard } from 'grammy'

/** Callback data is capped at 64 bytes by Telegram; `gl:<id>:<choice>` fits easily. */
export const GROCERY_CB = {
  pattern: /^gl:(\d+):(cart|aisle)$/,
  cart: (planId: number) => `gl:${planId}:cart`,
  aisle: (planId: number) => `gl:${planId}:aisle`,
}

export interface GroceryKeyboardOptions {
  /** Drop the Instacart button once used: it spends the standing shopping list. */
  cartSpent?: boolean
}

/**
 * The in-store button is a pure render and stays live for good. The Instacart
 * one consumes the standing items, so it is offered exactly once.
 */
export function groceryKeyboard(
  planId: number,
  opts: GroceryKeyboardOptions = {},
): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  if (opts.cartSpent !== true) keyboard.text('🛒 Instacart list', GROCERY_CB.cart(planId))
  keyboard.text('🏪 In-store list', GROCERY_CB.aisle(planId))
  return keyboard
}
