/**
 * Retire a watcher and undo what it put on the family calendar.
 *
 * `deleteWatcher()` deliberately leaves `extracted_events` alone, because the
 * 🗑 Remove buttons sitting in the household's chat history are backed by those
 * rows. That is the right default for dropping a watcher you never want to
 * think about again. It is the wrong one when a feed has already mirrored
 * months of entries onto the calendar and you want them gone: nobody is going
 * to tap fifty buttons, and the reminders behind those entries have no button
 * at all.
 *
 * This module is the other half. It walks every entry a watcher created,
 * deletes it from Google, cancels the reminder behind it, and only then stands
 * the watcher down.
 *
 * Two rules shape the error handling, both learned from the Remove button in
 * `src/telegram/approvals.ts`:
 *
 *  1. A 404 or 410 from Google means the entry is already gone, which is the
 *     outcome we wanted. Anything else means we do not know what happened, so
 *     `calendar_event_id` stays on the row and a later run can retry it.
 *  2. A run that failed on any entry never deletes the watcher, even when asked
 *     to. Deleting it would strand the residue with nothing pointing at it.
 *
 * Cancelling a reminder is a status flip and nothing more. The delivery worker
 * re-reads `status` before it sends, so a cancelled row cannot fire even though
 * its pg-boss job is still queued — the same contract `reminder_cancel` relies
 * on.
 *
 * Run it from the deployed service, which is the only place the database and
 * the Google grant both exist:
 *
 * ```
 * railway ssh "node dist/ops/retire-watcher.js"            # list the watchers
 * railway ssh "node dist/ops/retire-watcher.js 7 --dry-run" # show the damage
 * railway ssh "node dist/ops/retire-watcher.js 7 --remove"  # do it
 * ```
 */
import { pathToFileURL } from 'node:url'
import { eq } from 'drizzle-orm'
import { audit } from '../audit/log.js'
import { getDb, schema } from '../db/client.js'
import { calendar, familyCalendarId, isMissingOnGoogle } from '../integrations/google.js'
import { logger } from '../logger.js'
import { deleteWatcher, getWatcher, setWatcherActive } from '../watchers/index.js'

const log = logger.child({ mod: 'ops/retire-watcher' })

export interface RetireOptions {
  /** Report what would change and touch nothing. */
  dryRun?: boolean
  /** Delete the watcher row outright. The default is to deactivate it. */
  remove?: boolean
}

export interface RetireFailure {
  extractedEventId: number
  title: string
  error: string
}

export interface RetireSummary {
  watcher: { id: number; name: string; type: string }
  /** Entries this watcher created, whatever became of them. */
  entries: number
  /** Deleted from Google on this run. */
  calendarRemoved: number
  /** Google no longer had them; counted as done. */
  calendarAlreadyGone: number
  remindersCancelled: number
  /** To-dos are left alone — the household may have acted on them already. */
  todosKept: number
  failures: RetireFailure[]
  watcherState: 'deleted' | 'deactivated' | 'unchanged'
  dryRun: boolean
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error'
}

/**
 * Undo a watcher's calendar footprint, then stand the watcher down.
 *
 * @param id The watcher's row id. Run the CLI with no arguments to list them.
 * @throws When there is no such watcher, or when entries need removing from
 *   Google and the account is not connected. Both throw before anything is
 *   written, so a refused run leaves the household exactly as it was.
 */
