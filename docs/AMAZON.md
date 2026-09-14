# Ordering from Amazon: what's actually possible

**There is no API that lets a household account place an Amazon order.** Every
official ordering endpoint Amazon publishes is gated behind a registered legal
business or a seller account. That is why this repo drives a browser for M5, and
why the default mode carts the items and hands checkout back to you.

This page records what was checked, in August 2026, so nobody re-litigates it.

## The options, and why each one is out

| Path | Can it place a household order? | Blocker |
|---|---|---|
| Product Advertising API (PA-API 5.0) | **No** | Search and product data only. Cannot add to cart, cannot order. Also requires an Associates account, and access is revoked if the app doesn't generate qualifying affiliate revenue within 30 days. |
| Amazon Business Ordering API | Technically yes — but **not for you** | Real orders that ship (`POST /ordering/2022-10-30/orders`). Requires an Amazon Business account, a **registered legal business**, an Active purchasing group with payment methods, and **solution-provider approval with a 4–6 week developer onboarding**. Explicitly targeted at enterprise procurement, not individuals or households. |
| Selling Partner API (SP-API) | **No** | Seller-side. It manages orders placed *with* you, not orders placed *by* you. |
| Alexa Shopping / Dash Replenishment | **No** | No public programmatic consumer ordering surface. |
| Amazon Fresh / Whole Foods | **No** | No public ordering API. |
| An official Amazon MCP server | **Does not exist** | Amazon has not adopted MCP, ACP, AP2, or UCP. Rufus and "Buy for Me" are closed, in-app, and have no public API. The walled garden is the strategy, not an oversight. |
| Third-party MCP "Amazon shopping" servers | Unofficial | These are browser-driving or scraping wrappers with someone else's code between you and your logged-in account. Same brittleness as doing it yourself, plus a third party in the loop. |
| Third-party order APIs (e.g. Zinc) | Yes, unofficially | A paid service that places the order on your behalf. It operates outside Amazon's terms, and it needs your account credentials. Not recommended for a family account you cannot afford to lose. |

## What this repo does instead

**Cart-and-handoff is the default, and it is the durable one.** The assistant
searches, compares, and adds to the cart using a logged-in Playwright profile,
then sends you a Telegram summary with the cart link. You tap checkout in the
Amazon app. The agent never sees or handles payment, spends nothing, and so runs
under the `allow` policy.

**Full checkout is opt-in and experimental.** It sits in the `purchase`
category: an approval card every time, showing the item list and total, plus a
hard monthly ceiling (`PURCHASE_MONTHLY_CAP`) enforced in the policy engine from
audit history rather than in a prompt. Turn it on with `/policy` only if you
want it. Expect it to break periodically — bot detection and layout drift are
constant — and expect it to degrade to "here's the link, I couldn't finish."

## Account risk

Automated purchasing runs against Amazon's conditions of use. The realistic
exposure for a single household account doing occasional, human-approved,
human-paced actions is low but not zero, and the failure mode is account
suspension, which would also take out your Prime, your order history, and any
Amazon devices in the house. Cart-and-handoff keeps a human in the checkout
loop, which is both the safer posture and the one that degrades gracefully.

If Amazon ever ships a real consumer ordering API, or joins an agentic-commerce
protocol, this becomes a small refactor: swap the browser worker behind
`src/tools/browser.ts` for an API client and keep the same policy gates.

## Sources

- [Amazon Business Ordering API overview](https://docs.business.amazon.com/docs/ordering-api) — endpoints, eligibility, 4–6 week onboarding
- [Zinc: Amazon Shopping API guide (2026)](https://www.zinc.com/blog/amazon-api) — confirms PA-API cannot cart or order, and the affiliate-revenue gate
- [Selling Partner API](https://sell.amazon.com/developers) — seller-side scope
- [Amazon's AI agent strategy: Rufus, Buy for Me, and the walled garden (2026)](https://stellagent.ai/insights/amazon-ai-agent-rufus-buy-for-me) — Amazon has not adopted MCP, UCP, ACP, or AP2
