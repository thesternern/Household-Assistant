/**
 * Idempotent first-run seed: policy defaults, the household row, the two
 * whitelisted users, and the standing food preferences the chef subagent needs
 * before anyone has run /setup. Safe to run repeatedly.
 */
import { eq } from 'drizzle-orm'
import { getConfig } from '../src/config.js'
import { getDb, schema, closeDb } from '../src/db/client.js'
import { seedPolicies } from '../src/policy/engine.js'
import { logger } from '../src/logger.js'

const FOOD_FACTS: Array<{ subject: string; category: string; fact: string }> = [
  { subject: 'food', category: 'preference', fact: 'Meals should be flavourful but not spicy — no chilli heat.' },
  { subject: 'food', category: 'preference', fact: 'Prefer batch-friendly recipes that keep well for 2–3 days.' },
  { subject: 'food', category: 'preference', fact: 'Rotate proteins across the week; do not repeat the same protein twice.' },
  { subject: 'food', category: 'preference', fact: 'Everything must be child-friendly — the kids eat the same meal.' },
  { subject: 'food', category: 'preference', fact: "Prefer recipes marked 'easy'; weeknight active time under about 40 minutes." },
]

const STARTER_RULES = [
  'Be concise. No preamble, no sign-off, no restating the question.',
  'Never invent a fact about the family. If you do not know it, search memory or ask.',
  'When an action needs approval, take it anyway and let the approval card fire — never refuse on the grounds that it needs approval.',
]

async function main(): Promise<void> {
  const cfg = getConfig()
  const db = getDb()

  await seedPolicies()
  logger.info('policy defaults seeded')

  const existing = await db.select().from(schema.households).limit(1)
  let householdId = existing[0]?.id
  if (!householdId) {
    const inserted = await db
      .insert(schema.households)
      .values({ name: 'Household', timezone: cfg.HOUSEHOLD_TIMEZONE })
      .returning({ id: schema.households.id })
    householdId = inserted[0]?.id
    logger.info({ householdId }, 'household created')
  } else {
    logger.info({ householdId }, 'household already present')
  }

  for (const [i, telegramUserId] of cfg.telegramUserIds.entries()) {
    const found = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.telegramUserId, telegramUserId))
      .limit(1)
    if (found.length === 0) {
      await db.insert(schema.users).values({
        telegramUserId,
        displayName: i === 0 ? 'Alex' : 'Spouse',
        isPrimary: i === 0,
      })
      logger.info({ telegramUserId }, 'user whitelisted')
    }
  }

  for (const f of FOOD_FACTS) {
    const found = await db
      .select()
      .from(schema.memoryFacts)
      .where(eq(schema.memoryFacts.fact, f.fact))
      .limit(1)
    if (found.length === 0) await db.insert(schema.memoryFacts).values(f)
  }
  logger.info({ count: FOOD_FACTS.length }, 'food preferences seeded')

  for (const text of STARTER_RULES) {
    const found = await db.select().from(schema.rules).where(eq(schema.rules.text, text)).limit(1)
    if (found.length === 0) await db.insert(schema.rules).values({ text, source: 'seed' })
  }
  logger.info({ count: STARTER_RULES.length }, 'starter rules seeded')

  logger.info('seed complete — run /setup in Telegram to fill in the household profile')
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'seed failed')
    process.exit(1)
  })