export async function retireWatcher(id: number, opts: RetireOptions = {}): Promise<RetireSummary> {
  const dryRun = opts.dryRun ?? false

  const watcher = await getWatcher(id)
  if (!watcher) throw new Error(`There is no watcher with id ${id}.`)

  const rows = await getDb()
    .select()
    .from(schema.extractedEvents)
    .where(eq(schema.extractedEvents.watcherId, id))

  const summary: RetireSummary = {
    watcher: { id: watcher.id, name: watcher.name, type: watcher.type },
    entries: rows.length,
    calendarRemoved: 0,
    calendarAlreadyGone: 0,
    remindersCancelled: 0,
    todosKept: 0,
    failures: [],
    watcherState: 'unchanged',
    dryRun,
  }

  // Fail before writing anything. A half-cleaned watcher is worse than an
  // untouched one, and a missing Google grant is the likeliest reason to stop.
  const needsGoogle = rows.some((row) => row.calendarEventId !== null)
  const cal = needsGoogle ? await calendar() : null
  if (needsGoogle && !cal) {
    throw new Error(
      'Google is not connected, so the calendar entries cannot be removed. Nothing was changed.',
    )
  }
  const calendarId = cal ? await familyCalendarId() : ''

  for (const row of rows) {
    if (row.todoId !== null) summary.todosKept += 1

    if (row.calendarEventId !== null && cal) {
      if (dryRun) {
        summary.calendarRemoved += 1
      } else {
        try {
          await cal.events.delete({ calendarId, eventId: row.calendarEventId })
          summary.calendarRemoved += 1
        } catch (err) {
          if (!isMissingOnGoogle(err)) {
            // We do not know whether it is still there. Leave the id so the
            // next run can try again, and leave its reminder alone: an entry
            // still on the calendar deserves the nudge that goes with it.
            summary.failures.push({
              extractedEventId: row.id,
              title: row.title,
              error: describe(err),
            })
            log.error(
              { watcherId: id, extractedEventId: row.id, err: describe(err) },
              'could not delete a watcher-created event',
            )
            continue
          }
          summary.calendarAlreadyGone += 1
        }

        await getDb()
          .update(schema.extractedEvents)
          .set({ calendarEventId: null })
          .where(eq(schema.extractedEvents.id, row.id))
      }
    }

    if (row.reminderId !== null) {
      if (!dryRun) {
        await getDb()
          .update(schema.reminders)
          .set({ status: 'cancelled' })
          .where(eq(schema.reminders.id, row.reminderId))
      }
      summary.remindersCancelled += 1
    }
  }

  if (dryRun) return summary

  if (summary.failures.length > 0) {
    // Stop it adding more, but keep the row: it is the only handle on what is
    // left behind.
    await setWatcherActive(id, false)
    summary.watcherState = 'deactivated'
  } else if (opts.remove === true) {
    await deleteWatcher(id)
    summary.watcherState = 'deleted'
  } else {
    await setWatcherActive(id, false)
    summary.watcherState = 'deactivated'
  }

  await audit({
    actor: 'system',
    event: 'watcher.retired',
    category: 'calendar_write_from_watcher',
    resultSummary:
      `Retired "${watcher.name}" (#${id}, ${summary.watcherState}): ` +
      `${summary.calendarRemoved} calendar entries removed, ` +
      `${summary.calendarAlreadyGone} already gone, ` +
      `${summary.remindersCancelled} reminders cancelled, ` +
      `${summary.failures.length} failed.`,
    ok: summary.failures.length === 0,
  })

  log.info(
    {
      watcherId: id,
      state: summary.watcherState,
      removed: summary.calendarRemoved,
      cancelled: summary.remindersCancelled,
      failed: summary.failures.length,
    },
    'watcher retired',
  )

  return summary
}

/* ─────────────────────────────────── cli ─────────────────────────────────── */

/**
 * The watcher list, for picking an id. Imported lazily so the module above
 * stays mockable in tests with only the three functions it actually uses.
 */
function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

async function printWatchers(): Promise<void> {
  const { listWatchers } = await import('../watchers/index.js')
  const rows = await listWatchers()
  if (rows.length === 0) {
    process.stdout.write('No watchers are configured.\n')
    return
  }
  for (const row of rows) {
    const config = (row.config ?? {}) as Record<string, unknown>
    // The feed URL is the reason to run this: retiring an ICS watcher usually
    // means subscribing to the same URL in Google Calendar instead, so print it
    // rather than making someone go back to the database for it.
    const source =
      readString(config.url) ||
      readString(config.eventsUrl) ||
      (Array.isArray(config.senders) ? config.senders.join(', ') : '')
    process.stdout.write(
      `#${row.id}  ${row.active ? 'active  ' : 'paused  '}${row.type.padEnd(8)}${row.name}\n`,
    )
    if (source !== '') process.stdout.write(`      ${source}\n`)
  }
  process.stdout.write('\nThen: node dist/ops/retire-watcher.js <id> --dry-run\n')
}

function render(summary: RetireSummary): string {
  const lines = [
    `${summary.dryRun ? 'Would retire' : 'Retired'} "${summary.watcher.name}" ` +
      `(#${summary.watcher.id}, ${summary.watcher.type})`,
    `  entries created by it:   ${summary.entries}`,
    `  calendar entries removed: ${summary.calendarRemoved}`,
    `  already gone from Google: ${summary.calendarAlreadyGone}`,
    `  reminders cancelled:      ${summary.remindersCancelled}`,
    `  to-dos left alone:        ${summary.todosKept}`,
    `  watcher:                  ${summary.watcherState}`,
  ]
  if (summary.failures.length > 0) {
    lines.push(`  FAILED on ${summary.failures.length}:`)
    for (const f of summary.failures) {
      lines.push(`    #${f.extractedEventId} "${f.title}" — ${f.error}`)
    }
    lines.push('  Their calendar ids were kept. Run it again to retry those.')
  }
  return `${lines.join('\n')}\n`
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const flags = new Set(args.filter((a) => a.startsWith('--')))
  const positional = args.filter((a) => !a.startsWith('--'))

  const first = positional[0]
  if (first === undefined) {
    await printWatchers()
    return 0
  }

  const id = Number(first)
  if (!Number.isInteger(id) || id <= 0) {
    process.stderr.write(`"${first}" is not a watcher id.\n`)
    return 2
  }

  const summary = await retireWatcher(id, {
    dryRun: flags.has('--dry-run'),
    remove: flags.has('--remove'),
  })
  process.stdout.write(render(summary))
  return summary.failures.length > 0 ? 1 : 0
}

// Only when run as a program. Under vitest `process.argv[1]` is the runner, so
// importing this module for its exports never triggers the CLI.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    })
}
