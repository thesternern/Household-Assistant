import { POLICY_CATEGORIES, POLICY_MODES } from '../db/schema.js'
import type { PolicyCategory, PolicyMode } from '../db/schema.js'

/** Human-facing metadata for one policy category. */
export interface CategoryMeta {
  category: PolicyCategory
  /** Short title for the /policy screen and approval cards. */
  label: string
  /** One line a non-technical spouse can read and understand. */
  description: string
  /**
   * True when acting in this category touches the outside world or spends money.
   * Consequential categories must never execute straight from a model turn:
   * the tool handler requires an approved pending_action row.
   */
  consequential: boolean
  /** Mode written by seedPolicies() when no row exists yet. */
  defaultMode: PolicyMode
}

export const CATEGORY_META: Record<PolicyCategory, CategoryMeta> = {
  read: {
    category: 'read',
    label: 'Read household data',
    description: 'Look things up: calendar, email, contacts, to-dos, memory, recipes, and the web.',
    consequential: false,
    defaultMode: 'allow',
  },
  memory_write: {
    category: 'memory_write',
    label: 'Remember facts',
    description: 'Save, update, or retire a remembered fact about the household.',
    consequential: false,
    defaultMode: 'allow',
  },
  todo_write: {
    category: 'todo_write',
    label: 'Manage to-dos',
    description: 'Add, edit, complete, or drop items on the shared to-do list.',
    consequential: false,
    defaultMode: 'allow',
  },
  reminder_write: {
    category: 'reminder_write',
    label: 'Set reminders',
    description: 'Schedule, reschedule, or cancel a reminder ping.',
    consequential: false,
    defaultMode: 'allow',
  },
  recipe_write: {
    category: 'recipe_write',
    label: 'Save recipes and meal plans',
    description: 'Import recipes, build the weekly meal plan, and generate grocery lists.',
    consequential: false,
    defaultMode: 'allow',
  },
  calendar_write: {
    category: 'calendar_write',
    label: 'Change the family calendar',
    description: 'Create, move, or delete an event on the shared Google calendar.',
    consequential: true,
    defaultMode: 'require_approval',
  },
  calendar_write_from_watcher: {
    category: 'calendar_write_from_watcher',
    label: 'Add watcher-found events',
    description: 'Add a dated event a watcher extracted from a school or daycare message.',
    consequential: false,
    defaultMode: 'allow',
  },
  email_send: {
    category: 'email_send',
    label: 'Send email',
    description: 'Send or reply to mail from the household Gmail account.',
    consequential: true,
    defaultMode: 'require_approval',
  },
  phone_call: {
    category: 'phone_call',
    label: 'Place phone calls',
    description: 'Call a business or person by voice on the household’s behalf.',
    consequential: true,
    defaultMode: 'require_approval',
  },
  sms_send: {
    category: 'sms_send',
    label: 'Send a text message',
    description: 'Text a contact from the household number. Never a family member; never a number not in the address book.',
    consequential: true,
    defaultMode: 'require_approval',
  },
  purchase: {
    category: 'purchase',
    label: 'Spend money',
    description: 'Buy something online, inside the monthly spending cap.',
    consequential: true,
    defaultMode: 'require_approval',
  },
  booking_cancel: {
    category: 'booking_cancel',
    label: 'Cancel bookings',
    description: 'Cancel a reservation, appointment, delivery, or subscription.',
    consequential: true,
    defaultMode: 'require_approval',
  },
  browser_task: {
    category: 'browser_task',
    label: 'Drive the browser',
    description: 'Sign in to an allowed site and take actions there as you.',
    consequential: true,
    defaultMode: 'require_approval',
  },
}

function pluck<K extends keyof CategoryMeta>(key: K): Record<PolicyCategory, CategoryMeta[K]> {
  const out = {} as Record<PolicyCategory, CategoryMeta[K]>
  for (const category of POLICY_CATEGORIES) out[category] = CATEGORY_META[category][key]
  return out
}

/** Mode each category starts at on a fresh database. */
export const SEEDED_DEFAULTS: Record<PolicyCategory, PolicyMode> = pluck('defaultMode')

