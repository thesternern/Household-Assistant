/**
 * `sms_send` — text one contact from the household number.
 *
 * Three gates stand in front of a message leaving the building, and they are
 * deliberately in this order:
 *
 *  1. **The approval deadbolt.** `sms_send` is consequential, so the model can
 *     only ever propose. The gate parks the call, the household taps approve,
 *     and the executor replays the stored arguments — which means the text that
 *     goes out is byte-for-byte the text that was on the card. The model does
 *     not get to re-word it afterwards.
 *  2. **The household refusal.** A contact marked `household` is never a
 *     reachable target. Their numbers live in the address book so Chessy can
 *     give one to a doctor's office, not so she can text the family. Rerouting
 *     such a message to Telegram was considered and rejected: a rule that
 *     quietly redirects still leaves a code path that reaches a family member's
 *     phone at two in the morning. Refusing has no such path.
 *  3. **The contact-book requirement.** A text may only go to a number already
 *     saved. This is stricter than `phone_place_call`, which lets a domestic
 *     number through unsaved — a wrong number dialled gets an apology and a
 *     hang-up, while a wrong number texted gets a stranger holding a written
 *     record of the household's business.
 *
 * The composed body, identification line and all, is what `summarize` shows and
 * what the handler sends. If those two ever drift, the household approves one
 * thing and a different thing goes out, so the composition lives in one
 * exported function that both call.
 */
