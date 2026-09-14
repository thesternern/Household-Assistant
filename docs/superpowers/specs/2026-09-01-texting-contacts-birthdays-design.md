# Texting, contacts, and birthdays

Design, 1 September 2026.

## Context

Chessy can call a contact and email from two accounts. She cannot text, she does
not know the household's own phone numbers, and she has no idea how old the
children are or when anyone's birthday falls.

Three gaps, one shared foundation: the `contacts` table. Texting resolves a
recipient through it, birthdays hang off it, and the household's own numbers
belong in it.

The first instinct was to use Vapi, which now supports SMS. Vapi's own
documentation rules it out: *"Only customers can initiate conversations —
assistants cannot send the first message."* Chessy texting the sitter first is the
entire use case. Vapi's SMS also runs on Twilio underneath, so going to Twilio
directly is the same pipe without the restriction.

Vapi keeps the phone calls. Nothing in `vapi.ts`, `phone.ts`, or
`workflows/call.ts` changes.

## Jurisdiction

The household is in British Columbia, Canada, and its Twilio number
`+1 604 555 0100` is a Canadian local long code with SMS, MMS, and Voice
enabled.

A2P 10DLC governs **US-bound** traffic, and the destination decides, not the
sender. Two different answers follow from that, and the first draft of this
document got it wrong by giving only one:

- **To Canadian recipients** — no brand or campaign registration, and it works
  today. Verified on 2 September 2026: a message from `+1 604 555 0100` to a
  BC mobile was **delivered**. The Canadian long-code
  filtering this document once treated as an accepted risk did not materialise at
  household volume, so Phase 2 needs no toll-free sender to reach the babysitter.
- **To US recipients** — registration is required, even from this Canadian
  number. Verified empirically on 2 September 2026: a test message from
  `+1 604 555 0100` to a US mobile was accepted by Twilio, then returned
  `undelivered` with error **30034**, "message from an unregistered number".

So any US mobile is unreachable by text until either an A2P
10DLC Sole Proprietor brand and campaign are registered and the number is added
to a Messaging Service sender pool, or a verified toll-free number is used
instead.

This is mostly moot for the actual use case — the babysitter is texted at a
Canadian number — but it must not be discovered during Phase 2 by a message that
silently fails.

## Phases

Each phase ships independently and is useful on its own.

1. **Birthdays, and the household guardrail.** No vendor dependency. Useful the
   day it lands.
2. **Outbound SMS.** Send-only, behind the approval deadbolt.
3. **Inbound SMS.** Threads, replies, bounded autonomy.

---

## Phase 1 — Birthdays

### Data

Two columns on `contacts`:

```ts
birthday: date('birthday'),
household: boolean('household').notNull().default(false),
```

A `date`, not a timestamp. A birthday is a calendar day, and giving it a time
invites a timezone to shift it across midnight.

`household` marks the people who live here — both adults and the children. It
earns its place in Phase 2, where it is what stops Chessy texting a family
member, but it costs nothing to add in the same migration and saves a second
one.

Family goes in as ordinary contact rows: the two adults with `role` `spouse` and
a phone number, the children with `role` `child`, a birthday, and no phone.

Putting family in the address book rather than a table of their own means one
place to look when the household asks about a person, and it reuses the ranking,
the E.164 normalisation, and the phone guardrail that already exist. The ranking
in `contacts.ts` already keeps a row without a phone number from outranking one
that has a number to dial, so a child cannot displace the dentist when Chessy is
deciding who to call.

### Age is derived, never stored

Age is computed with Luxon at read time, in the household timezone. A stored age
is wrong within a year of being written, and nothing would notice.

`contact_search` returns `birthday` and a derived `age`, so "how old is she, the
form is asking" and "whose birthday is coming up" both answer off one column.

The awkward cases are real and get tests: a 29 February birthday, and a birthday
that falls either side of the local midnight boundary.

### Household members are reference-only

