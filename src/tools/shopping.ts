/**
 * The shopping list tools.
 *
 * Nothing here spends money, contacts anyone, or leaves the building. The list
 * is text this household already owns, and `shopping_order` turns it into more
 * text. That is why it is `read` — the same reasoning `docs/AMAZON.md` gives
 * for cart-and-handoff running ungated.
 *
 * `read` is not the same claim as `readOnly`, though. `shopping_order` marks
 * rows sent and the grocery list it folds in is rewritten as it is generated,
 * so it is annotated `readOnly: false`: `read` is watcher-allowed, and an
 * annotation that says a writer writes nothing is the kind of thing a policy
 * decision later leans on.
 */
import { z } from 'zod'
import { audit } from '../audit/log.js'
import { logger } from '../logger.js'
import { buildShopList } from '../shopping/order.js'
import {
  MAX_PREFERENCE_CHARS,
  activePreferences,
  addPreference,
  allPreferences,
  setPreferenceActive,
} from '../shopping/preferences.js'
import {
  addItems,
  pendingItems,
  recentlySent,
  setStatus,
} from '../shopping/standing-list.js'
import type { StandingItem, StandingItemInput } from '../shopping/standing-list.js'
import { md, sendToChat } from '../telegram/send.js'
import { fail, ok } from './types.js'
import type { ToolDef } from './types.js'

const log = logger.child({ mod: 'tools/shopping' })

/** `#3 dish soap (2 lb) — urgent`. The id first, because it is the handle. */
const itemLine = (i: StandingItem): string =>
  `#${i.id} ${i.name}${i.quantityText ? ` (${i.quantityText})` : ''}${i.urgent ? ' — urgent' : ''}`

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * A bare name, or a name with the amount the household said.
 *
 * Both shapes stay valid on purpose: "coffee and bin bags" is the common case
 * and should not have to be dressed up as objects, while "2 lb of chicken
 * thighs" has to keep its "2 lb" or the quantity is lost between the message
 * and the cart.
 */
const addItemSchema = z.union([
  z.string().trim().min(1).max(200),
  z.object({
    name: z.string().trim().min(1).max(200),
    quantity: z
      .string()
      .trim()
      .max(60)
      .optional()
      .describe(
        'How much, exactly as the household phrased it: "2 lb", "a big one", "2 bottles". Never ' +
          'invent one, and never round: an unparseable amount is kept as written and a wrong ' +
          'number ends up in the cart.',
      ),
  }),
])

const addShape = {
  items: z
    .array(addItemSchema)
    .min(1)
    .max(50)
    .describe(
      'The things to add. One entry per item, as the household said it. Use a bare name when they ' +
        'did not say an amount, and {"name": "chicken thighs", "quantity": "2 lb"} when they did.',
    ),
  urgent: z
    .boolean()
    .optional()
    .describe(
      'Only when the household actually said it is needed today. Urgent items skip the batching ' +
        'and can be ordered on their own; everything else waits for the next shop.',
    ),
}

const listShape = {
  include_sent: z
    .boolean()
    .optional()
    .describe(
      'Also show the items most recently sent to a shop, with their ids. Use it when the household ' +
        'says something did not make it into the order, so you have an id to hand shopping_remove.',
    ),
}

const removeShape = {
  id: z.coerce.number().int().positive().describe('The item id, from shopping_list.'),
  restore: z
    .boolean()
    .optional()
    .describe('True to put a sent item back on the list, when it did not make it into the shop.'),
}

const shoppingAdd: ToolDef = {
  name: 'shopping_add',
  description:
    'Add one or more things to the household shopping list. Use this for "we are out of X" and for ' +
    '"order me Y" alike — both wait for the next shop rather than going out on their own. Say so ' +
    'plainly: the household is told it will go with the next shop, not handed a list.',
  schema: addShape,
  category: 'todo_write',
  consequential: false,
  summarize: (args) => {
    const items = Array.isArray(args.items) ? args.items : []
    return `Add ${plural(items.length, 'item')} to the shopping list`
  },
  handler: async (args, ctx) => {
    const parsed = z.object(addShape).safeParse(args)
    if (!parsed.success) return fail('shopping_add: tell me what to add.')

    const entries: StandingItemInput[] = parsed.data.items.map((entry) =>
      typeof entry === 'string'
        ? { name: entry }
        : { name: entry.name, ...(entry.quantity ? { quantity: entry.quantity } : {}) },
    )

    const added = await addItems({
      items: entries,
      ...(parsed.data.urgent === undefined ? {} : { urgent: parsed.data.urgent }),
      addedBy: ctx.actor,
    })
    if (added.length === 0) return fail('shopping_add: nothing in that was an item I could add.')

    await audit({
      actor: ctx.actor,
      event: 'shopping.added',
      category: 'todo_write',
      toolName: 'shopping_add',
      args: { items: parsed.data.items },
      resultSummary: `added ${added.length} to the shopping list`,
      ok: true,
    })

    const names = added
      .map((i) => (i.quantityText ? `${i.quantityText} ${i.name}` : i.name))
      .join(', ')
    return ok(
      parsed.data.urgent === true
        ? `Added ${names} and marked it urgent, so it can go on its own.`
        : `Added ${names} — it'll go with the next shop.`,
      { added: added.map((i) => ({ id: i.id, name: i.name })) },
    )
  },
}