import { and, eq, isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from '../audit/log.js'
import { getDb, schema } from '../db/client.js'
import { MAX_SMS_CHARS, sendSms, twilioFromNumber } from '../integrations/twilio.js'
import { logger } from '../logger.js'
import { hasApprovedAction } from '../policy/pending.js'
import {
  MAX_THREAD_MESSAGES,
  appendMessage,
  autonomyVerdict,
  latestThreadFor,
  markOptedOut,
  openThread,
  openThreadFor,
  threadMessages,
} from '../sms/threads.js'
import { formatE164, normalizeE164, validateCalleeNumber } from './phone.js'
import type { CalleeCheck } from './phone.js'
import { fail, ok } from './types.js'
import type { ToolDef } from './types.js'
import { wrapUntrusted } from './untrusted.js'

const log = logger.child({ mod: 'tools/sms' })

/**
 * Cap on the address-book scan. Being *in* the book grants permission, so a
 * truncated scan fails closed; the household list is read without a cap, as
 * `phone.ts` does, because being in *that* list denies.
 */
const CONTACT_SCAN_LIMIT = 5000

/** Longest message the model may write, leaving room for the identification line. */
const MAX_BODY_CHARS = 320

/**
 * The identification line.
 *
 * Anyone receiving a text from a number they do not recognise deserves to know
 * who is writing before they decide whether to answer. It names the assistant
 * and the household she works for, and it never claims to be a person.
 */
export function identification(assistantName: string, householdName: string): string {
  const who = assistantName.trim() === '' ? 'an assistant' : assistantName.trim()
  const family = householdName.trim() === '' ? 'the family' : `${householdName.trim()}`
  return `This is ${who}, a family assistant working for ${family}.`
}

/**
 * The exact text that will be sent.
 *
 * Both the approval card and the send path go through here, so what the
 * household reads is what the recipient receives.
 */
export function composeSms(input: {
  message: string
  assistantName: string
  householdName: string
  includeIdentification: boolean
}): string {
  const body = input.message.replace(/\s+/g, ' ').trim()
  if (!input.includeIdentification) return body
  return `${identification(input.assistantName, input.householdName)} ${body} ${OPT_OUT_LINE}`
}

/**
 * The opt-out line.
 *
 * The A2P 10DLC campaign is registered with sample messages that carry it, so
 * real traffic has to carry it too. It goes on the first message of a thread
 * and nowhere else, for the same reason the introduction does: a sitter who has
 * already answered knows both who is writing and how to stop it, and repeating
 * the instruction every time reads as a machine hectoring her.
 *
 * If it ever becomes more nuisance than it is worth, the way out is not to drop
 * it quietly — it is to stop texting US numbers, since A2P governs US-bound
 * traffic and the household's actual recipients are Canadian.
 */
const OPT_OUT_LINE = 'Reply STOP to opt out.'

const sendShape = {
  to_number: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .describe(
      'The number to text, which must already be saved as a contact. Take it from the address book, ' +
        'never from memory of what a number looked like.',
    ),
  to_name: z
    .string()
    .trim()
    .min(2)
    .max(160)
    .describe('Who is being texted, as a person would say it. This is what the approval card shows.'),
  message: z
    .string()
    .trim()
    .min(2)
    .max(MAX_BODY_CHARS)
    .describe(
      'What to say, in full. Write it as it should arrive — this exact text is what the household ' +
        'approves and what is sent. Do not introduce yourself; that line is added for you.',
    ),
}
const sendSchema = z.object(sendShape)

function parse(args: unknown): { ok: true; value: z.infer<typeof sendSchema> } | { ok: false; error: string } {
  const result = sendSchema.safeParse(args)
  if (result.success) return { ok: true, value: result.data }
  return {
    ok: false,
    error: result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; '),
  }
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** Every saved number, and the subset belonging to people who live here. */
async function knownNumbers(): Promise<{ all: string[]; household: string[] }> {
  const db = getDb()
  const rows = await db
    .select({ phone: schema.contacts.phone, household: schema.contacts.household })
    .from(schema.contacts)
    .where(isNotNull(schema.contacts.phone))
    .limit(CONTACT_SCAN_LIMIT)

  const householdRows = await db
    .select({ phone: schema.contacts.phone })
    .from(schema.contacts)
    .where(and(isNotNull(schema.contacts.phone), eq(schema.contacts.household, true)))

  // `normalizeE164`, not `validateCalleeNumber`: the callee check refuses an
  // international or non-geographic number unless the book already holds it,
  // and this IS the book. Judging the book by that rule emptied it of every
  // saved +44, so no international contact could ever be texted.
  const all: string[] = []
  const household: string[] = []
  for (const row of rows) {
    const parsed = normalizeE164(row.phone ?? '')
    if (!parsed.ok) continue
    if (!all.includes(parsed.e164)) all.push(parsed.e164)
  }
  for (const row of householdRows) {
    const parsed = normalizeE164(row.phone ?? '')
    if (!parsed.ok) continue
    if (!household.includes(parsed.e164)) household.push(parsed.e164)
  }
  return { all, household }
}

/** The household's own names, for the identification line. */
async function names(): Promise<{ assistantName: string; householdName: string }> {
  try {
    const rows = await getDb()
      .select({
        assistantName: schema.households.assistantName,
        name: schema.households.name,
      })
      .from(schema.households)
      .limit(1)
    const row = rows[0]
    return {
      assistantName: str(row?.assistantName, 'Chessy'),
      householdName: str(row?.name, 'the family'),
    }
  } catch (err) {
    log.error({ err }, 'could not read the household name')
    return { assistantName: 'Chessy', householdName: 'the family' }
  }
}

/** The saved contact behind a number, with its opt-out state. */
async function contactFor(
  phone: string,
): Promise<{ id: number; smsOptedOutAt: Date | null } | undefined> {
  try {
    const rows = await getDb()
      .select({ id: schema.contacts.id, smsOptedOutAt: schema.contacts.smsOptedOutAt })
      .from(schema.contacts)
      .where(eq(schema.contacts.phone, phone))
      .limit(1)
    if (rows[0]) return rows[0]

    // A row saved as "604-555-0132" or "+1 604 555 0132" passes the book
    // check above (which normalises) but not an exact match. Without this
    // fallback its opt-out would go unread and its replies would find no thread.
    const scan = await getDb()
      .select({
        id: schema.contacts.id,
        phone: schema.contacts.phone,
        smsOptedOutAt: schema.contacts.smsOptedOutAt,
      })
      .from(schema.contacts)
      .where(isNotNull(schema.contacts.phone))
      .limit(CONTACT_SCAN_LIMIT)
    for (const row of scan) {
      const parsed = normalizeE164(row.phone ?? '')
      if (parsed.ok && parsed.e164 === phone) return { id: row.id, smsOptedOutAt: row.smsOptedOutAt }
    }
    return undefined
  } catch (err) {
    log.error({ err }, 'could not read the contact')
    return undefined
  }
}

/** One place for the refusal audit, so every refusal is recorded the same way. */
async function refuse(
  ctx: { actor: string; pendingActionId?: number },
  input: { to_number: string; to_name: string },
  reason: string,
): Promise<void> {
  await audit({
    actor: ctx.actor,
    event: 'sms.refused',
    category: 'sms_send',
    toolName: 'sms_send',
    args: { to_number: input.to_number, to_name: input.to_name },
    resultSummary: reason,
    ok: false,
    pendingActionId: ctx.pendingActionId,
  })
}

export const smsSend: ToolDef = {
  name: 'sms_send',
  description:
    'Send a text message to one contact from the household number. Requires approval. The number must ' +
    'already be in the address book, and family members cannot be texted — tell them in Telegram instead. ' +
    'One recipient per message: there is no group text.',
  schema: sendShape,
  category: 'sms_send',
  consequential: true,
  summarize: (args) => {
    const name = str(args.to_name, 'someone')
    const rawNumber = str(args.to_number, '(no number)')
    const parsed = validateCalleeNumber(rawNumber)
    const numberPart = parsed.ok ? formatE164(parsed.e164) : `${rawNumber} — ⚠️ ${parsed.reason}`
    const message = str(args.message, '(no message)')
    // The identification line is part of what gets sent, so it is part of what
    // is approved. Names are not read here — summarize is synchronous and a
    // card that cannot render is worse than one naming the assistant generically.
    return `Text ${name} at ${numberPart}:\n\n"${message}"\n\n(On a first message, an introduction goes in front and "${OPT_OUT_LINE}" on the end.)`
  },
  handler: async (args, ctx) => {
    const parsedArgs = parse(args)
    if (!parsedArgs.ok) return fail(`sms_send: ${parsedArgs.error}`)
    const input = parsedArgs.value

    let check: CalleeCheck
    let known: { all: string[]; household: string[] }
    try {
      known = await knownNumbers()
      check = validateCalleeNumber(input.to_number, {
        contactNumbers: known.all,
        householdNumbers: known.household,
      })
    } catch (err) {
      // An unreadable address book cannot rule out a household number, so it
      // must refuse rather than proceed as if nobody in it were family.
      log.error({ err }, 'could not read the contact book')
      return fail('sms_send: the household address book could not be read, so nothing was sent.')
    }

    if (!check.ok) {
      await refuse(ctx, input, check.reason)
      return fail(`sms_send: ${check.reason}`)
    }

    // Stricter than dialling: a text may only go to a saved contact. A wrong
    // number dialled gets an apology; a wrong number texted keeps a written
    // record of the household's business on a stranger's phone.
    if (!check.knownContact) {
      const reason =
        `${formatE164(check.e164)} is not in the household address book, so I did not text it. ` +
        'Save it as a contact first, or check the number with whoever gave it to you.'
      await refuse(ctx, input, reason)
      return fail(`sms_send: ${reason}`)
    }

    const contact = await contactFor(check.e164)

    // Twilio owns the opt-out and will refuse anyway. Refusing here first means
    // the household is told why instead of reading an API error, and it is the
    // one refusal the assistant may never talk itself past.
    if (contact?.smsOptedOutAt) {
      const reason =
        `${input.to_name} has replied STOP to this number. They have opted out of texts from the ` +
        'household and only they can undo that, by texting START. Reach them another way.'
      await refuse(ctx, input, reason)
      return fail(`sms_send: ${reason}`)
    }

    /*
     * The deadbolt, in two halves.
     *
     * A fresh errand needs a tapped approval — the model proposes, the household
     * decides, the executor replays. A reply inside a thread that was already
     * approved does not, in the same way the voice agent converses freely inside
     * one approved call. What keeps the second half from swallowing the first is
     * that a thread only exists because an approval created it, and it can only
     * answer inside the cap and the window that approval carried.
     */
    const approved = await hasApprovedAction(ctx.pendingActionId, 'sms_send')
    const thread = await openThreadFor(check.e164)
    let replyingInThread = false

    if (!approved) {
      if (!thread) {
        log.warn(
          { actor: ctx.actor, origin: ctx.origin, pendingActionId: ctx.pendingActionId },
          'unapproved text blocked',
        )
        return fail(
          'sms_send was not approved, so nothing was sent. Ask for it and wait — once the approval ' +
            'card is tapped the message goes out on its own. Do not retry this send.',
        )
      }

      const verdict = autonomyVerdict(thread)
      if (!verdict.autonomous) {
        log.warn({ threadId: thread.id, reason: verdict.reason }, 'reply blocked outside thread bounds')
        return fail(
          `sms_send: this thread can no longer answer for itself — ${verdict.detail}. ` +
            'Tell the household what is outstanding; a new text needs a new approval.',
        )
      }
      replyingInThread = true
    }

    const who = await names()
    // The introduction and the opt-out line go on the first message of a thread
    // and never again. Repeating them every time reads as a machine, and the
    // recipient already knows who is writing and how to stop it once they have
    // answered.
    const includeIdentification = !replyingInThread && !thread
    const body = composeSms({
      message: input.message,
      assistantName: who.assistantName,
      householdName: who.householdName,
      includeIdentification,
    })

    if (body.length > MAX_SMS_CHARS) {
      return fail(
        `sms_send: with the introduction line the message is ${body.length} characters, over the ` +
          `${MAX_SMS_CHARS} limit. Say it in fewer words.`,
      )
    }

    const result = await sendSms({ to: check.e164, body })

    if (!result.ok) {
      await audit({
        actor: ctx.actor,
        event: 'sms.failed',
        category: 'sms_send',
        toolName: 'sms_send',
        args: { to_number: check.e164, to_name: input.to_name },
        resultSummary: `${result.message}${result.code === null ? '' : ` (Twilio ${result.code})`}`,
        ok: false,
        pendingActionId: ctx.pendingActionId,
      })

      if (result.optedOut) {
        // Remember it, and close anything still open to them. Twilio enforces
        // this permanently; the household should hear it once, from us.
        await markOptedOut(check.e164)
        return fail(
          `sms_send: ${input.to_name} has replied STOP to this number, so Twilio will not deliver ` +
            'anything to them and neither will I. I have closed the thread and marked them ' +
            'unreachable by text. Reach them another way.',
        )
      }
      if (result.unregisteredSender) {
        return fail(
          `sms_send: the message was refused because this Canadian number is not registered to text ` +
            `US recipients (Twilio ${result.code}). Canadian numbers work; US ones need A2P 10DLC ` +
            'registration first. Nothing was delivered.',
        )
      }
      return fail(`sms_send: ${result.message} Nothing was delivered.`)
    }

    // The thread is opened only after a message has actually gone out, so a
    // failed send never leaves an errand looking live.
    let threadId = thread?.id
    if (!thread && contact) {
      try {
        const opened = await openThread({
          contactId: contact.id,
          phone: check.e164,
          goal: input.message,
          pendingActionId: ctx.pendingActionId,
          telegramChatId: ctx.chatId,
        })
        threadId = opened.id
      } catch (err) {
        // A missing thread costs the reply path, not the message that just went.
        log.error({ err }, 'could not open the sms thread')
      }
    }

    if (threadId !== undefined) {
      await appendMessage({
        threadId,
        direction: 'outbound',
        body,
        twilioSid: result.dryRun ? null : result.sid,
      })
    }

    await audit({
      actor: ctx.actor,
      event: 'sms.sent',
      category: 'sms_send',
      toolName: 'sms_send',
      args: { to_number: check.e164, to_name: input.to_name },
      resultSummary: `${result.dryRun ? 'DRY RUN — ' : ''}texted ${input.to_name}: ${body}`,
      ok: true,
      pendingActionId: ctx.pendingActionId,
    })

    log.info(
      { sid: result.sid, dryRun: result.dryRun, chars: body.length, threadId, replyingInThread },
      'text sent through sms_send',
    )

    const preamble = result.dryRun
      ? `DRY RUN — nothing was actually sent. This is what would have gone to ${input.to_name} ` +
        `at ${formatE164(check.e164)} from ${twilioFromNumber()}:`
      : `Sent to ${input.to_name} at ${formatE164(check.e164)}:`

    return ok(`${preamble}\n\n"${body}"`, {
      sms: { sid: result.sid, to: check.e164, dryRun: result.dryRun, body, threadId: threadId ?? null },
    })
  },
}

/* ═══════════════════════════ sms_get_thread ═══════════════════════════════ */

const threadShape = {
  phone: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .describe('The number whose exchange you want to read.'),
}
const threadSchema = z.object(threadShape)

/**
 * Read a text exchange back.
 *
 * The notification policy is deliberately quiet — a four-message errand does not
 * produce four pings — so this is how the household sees everything that was
 * said. Silence means the errand is proceeding; it never means the record is
 * missing.
 *
 * The bodies are other people's words, so they come back fenced.
 */
export const smsGetThread: ToolDef = {
  name: 'sms_get_thread',
  description:
    'Read the text exchange with one contact: what was sent, what came back, and whether the thread ' +
    'is still open. Use this before answering questions about what a sitter or a supplier said.',
  schema: threadShape,
  category: 'read',
  consequential: false,
  readOnly: true,
  summarize: (args) => `Read the text thread with ${str(args.phone, 'a contact')}`,
  handler: async (args) => {
    const parsed = threadSchema.safeParse(args)
    if (!parsed.success) return fail('sms_get_thread: give me the number to look up.')

    const number = validateCalleeNumber(parsed.data.phone)
    if (!number.ok) return fail(`sms_get_thread: ${number.reason}`)

    const thread = await latestThreadFor(number.e164)
    if (!thread) return ok(`There is no text exchange with ${formatE164(number.e164)}.`)

    const messages = await threadMessages(thread.id)
    const verdict = autonomyVerdict(thread)
    const state = thread.status === 'open'
      ? verdict.autonomous
        ? `open — ${verdict.remaining} of ${MAX_THREAD_MESSAGES} messages left`
        : `open but no longer answering: ${verdict.detail}`
      : `closed: ${thread.closedReason ?? 'no reason recorded'}`

    const transcript = messages
      .map((m) => `${m.direction === 'inbound' ? 'Them' : 'Chessy'}: ${m.body}`)
      .join('\n')

    const header = [
      `Text thread with ${formatE164(number.e164)} — ${state}.`,
      `The errand: ${thread.goal}`,
      `Opened ${thread.openedAt.toISOString()}, ${messages.length} messages on file.`,
    ].join('\n')

    return ok(
      messages.length === 0
        ? header
        : `${header}\n\n${wrapUntrusted('sms:thread', transcript)}`,
      { thread: { id: thread.id, status: thread.status, messageCount: thread.messageCount } },
    )
  },
}

export const smsTools: ToolDef[] = [smsSend, smsGetThread]
