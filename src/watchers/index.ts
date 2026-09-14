/**
 * The watcher subsystem's front door: the sweep, the CRUD, and the three chat
 * tools that let the household say "watch emails from @brightwheel.com".
 *
 * Two things worth knowing before editing anything in here.
 *
 * **The pollers are sweeps, and they coalesce.** `pollAllWatchers` runs at most
 * one pass per kind at a time. pg-boss queues watcher polls per watcher id, so
 * three daycare watchers would otherwise mean three full mailbox passes and
 * three Telegram digests within a second of each other.
 *
 * **The tools in here are ordinary agent tools, not watcher-origin calls.** A
 * spouse asking to add a watcher is a person making a decision, so
 * `watcher_add` sits in `memory_write` and runs from a normal turn. Everything
 * the resulting watcher then *does* runs through `callWatcherTool` in
 * `pipeline.ts`, at `origin: 'watcher'`, where the policy engine denies every
 * category but read, watcher-calendar, reminder, to-do, and memory.
 */
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from '../audit/log.js'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { fail, ok } from '../tools/types.js'
import type { ToolDef } from '../tools/types.js'
import { pollEmailWatchers } from './email-watcher.js'
import { pollIcsWatchers } from './ics-watcher.js'
import { pollReplyWatchers } from './reply-watcher.js'
import { pollPortalWatchers } from './portal-watcher.js'
import { CANONICAL_TYPE, describeError, kindOfType } from './pipeline.js'
import type { WatcherKind, WatcherRow } from './pipeline.js'

const log = logger.child({ mod: 'watchers' })

export type { WatcherKind, WatcherRow } from './pipeline.js'
export { kindOfType } from './pipeline.js'

/* ─────────────────────────────── the sweep ───────────────────────────────── */

export interface PollResult {
  checked: number
  added: number
  byKind: Record<WatcherKind, { checked: number; added: number }>
}

const POLLERS: Record<WatcherKind, () => Promise<{ checked: number; added: number }>> = {
  email: pollEmailWatchers,
  ics: pollIcsWatchers,
  portal: pollPortalWatchers,
  reply: pollReplyWatchers,
}

/**
 * In-flight pass per kind. A second caller joins the pass already running
 * rather than starting a duplicate one — which is what keeps a per-watcher job
 * queue from producing one mailbox sweep and one digest per watcher.
 */
const inFlight = new Map<WatcherKind, Promise<{ checked: number; added: number }>>()

async function pollKind(kind: WatcherKind): Promise<{ checked: number; added: number }> {
  const running = inFlight.get(kind)
  if (running !== undefined) {
    log.debug({ kind }, 'joining the watcher pass already in flight')
    return running
  }

  const pass = (async () => {
    try {
      return await POLLERS[kind]()
    } catch (err) {
      // A poller is supposed to contain its own failures; if one escapes, the
      // sweep still has to finish the other kinds.
      log.error({ err, kind }, 'watcher poll failed')
      return { checked: 0, added: 0 }
    } finally {
      inFlight.delete(kind)
    }
  })()

  inFlight.set(kind, pass)
  return pass
}

/** Run the named pollers. Unknown kinds are ignored; duplicates run once. */
export async function pollAllWatchers(kinds: WatcherKind[]): Promise<PollResult> {
  const wanted = [...new Set(kinds)].filter((k): k is WatcherKind => k in POLLERS)
  const result: PollResult = {
    checked: 0,
    added: 0,
    byKind: {
      email: { checked: 0, added: 0 },
      ics: { checked: 0, added: 0 },
      portal: { checked: 0, added: 0 },
      reply: { checked: 0, added: 0 },
    },
  }

  for (const kind of wanted) {
    const pass = await pollKind(kind)
    result.byKind[kind] = pass
    result.checked += pass.checked
    result.added += pass.added
  }

  if (wanted.length > 0) {
    log.info({ kinds: wanted, checked: result.checked, added: result.added }, 'watcher sweep complete')
  }
  return result
}

