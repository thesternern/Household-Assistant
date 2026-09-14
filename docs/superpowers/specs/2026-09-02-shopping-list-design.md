# The shopping list: from the meal plan to a delivered shop

The household plans meals on Sunday and the plan already produces a
consolidated grocery list. Today that list is read on a phone and retyped into
Instacart. This closes that gap: one standing list that everything feeds, and a
paste-ready block that goes into Instacart's own Shopping List in one tap.

It is deliberately the smallest thing that connects meal planning to delivery.
No API key, no browser, no account risk.

## Why not an API

Checked on 2 September 2026, so nobody re-litigates it. This section is the
point of the document as much as the design is.

| Path | Usable? | Why not |
|---|---|---|
| **Instacart Developer Platform** | **No — closed** | The `Create shopping list page` endpoint is exactly this feature, natively, and covers Canada. Applications are closed with no waitlist and no announced date. |
| Instacart official MCP | No | `mcp.instacart.com/mcp` authenticates with the same API key. Not a way around the closed door. |
| ChatGPT / Instant Checkout | No | Was a ChatGPT consumer surface, never an API. **Retired March 2026**, about six months after launch. An OpenAI key buys nothing here. |
| Agentic Commerce Protocol | Not yet | Apache-2.0, open, "any AI agent can call an ACP-enabled checkout", REST and MCP compatible. Participants include Instacart, DoorDash grocery, Target, Shopify. But unverified whether a self-hosted household agent can transact, and it does **real checkout** — money moves — which belongs behind `purchase`, the monthly cap and an approval card. A separate design. |
| DoorDash / Uber Eats | No | Merchant-side only. Both manage orders placed *with* you, not *by* you — the same category as Amazon's SP-API. DoorDash Marketplace APIs are not generally available. |
| PC Express, Voilà, Save-On-Foods | No | No public ordering API. What is marketed as a "Canadian grocery API" is a price scraper: read-only, cannot cart. |
| Third-party scrapers | Read-only | Useful later for price awareness. Never touches a household account, and never places an order. |

**What OpenAI did is worth recording.** They shipped full agentic checkout,
retired it inside six months, and now recommend **External Checkout** — the
agent helps decide, the human pays at the merchant. That is cart-and-handoff,
arrived at independently. `docs/AMAZON.md` chose the same posture in August on
different grounds. Two independent paths to the same answer is a reason to stop
treating it as a limitation.

## What Instacart's app actually accepts

The consumer Shopping List feature takes a pasted list: up to **200 items**,
from notes, email, texts or a website, and it parses items without separators.
It also reads a photo of a paper list.

**iOS only** as of this writing; Android and web are listed as coming. The
household is on iPhone, so this works today.

## The design

### One type, at the seam

```ts
// src/shopping/list.ts
interface ShoppingLine {
  name: string          // "unsalted butter" — what a store matches on
  quantity?: number     // omitted when the text will not parse
  unit?: string         // 'lb', 'each', …
  displayText?: string  // the original human phrasing, always kept
  note?: string         // "for Thursday's curry" — never sent to a store
}
interface ShoppingList { title: string; lines: ShoppingLine[] }
```

The seam is the **list**, not a provider interface. Amazon's flow is *pick this
specific product from these search results*; Instacart's is *here are names, you
match them*. Forcing both through one interface produces an Amazon-shaped
interface with the other faking half of it. What they genuinely share is the
ending — a list a human turns into a shop — so that is what gets a type.

Adding a provider later means writing one consumer of a type that already
exists, not retrofitting an abstraction. This has already been tested: the
provider changed from Instacart to a paste formatter mid-design and nothing
upstream moved.

`quantity` and `unit` are optional deliberately. `grocery_list_generate`
produces a free-text `quantity` — `"2 lb"`, `"as needed"`, sometimes
`"2 lb + 3 cups"` when the consolidator cannot merge units. When it parses, send
structure. When it does not, send the name alone and keep the phrasing in
`displayText`. Guessing `2` from `"2 lb"` is worse than sending no quantity.
`src/recipes/grocery/parser.ts` already parses amounts and units; the adapter
reuses it rather than growing a second parser.

### One standing list, two producers

```
"we're out of dish soap"       ─┐
"order me coffee and bin bags" ─┼─→  shopping_list_items  ─→  paste block, on request
weekly meal plan               ─┘        (pending)
```

**Ad hoc and "we're out of" are the same act.** The difference was never in the
item, only in what prompted it. Both add to one list.

