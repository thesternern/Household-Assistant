import { isNotNull } from 'drizzle-orm'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { sendToAll } from '../telegram/send.js'
import { householdNow } from '../time.js'
import { type BirthdayNotice, type BirthdayRow, birthdaysDue } from './birthdays.js'

/**
 * The daily birthday sweep, and the one database read it needs.
 *
 * Split from `birthdays.ts` on purpose: the arithmetic there is pure and its
 * tests need nothing but a date, while everything here needs a database and a
 * chat to send to.
 */

const log = logger.child({ mod: 'contacts/birthday-sweep' })

/** Everyone in the address book who has a birthday on file. */
export async function loadBirthdayContacts(): Promise<BirthdayRow[]> {
  const rows = await getDb()
    .select({ name: schema.contacts.name, birthday: schema.contacts.birthday })
    .from(schema.contacts)
    .where(isNotNull(schema.contacts.birthday))
  return rows
}

function renderNotice(n: BirthdayNotice): string {
  const age = n.age === null ? '' : ` — turning ${n.age}`
  return n.daysAway === 0 ? `Today: ${n.name}${age}.` : `In a week: ${n.name}${age}.`
}

/**
 * The daily birthday sweep. Reads the `birthday` column and says something only
 * when there is something to say, so a quiet day is silent.
 */
export async function birthdaySweep(): Promise<void> {
  const rows = await loadBirthdayContacts()
  const due = birthdaysDue(rows, householdNow())
  if (due.length === 0) return

  await sendToAll(due.map(renderNotice).join('\n'))
  log.info({ count: due.length }, 'birthday notices sent')
}