/**
 * Handler for the `watcher-poll` queue, which carries one watcher id per job.
 *
 * Register it before `startQueue()`:
 * `registerJobHandler(QUEUES.watcherPoll, runWatcherPollJob)`.
 */
export async function runWatcherPollJob(data: { watcherId?: number; type?: string }): Promise<void> {
  const kindFromType = typeof data.type === 'string' ? kindOfType(data.type) : null
  let kind = kindFromType

  if (kind === null && typeof data.watcherId === 'number') {
    const rows = await getDb()
      .select({ type: schema.watchers.type })
      .from(schema.watchers)
      .where(eq(schema.watchers.id, data.watcherId))
      .limit(1)
    const type = rows[0]?.type
    if (type !== undefined) kind = kindOfType(type)
  }

  if (kind === null) {
    log.warn({ data }, 'watcher-poll job named no recognisable watcher kind')
    return
  }
  await pollAllWatchers([kind])
}

/* ────────────────────────────────── CRUD ─────────────────────────────────── */

export interface CreateWatcherInput {
  name: string
  kind: WatcherKind
  config: Record<string, unknown>
  active?: boolean
}

const MAX_NAME_CHARS = 120

/**
 * Per-kind config validation.
 *
 * A watcher with no sender would read the whole mailbox; a portal watcher with
 * no URL would do nothing at all. Both are caught here rather than at 3am in a
 * poll.
 */
export function validateWatcherConfig(
  kind: WatcherKind,
  config: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (kind === 'email') {
    const senders = Array.isArray(config.senders) ? config.senders : []
    const clean = senders
      .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      .map((s) => s.trim().toLowerCase())
    if (clean.length === 0) {
      return { ok: false, error: 'An email watcher needs at least one sender address or domain.' }
    }
    return { ok: true, value: { ...config, senders: clean } }
  }

  if (kind === 'ics') {
    const url = typeof config.url === 'string' ? config.url.trim() : ''
    if (url === '') return { ok: false, error: 'An ICS watcher needs a feed URL.' }
    if (!/^(https?|webcal):\/\//i.test(url)) {
      return { ok: false, error: 'The feed URL must start with https://, http://, or webcal://.' }
    }
    return { ok: true, value: { ...config, url } }
  }

  if (kind === 'reply') {
    // Nothing to configure: it watches the assistant's own mailbox, and which
    // mailbox that is comes from the connected `assistant` Google account, not
    // from anything a caller can set here.
    return { ok: true, value: { ...config } }
  }

  // Portal. The poller reads `eventsUrl` (the announcements page) and treats
  // `loginUrl` as optional, so validation mirrors that: accept either, and
  // store an eventsUrl the poller will actually find — a config that passes
  // here must not fail its first poll with "no valid eventsUrl".
  const readUrl = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  const loginUrl = readUrl(config.loginUrl)
  const eventsUrl = readUrl(config.eventsUrl) || readUrl(config.announcementsUrl) || readUrl(config.url) || loginUrl
  if (eventsUrl === '') {
    return { ok: false, error: 'A portal watcher needs an eventsUrl or a loginUrl.' }
  }
  if (!/^https?:\/\//i.test(eventsUrl)) {
    return { ok: false, error: 'The portal URL must start with https:// or http://.' }
  }
  if (loginUrl !== '' && !/^https?:\/\//i.test(loginUrl)) {
    return { ok: false, error: 'The loginUrl must start with https:// or http://.' }
  }
  return {
    ok: true,
    value: { ...config, eventsUrl, ...(loginUrl === '' ? {} : { loginUrl }) },
  }
}

export async function createWatcher(input: CreateWatcherInput): Promise<WatcherRow> {
  const name = input.name.trim().slice(0, MAX_NAME_CHARS)
  if (name === '') throw new Error('a watcher needs a name')

  const validated = validateWatcherConfig(input.kind, input.config)
  if (!validated.ok) throw new Error(validated.error)

  const inserted = await getDb()
    .insert(schema.watchers)
    .values({
      name,
      type: CANONICAL_TYPE[input.kind],
      config: validated.value,
      active: input.active ?? true,
    })
    .returning()

  const row = inserted[0]
  if (!row) throw new Error('the watcher could not be saved')

  log.info({ watcherId: row.id, name, kind: input.kind }, 'watcher created')
  return row
}

