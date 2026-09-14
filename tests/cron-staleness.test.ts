import { describe, expect, it } from 'vitest'
import { CRON_TASKS } from '../src/jobs/crons.js'
import { CRON_JOB_RETENTION_MINUTES, judgeCrons } from '../src/ops/watchdog.js'

/**
 * When a routine counts as behind.
 *
 * Both cases here produced a real false alarm. The household was told
 * "scheduled work is behind — check the Railway service is awake" about a
 * routine that had shipped that morning and whose first run was still hours
 * away, and about daily routines on a service that had redeployed an hour
 * earlier. Telling someone to go and check a healthy worker is worse than
 * saying nothing.
 */

const NOW = new Date('2026-09-02T22:00:00Z')

function health(lastRun: Array<{ task: string; at: Date | null }>) {
  return { reachable: true as const, scheduled: lastRun.map((r) => r.task), lastRun, error: undefined }
}

function verdictFor(task: string, at: Date | null, uptimeMinutes: number): string {
  const rows = judgeCrons(health([{ task, at }]), NOW, uptimeMinutes)
  return rows[0]?.state ?? 'missing'
}

describe('a routine with no run on record', () => {
  it('is not behind when this process has not been alive long enough to run it', () => {
    // Shipped this morning, fires at 18:00, deployed 90 minutes ago.
    expect(verdictFor(CRON_TASKS.birthdaySweep, null, 90)).toBe('unknown')
    expect(verdictFor(CRON_TASKS.morningBrief, null, 90)).toBe('unknown')
    expect(verdictFor(CRON_TASKS.dataHygiene, null, 90)).toBe('unknown')
  })

  it('is behind once the process has been up longer than its whole window', () => {
    // Two days of uptime and still nothing on file is a real problem.
    expect(verdictFor(CRON_TASKS.birthdaySweep, null, 48 * 60)).toBe('stale')
    expect(verdictFor(CRON_TASKS.morningBrief, null, 48 * 60)).toBe('stale')
  })

  it('stays unknown for a routine whose window outlives the job retention', () => {
    // The weekly review legitimately has nothing on file either way.
    expect(verdictFor(CRON_TASKS.weeklyReview, null, 48 * 60)).toBe('unknown')
  })

  it('still catches a fast routine that has genuinely stopped', () => {
    // Approval expiry runs every half hour. An hour of uptime with no record
    // is a real failure and must not be excused.
    expect(verdictFor(CRON_TASKS.pendingExpiry, null, 60)).toBe('stale')
  })
})

describe('a routine that has run', () => {
  it('is judged on when it last ran, not on uptime', () => {
    const recent = new Date(NOW.getTime() - 60 * 60_000)
    expect(verdictFor(CRON_TASKS.morningBrief, recent, 5)).toBe('fresh')

    const ancient = new Date(NOW.getTime() - 40 * 60 * 60_000)
    expect(verdictFor(CRON_TASKS.morningBrief, ancient, 48 * 60)).toBe('stale')
  })

  it('gives the birthday sweep the same slack as the other daily routines', () => {
    // It fires at 18:00, so consecutive runs are exactly 24h apart. On a 24h
    // window any delay at all reads as late, every single day.
    const yesterday = new Date(NOW.getTime() - (24 * 60 + 15) * 60_000)
    expect(verdictFor(CRON_TASKS.birthdaySweep, yesterday, 48 * 60)).toBe('fresh')
    expect(verdictFor(CRON_TASKS.dataHygiene, yesterday, 48 * 60)).toBe('fresh')
  })

  it('still reports the sweep stale when it really has missed a day', () => {
    const tooLongAgo = new Date(NOW.getTime() - 27 * 60 * 60_000)
    expect(verdictFor(CRON_TASKS.birthdaySweep, tooLongAgo, 48 * 60)).toBe('stale')
  })
})

describe('the retention constant this all rests on', () => {
  it('is two days, matching deleteAfterSeconds on the cron queue', () => {
    expect(CRON_JOB_RETENTION_MINUTES).toBe(2880)
  })
})