They batch by default. Saying "order me hand soap" answers *"added — it'll go
with Saturday's shop"*, not a list. Nobody should send a shopper out for one
bottle of hand soap, and a household that has to remember to batch will not.

**Urgency is opt-in and stated out loud.** "I need this today" produces a block
for that item alone, immediately. Without an escape hatch the household routes
around the feature and opens the app, which loses everything.

**The weekly plan folds in.** When `/mealprep` runs, pending standing items join
the **weekend** shop — the big one. Midweek stays the freshness-driven top-up it
already is.

### What arrives in Telegram

Two messages, and the split matters.

1. **The readable list** — sections, quantities, which recipe each item serves.
   Unchanged from today.
2. **The paste block** — bare item lines in a code block, which Telegram renders
   with a tap-to-copy button on mobile.

Provenance, section headers and markdown all help a person and confuse a
matcher. They belong in the first message and never in the second.

### After a block is generated

Items are marked `sent`, with one line in the same message: *"included these 7 —
tell me if any didn't make it and I'll put them back."*

Nothing reads back from Instacart, so the assistant cannot know what was
actually bought. The alternative is leaving items `pending` until confirmed,
which is more correct and makes the household do bookkeeping the assistant
exists to avoid. A forgotten item is a better failure than the same six items
reappearing every week.

## Data

```
shopping_list_items
  id, name, quantity_text, note,
  status         pending | sent | dropped
  urgent         boolean, default false
  added_by, added_at, sent_at
```

Indexed on `status`, which is the only query that matters.

## Tools

| Tool | Category | Does |
|---|---|---|
| `shopping_add` | `todo_write` | Add one or more items to the standing list |
| `shopping_list` | `read` | What is pending |
| `shopping_remove` | `todo_write` | Drop an item, or put a sent one back |
| `shopping_order` | `read` | Produce the paste block; mark items sent |

`shopping_order` is `read` because it spends nothing, commits nothing and
contacts nobody — it formats text this household already owns. That follows the
precedent `docs/AMAZON.md` set for cart-and-handoff. Nothing here can reach
`purchase`, so the `PURCHASE_MONTHLY_CAP` currency mismatch — the cap is USD and
Canadian prices are not — does not arise. It will matter when Amazon lands.

## Error handling

- **Unparseable quantity.** Degrade to name-only, phrasing preserved in
  `displayText`. Never invent a number.
- **Empty list.** Say so plainly. Do not produce an empty code block.
- **Over 200 items.** Split into two blocks rather than silently truncating. A
  household will not hit this; silent truncation would be discovered at the till.
- **Marking sent fails.** The block has already been shown, so the items stay
  pending and the household is told they may be offered again. Better a repeat
  than a loss.

## Testing

The tests that carry weight:

- Quantity degradation: `"as needed"` and `"2 lb + 3 cups"` produce a named line
  with no invented number
- The paste block contains no markdown, no section headers, no provenance
- Standing items fold into the weekend shop and not the midweek one
- Items are marked `sent` only after a block is actually produced
- Urgent bypasses batching; ordinary items do not
- Over 200 items splits rather than truncates
- A `sent` item can be put back and reappears as pending

## Out of scope

- **Reorder-the-usual.** With no read-back it can only mine our own lists — what
  we suggested, never what was bought. Revisit after real use shows a gap.
- **Price awareness** from scraper APIs. Read-only and low risk, but it is a
  different feature and would blur a clean design.
- **Amazon.ca.** Next, and separate. Household staples the grocery shop does not
  cover, browser-driven, cart-and-handoff. Its own spec.
- **ACP.** Real checkout, real money. Its own design conversation.

## Human setup steps

None. No key, no account, no configuration.

When Instacart reopens applications, apply — the API client replaces the
formatter behind the same `ShoppingList` type, and nothing upstream changes.

## Sources

- [Instacart Shopping List (paste and photo import)](https://www.instacart.ca/help/section/360007902831/8773376095508)
- [Create shopping list page API](https://docs.instacart.com/developer_platform_api/api/products/create_shopping_list_page) — the closed path
- [Agentic Commerce Protocol](https://www.agenticcommerce.dev/) — open standard, any agent
- [OpenAI retires Instant Checkout](https://www.americanbanker.com/payments/news/openai-moves-ai-checkout-to-third-parties)
- [Agentic Checkout spec](https://developers.openai.com/commerce/specs/checkout) — External Checkout as the recommended pattern