export async function listWatchers(opts?: { activeOnly?: boolean }): Promise<WatcherRow[]> {
  const query = getDb().select().from(schema.watchers)
  const rows = opts?.activeOnly
    ? await query.where(eq(schema.watchers.active, true)).orderBy(asc(schema.watchers.id))
    : await query.orderBy(asc(schema.watchers.id))
  return rows
}

export async function getWatcher(id: number): Promise<WatcherRow | undefined> {
  if (!Number.isInteger(id)) return undefined
  const rows = await getDb().select().from(schema.watchers).where(eq(schema.watchers.id, id)).limit(1)
  return rows[0]
}

/** Pause or resume a watcher. Returns null when there is no such row. */
export async function setWatcherActive(id: number, active: boolean): Promise<WatcherRow | null> {
  if (!Number.isInteger(id)) return null
  const updated = await getDb()
    .update(schema.watchers)
    .set({ active, ...(active ? { lastError: null } : {}) })
    .where(eq(schema.watchers.id, id))
    .returning()
  const row = updated[0]
  if (!row) return null
  log.info({ watcherId: id, active }, 'watcher active flag changed')
  return row
}

/**
 * Delete a watcher.
 *
 * The `extracted_events` rows it produced are left alone on purpose: they carry
 * the calendar and reminder ids behind the 🗑 Remove buttons already sitting in
 * the household's chat history, and the retention cron prunes them on its own
 * schedule.
 */
export async function deleteWatcher(id: number): Promise<WatcherRow | null> {
  if (!Number.isInteger(id)) return null
  const removed = await getDb()
    .delete(schema.watchers)
    .where(eq(schema.watchers.id, id))
    .returning()
  const row = removed[0]
  if (!row) return null
  log.info({ watcherId: id, name: row.name }, 'watcher deleted')
  return row
}

/* ─────────────────────────────────── tools ───────────────────────────────── */

const KIND_LABEL: Record<WatcherKind, string> = {
  email: 'email',
  ics: 'calendar feed',
  portal: 'parent portal',
  reply: "the assistant's own mailbox",
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function issueText(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
}

const addShape = {
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAX_NAME_CHARS)
    .describe('What to call it, e.g. "Brightwheel daycare".'),
  kind: z
    .enum(['email', 'ics', 'portal', 'reply'])
    .describe(
      'email = watch a sender; ics = mirror a calendar feed; portal = log in and scrape; reply = watch the assistant’s own mailbox for replies to mail it sent.',
    ),
  senders: z
    .array(z.string())
    .optional()
    .describe('email only: addresses or domains to watch, e.g. ["brightwheel.com", "office@school.org"].'),
  url: z.string().optional().describe('ics only: the .ics or webcal feed URL.'),
  loginUrl: z.string().optional().describe('portal only: the sign-in page URL.'),
  eventsUrl: z
    .string()
    .optional()
    .describe('portal only: the announcements page to read, if it differs from the sign-in page.'),
  contentSelector: z
    .string()
    .optional()
    .describe('portal only: CSS selector for the announcements area. Defaults to the whole page.'),
  usernameSelector: z.string().optional().describe('portal only: CSS selector for the username field.'),
  passwordSelector: z.string().optional().describe('portal only: CSS selector for the password field.'),
  submitSelector: z.string().optional().describe('portal only: CSS selector for the sign-in button.'),
  labels: z.array(z.string()).optional().describe('email only: restrict to these Gmail labels.'),
  lookbackDays: z
    .number()
    .int()
    .min(1)
    .max(90)
    .optional()
    .describe('email only: how far back to read on the first run. Defaults to 7 days.'),
}
const addSchema = z.object(addShape)

