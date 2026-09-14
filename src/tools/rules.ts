/**
 * Behaviour rules: the standing instructions the household gives the assistant.
 *
 * "Never book anything before 9am." "Always check with me before spending over
 * fifty dollars." "Call Alex 'Alex', not 'Mr Smith'." Every active rule is
 * injected into the system prompt on every turn, so this table is small,
 * append-mostly, and deliberately blunt to edit.
 *
 * A rule is not a policy. Policies are enforced by the approval gate in code
 * and cannot be talked around; rules are guidance the model follows. Anything
 * that must hold even against a hostile prompt belongs in the policy engine,
 * not here.
 */
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from '../audit/log.js'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { fail, ok } from './types.js'
import type { ToolDef } from './types.js'

const log = logger.child({ mod: 'tools/rules' })

/** Guardrail on the prompt budget: every active rule is sent on every turn. */
const MAX_ACTIVE_RULES = 40
const MAX_LIST = 100

type RuleRow = typeof schema.rules.$inferSelect

/* ────────────────────────────── small helpers ────────────────────────────── */

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function issueText(error: z.ZodError): string {
  const first = error.issues[0]
  if (!first) return 'the arguments were not valid'
  const path = first.path.join('.')
  return path === '' ? first.message : `${path}: ${first.message}`
}

/** Case- and punctuation-insensitive form used to spot a rule we already have. */
function ruleKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function toStructured(row: RuleRow): Record<string, unknown> {
  return {
    id: row.id,
    text: row.text,
    active: row.active,
    source: row.source,
    createdBy: row.createdBy,
    createdAt: row.createdAt?.toISOString() ?? null,
  }
}

/* ──────────────────────────────── rule_add ───────────────────────────────── */

const addShape = {
  text: z
    .string()
    .trim()
    .min(3)
    .max(300)
    .describe(
      'The standing instruction, written as one imperative sentence: "Never schedule anything before 9am on weekends."',
    ),
}
const addSchema = z.object(addShape)

const ruleAdd: ToolDef = {
  name: 'rule_add',
  description:
    'Add a standing behaviour rule that you will follow on every future turn. Use this when the household ' +
    'corrects how you work ("stop doing X", "always do Y first"), not for one-off instructions.',
  schema: addShape,
  category: 'memory_write',
  consequential: false,
  summarize: (args) => `Add a standing rule: "${readString(args['text']) ?? ''}".`,
  handler: async (args, ctx) => {
    const parsed = addSchema.safeParse(args)
    if (!parsed.success) return fail(`I could not add that rule: ${issueText(parsed.error)}`)
    const { text } = parsed.data

    try {
      const db = getDb()
      const active = await db
        .select()
        .from(schema.rules)
        .where(eq(schema.rules.active, true))
        .orderBy(asc(schema.rules.id))
        .limit(MAX_LIST)

      const key = ruleKey(text)
      const duplicate = active.find((row) => ruleKey(row.text) === key)
      if (duplicate) {
        return ok(`That rule is already in force as #${duplicate.id}: "${duplicate.text}".`, {
          rule: toStructured(duplicate),
          action: 'unchanged',
        })
      }

      if (active.length >= MAX_ACTIVE_RULES) {
        return fail(
          `There are already ${active.length} active rules, which is as many as I can carry. ` +
            'Remove one with rule_remove before adding another.',
        )
      }

      const inserted = await db
        .insert(schema.rules)
        .values({
          text,
          active: true,
          source: ctx.origin === 'agent' ? 'chat' : ctx.origin,
          createdBy: ctx.actor,
        })
        .returning()
      const row = inserted[0]
      if (!row) return fail('The rule could not be saved.')

      await audit({
        actor: ctx.actor,
        event: 'rule.add',
        category: 'memory_write',
        toolName: 'rule_add',
        args: { text },
        resultSummary: `rule #${row.id}`,
        ok: true,
      })
      log.info({ ruleId: row.id, actor: ctx.actor }, 'rule added')

      return ok(`Rule #${row.id} added: "${text}". I will follow it from now on.`, {
        rule: toStructured(row),
        action: 'created',
        activeCount: active.length + 1,
      })
    } catch (err) {
      log.error({ err }, 'rule_add failed')
      return fail('I could not save that rule — the database rejected the write.')
    }
  },
}

