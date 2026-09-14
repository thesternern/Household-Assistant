import { and, eq, gte, lt } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { audit } from '../audit/log.js'
import { getConfig } from '../config.js'
import { getDb, schema } from '../db/client.js'
import { POLICY_CATEGORIES } from '../db/schema.js'
import type { PolicyCategory, PolicyMode } from '../db/schema.js'
import { logger } from '../logger.js'
import { getTool } from '../tools/registry.js'
import type { ToolContext } from '../tools/types.js'
import {
  CATEGORY_LABELS,
  INBOUND_DENIED_CATEGORIES,
  SEEDED_DEFAULTS,
  WATCHER_ALLOWED_CATEGORIES,
  isInboundDeniedCategory,
  isInboundUngatedCategory,
  isPolicyCategory,
  isPolicyMode,
  isWatcherAllowedCategory,
} from './categories.js'

export type Decision = { decision: 'allow' | 'deny' | 'require_approval'; reason: string }

/** audit_log event the executor writes after money actually moves. */
export const PURCHASE_EXECUTED_EVENT = 'purchase.executed'

/**
 * Arg keys a purchase tool may use to declare its total, most specific first.
 * `amountUsd` is canonical — it is the key monthlySpendUsd() reads back.
 */
export const PURCHASE_AMOUNT_KEYS = [
  'amountUsd',
  'totalUsd',
  'estimatedTotalUsd',
  'totalPriceUsd',
  'priceUsd',
  'total',
  'amount',
  'price',
] as const

/* ─────────────────────────────── policy storage ──────────────────────────── */

/** Write every category at its default. Rows that already exist are left alone. */
export async function seedPolicies(): Promise<void> {
  const rows = POLICY_CATEGORIES.map((category) => ({
    category,
    mode: SEEDED_DEFAULTS[category],
    updatedBy: 'system',
  }))
  await getDb()
    .insert(schema.policies)
    .values(rows)
    .onConflictDoNothing({ target: schema.policies.category })
  logger.debug({ count: rows.length }, 'policy defaults seeded')
}

export async function getPolicyMode(category: PolicyCategory): Promise<PolicyMode> {
  // Callers include /policy handlers that pass raw user text through a cast.
  // An unknown category has no seeded default, so answer with the closed one
  // instead of returning undefined at runtime.
  if (!isPolicyCategory(category)) {
    logger.warn({ category }, 'policy mode requested for an unknown category, answering deny')
    return 'deny'
  }

  const rows = await getDb()
    .select({ mode: schema.policies.mode })
    .from(schema.policies)
    .where(eq(schema.policies.category, category))
    .limit(1)

  const row = rows[0]
  if (!row) return SEEDED_DEFAULTS[category]
  if (!isPolicyMode(row.mode)) {
    logger.warn({ category, mode: row.mode }, 'invalid policy mode in database, using default')
    return SEEDED_DEFAULTS[category]
  }
  return row.mode
}

export async function setPolicyMode(
  category: PolicyCategory,
  mode: PolicyMode,
  actor: string,
): Promise<void> {
  if (!isPolicyCategory(category)) throw new Error(`unknown policy category: ${String(category)}`)
  if (!isPolicyMode(mode)) throw new Error(`unknown policy mode: ${String(mode)}`)

  const now = new Date()
  await getDb()
    .insert(schema.policies)
    .values({ category, mode, updatedBy: actor, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.policies.category,
      set: { mode, updatedBy: actor, updatedAt: now },
    })

  await audit({
    actor,
    event: 'policy.changed',
    category,
    resultSummary: `${CATEGORY_LABELS[category]} set to ${mode}`,
    args: { category, mode },
  })
  logger.info({ category, mode, actor }, 'policy mode changed')
}

/** Every category with its effective mode, in canonical order. */
export async function listPolicies(): Promise<Array<{ category: PolicyCategory; mode: PolicyMode }>> {
  const rows = await getDb()
    .select({ category: schema.policies.category, mode: schema.policies.mode })
    .from(schema.policies)

  const stored = new Map<string, PolicyMode>()
  for (const row of rows) {
    if (isPolicyCategory(row.category) && isPolicyMode(row.mode)) stored.set(row.category, row.mode)
  }

  return POLICY_CATEGORIES.map((category) => ({
    category,
    mode: stored.get(category) ?? SEEDED_DEFAULTS[category],
  }))
}

/* ──────────────────────────────── spend cap ──────────────────────────────── */