A contact with `household` set is **not a reachable target**. Neither
`sms_send` nor `phone_place_call` will accept one. The tool refuses and says
why: *"Sam is in the household — tell her in Telegram."*

These numbers are in the address book so Chessy can give one to a doctor's
office or put one on a booking. That is the whole reason they are there.

Redirecting such a message to Telegram instead was considered and rejected. A
rule that quietly reroutes still leaves a code path where a misfire reaches a
family member's phone at two in the morning. Refusing outright has no such path.

The block on calling lands here, in Phase 1, rather than waiting for Twilio:
`phone_place_call` already exists and the column ships with this migration, so
there is nothing to wait for.

The flag is explicit rather than inferred from `role`, which is free text. "Wife"
and "spouse" are the same person to the household and two different strings to a
`LIKE`, and a guardrail that depends on spelling is not a guardrail.

This also covers the children as they grow into phones of their own.

### Reminders

A daily `birthday-sweep` cron, registered alongside the existing crons and fired
at 18:00 household-local. It reads the `birthday` column directly.

It deliberately does **not** run at `briefHour`. The morning brief carries
birthdays too, and a sweep five minutes behind it delivered the same fact twice
in different words. The brief is an agent turn under a word cap and can drop a
line; the sweep cannot, so it stays as the deterministic backstop — twelve hours
away, where it reads as an evening nudge rather than an echo.

**No reminder rows.** Creating recurring `reminders` with a yearly rrule was the
obvious alternative — that machinery already exists — but it duplicates state.
Correcting a birthday would leave a stale reminder firing on the old date, and
the two sources would disagree with nothing to reconcile them. One column, one
source of truth.

Two notifications per birthday: **seven days ahead**, which is enough time to buy
something, and **on the day**. Birthdays also appear in the morning brief.

---

## Phase 2 — Outbound SMS

### Integration

A new `src/integrations/twilio.ts`, structured like `vapi.ts`:

- `sendSms(to, body)` — E.164 normalised, Canada and US only
- `twilioConfigured`, computed like `vapiConfigured` but stricter: the account
  SID must carry Twilio's actual shape — `AC` followed by 32 hex characters —
  rather than merely being non-empty. The Railway variables are seeded with
  placeholders so the slots exist, and a placeholder must never read as
  configured.
- A dry-run path mirroring `vapi.ts`, so the whole path can be exercised with
  nothing leaving the building

### The deadbolt

A new policy category `sms_send`, seeded to `require_approval`, guarded by
`hasApprovedAction` — the same gate that stands in front of `phone_call`. No
approval row, no message. The tool proposes; the executor replays the stored
arguments only after a household member taps approve.

The approval card shows the recipient's name, their number, and the exact text
that will be sent. The approved text is what goes out, unchanged.

### The contact guardrail

A text may only go to a number already in the contact book. This is the rule
`phone.ts` enforces for dialling, and it carries over unchanged: a number the
model produced from memory is a number nobody in the house has ever saved.

### Identification

The first outbound message in any thread identifies the sender:

> This is Chessy, a family assistant working for Alex and Sam.

Anyone receiving a text from an unfamiliar number deserves to know who is
writing before they answer. Subsequent messages in the same thread do not repeat
it.

### One recipient

`sms_send` targets a single contact. There is no fan-out and no shared group
thread. When the household wants several people told something, Chessy tells
them in Telegram; when an outsider needs to be told, she texts that one person
and reports back.

Group MMS behaves inconsistently across carriers and between iOS and Android,
and Twilio's Conversations API is a substantial dependency for a household that
mostly needs to reach one sitter.

---

## Phase 3 — Inbound SMS

### Webhook

`POST /webhooks/twilio/sms`, following the discipline the existing webhooks
already set:

- Twilio's `X-Twilio-Signature` HMAC validated before anything else
- Body size limited
- Rejections audited under the existing throttle
- A job queued rather than an agent turn run inline

An agent turn takes tens of seconds. Running one inside a webhook guarantees a
timeout and a redelivery storm.

### Threads