const watcherAdd: ToolDef = {
  name: 'watcher_add',
  description:
    'Start watching a school, daycare, club, or clinic for events and deadlines. An email watcher reads mail from the senders you name; an ics watcher mirrors a published calendar feed; a portal watcher signs in to a parent portal and reads the announcements page; a reply watcher checks the assistant’s own mailbox for replies to mail it sent. Anything a watcher finds is added automatically and announced, and every auto-added event comes with a Remove button.',
  schema: addShape,
  category: 'memory_write',
  consequential: false,
  summarize: (args) => {
    const name = str(args.name, 'a provider')
    const kind = str(args.kind, 'email')
    const senders = Array.isArray(args.senders) ? args.senders.filter((s) => typeof s === 'string') : []
    const target =
      kind === 'reply'
        ? "the assistant's own mailbox"
        : senders.length > 0
          ? senders.join(', ')
          : str(args.url) || str(args.eventsUrl) || str(args.loginUrl) || 'the configured source'
    return `Watch ${name} (${kind}) at ${target}.`
  },
  handler: async (args, ctx) => {
    const parsed = addSchema.safeParse(args)
    if (!parsed.success) return fail(`I could not set that watcher up: ${issueText(parsed.error)}`)
    const input = parsed.data

    const config: Record<string, unknown> = {}
    if (input.senders !== undefined) config.senders = input.senders
    if (input.labels !== undefined) config.labels = input.labels
    if (input.lookbackDays !== undefined) config.lookbackDays = input.lookbackDays
    if (input.url !== undefined) config.url = input.url
    if (input.loginUrl !== undefined) config.loginUrl = input.loginUrl
    if (input.eventsUrl !== undefined) config.eventsUrl = input.eventsUrl
    if (input.contentSelector !== undefined) config.contentSelector = input.contentSelector
    if (input.usernameSelector !== undefined) config.usernameSelector = input.usernameSelector
    if (input.passwordSelector !== undefined) config.passwordSelector = input.passwordSelector
    if (input.submitSelector !== undefined) config.submitSelector = input.submitSelector

    let row: WatcherRow
    try {
      row = await createWatcher({ name: input.name, kind: input.kind, config })
    } catch (err) {
      return fail(`I could not set that watcher up: ${describeError(err)}`)
    }

    await audit({
      actor: ctx.actor,
      event: 'watcher.created',
      category: 'memory_write',
      toolName: 'watcher_add',
      args: { name: row.name, kind: input.kind, config },
      resultSummary: `watcher #${row.id}`,
      ok: true,
    })

    const target =
      input.kind === 'reply'
        ? "the assistant's own mailbox"
        : input.senders !== undefined && input.senders.length > 0
          ? input.senders.join(', ')
          : (input.url ?? input.eventsUrl ?? input.loginUrl ?? 'the configured source')
    return ok(
      `Watcher #${row.id} is on: I will check ${target} (${KIND_LABEL[input.kind]}) and add what I find, telling you both each time.`,
      { watcher: { id: row.id, name: row.name, type: row.type, active: row.active } },
    )
  },
}

const listShape = {
  includeInactive: z.boolean().default(true).describe('Include watchers that are currently paused.'),
}
const listSchema = z.object(listShape)