function numberFrom(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const cleaned = value.replace(/[$,\s]/g, '')
    if (cleaned === '') return null
    const parsed = Number(cleaned)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

type DeclaredTotal = {
  /** Dollars declared. Clamped at 0 so a "credit" can't buy headroom. */
  usd: number
  /** The key we read it from, or null when nothing was declared. */
  key: string | null
  /** The key was present but its value is not money. */
  unreadable: boolean
}

const NOTHING_DECLARED: DeclaredTotal = { usd: 0, key: null, unreadable: false }

/**
 * Reads the declared dollar total out of a bag of args.
 *
 * The FIRST present key in `PURCHASE_AMOUNT_KEYS` wins, and an unparseable
 * value stops the search rather than falling through — otherwise a generic
 * later key (`amount`, `price`, which a tool might use for a quantity) could
 * silently stand in for an unreadable `amountUsd` and understate the spend.
 * Both the pre-check and the post-hoc audit sum go through here, so the two can
 * never disagree about which field carries the money.
 */
function readDeclaredTotal(source: unknown): DeclaredTotal {
  if (typeof source !== 'object' || source === null) return NOTHING_DECLARED
  const bag = source as Record<string, unknown>
  for (const key of PURCHASE_AMOUNT_KEYS) {
    const raw = bag[key]
    if (raw === undefined || raw === null || raw === '') continue
    const parsed = numberFrom(raw)
    if (parsed === null) return { usd: 0, key, unreadable: true }
    return { usd: Math.max(0, parsed), key, unreadable: false }
  }
  return NOTHING_DECLARED
}

const usd = (n: number): string => `$${n.toFixed(2)}`
const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * Half-open [start, end) bounds for the current calendar month in the household
 * timezone. A misconfigured zone falls back to the process zone with a loud log
 * rather than handing an Invalid Date to the driver.
 */
function currentMonthWindow(): { start: Date; end: Date } {
  const zone = getConfig().HOUSEHOLD_TIMEZONE
  let now = DateTime.now().setZone(zone)
  if (!now.isValid) {
    logger.error(
      { zone, reason: now.invalidReason },
      'invalid HOUSEHOLD_TIMEZONE, using the process zone for the spend window',
    )
    now = DateTime.now()
  }
  const start = now.startOf('month')
  return { start: start.toJSDate(), end: start.plus({ months: 1 }).toJSDate() }
}

/**
 * Dollars already spent this calendar month, in the household timezone.
 *
 * Sums the declared total out of the argsJson of every `purchase.executed`
 * audit row, reading the same `PURCHASE_AMOUNT_KEYS` the pre-check reads so the
 * cap cannot go inert just because the purchase tool named its field `totalUsd`.
 * Negative rows are clamped at 0: a refund must not silently mint headroom.
 */
export async function monthlySpendUsd(): Promise<number> {
  const { start, end } = currentMonthWindow()

  const rows = await getDb()
    .select({ argsJson: schema.auditLog.argsJson })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.event, PURCHASE_EXECUTED_EVENT),
        gte(schema.auditLog.ts, start),
        lt(schema.auditLog.ts, end),
      ),
    )

  let total = 0
  let unreadable = 0
  for (const row of rows) {
    const declared = readDeclaredTotal(row.argsJson)
    if (declared.unreadable) {
      unreadable += 1
      continue
    }
    total += declared.usd
  }
  if (unreadable > 0) {
    // The cap is now understating the month. Say so loudly — silently under-
    // counting spend is the failure mode that lets the cap drift open.
    logger.warn(
      { unreadable, event: PURCHASE_EXECUTED_EVENT },
      'purchase audit rows with an unreadable amount are excluded from the monthly spend',
    )
  }
  return round2(total)
}

/* ──────────────────────────────── the decision ───────────────────────────── */