const shoppingList: ToolDef = {
  name: 'shopping_list',
  description:
    'What is waiting on the household shopping list, with the id of each item. Pass include_sent to ' +
    'also see what went into the last shop, which is how you find the id of something that did not ' +
    'arrive.',
  schema: listShape,
  category: 'read',
  consequential: false,
  readOnly: true,
  summarize: (args) =>
    args.include_sent === true ? 'Read the shopping list, sent items included' : 'Read the shopping list',
  handler: async (args) => {
    const parsed = z.object(listShape).safeParse(args)
    if (!parsed.success) return fail('shopping_list: include_sent is either true or false.')
    const includeSent = parsed.data.include_sent === true

    const items = await pendingItems()
    const sent = includeSent ? await recentlySent() : []

    const sections: string[] = [
      items.length === 0
        ? 'Nothing on the shopping list.'
        : `${plural(items.length, 'item')} waiting:\n${items.map(itemLine).join('\n')}`,
    ]

    if (includeSent) {
      sections.push(
        sent.length === 0
          ? 'Nothing has gone into a shop yet.'
          : `Recently sent — tell me which one to put back:\n${sent.map(itemLine).join('\n')}`,
      )
    }

    return ok(sections.join('\n\n'), {
      count: items.length,
      ...(includeSent ? { sent: sent.map((i) => ({ id: i.id, name: i.name })) } : {}),
    })
  },
}

const shoppingRemove: ToolDef = {
  name: 'shopping_remove',
  description:
    'Drop an item from the shopping list, or put a sent one back when it did not make it into the ' +
    'shop. Get the id from shopping_list — with include_sent for something already sent.',
  schema: removeShape,
  category: 'todo_write',
  consequential: false,
  summarize: (args) => `Remove item #${String(args.id ?? '?')} from the shopping list`,
  handler: async (args, ctx) => {
    const parsed = z.object(removeShape).safeParse(args)
    if (!parsed.success) return fail('shopping_remove: which item id?')

    const status = parsed.data.restore === true ? 'pending' : 'dropped'
    const row = await setStatus(parsed.data.id, status)
    if (!row) return fail(`shopping_remove: there is no item #${parsed.data.id}.`)

    await audit({
      actor: ctx.actor,
      event: 'shopping.removed',
      category: 'todo_write',
      toolName: 'shopping_remove',
      args: { id: parsed.data.id, status },
      resultSummary: `${row.name} -> ${status}`,
      ok: true,
    })

    return ok(status === 'pending' ? `Put ${row.name} back on the list.` : `Dropped ${row.name}.`)
  },
}

const orderShape = {
  urgent_only: z
    .boolean()
    .optional()
    .describe('Only the items marked urgent. Use when the household needs something today.'),
  week: z
    .string()
    .trim()
    .optional()
    .describe(
      "A week whose weekend groceries should be folded into the same list — 'this week', 'next " +
        "week', or a date inside the week such as 2026-09-07. Use it when the household is doing " +
        'the big shop. The midweek top-up stays its own trip. Ignored when urgent_only is true, ' +
        'because an urgent errand is not the big shop.',
    ),
}

