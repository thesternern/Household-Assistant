# Birthdays and the Household Guardrail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the address book about birthdays so Chessy can state a child's age and remind the household about birthdays, and make household members unreachable by phone.

**Architecture:** Two nullable-or-defaulted columns on the existing `contacts` table. All date arithmetic lives in one pure leaf module so both a cron and the morning brief can use it without either importing the other. Age is computed at read time and never stored. The household guardrail extends the existing pure `validateCalleeNumber` gate rather than adding a second check elsewhere.

**Tech Stack:** TypeScript (ESM, NodeNext — every relative import ends `.js`), Drizzle ORM against Postgres, Luxon for dates, Vitest, pg-boss for cron.

**Spec:** `docs/superpowers/specs/2026-09-01-texting-contacts-birthdays-design.md`

## Global Constraints

- Node >= 22. `"type": "module"` — every relative import specifier ends in `.js`, including from `tests/`.
- **Age is derived, never stored.** No `age` column, ever.
- `birthday` is a Postgres `date`, not a timestamp. Drizzle returns it as a `YYYY-MM-DD` string.
- **A 29 February birthday is observed on 28 February in non-leap years.** One rule, used for both age and reminders, so the two can never disagree.
- Birthday reminders fire **7 days ahead** and **on the day**, at the household's `briefHour`, in the household timezone.
- A contact with `household` true is not a valid target for `phone_place_call` (and, in Phase 2, `sms_send`).
- Household membership is the explicit `household` column. **Never infer it from `role`**, which is free text.
- Run `npx tsc -p tsconfig.json --noEmit` and `npx vitest run` before every commit.

---

### Task 1: Schema columns and migration

**Files:**
- Modify: `src/db/schema.ts:1-12` (imports), `src/db/schema.ts:231-244` (contacts table)
- Create: `drizzle/0003_*.sql` (generated — do not hand-write)
- Test: `tests/contacts-schema.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `schema.contacts.birthday` (`string | null`), `schema.contacts.household` (`boolean`, default `false`). Row type `typeof schema.contacts.$inferSelect` gains both.

- [ ] **Step 1: Write the failing test**

Create `tests/contacts-schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { contacts } from '../src/db/schema.js'

/**
 * The two columns Phase 1 adds. A guardrail that depends on `household` is
 * only as good as the column being there, so its absence should fail loudly
 * rather than surface later as "the block just did not apply to Sam".
 */