/** Short human title per category. */
export const CATEGORY_LABELS: Record<PolicyCategory, string> = pluck('label')

/** One-line explanation per category. */
export const CATEGORY_DESCRIPTIONS: Record<PolicyCategory, string> = pluck('description')

/** Whether a category touches the world or spends money. */
export const CATEGORY_CONSEQUENTIAL: Record<PolicyCategory, boolean> = pluck('consequential')

/**
 * Blast-radius limit for watcher-origin work.
 *
 * A watcher reads untrusted text — daycare newsletters, school emails, scraped
 * pages — so anything it triggers is treated as attacker-controlled. Only these
 * categories are reachable from a watcher, and no policy setting can widen the
 * list. Everything else is denied before the mode is even read.
 */
export const WATCHER_ALLOWED_CATEGORIES = [
  'read',
  'calendar_write_from_watcher',
  'reminder_write',
  'todo_write',
  'memory_write',
] as const satisfies readonly PolicyCategory[]

const WATCHER_ALLOWED_SET: ReadonlySet<string> = new Set<string>(WATCHER_ALLOWED_CATEGORIES)

/** True when a watcher-origin call may touch this category at all. */
export function isWatcherAllowedCategory(category: PolicyCategory): boolean {
  return WATCHER_ALLOWED_SET.has(category)
}

/**
 * Blast-radius limit for inbound-origin work.
 *
 * An inbound turn is a model reasoning over a stranger's words. It may look
 * things up and it may PROPOSE — `decide()` turns every allow-mode write into an
 * approval card for it — but these categories are refused before the mode is
 * read, whatever the policy table says:
 *
 * - `memory_write` covers rules, remembered facts, contacts, and watcher
 *   definitions: everything that is read back into later turns as the
 *   household's own words. A stranger must not get to author those, not even
 *   behind a card, because a card for "remember that the gate code is 4471" is
 *   one a tired spouse taps.
 * - `purchase`, `browser_task`, and `booking_cancel` have no legitimate
 *   inbound use. A plumber's text does not spend money.
 */
export const INBOUND_DENIED_CATEGORIES = [
  'memory_write',
  'purchase',
  'browser_task',
  'booking_cancel',
] as const satisfies readonly PolicyCategory[]

const INBOUND_DENIED_SET: ReadonlySet<string> = new Set<string>(INBOUND_DENIED_CATEGORIES)

/** True when inbound-origin work may never touch this category. */
export function isInboundDeniedCategory(category: PolicyCategory): boolean {
  return INBOUND_DENIED_SET.has(category)
}

/**
 * Allow-mode categories an inbound turn may still use without a card.
 *
 * `read` is the point of the turn. `sms_send` keeps its own deadbolt inside the
 * tool: an unapproved send goes out only as a reply inside a thread the
 * household already approved, within that thread's cap and window.
 */
export const INBOUND_UNGATED_CATEGORIES = ['read', 'sms_send'] as const satisfies readonly PolicyCategory[]

const INBOUND_UNGATED_SET: ReadonlySet<string> = new Set<string>(INBOUND_UNGATED_CATEGORIES)

export function categoryMeta(category: PolicyCategory): CategoryMeta {
  return CATEGORY_META[category]
}

export function categoryLabel(category: PolicyCategory): string {
  return CATEGORY_LABELS[category]
}

/** True when an allow-mode call in this category still needs no card from inbound work. */
export function isInboundUngatedCategory(category: PolicyCategory): boolean {
  return INBOUND_UNGATED_SET.has(category)
}

export function isConsequentialCategory(category: PolicyCategory): boolean {
  return CATEGORY_CONSEQUENTIAL[category]
}

export function isPolicyCategory(value: unknown): value is PolicyCategory {
  return typeof value === 'string' && (POLICY_CATEGORIES as readonly string[]).includes(value)
}

export function isPolicyMode(value: unknown): value is PolicyMode {
  return typeof value === 'string' && (POLICY_MODES as readonly string[]).includes(value)
}