const shoppingOrder: ToolDef = {
  name: 'shopping_order',
  description:
    'Turn the shopping list into a block the household can paste into their grocery app, and mark ' +
    'those items sent. The block is normally sent straight to the household as its own message, so ' +
    'the result tells you what to say and you must NOT repeat the list. If delivery fails the result ' +
    'carries the block instead, already escaped for Telegram MarkdownV2 — post that verbatim, do not ' +
    'reformat, re-escape, or unwrap it. It spends nothing and orders nothing — a person still does ' +
    'the shop.',
  schema: orderShape,
  category: 'read',
  consequential: false,
  // Marks rows sent, and the fold-in regenerates the week's stored grocery
  // list. `read` is the policy call; this is the factual one.
  readOnly: false,
  summarize: () => 'Build the shopping list to paste',
  handler: async (args, ctx) => {
    const parsed = z.object(orderShape).safeParse(args)
    // This is the one tool that consumes state. Falling through to the
    // defaults on a bad parse turns a malformed *urgent* request into the
    // whole standing list, emitted and eaten in one go, so it fails instead.
    if (!parsed.success) {
      return fail(
        'shopping_order: I could not read those arguments. urgent_only is true or false, and week ' +
          "is a week such as 'this week' or 2026-09-07.",
      )
    }

    const urgentOnly = parsed.data.urgent_only === true

    // The build — which items go in, whether the week folds in, and the
    // markSent that spends them — lives in src/shopping/order.ts, because the
    // grocery card's Instacart button has to do exactly the same thing. Only
    // the wording and the audit entry below are this tool's own.
    const result = await buildShopList({
      urgentOnly,
      ...(parsed.data.week === undefined ? {} : { week: parsed.data.week }),
    })

    if (!result.ok) {
      return ok(md.escape(result.foldNote === '' ? result.reason : `${result.reason} ${result.foldNote}`))
    }

    const { blocks, pasted, standingItems: items, foldedCount, foldNote, consumed } = result.build

    await audit({
      actor: ctx.actor,
      event: 'shopping.ordered',
      category: 'read',
      toolName: 'shopping_order',
      args: { urgentOnly, ...(parsed.data.week ? { week: parsed.data.week } : {}) },
      resultSummary: `built a paste list of ${pasted} lines from ${items.length} standing items`,
      ok: true,
    })

    const header = md.bold(urgentOnly ? 'Urgent items' : 'Shopping list')
    const body = blocks.map((block) => md.pre(block)).join('\n\n')
    const countText = plural(pasted, 'item')
    const included =
      foldedCount === 0
        ? `Included ${countText}.`
        : items.length === 0
          ? `Included ${countText}, all from the week's plan.`
          : `Included ${countText}: ${items.length} from the standing list and ` +
            `${foldedCount} from the week's plan.`
    // Nothing was consumed when the standing list was empty, so there is
    // nothing to offer to put back.
    const consumedNote =
      items.length === 0
        ? ''
        : consumed
          ? "Tell me if any didn't make it and I'll put them back."
          : 'I could not tick the standing items off the list, so they may be offered again next time.'
    const tail = md.escape([included, foldNote, consumedNote].filter((s) => s !== '').join(' '))

    /*
     * The blocks go out as their own messages, from here, rather than through
     * the model's reply.
     *
     * Two reasons, and the second is the load-bearing one. A message holding
     * only the block is what the household wants to paste — nothing above it,
     * nothing below it, so the iOS list importer receives exactly the lines and
     * nothing else. And a paste list has to be byte-exact: routing it through a
     * language model that is asked to reproduce it verbatim is the one design
     * guaranteed to corrupt it eventually, however firmly the description says
     * not to.
     *
     * `sendToChat` never throws and returns the ids it delivered, so a failed
     * send falls back to the old behaviour: hand the block to the model and let
     * it post it. Worse formatting beats no list.
     */
    let delivered = false
    try {
      const sends = await Promise.all(
        blocks.map((block) => sendToChat(ctx.chatId, md.pre(block), { markdown: true })),
      )
      delivered = sends.length > 0 && sends.every((ids) => ids.length > 0)
    } catch (err) {
      log.error({ err }, 'could not send the shopping blocks')
    }

    if (delivered) {
      // The model must not repeat what the household has already received.
      return ok(
        `${plural(pasted, 'line')} of shopping list already sent to the household as ` +
          `${blocks.length === 1 ? 'a pasteable block' : `${blocks.length} pasteable blocks`}. ` +
          'Do NOT repeat the list or any of its items in your reply. Say only this, in one line: ' +
          // The paste-only message carries no header, so whether this was the
          // urgent list or the whole shop has to be said here or not at all.
          [urgentOnly ? 'Urgent items.' : '', included, foldNote, consumedNote]
            .filter((t) => t !== '')
            .join(' '),
        {
          count: items.length,
          folded: foldedCount,
          pasted,
          blocks: blocks.length,
          consumed,
          deliveredDirectly: true,
          included: items.map((i) => ({ id: i.id, name: i.name })),
        },
      )
    }

    return ok(`${header}\n\n${body}\n\n${tail}`, {
      count: items.length,
      folded: foldedCount,
      pasted,
      blocks: blocks.length,
      consumed,
      // The ids are the whole restore path: `shopping_remove(restore: true)`
      // needs one, and without this the only way back was to know it already.
      included: items.map((i) => ({ id: i.id, name: i.name })),
    })
  },
}