Two new tables. `conversations` is keyed on `telegram_chat_id` and cannot carry
this.

```
sms_threads    contact_id, goal, status, approved_action_id,
               message_count, opened_at, expires_at, last_message_at
sms_messages   thread_id, direction, body, twilio_sid, created_at
```

### Bounded autonomy

An approved `sms_send` opens a thread carrying the goal it was approved for, a
message cap of **10**, and a window of **24 hours**.

Inside those bounds Chessy answers without a fresh approval, the way the voice
agent already converses freely inside a single approved call. Outside them the
thread closes, and further inbound messages are relayed to the household in
Telegram rather than answered.

This is the safety boundary of the whole feature and is where the tests
concentrate. An SMS thread, unlike a call, can stay open for days; the cap and
the window are what stop an approved errand becoming a standing licence to
correspond.

### Notification policy

Chessy does not relay every message. A four-message exchange with a sitter would
otherwise produce four notifications for an errand the household delegated
precisely so it would not have to be watched.

She tells the household when:

- a send fails, including an opt-out (`21610`)
- a thread hits its message cap or its window without meeting its goal
- a reply arrives that she cannot act on within the approved goal
- the goal completes — one line, so the household learns the sitter said yes
- any message arrives after the thread has closed

The full transcript is always written to `sms_messages` and readable on demand
through `sms_get_thread`. Silence means the errand is proceeding. It never means
the record is missing.

### Opt-out

Twilio enforces `STOP` and its variants automatically for Canada and the US, and
returns error `21610` on a subsequent send to that number. The design surfaces
that state rather than fighting it: on `21610`, mark the contact unreachable by
text, close any open thread, and tell the household. Chessy must never be able to
text someone who has opted out.

---

## Configuration

All four live as **Railway service variables**. No `.env` file is involved, and
nothing is baked into the image.

| Variable | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | secret, household-supplied; seeded `REPLACE_ME` |
| `TWILIO_AUTH_TOKEN` | secret, household-supplied; seeded `REPLACE_ME` |
| `TWILIO_FROM_NUMBER` | `+16045550100` |
| `DRY_RUN_SMS` | `true` until a dry run has been watched end to end |

`DRY_RUN_SMS` defaults to `true`, matching `DRY_RUN_CALLS`. The household sees
the entire path exercised before a real message leaves.

## One number, two channels

The same Twilio number serves Vapi voice and this SMS integration, so a
recipient sees one number whether Chessy calls or texts.

When importing the number into Vapi, its **SMS toggle must stay off**. Turning it
on makes Vapi rewrite the Twilio messaging webhook to route inbound texts to a
Vapi agent, which silently takes over the inbound path this design depends on.

## Testing

Test-driven throughout, matching the existing suite's style.

The tests that carry weight:

- Age across a 29 February birthday, and either side of local midnight
- Lead-time boundaries: exactly seven days out, and the day itself
- The approval deadbolt refusing to send with no approval row
- The contact guardrail refusing a number that is not in the book
- Both `sms_send` and `phone_place_call` refusing a household contact
- Webhook signature rejection, and that a rejected caller queues no job
- The message cap and the time window actually ending autonomy
- `21610` marking a contact unreachable and closing the thread
- The dry-run path sending nothing while recording everything

## Out of scope

- **Toll-free fallback.** Revisited only if Canadian carrier filtering starts
  eating messages.
- **Group threads and fan-out.**
- **MMS.** Text only.
- **Vapi SMS.** Cannot initiate; superseded by Twilio.
- **Non-North-American recipients.**

## Human setup steps

In order, after each phase deploys:

1. Add the four Railway variables above.
2. Twilio → Messaging configuration → "A message comes in" → Webhook, HTTP POST,
   `https://your-app.up.railway.app/webhooks/twilio/sms`
3. Watch one dry run, then set `DRY_RUN_SMS=false`.
4. Optionally, Vapi → Phone Numbers → Import Twilio, SMS toggle **off**, then set
   `VAPI_PHONE_NUMBER_ID`.