/* ──────────────────────────────── rule_list ──────────────────────────────── */

const listShape = {
  includeRemoved: z
    .boolean()
    .default(false)
    .describe('Also return rules that were removed. Off by default.'),
}
const listSchema = z.object(listShape)

const ruleList: ToolDef = {
  name: 'rule_list',
  description:
    'List the standing behaviour rules currently in force. Call this before removing one so you have the right id.',
  schema: listShape,
  category: 'read',
  consequential: false,
  readOnly: true,
  summarize: () => 'List the standing household rules.',
  handler: async (args) => {
    const parsed = listSchema.safeParse(args)
    if (!parsed.success) return fail(`I could not read that rule filter: ${issueText(parsed.error)}`)

    try {
      const rows = await getDb()
        .select()
        .from(schema.rules)
        .where(parsed.data.includeRemoved ? undefined : eq(schema.rules.active, true))
        .orderBy(desc(schema.rules.active), asc(schema.rules.id))
        .limit(MAX_LIST)

      if (rows.length === 0) return ok('There are no standing rules yet.', { rules: [], count: 0 })

      const lines = rows.map((row) => `#${row.id} ${row.text}${row.active ? '' : ' (removed)'}`)
      return ok(`${rows.length} rule${rows.length === 1 ? '' : 's'}:\n${lines.join('\n')}`, {
        rules: rows.map(toStructured),
        count: rows.length,
      })
    } catch (err) {
      log.error({ err }, 'rule_list failed')
      return fail('I could not read the rules right now.')
    }
  },
}

/* ─────────────────────────────── rule_remove ─────────────────────────────── */

const removeShape = {
  id: z.coerce.number().int().positive().describe('The rule id, as shown by rule_list.'),
}
const removeSchema = z.object(removeShape)

const ruleRemove: ToolDef = {
  name: 'rule_remove',
  description: 'Retire a standing rule so you stop following it. The row is kept for the audit trail.',
  schema: removeShape,
  category: 'memory_write',
  consequential: false,
  summarize: (args) => `Remove standing rule #${String(args['id'] ?? '?')}.`,
  handler: async (args, ctx) => {
    const parsed = removeSchema.safeParse(args)
    if (!parsed.success) return fail(`I need a numeric rule id: ${issueText(parsed.error)}`)
    const { id } = parsed.data

    try {
      const updated = await getDb()
        .update(schema.rules)
        .set({ active: false })
        .where(and(eq(schema.rules.id, id), eq(schema.rules.active, true)))
        .returning()

      const row = updated[0]
      if (!row) {
        const existing = await getDb().select().from(schema.rules).where(eq(schema.rules.id, id)).limit(1)
        const found = existing[0]
        if (!found) return fail(`There is no rule #${id}.`)
        return ok(`Rule #${id} was already removed.`, { rule: toStructured(found), changed: false })
      }

      await audit({
        actor: ctx.actor,
        event: 'rule.remove',
        category: 'memory_write',
        toolName: 'rule_remove',
        args: { id, text: row.text },
        resultSummary: row.text,
        ok: true,
      })
      log.info({ ruleId: id, actor: ctx.actor }, 'rule removed')

      return ok(`Rule #${id} removed: "${row.text}". I will stop applying it.`, {
        rule: toStructured(row),
        changed: true,
      })
    } catch (err) {
      log.error({ err, ruleId: id }, 'rule_remove failed')
      return fail(`I could not remove rule #${id}.`)
    }
  },
}

/* ───────────────────────────────── exports ───────────────────────────────── */

export const ruleTools: ToolDef[] = [ruleAdd, ruleList, ruleRemove]

export const tools: ToolDef[] = ruleTools