/* ═══════════════════════════ shopping_prefs ═══════════════════════════════ */

const prefsShape = {
  action: z
    .enum(['list', 'add', 'remove', 'restore'])
    .describe('What to do. Default to list when the household is only asking what is set.'),
  text: z
    .string()
    .trim()
    .min(3)
    .max(MAX_PREFERENCE_CHARS)
    .optional()
    .describe(
      'For add: the instruction, in the household\'s own words. Write it as an instruction to the ' +
        'grocery app, not as a note to yourself — it is pasted verbatim above their list. Be specific: ' +
        '"buy Oatly oat milk" beats "we like good oat milk".',
    ),
  id: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe('For remove and restore: the instruction id, from action list.'),
}

/**
 * The household's standing shopping instructions.
 *
 * These reach a grocery app's assistant, which reads them and shops to them, so
 * they are the household's taste expressed as text rather than as code. Adding
 * one takes effect on the next list; nothing is deployed.
 */
export const shoppingPrefs: ToolDef = {
  name: 'shopping_prefs',
  description:
    'Read or change the standing instructions that go out on top of every shopping list — brands, ' +
    'quality, what to do about substitutions. The grocery app reads them and shops to them, so this ' +
    'is how the household changes what gets bought without anyone editing code. Use it whenever they ' +
    'state a preference about brands or shopping in general, not just when they ask to set a rule.',
  schema: prefsShape,
  category: 'memory_write',
  consequential: false,
  summarize: (args) => {
    const action = typeof args.action === 'string' ? args.action : 'list'
    const id = args.id === undefined || args.id === null ? '?' : String(args.id)
    const text = typeof args.text === 'string' && args.text.trim() !== '' ? args.text.trim() : '(none given)'
    if (action === 'add') return `Add a shopping preference: ${text}`
    if (action === 'remove') return `Drop shopping preference #${id}`
    if (action === 'restore') return `Restore shopping preference #${id}`
    return 'Read the shopping preferences'
  },
  handler: async (args, ctx) => {
    const parsed = z.object(prefsShape).safeParse(args)
    if (!parsed.success) {
      return fail(
        'shopping_prefs: action is list, add, remove or restore. add needs text; remove and restore need an id.',
      )
    }

    if (parsed.data.action === 'add') {
      if (parsed.data.text === undefined) return fail('shopping_prefs: what is the instruction?')
      const row = await addPreference({ text: parsed.data.text, createdBy: ctx.actor })
      if (!row) return fail('shopping_prefs: there was nothing usable in that.')
      await audit({
        actor: ctx.actor,
        event: 'shopping.preference_added',
        category: 'memory_write',
        toolName: 'shopping_prefs',
        args: { text: row.text },
        resultSummary: `shopping preference #${row.id}`,
        ok: true,
      })
      return ok(`Added, and it goes out with every list from now on:\n\n#${row.id} ${row.text}`)
    }

    if (parsed.data.action === 'remove' || parsed.data.action === 'restore') {
      if (parsed.data.id === undefined) return fail('shopping_prefs: which instruction id?')
      const active = parsed.data.action === 'restore'
      const row = await setPreferenceActive(parsed.data.id, active)
      if (!row) return fail(`shopping_prefs: there is no instruction #${parsed.data.id}.`)
      await audit({
        actor: ctx.actor,
        event: active ? 'shopping.preference_restored' : 'shopping.preference_removed',
        category: 'memory_write',
        toolName: 'shopping_prefs',
        args: { id: row.id },
        resultSummary: row.text,
        ok: true,
      })
      return ok(active ? `Back on every list:\n\n#${row.id} ${row.text}` : `Dropped: ${row.text}`)
    }

    const rows = await allPreferences()
    if (rows.length === 0) {
      return ok('No standing shopping instructions. Lists go out as items alone.')
    }
    const live = await activePreferences()
    const lines = rows.map((r) => `#${r.id}${r.active ? '' : ' (off)'} ${r.text}`)
    return ok(
      `${live.length} instruction${live.length === 1 ? '' : 's'} ride on every list:\n\n${lines.join('\n\n')}`,
      { active: live.length, total: rows.length },
    )
  },
}

export const shoppingTools: ToolDef[] = [
  shoppingAdd,
  shoppingList,
  shoppingRemove,
  shoppingOrder,
  shoppingPrefs,
]