const watcherList: ToolDef = {
  name: 'watcher_list',
  description:
    'List the watchers, with what each one is watching, when it last ran, and any error from its last run.',
  schema: listShape,
  category: 'memory_write',
  consequential: false,
  readOnly: true,
  summarize: () => 'List the configured watchers.',
  handler: async (args) => {
    const parsed = listSchema.safeParse(args)
    const includeInactive = parsed.success ? parsed.data.includeInactive : true

    let rows: WatcherRow[]
    try {
      rows = await listWatchers(includeInactive ? undefined : { activeOnly: true })
    } catch (err) {
      log.error({ err }, 'watcher_list failed')
      return fail('I could not read the watcher list right now.')
    }
    if (rows.length === 0) {
      return ok('No watchers are set up yet.', { watchers: [], count: 0 })
    }

    const lines = rows.map((row) => {
      const kind = kindOfType(row.type)
      const label = kind === null ? row.type : KIND_LABEL[kind]
      const state = row.active ? '' : ' · paused'
      const last = row.lastCheckedAt ? ` · last checked ${row.lastCheckedAt.toISOString()}` : ' · never checked'
      const error = row.lastError ? ` · last error: ${row.lastError}` : ''
      return `#${row.id} ${row.name} (${label})${state}${last}${error}`
    })

    return ok(`${rows.length} watcher${rows.length === 1 ? '' : 's'}:\n${lines.join('\n')}`, {
      count: rows.length,
      watchers: rows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        kind: kindOfType(row.type),
        active: row.active,
        lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
        lastError: row.lastError,
      })),
    })
  },
}

const removeShape = {
  id: z.coerce.number().int().positive().describe('The watcher id, from watcher_list.'),
  pause: z
    .boolean()
    .default(false)
    .describe('Pause it instead of deleting it, so it can be switched back on later.'),
}
const removeSchema = z.object(removeShape)

const watcherRemove: ToolDef = {
  name: 'watcher_remove',
  description:
    'Stop watching a provider. Deletes the watcher, or pauses it when pause is true. Events it already added stay on the calendar.',
  schema: removeShape,
  category: 'memory_write',
  consequential: false,
  summarize: (args) =>
    `${args.pause === true ? 'Pause' : 'Delete'} watcher #${String(args.id ?? '?')}.`,
  handler: async (args, ctx) => {
    const parsed = removeSchema.safeParse(args)
    if (!parsed.success) return fail(`I need a watcher id: ${issueText(parsed.error)}`)
    const { id, pause } = parsed.data

    try {
      const row = pause ? await setWatcherActive(id, false) : await deleteWatcher(id)
      if (row === null) return fail(`There is no watcher #${id}.`)

      await audit({
        actor: ctx.actor,
        event: pause ? 'watcher.paused' : 'watcher.deleted',
        category: 'memory_write',
        toolName: 'watcher_remove',
        args: { id },
        resultSummary: row.name,
        ok: true,
      })

      return ok(
        pause
          ? `Paused watcher #${id} (${row.name}). Nothing it already added has changed.`
          : `Deleted watcher #${id} (${row.name}). Nothing it already added has changed.`,
        { watcher: { id, name: row.name }, paused: pause },
      )
    } catch (err) {
      log.error({ err, watcherId: id }, 'watcher_remove failed')
      return fail(`I could not remove watcher #${id}: ${describeError(err)}`)
    }
  },
}

/**
 * The watcher tools, for `src/tools/registry.ts`.
 *
 * All three are `memory_write`: configuring a watcher changes what the
 * assistant pays attention to, which is household bookkeeping rather than an
 * action in the world. Note that this also means a watcher cannot create
 * another watcher — `memory_write` is inside the watcher-allowed set, but
 * nothing in the pipeline names these tools, and `WATCHER_TOOL_ALLOWLIST` does
 * not contain them.
 */
export const watcherTools: ToolDef[] = [watcherAdd, watcherList, watcherRemove]

export {
  WATCHER_ACTOR,
  WATCHER_TOOL_ALLOWLIST,
  callWatcherTool,
  EMAIL_WATCHER_TYPES,
  ICS_WATCHER_TYPES,
  PORTAL_WATCHER_TYPES,
  REPLY_WATCHER_TYPES,
  TYPES_BY_KIND,
  CANONICAL_TYPE,
} from './pipeline.js'
export { pollEmailWatchers } from './email-watcher.js'
export { pollIcsWatchers } from './ics-watcher.js'
export { pollReplyWatchers } from './reply-watcher.js'
export { pollPortalWatchers } from './portal-watcher.js'
export { contentHash, extractEvents } from './extract.js'
export type { ExtractedItem } from './extract.js'
