# Setup

You need about 45 minutes, split across four accounts. Work top to bottom — each
section's output feeds the next. Nothing here is reversible-in-a-bad-way; the
assistant refuses to act until its whitelist and policies are in place.

## What you get at each stage

| Stage | Time | What starts working |
|---|---|---|
| 1. Local run | 10 min | Telegram chat, memory, to-dos, reminders, `/setup` |
| 2. Railway | 10 min | The same thing, always on |
| 3. Google | 15 min | Calendar, Gmail, the morning brief, daycare watchers, and the assistant's own mailbox |
| 4. Vapi | 10 min | Real phone calls |
| 5. Browser | 5 min | Amazon cart-and-handoff |

Stages 3–5 are optional and independent. Run `/status` in Telegram at any point
to see what is connected and what is missing.

---

## Stage 1 — run it locally

### 1.1 Create the Telegram bot

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts.
2. Copy the token into `TELEGRAM_BOT_TOKEN`.
3. Message [@userinfobot](https://t.me/userinfobot) from your own account. Copy the
   numeric ID into `TELEGRAM_USER_ID_1`.
4. Have your partner do the same. Their ID goes in `TELEGRAM_USER_ID_2`.

Those two IDs are the entire access control list. Any message from any other
account is dropped before it reaches the model.

**Both of you must open the bot and press Start before it can reach you.**
Telegram does not let a bot send the first message, so until each spouse has
that chat open, approval cards and reminders have nowhere to arrive — and the
symptom is an assistant that looks broken rather than one waiting on a tap.

### 1.2 Fill in the environment

```bash
cp .env.example .env
openssl rand -base64 48        # -> APP_SECRET
openssl rand -hex 24           # -> TELEGRAM_WEBHOOK_SECRET
```

Set `ANTHROPIC_API_KEY` from [console.anthropic.com](https://console.anthropic.com).
Leave `APP_URL` as-is for now; local runs use long polling, not webhooks.

### 1.3 Database

```bash
createdb home_assistant
npm run db:migrate
npm run seed          # seeds policy defaults and the household row
```

### 1.4 Run

```bash
npm run dev
```

The bot connects by long polling — no tunnel, no public URL. Message it on
Telegram and run `/setup` to walk the onboarding interview.

---

## Stage 2 — Railway

The target shape:

| | |
|---|---|
| Services | `Postgres`, `home-assistant` |
| Volume | `/data` on `home-assistant` (5 GB) |
| URL | `https://your-app.up.railway.app` |
| Replicas | 1, pinned in `railway.json` |

### 2.1 Create the project

1. Fork this repo.
2. In Railway, create a project and add a **Postgres** service.
3. Add a service from your fork, name it `home-assistant`, and pick the branch
   `main`. It builds from the `Dockerfile` and auto-deploys on every push.
4. Attach a volume at `/data` and generate a public domain.
5. Set `DATABASE_URL` as a reference to the Postgres service, so it follows a
   credential rotation. Then set `APP_URL` to the generated domain,
   `CLAUDE_CONFIG_DIR=/data/claude`, `PLAYWRIGHT_BROWSERS_PATH=/data/playwright`,
   `HOUSEHOLD_TIMEZONE`, and freshly generated `APP_SECRET` and
   `TELEGRAM_WEBHOOK_SECRET`. `PORT` comes from Railway. Everything else has a
   default in `.env.example`.

### 2.2 Paste the secrets

Set these on the `home-assistant` service.

| Variable | Where it comes from |
|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) |
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_USER_ID_1` | [@userinfobot](https://t.me/userinfobot), your account |
| `TELEGRAM_USER_ID_2` | @userinfobot, your partner's account |

Optional, per stage: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (stage 3),
`VAPI_API_KEY` / `VAPI_PHONE_NUMBER_ID` / `VAPI_WEBHOOK_SECRET` (stage 4),
`WEATHER_LATITUDE` / `WEATHER_LONGITUDE` for the morning brief, and
`GITHUB_TOKEN` to let `/improve` file issues.

The service will fail to boot until the four required ones are set — that is
deliberate. A half-configured household assistant is worse than none, so the
config is validated at startup and the process exits with the exact list of
what is missing.

### 2.3 Verify

On boot it runs migrations, creates its queues, and registers its own Telegram
webhook at `${APP_URL}/webhooks/telegram/${TELEGRAM_WEBHOOK_SECRET}`. Check:

```
curl https://your-app.up.railway.app/healthz
```

Then message the bot and run `/status`, which reports webhook health, queue
depth, last cron runs, both Google accounts, Vapi, and volume usage.

**Keep replicas at 1.** pg-boss cron scheduling and webhook ordering both assume
a single writer.

## Stage 3 — Google: two accounts

The assistant connects **two** Google accounts, and the split is the point.

| Role | Which account | What it's for |
|---|---|---|
| `personal` | Your own Gmail | Reading. The daycare watchers, inbox triage, and the morning brief all need to see what actually arrives. Read-mostly — it rarely sends. |
| `assistant` | A user in your Google Workspace, on your family domain | Its own identity. This is what it **sends as**, and where replies to its mail come back, so its correspondence never drowns in your inbox. |

Sends default to the assistant account and reads default to yours. If an account
isn't connected, the tool fails with a clear error rather than quietly falling
back — sending family mail from the wrong address is exactly what this split
exists to prevent.

Your partner stays Telegram-only. They still see everything, because every event
the assistant creates lands on the shared family calendar.

### 3.1 Create the assistant's mailbox

The assistant needs a second Google account. Nothing in the code requires
Workspace — the OAuth flow, the scopes and the send path are identical either
way — so there are two ways to give her one.

| | Address | Cost | Trade-off |
|---|---|---|---|
| **Workspace user on your family domain** | `chessy@yourdomain` | Paid, per user | Reads as the household writing. Needs a domain you control. |
| **A second free Gmail** | `chessy.yourname@gmail.com` | Free | Identical to the code. Reads as a personal address, and a brand-new Gmail is likelier to land in spam at first. |

For Workspace, add a user in the admin console for your domain; Business Starter
is enough, and no extra DNS work is needed because the domain is already
verified. For the free path, just create the account.

Either way, set the account's **first name to the name you chose in `/setup`**.
The display name on outgoing mail and the sign-off both come from that Google
profile, not from the database, so this is what keeps her name the same on
Telegram, on the phone, and in the inbox.

### 3.2 One OAuth client covers both

1. In [Google Cloud Console](https://console.cloud.google.com), create a project.
2. **Enable APIs**: Gmail API and Google Calendar API.
3. **OAuth consent screen**: External. Add both accounts as users.
   **Publish it to "In production."** Testing mode expires refresh tokens after
   7 days, and the assistant will silently lose access every week.
4. **Credentials → Create OAuth client ID → Web application.** Authorised
   redirect URI, exactly:
   ```
   https://<your-app>.up.railway.app/oauth/google/callback
   ```
5. Copy the client ID and secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

### 3.3 Connect them

In Telegram, run it twice — once per role:

```
/connect_google personal
/connect_google assistant
```

Sign in as the matching account each time. `/status` then lists both with their
email addresses, so it is obvious if one is missing or has gone invalid.

Then `/setup` asks which calendar is the family one and stores its ID.

Both refresh tokens are encrypted with `APP_SECRET` before they touch the
database. If Google returns `invalid_grant`, the assistant names **which**
account broke and asks you to reconnect that one, rather than failing silently.

### Watchers

Once the personal account is connected, tell the assistant what to watch:

> watch emails from @brightwheel.com

It polls every 15 minutes, extracts dates and action items from new messages,
adds events to the family calendar, sets reminders, and posts a digest to both
of you. Every auto-added event carries a **Remove** button.

Anything a watcher does is structurally confined to calendar, reminder, to-do
and memory writes — no policy setting can widen it, so a hostile email cannot
reach the phone, the inbox, or your wallet.

### Replies to the assistant's own mail

Once the `assistant` account is connected, add a watcher on its inbox:

> watch my assistant's inbox

Every 15 minutes it checks the assistant's own mailbox. When someone replies to
a thread the assistant started — the plumber confirming Thursday — you get the
reply in Telegram and the assistant picks the thread back up, proposing the
calendar entry or the follow-up. Anything it proposes still goes through the
approval card.

Mail from a stranger who was never in one of its threads is **announced and
nothing more**. It never becomes a prompt. That line matters: the assistant's
address is the one inbox an outsider can write to directly, and turning a cold
email into an agent instruction is a door worth leaving shut.

## Stage 4 — Vapi (phone calls)

1. Sign up at [vapi.ai](https://vapi.ai), create an API key → `VAPI_API_KEY`.
2. **Import** the household's existing Twilio number — do not buy a Vapi one.
   In **Phone Numbers → Import**, give it the Twilio account SID, auth token,
   and your Twilio number. The resulting ID goes in `VAPI_PHONE_NUMBER_ID`.

   **Leave Vapi's SMS toggle off.** One number carries both voice and text so
   the assistant has a single identity, but enabling SMS in Vapi rewrites the
   messaging webhook on the Twilio number, which takes the inbound text path
   away from this service. Voice through Vapi, text through Twilio directly.
3. Invent a webhook secret → `VAPI_WEBHOOK_SECRET`. This is not a value Vapi
   issues: generate one with `openssl rand -hex 24`. Every call carries it in an
   `x-vapi-secret` header and the webhook checks it in constant time.

   **There is no server URL to set in the Vapi dashboard.** Each call builds a
   transient assistant that carries `${APP_URL}/webhooks/vapi` and the secret
   header with it, so the callback is configured per call rather than per
   account.
4. **Set a fallback destination on the number.** Nothing answers an inbound
   call: the number has no assistant, so Vapi tells whoever rang that it
   "could not get assistant" and hangs up. That matters because the voicemail
   she leaves quotes this number as the callback, so the people most likely to
   ring it are the ones she asked to.

   Vapi routes to `fallbackDestination` exactly when `assistantId` and
   `squadId` are unset and no `assistant-request` succeeds — which is always,
   here. Point it at a household mobile:

   ```
   curl -X PATCH https://api.vapi.ai/phone-number/$VAPI_PHONE_NUMBER_ID \
     -H "Authorization: Bearer $VAPI_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"fallbackDestination":{"type":"number","number":"+1..."}}'
   ```

   This one lives in Vapi rather than in this repo, so it does not come back on
   its own if the number is ever re-imported. It is the only piece of per-call
   behaviour not shipped with the code, and it is here because there is no
   inbound path to ship it through yet.
5. **Leave `DRY_RUN_CALLS=true`.** Run `/call` a few times first. Dry run
   exercises the entire path — approval card, transient assistant construction,
   webhook handling, transcript storage, outcome narration — without dialling.
6. When you are satisfied, set `DRY_RUN_CALLS=false` and make the first real
   call to your own mobile.

Every call is gated: you see the number, the goal, and the script summary on an
approval card before anything dials. The system prompt template forbids sharing
payment details.

---

## Stage 5 — browser automation and Amazon (M5)

Off by default. Set `BROWSER_ENABLED=true` to turn it on.

**There is no official Amazon API for this.** See
[docs/AMAZON.md](AMAZON.md) for why, and what that means for reliability.

Two modes:

- **Cart-and-handoff (default).** The assistant searches, compares, and adds to
  your cart, then sends a Telegram summary with the cart link. You tap checkout
  in the Amazon app. The agent never touches payment. Costs nothing, so it runs
  under the `allow` policy.
- **Full checkout (opt-in).** `purchase` category — always an approval card
  showing items and total, plus a hard monthly ceiling from
  `PURCHASE_MONTHLY_CAP` enforced in the policy engine against audit history.
  Enable per-category with `/policy`. Treat it as experimental.

`BROWSER_ALLOWED_DOMAINS` is a hard allowlist enforced at the tool layer, not in
a prompt. Navigation outside it is refused before the browser is told to move.

To log into a site once and keep the session:

```
/connect_site
```

Credentials are encrypted with `APP_SECRET`, stored in `site_credentials`, and
never echoed back into chat or into model context. The logged-in profile lives
on the `/data` volume so it survives deploys.

---

## Policy and trust

`/policy` lists every action category and its current mode, and lets you flip
one as trust builds.

| Category | Default | What it covers |
|---|---|---|
| `read` | allow | Anything that only looks |
| `memory_write`, `todo_write`, `reminder_write`, `recipe_write` | allow | Household state |
| `calendar_write_from_watcher` | allow | Daycare/school events found by a watcher — announced, with a Remove button |
| `calendar_write` | require approval | Events the assistant proposes |
| `email_send` | require approval | Sending or replying |
| `phone_call` | require approval | Placing a call |
| `purchase` | require approval | Spending money, plus the monthly cap |
| `booking_cancel` | require approval | Cancelling a reservation |
| `browser_task` | require approval | Driving a logged-in browser session |

Approval cards go to **both** of you. The first tap wins, atomically. What
executes is the exact argument object you were shown — the model does not get
to re-issue the call after you approve it.

---

## Operating it

| Command | Does |
|---|---|
| `/start`, `/help` | Introduce the assistant; list everything it answers to. |
| `/setup` | Guided onboarding interview. Rerunnable and additive. |
| `/status` | Connection checklist and health. |
| `/brief` | Morning brief on demand. |
| `/review` | Weekly review with the cost report and approval retro. |
| `/todo`, `/todos`, `/done` | To-dos. |
| `/remind`, `/reminders` | Set a reminder; list the scheduled ones. |
| `/mealprep` | Weekly meal plan and grocery list. |
| `/book`, `/call` | Phone-based booking and calls. |
| `/approve` | List pending approvals. |
| `/cancel` | Cancel the setup wizard, or a pending approval by id. |
| `/policy` | View and change category modes. |
| `/rules` | Behaviour rules injected into every prompt. |
| `/improve` | File a capability request as a GitHub issue. |
| `/connect_google personal\|assistant` | Connect either Google account. |
| `/connect_site` | Log the browser worker into a site once. |
| `/reset` | Start a fresh conversation; memory, to-dos, and rules are kept. |

## Troubleshooting

**The bot doesn't answer.** `/status` in a browser: `GET ${APP_URL}/healthz`. If
the service is up but Telegram is quiet, the webhook probably dropped — the
watchdog re-registers it every 10 minutes, or restart the service to force it.

**Gmail stopped working after a week.** The consent screen is still in Testing
mode. Publish it and re-run `/connect_google`.

**Approvals expire before you tap.** They hold for 30 minutes. Ask again; the
assistant re-proposes.

**Costs look high.** `/review` breaks down spend by trigger. Lower
`DAILY_BUDGET_ALERT_USD` to get told sooner.