describe('contacts schema', () => {
  it('has a birthday column', () => {
    expect(contacts.birthday).toBeDefined()
    expect(contacts.birthday.name).toBe('birthday')
  })

  it('has a household column that defaults to false and is not null', () => {
    expect(contacts.household).toBeDefined()
    expect(contacts.household.name).toBe('household')
    expect(contacts.household.notNull).toBe(true)
    expect(contacts.household.default).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contacts-schema.test.ts`
Expected: FAIL — `contacts.birthday` is undefined.

- [ ] **Step 3: Add `date` to the drizzle imports**

In `src/db/schema.ts`, the import block currently ends `index,`. Add `date` to it:

```ts
import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  date,
  jsonb,
  doublePrecision,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core'
```

- [ ] **Step 4: Add the two columns**

In `src/db/schema.ts`, inside `export const contacts = pgTable('contacts', {...})`, add after `notes`:

```ts
    /**
     * A calendar day, never a timestamp: giving a birthday a time invites a
     * timezone to shift it across midnight. Age is derived from this at read
     * time and is never stored, because a stored age is wrong within a year
     * and nothing would notice.
     */
    birthday: date('birthday'),
    /**
     * The people who live here. A household contact is reference data — their
     * number exists so Chessy can give it to a doctor's office — and is never
     * a valid target for a call or a text.
     *
     * Explicit rather than inferred from `role`, which is free text: "wife"
     * and "spouse" are one person to the household and two strings to a LIKE,
     * and a guardrail that depends on spelling is not a guardrail.
     */
    household: boolean('household').notNull().default(false),
```

- [ ] **Step 5: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/0003_<name>.sql` containing two `ALTER TABLE "contacts" ADD COLUMN` statements, plus an updated `drizzle/meta/_journal.json`.

- [ ] **Step 6: Read the generated SQL and confirm it is additive**

Run: `cat drizzle/0003_*.sql`
Expected, allowing for drizzle's formatting:

```sql
ALTER TABLE "contacts" ADD COLUMN "birthday" date;
ALTER TABLE "contacts" ADD COLUMN "household" boolean DEFAULT false NOT NULL;
```

If it contains any `DROP`, stop and report — the migration must be purely additive against a live production table.

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: typecheck clean, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts drizzle/ tests/contacts-schema.test.ts
git commit -m "Give contacts a birthday and a household flag"
```

---

### Task 2: Birthday arithmetic

**Files:**
- Create: `src/contacts/birthdays.ts`
- Test: `tests/birthdays.test.ts`

**Interfaces:**
- Consumes: nothing (pure, Luxon only)
- Produces:
  - `observedBirthday(birthday: string, year: number, zone: string): DateTime | null`
  - `ageOn(birthday: string, today: DateTime): number | null`
  - `daysUntilBirthday(birthday: string, today: DateTime): number | null`
  - `LEAD_DAYS = 7`

This module imports **only** `luxon` and keeps it that way. The database read and the Telegram send live in a separate file (Task 5), so the arithmetic stays trivially testable and the cron and the morning brief can both use it without importing each other.

- [ ] **Step 1: Write the failing test**

Create `tests/birthdays.test.ts`:

```ts
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { ageOn, daysUntilBirthday, observedBirthday } from '../src/contacts/birthdays.js'

const ZONE = 'America/Vancouver'
const on = (iso: string) => DateTime.fromISO(iso, { zone: ZONE })

describe('ageOn', () => {
  it('counts a birthday that has already passed this year', () => {
    expect(ageOn('2018-03-04', on('2026-09-01'))).toBe(8)
  })

  it('does not count a birthday still to come this year', () => {
    expect(ageOn('2018-12-04', on('2026-09-01'))).toBe(7)
  })

  it('increments on the birthday itself', () => {
    expect(ageOn('2018-09-01', on('2026-09-01'))).toBe(8)
  })

  it('treats 29 February as 28 February in a non-leap year', () => {
    // 2026 is not a leap year. The observed day is the 28th, so the 28th is
    // the day the age ticks over.
    expect(ageOn('2000-02-29', on('2026-02-27'))).toBe(25)
    expect(ageOn('2000-02-29', on('2026-02-28'))).toBe(26)
  })

  it('uses the real day in a leap year', () => {
    expect(ageOn('2000-02-29', on('2028-02-28'))).toBe(27)
    expect(ageOn('2000-02-29', on('2028-02-29'))).toBe(28)
  })

  it('returns null for an unparseable birthday', () => {
    expect(ageOn('not-a-date', on('2026-09-01'))).toBeNull()
    expect(ageOn('', on('2026-09-01'))).toBeNull()
  })
})

describe('daysUntilBirthday', () => {
  it('is 0 on the day', () => {
    expect(daysUntilBirthday('2018-09-01', on('2026-09-01'))).toBe(0)
  })

  it('counts forward within the year', () => {
    expect(daysUntilBirthday('2018-09-08', on('2026-09-01'))).toBe(7)
  })

  it('rolls into next year once the birthday has passed', () => {
    expect(daysUntilBirthday('2018-08-30', on('2026-09-01'))).toBe(363)
  })

  it('crosses the year boundary', () => {
    expect(daysUntilBirthday('2018-01-01', on('2026-12-28'))).toBe(4)
  })

  it('is measured in local days, not elapsed hours', () => {
    // Late in the evening, local time. A naive hour-difference would round
    // this to 6 days and the seven-day notice would never fire.
    expect(daysUntilBirthday('2018-09-08', on('2026-09-01T23:30'))).toBe(7)
  })
})

describe('observedBirthday', () => {
  it('returns null for a malformed value', () => {
    expect(observedBirthday('13-13-13', 2026, ZONE)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/birthdays.test.ts`
Expected: FAIL — cannot find module `../src/contacts/birthdays.js`.

- [ ] **Step 3: Write the implementation**

Create `src/contacts/birthdays.ts`:

```ts
import { DateTime } from 'luxon'

/**
 * Birthday arithmetic, as pure functions.
 *
 * This module imports nothing but Luxon on purpose. The sweep cron and the
 * morning brief both need these answers, and a leaf module is what lets them
 * share without one importing the other.
 *
 * Age is computed here and stored nowhere. A stored age is wrong within a year
 * of being written and nothing in the system would notice.
 */

/** How much notice the household gets before a birthday. Enough to buy something. */
export const LEAD_DAYS = 7

/**
 * The day a birthday is observed in a given year.
 *
 * A 29 February birthday is observed on the 28th in non-leap years. That is one
 * rule used by both the age and the reminder, which is the point: two rules
 * would eventually disagree about whether someone had had their birthday.
 */
export function observedBirthday(
  birthday: string,
  year: number,
  zone: string,
): DateTime | null {
  const born = DateTime.fromISO(birthday, { zone })
  if (!born.isValid) return null

  const candidate = DateTime.fromObject(
    { year, month: born.month, day: born.day },
    { zone },
  )
  if (candidate.isValid) return candidate.startOf('day')

  // The only way a real month/day fails to exist is 29 February in a non-leap
  // year. Observe it on the 28th.
  return DateTime.fromObject({ year, month: born.month, day: 28 }, { zone }).startOf('day')
}

/** Whole years old on `today`, or `null` if the birthday cannot be read. */
export function ageOn(birthday: string, today: DateTime): number | null {
  const born = DateTime.fromISO(birthday, { zone: today.zoneName ?? 'utc' })
  if (!born.isValid) return null

  const observed = observedBirthday(birthday, today.year, today.zoneName ?? 'utc')
  if (!observed) return null

  const had = today.startOf('day') >= observed
  return today.year - born.year - (had ? 0 : 1)
}

/**
 * Whole local days until the next observed birthday. `0` on the day itself.
 *
 * Measured between start-of-day values so an evening run still reports seven
 * days rather than six-and-a-bit, which is what would silently swallow the
 * week's notice.
 */
export function daysUntilBirthday(birthday: string, today: DateTime): number | null {
  const zone = today.zoneName ?? 'utc'
  const start = today.startOf('day')

  const thisYear = observedBirthday(birthday, today.year, zone)
  if (!thisYear) return null

  const target = thisYear >= start ? thisYear : observedBirthday(birthday, today.year + 1, zone)
  if (!target) return null

  return Math.round(target.diff(start, 'days').days)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/birthdays.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: typecheck clean, everything green.

- [ ] **Step 6: Commit**

```bash
git add src/contacts/birthdays.ts tests/birthdays.test.ts
git commit -m "Add birthday arithmetic, with one rule for 29 February"
```

---

### Task 3: The address book learns both fields

**Files:**
- Modify: `src/tools/contacts.ts` — `toStructured` (line ~88), `describeContact` (line ~100), `addShape` (line ~133), `updateShape` (line ~333)
- Test: `tests/contacts-birthday-fields.test.ts`

**Interfaces:**
- Consumes: `ageOn` from `src/contacts/birthdays.js`; the columns from Task 1
- Produces: `contact_add` and `contact_update` accept `birthday` (`YYYY-MM-DD`) and `household` (boolean). `contact_search` returns `birthday` and a derived `age` in `structuredContent`.

- [ ] **Step 1: Write the failing test**

Create `tests/contacts-birthday-fields.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isBirthdayString } from '../src/tools/contacts.js'

/**
 * A birthday reaches the database as whatever the model typed. `familyCalendarId`
 * taught this codebase what happens when an unvalidated string is handed to a
 * consumer four modules away: the failure surfaces nowhere near its cause. The
 * column is a Postgres `date`, so anything that is not an ISO calendar day is
 * rejected at the tool boundary.
 */
describe('isBirthdayString', () => {
  it('accepts an ISO calendar day', () => {
    expect(isBirthdayString('2018-03-04')).toBe(true)
  })

  it('rejects a day that does not exist', () => {
    expect(isBirthdayString('2026-02-30')).toBe(false)
    expect(isBirthdayString('2026-13-01')).toBe(false)
  })

  it('accepts 29 February in a leap year and rejects it otherwise', () => {
    expect(isBirthdayString('2000-02-29')).toBe(true)
    expect(isBirthdayString('2001-02-29')).toBe(false)
  })

  it('rejects prose, timestamps, and empty strings', () => {
    expect(isBirthdayString('March 4th')).toBe(false)
    expect(isBirthdayString('2018-03-04T00:00:00Z')).toBe(false)
    expect(isBirthdayString('')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contacts-birthday-fields.test.ts`
Expected: FAIL — `isBirthdayString` is not exported.

- [ ] **Step 3: Add the validator to `src/tools/contacts.ts`**

Add near the other helpers, after `readString`:

```ts
/**
 * True for an ISO calendar day that actually exists. The column is a Postgres
 * `date`; anything else is rejected here rather than at the driver, where the
 * error would name the query and not the field.
 */
export function isBirthdayString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  return DateTime.fromISO(value, { zone: 'utc' }).isValid
}
```

Add the Luxon import at the top of the file, after the drizzle imports:

```ts
import { DateTime } from 'luxon'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/contacts-birthday-fields.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add both fields to `addShape`**

In `src/tools/contacts.ts`, add to `addShape` after `notes`:

```ts
  birthday: z
    .string()
    .trim()
    .max(10)
    .optional()
    .describe('Date of birth as YYYY-MM-DD, e.g. 2018-03-04. Used to work out their age.'),
  household: z
    .boolean()
    .optional()
    .describe(
      'True only for people who live in this household — the parents and the children. ' +
        'Their numbers are here so they can be given to a doctor or a booking. Chessy may ' +
        'never call or text a household member.',
    ),
```

- [ ] **Step 6: Handle both fields in the `contact_add` handler**

In the handler, change the destructure and add validation immediately after the existing email check:

```ts
    const { name, role, email, address, notes, birthday, household } = parsed.data
```

```ts
    if (birthday !== undefined && !isBirthdayString(birthday)) {
      return fail(`"${birthday}" is not a date I can store. Give me a birthday as YYYY-MM-DD.`)
    }
```

In the `if (existing)` branch, extend the patch:

```ts
        if (birthday !== undefined) patch.birthday = birthday
        if (household !== undefined) patch.household = household
```

And add `birthday` and `household` to the `.values({...})` object of the insert branch, alongside `name`, `role`, `phone`, `email`, `address`, `notes`.

- [ ] **Step 7: Add both fields to `updateShape` and its handler**

Add to `updateShape`:

```ts
  birthday: z
    .string()
    .trim()
    .max(10)
    .optional()
    .describe("New date of birth as YYYY-MM-DD. Pass 'none' to clear it."),
  household: z.boolean().optional().describe('Whether this person lives in the household.'),
```

In the `contact_update` handler, the existing loop clears `role`, `email`, `address`, and `notes`. Add the birthday after it, and the household flag after that:

```ts
    if (parsed.data.birthday !== undefined) {
      const raw = parsed.data.birthday
      if (CLEAR_WORDS.has(raw.toLowerCase())) {
        patch.birthday = null
      } else if (!isBirthdayString(raw)) {
        return fail(`"${raw}" is not a date I can store. Give me a birthday as YYYY-MM-DD.`)
      } else {
        patch.birthday = raw
      }
    }
    if (parsed.data.household !== undefined) {
      patch.household = parsed.data.household
    }
```

Also extend the "tell me what to change" message below it, so the list of fields stays honest:

```ts
      return fail(
        'Tell me what to change: name, role, phone, email, address, notes, birthday, or household.',
      )
```

- [ ] **Step 8: Return birthday and derived age from searches**

Change `toStructured`:

```ts
function toStructured(row: ContactRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    phone: row.phone,
    email: row.email,
    address: row.address,
    notes: row.notes,
    birthday: row.birthday,
    // Derived on every read. Never stored — see src/contacts/birthdays.ts.
    age: row.birthday ? ageOn(row.birthday, DateTime.now().setZone(householdZone())) : null,
    household: row.household,
  }
}
```

Add the imports:

```ts
import { ageOn } from '../contacts/birthdays.js'
import { getConfig } from '../config.js'
```

And a small local helper, because this module has no zone of its own:

```ts
/** The household timezone, or the configured default when the row is unreadable. */
function householdZone(): string {
  try {
    return getConfig().HOUSEHOLD_TIMEZONE
  } catch {
    return 'America/Vancouver'
  }
}
```

- [ ] **Step 9: Mention the age in the human-readable line**

In `describeContact`, after the existing `role` push, add:

```ts
  if (row.birthday) {
    const age = ageOn(row.birthday, DateTime.now().setZone(householdZone()))
    if (age !== null) bits.push(`age ${age}`)
  }
```

- [ ] **Step 10: Typecheck and run the full suite**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: typecheck clean, all tests pass.

- [ ] **Step 11: Commit**

```bash
git add src/tools/contacts.ts tests/contacts-birthday-fields.test.ts
git commit -m "Teach the address book about birthdays and household membership"
```

---

### Task 4: Household members are unreachable by phone

**Files:**
- Modify: `src/tools/phone.ts` — `validateCalleeNumber` (line ~357), `contactNumbers` (line ~423), the handler's call site (line ~551)
- Test: `tests/phone-household-block.test.ts`

**Interfaces:**
- Consumes: `schema.contacts.household` from Task 1
- Produces: `validateCalleeNumber(raw, { contactNumbers?, householdNumbers? })`. A number in `householdNumbers` is rejected regardless of anything else.

- [ ] **Step 1: Write the failing test**

Create `tests/phone-household-block.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { validateCalleeNumber } from '../src/tools/phone.js'

/**
 * Sam's number is in the address book so Chessy can give it to a doctor's
 * office. It is not there so she can dial it.
 *
 * The check sits inside `validateCalleeNumber` rather than beside it, because
 * that function is the one gate every call already passes through. A second
 * check somewhere else is a second thing to forget.
 */
const SAM = '+16045550143'
const DENTIST = '+16045550111'

describe('household numbers are not dialable', () => {
  it('refuses a household number', () => {
    const check = validateCalleeNumber(SAM, {
      contactNumbers: [SAM, DENTIST],
      householdNumbers: [SAM],
    })
    expect(check.ok).toBe(false)
  })

  it('says who it is and what to do instead', () => {
    const check = validateCalleeNumber(SAM, {
      contactNumbers: [SAM],
      householdNumbers: [SAM],
    })
    if (check.ok) throw new Error('expected a refusal')
    expect(check.reason).toMatch(/household/i)
    expect(check.reason).toMatch(/telegram/i)
  })

  it('still allows an ordinary contact', () => {
    const check = validateCalleeNumber(DENTIST, {
      contactNumbers: [SAM, DENTIST],
      householdNumbers: [SAM],
    })
    expect(check.ok).toBe(true)
  })

  it('refuses a household number even though it is a saved contact', () => {
    // Being in the book is what unlocks premium and international numbers.
    // It must never unlock a household one.
    const check = validateCalleeNumber(SAM, {
      contactNumbers: [SAM],
      householdNumbers: [SAM],
    })
    expect(check.ok).toBe(false)
  })

  it('behaves as before when no household numbers are supplied', () => {
    const check = validateCalleeNumber(DENTIST, { contactNumbers: [DENTIST] })
    expect(check.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/phone-household-block.test.ts`
Expected: FAIL — the household number is accepted, and `householdNumbers` is not a known option.

- [ ] **Step 3: Extend the gate**

In `src/tools/phone.ts`, change the signature and add the check as the **first** rule after parsing, before the classification logic:

```ts
export function validateCalleeNumber(
  raw: unknown,
  opts: { contactNumbers?: readonly string[]; householdNumbers?: readonly string[] } = {},
): CalleeCheck {
  const parsed = normalizeE164(raw)
  if (!parsed.ok) return parsed

  // First, and before anything that a saved contact can unlock. Being in the
  // address book is what permits a premium or international number; it must
  // never permit a household one.
  const household = new Set(opts.householdNumbers ?? [])
  if (household.has(parsed.e164)) {
    return reject(
      `${formatE164(parsed.e164)} belongs to someone in the household. ` +
        'I do not call or text the family — tell them in Telegram instead. ' +
        'Their number is in the address book so it can be given to a doctor or a booking.',
    )
  }

  const known = new Set(opts.contactNumbers ?? [])
  // ... the rest of the function is unchanged
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/phone-household-block.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Load the household numbers alongside the contact numbers**

Replace `contactNumbers()` in `src/tools/phone.ts` with a version returning both sets. It already selects from `contacts`; it now needs one more column.

```ts
/** Saved numbers in E.164, split into everything and the household's own. */
async function knownNumbers(): Promise<{ all: string[]; household: string[] }> {
  const rows = await getDb()
    .select({ phone: schema.contacts.phone, household: schema.contacts.household })
    .from(schema.contacts)
    .where(isNotNull(schema.contacts.phone))
    .limit(CONTACT_SCAN_LIMIT)

  const all: string[] = []
  const household: string[] = []
  for (const row of rows) {
    const parsed = normalizeE164(row.phone ?? '')
    if (!parsed.ok) continue
    if (!all.includes(parsed.e164)) all.push(parsed.e164)
    if (row.household && !household.includes(parsed.e164)) household.push(parsed.e164)
  }
  return { all, household }
}
```

- [ ] **Step 6: Update the call site**

At `src/tools/phone.ts:551`, replace the `known = await contactNumbers()` assignment and the `validateCalleeNumber` call:

```ts
      known = await knownNumbers()
```

```ts
    const check = validateCalleeNumber(input.callee_number, {
      contactNumbers: known.all,
      householdNumbers: known.household,
    })
```

The declaration above it changes shape too. Replace `let known: string[] = []` with:

```ts
    let known: { all: string[]; household: string[] } = { all: [], household: [] }
```

Keep the existing `try`/`catch` around the read exactly as it is. **If the database read fails**, both lists stay empty — which is the safe direction: an unreadable address book already means premium and international numbers are refused, and a household number that cannot be identified is simply a number with no special permission.

- [ ] **Step 7: Typecheck and run the full suite**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: typecheck clean, every test green — including the existing phone tests, which must not have regressed.

- [ ] **Step 8: Commit**

```bash
git add src/tools/phone.ts tests/phone-household-block.test.ts
git commit -m "Refuse to dial anyone who lives here"
```

---

### Task 5: The birthday sweep

**Files:**
- Modify: `src/contacts/birthdays.ts` (add the selector — still Luxon-only)
- Create: `src/contacts/birthday-sweep.ts` (the database read and the send)
- Modify: `src/jobs/crons.ts` — `CRON_TASKS` (line ~60), the spec list (line ~140), `CRON_HANDLERS` (line ~210)
- Test: `tests/birthday-sweep.test.ts`

**Interfaces:**
- Consumes: `ageOn`, `daysUntilBirthday`, `LEAD_DAYS` from Task 2; the columns from Task 1
- Produces:
  - from `birthdays.ts`: `birthdaysDue(rows, today): BirthdayNotice[]`, where
    `BirthdayRow = { name: string; birthday: string | null }` and
    `BirthdayNotice = { name: string; age: number | null; daysAway: number }`
  - from `birthday-sweep.ts`: `loadBirthdayContacts(): Promise<BirthdayRow[]>` and
    `birthdaySweep(): Promise<void>`
  - `CRON_TASKS.birthdaySweep === 'birthday-sweep'`

- [ ] **Step 1: Write the failing test**

Create `tests/birthday-sweep.test.ts`:

```ts
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { birthdaysDue } from '../src/contacts/birthdays.js'

const ZONE = 'America/Vancouver'
const on = (iso: string) => DateTime.fromISO(iso, { zone: ZONE })

const rows = [
  { name: 'Maya', birthday: '2018-09-08' }, // seven days out
  { name: 'Theo', birthday: '2020-09-01' }, // today
  { name: 'Alex', birthday: '1983-09-04' }, // three days out — too soon to mention
  { name: 'Sam', birthday: '1987-12-14' }, // months away
  { name: 'Dentist', birthday: null }, // no birthday at all
]

/**
 * Two notices per birthday and no others: a week out, which is enough time to
 * buy something, and the day itself. Anything in between is noise the household
 * did not ask for.
 */
describe('birthdaysDue', () => {
  it('picks up a birthday exactly seven days away', () => {
    const due = birthdaysDue(rows, on('2026-09-01'))
    expect(due.map((d) => d.name)).toContain('Maya')
    expect(due.find((d) => d.name === 'Maya')?.daysAway).toBe(7)
  })

  it('picks up a birthday today, with the age they are turning', () => {
    const due = birthdaysDue(rows, on('2026-09-01'))
    const theo = due.find((d) => d.name === 'Theo')
    expect(theo?.daysAway).toBe(0)
    expect(theo?.age).toBe(6)
  })

  it('ignores birthdays that are neither today nor a week away', () => {
    const due = birthdaysDue(rows, on('2026-09-01'))
    expect(due.map((d) => d.name)).not.toContain('Alex')
    expect(due.map((d) => d.name)).not.toContain('Sam')
  })

  it('ignores contacts with no birthday', () => {
    const due = birthdaysDue(rows, on('2026-09-01'))
    expect(due.map((d) => d.name)).not.toContain('Dentist')
  })

  it('returns nothing on an ordinary day', () => {
    expect(birthdaysDue(rows, on('2026-06-15'))).toEqual([])
  })

  it('reports the age they will turn, not the age they are, for a notice', () => {
    // Maya is 7 until the 8th. The notice is about her turning 8.
    const due = birthdaysDue(rows, on('2026-09-01'))
    expect(due.find((d) => d.name === 'Maya')?.age).toBe(8)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/birthday-sweep.test.ts`
Expected: FAIL — `birthdaysDue` is not exported.

- [ ] **Step 3: Add the selector to `src/contacts/birthdays.ts`**

```ts
export interface BirthdayRow {
  name: string
  birthday: string | null
}

export interface BirthdayNotice {
  name: string
  /** The age they are turning, not the age they are today. */
  age: number | null
  /** 0 on the day, otherwise LEAD_DAYS. */
  daysAway: number
}

/**
 * The birthdays worth mentioning on `today`: the ones happening now, and the
 * ones a week out. Nothing in between — a household that is told every day for
 * a week stops reading the notice.
 */
export function birthdaysDue(
  rows: readonly BirthdayRow[],
  today: DateTime,
): BirthdayNotice[] {
  const out: BirthdayNotice[] = []
  for (const row of rows) {
    if (!row.birthday) continue
    const daysAway = daysUntilBirthday(row.birthday, today)
    if (daysAway === null) continue
    if (daysAway !== 0 && daysAway !== LEAD_DAYS) continue

    // The notice is about the birthday, so it names the age being reached.
    const current = ageOn(row.birthday, today)
    const age = current === null ? null : daysAway === 0 ? current : current + 1
    out.push({ name: row.name, age, daysAway })
  }
  return out
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/birthday-sweep.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Add the database read and the sweep, in their own file**

Create `src/contacts/birthday-sweep.ts`. This lives apart from `birthdays.ts` so that module keeps its single Luxon import and stays testable without mocking a database or a chat client.

```ts
import { isNotNull } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { getConfig } from '../config.js'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'
import { sendToAll } from '../telegram/send.js'
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
  const zone = getConfig().HOUSEHOLD_TIMEZONE
  const rows = await loadBirthdayContacts()
  const due = birthdaysDue(rows, DateTime.now().setZone(zone))
  if (due.length === 0) return

  await sendToAll(due.map(renderNotice).join('\n'))
  log.info({ count: due.length }, 'birthday notices sent')
}
```

- [ ] **Step 6: Register the cron task key**

In `src/jobs/crons.ts`, add to `CRON_TASKS`:

```ts
  birthdaySweep: 'birthday-sweep',
```

- [ ] **Step 7: Schedule it**

In the spec list in `src/jobs/crons.ts`, add alongside the other household-local entries:

```ts
    // Five past the brief, so a birthday notice lands just after the rundown
    // rather than racing it into the same notification.
    { key: CRON_TASKS.birthdaySweep, cron: dailyCronUtc(s.timezone, s.briefHour, 5, reference) },
```

- [ ] **Step 8: Wire the handler**

Add to `CRON_HANDLERS` in `src/jobs/crons.ts`:

```ts
  [CRON_TASKS.birthdaySweep]: birthdaySweepCron,
```

And add the loader beside `morningBriefCron`, following the same dynamic-import convention used there:

```ts
export async function birthdaySweepCron(): Promise<void> {
  const { birthdaySweep } = await import('../contacts/birthday-sweep.js')
  await birthdaySweep()
}
```

- [ ] **Step 9: Typecheck and run the full suite**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: typecheck clean, all tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/contacts/birthdays.ts src/contacts/birthday-sweep.ts src/jobs/crons.ts tests/birthday-sweep.test.ts
git commit -m "Sweep for birthdays a week out and on the day"
```

---

### Task 6: Birthdays in the morning brief

**Files:**
- Modify: `src/workflows/morning-brief.ts` — the `Promise.all` (line ~99) and the `factsBlock` (line ~108)
- Test: `tests/morning-brief-birthdays.test.ts`

**Interfaces:**
- Consumes: `birthdaysDue` and `BirthdayRow` from `src/contacts/birthdays.js`; `loadBirthdayContacts` from `src/contacts/birthday-sweep.js` (both Task 5)
- Produces: nothing new; the brief's facts block gains a birthdays section

- [ ] **Step 1: Write the failing test**

Create `tests/morning-brief-birthdays.test.ts`:

```ts
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { renderBirthdayFact } from '../src/workflows/morning-brief.js'

const ZONE = 'America/Vancouver'
const on = (iso: string) => DateTime.fromISO(iso, { zone: ZONE })

/**
 * The brief is read on a phone before coffee, so a birthday has to survive as
 * one short line. It is handed to the model as settled fact rather than left
 * to a tool call, because a SELECT can answer it and the brief's whole design
 * is to spend tool calls only on what a SELECT cannot.
 */
describe('renderBirthdayFact', () => {
  it('names today with the age being turned', () => {
    const line = renderBirthdayFact([{ name: 'Theo', birthday: '2020-09-01' }], on('2026-09-01'))
    expect(line).toHaveLength(1)
    expect(line[0]).toContain('Theo')
    expect(line[0]).toContain('6')
  })

  it('flags a birthday a week out', () => {
    const line = renderBirthdayFact([{ name: 'Maya', birthday: '2018-09-08' }], on('2026-09-01'))
    expect(line[0]).toMatch(/week|7/i)
  })

  it('says nothing on an ordinary day', () => {
    expect(renderBirthdayFact([{ name: 'Maya', birthday: '2018-09-08' }], on('2026-06-15'))).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/morning-brief-birthdays.test.ts`
Expected: FAIL — `renderBirthdayFact` is not exported.

- [ ] **Step 3: Add the renderer**

In `src/workflows/morning-brief.ts`, add the import and the exported helper above `morningBrief`:

```ts
import { type BirthdayRow, birthdaysDue } from '../contacts/birthdays.js'
```

```ts
/**
 * Birthdays as brief-ready lines. Exported so it can be tested without standing
 * up a turn: everything else in this file needs the agent.
 */
export function renderBirthdayFact(rows: readonly BirthdayRow[], today: DateTime): string[] {
  return birthdaysDue(rows, today).map((b) => {
    const age = b.age === null ? '' : ` (turning ${b.age})`
    return b.daysAway === 0
      ? `- ${b.name}'s birthday is today${age}`
      : `- ${b.name}'s birthday is in a week${age}`
  })
}
```

Add the Luxon import if it is not already present:

```ts
import { DateTime } from 'luxon'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/morning-brief-birthdays.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Read birthdays alongside the other cheap facts**

In `brief()`, extend the existing `Promise.all`. `loadBirthdayContacts` is a plain SELECT and belongs with the others.

```ts
  const [dueTodos, followups, approvals, weather, birthdayRows] = await Promise.all([
    todosDueOrOverdue(),
    openFollowups(),
    waitingApprovals(),
    todayWeather(),
    loadBirthdayContacts().catch(() => [] as BirthdayRow[]),
  ])
```

Add the second import, which comes from the sweep module rather than the arithmetic one:

```ts
import { loadBirthdayContacts } from '../contacts/birthday-sweep.js'
```

The `.catch` matters: the brief already treats every input as best-effort, and an unreadable address book must not cost the household its rundown.

- [ ] **Step 6: Put the lines in the facts block**

Add a section to `factsBlock`, after the weather line and before the to-dos:

```ts
    section('Birthdays', renderBirthdayFact(birthdayRows, DateTime.now().setZone(zone()))),
```

`section` already omits an empty list, so a day with no birthdays adds nothing — which is what the brief's format rules require.

- [ ] **Step 7: Typecheck and run the full suite**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: typecheck clean, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/workflows/morning-brief.ts tests/morning-brief-birthdays.test.ts
git commit -m "Put birthdays in the morning brief"
```

---

## After the plan

Push to `main`, which deploys via Railway. Confirm the migration ran:

```bash
railway logs -s home-assistant | grep -E "migrations complete|home-assistant ready"
```

Then, in Telegram, tell Chessy the family — one message each, no slash commands:

> Add Sam as a contact, she lives here, phone 604-555-0143, birthday 1987-12-14

Verify with `/status` and by asking *"how old is Maya?"*. Then check the guardrail holds by asking her to call Sam — she should refuse and point at Telegram.

**Everyone who lives in the house needs `household` set.** A family member whose row lacks the flag is dialable. Ask Chessy to list the household contacts once they are all in, and confirm the list is complete.