export async function decide(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<Decision> {
  try {
    const tool = getTool(toolName)
    if (!tool) return { decision: 'deny', reason: 'unknown tool' }

    // The registry is another module's data. A tool that declares a category we
    // do not know has no mode to map to, so it gets no privileges.
    if (!isPolicyCategory(tool.category)) {
      logger.error(
        { toolName, category: tool.category },
        'tool declares a policy category that does not exist, denying',
      )
      return { decision: 'deny', reason: `unknown policy category for ${toolName}` }
    }

    const category: PolicyCategory = tool.category
    const label: string = CATEGORY_LABELS[category] ?? category

    // Containment first. A watcher reads attacker-controllable text, so it may
    // only ever reach the narrow set below — no policy setting can widen it.
    if (ctx.origin === 'watcher' && !isWatcherAllowedCategory(category)) {
      logger.warn(
        { toolName, category, actor: ctx.actor },
        'watcher containment blocked a tool call',
      )
      return {
        decision: 'deny',
        reason:
          `watchers may not use ${label} (${category}). ` +
          `Watcher-origin work is limited to: ${WATCHER_ALLOWED_CATEGORIES.join(', ')}.`,
      }
    }

    // Inbound containment, same principle. The turn is a model reading a
    // stranger's words, so the categories that would let those words shape
    // later turns or spend money are closed before the mode is read.
    if (ctx.origin === 'inbound' && isInboundDeniedCategory(category)) {
      logger.warn(
        { toolName, category, actor: ctx.actor },
        'inbound containment blocked a tool call',
      )
      return {
        decision: 'deny',
        reason:
          `a turn driven by an outside message may not use ${label} (${category}). ` +
          `Inbound work is refused: ${INBOUND_DENIED_CATEGORIES.join(', ')}. ` +
          'Tell the household what was asked and let them decide.',
      }
    }

    // The executor replays args a human already approved. It is a trusted
    // replay path, not a model path, so it does not re-run the gate.
    if (ctx.origin === 'executor') {
      return { decision: 'allow', reason: 'executor replay of an approved action' }
    }

    // `calendar_write_from_watcher` is the containment-safe write path and is
    // seeded to allow. That cheap default is only justified for an actual
    // watcher. Anyone else asking for it is asking for a plain calendar write —
    // otherwise a prompt injection in a mail body the main agent read could
    // route around calendar_write's approval gate by naming the watcher tool.
    let effective: PolicyCategory = category
    let effectiveLabel = label
    if (category === 'calendar_write_from_watcher' && ctx.origin !== 'watcher') {
      effective = 'calendar_write'
      effectiveLabel = CATEGORY_LABELS.calendar_write
      logger.warn(
        { toolName, origin: ctx.origin },
        'non-watcher origin used the watcher calendar path, applying calendar_write policy',
      )
    }

    if (effective === 'purchase') {
      const cap = getConfig().PURCHASE_MONTHLY_CAP
      if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) {
        // An unreadable cap is not an infinite cap.
        logger.error({ cap }, 'PURCHASE_MONTHLY_CAP is not a usable number, denying purchases')
        return { decision: 'deny', reason: 'purchase blocked: the monthly spending cap is misconfigured.' }
      }

      const declared = readDeclaredTotal(args)
      if (declared.unreadable) {
        // Money path: an amount we cannot read is not an amount of zero.
        return {
          decision: 'deny',
          reason:
            `purchase blocked: could not read a dollar amount from \`${declared.key}\`. ` +
            'Pass a plain number in amountUsd.',
        }
      }

      const spent = await monthlySpendUsd()
      const requested = declared.usd
      const projected = round2(spent + requested)
      if (projected > cap) {
        return {
          decision: 'deny',
          reason:
            `purchase blocked: ${usd(spent)} already spent this month plus ${usd(requested)} ` +
            `requested is ${usd(projected)}, over the ${usd(cap)} monthly cap.`,
        }
      }
    }

    const mode = await getPolicyMode(effective)
    if (mode === 'allow') {
      // An inbound turn proposes; it does not act. An allow-mode write —
      // a to-do, a reminder, a recipe — becomes a card for it, so a stranger's
      // message can put a button in front of the household but never a fact.
      if (ctx.origin === 'inbound' && !isInboundUngatedCategory(effective)) {
        return {
          decision: 'require_approval',
          reason: `policy for ${effectiveLabel} is allow, but a turn driven by an outside message needs approval for it`,
        }
      }
      return { decision: 'allow', reason: `policy for ${effectiveLabel} is allow` }
    }
    if (mode === 'deny') return { decision: 'deny', reason: `policy for ${effectiveLabel} is deny` }
    return { decision: 'require_approval', reason: `policy for ${effectiveLabel} requires approval` }
  } catch (err) {
    // Fail closed: an unreadable policy is not a permissive policy. Nothing in
    // here may throw again — this is the last line before the hook.
    logger.error({ err, toolName, origin: ctx?.origin }, 'policy decision failed')
    return { decision: 'deny', reason: 'policy engine error, denying by default' }
  }
}
