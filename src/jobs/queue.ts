import { PgBoss } from 'pg-boss'
import type { Job, JobWithMetadata } from 'pg-boss'
import type { Update } from 'grammy/types'
import { runTurn } from '../agent/run-turn.js'
import { audit } from '../audit/log.js'
import { getConfig } from '../config.js'
import { executeApprovedAction } from '../executor/execute-action.js'
import { logger } from '../logger.js'
import { primaryChatId, sendToAll } from '../telegram/send.js'
import type { ToolOrigin } from '../tools/types.js'
import { runCronTask, scheduleHouseholdCrons } from './crons.js'
import { fireReminder } from './fire-reminder.js'
import { handleTelegramUpdate, telegramChatIdOf } from './handle-telegram-update.js'
import { handleVapiEvent } from './handle-vapi-event.js'

/**
 * The pg-boss job layer. Everything asynchronous in the assistant flows
 * through here: Telegram turns, Vapi webhooks, approved-action replay,
 * reminders, background agent turns, watcher polls, browser tasks, and the
 * household crons.
 *
 * `./crons.ts`, `./fire-reminder.ts`, and `./handle-vapi-event.ts` import back
 * from this module. That cycle is deliberate and safe: every cross-reference
 * happens inside a function body, never at module-evaluation time.
 */

const log = logger.child({ mod: 'queue' })

export const QUEUES = {
  tgUpdate: 'tg-update',
  vapiEvent: 'vapi-event',
  executeAction: 'execute-action',
  fireReminder: 'fire-reminder',
  agentTask: 'agent-task',
  watcherPoll: 'watcher-poll',
  browserTask: 'browser-task',
  smsInbound: 'sms-inbound',
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]

/** Every household cron is one schedule on this queue, distinguished by its schedule key. */
export const CRON_QUEUE = 'household-cron'

/** Where a job lands after its retries are exhausted. Read by the DLQ worker below. */
export const DEAD_LETTER_QUEUE = 'dead-letter'

/**
 * Retry budget for every work queue: the first attempt plus three retries,
 * spaced by exponential backoff (~10s, ~20s, ~40s with jitter) and capped at
 * ten minutes. After that the job is copied into `dead-letter`, which tells the
 * household and offers a Retry button.
 */
const RETRY = {
  retryLimit: 3,
  retryBackoff: true,
  retryDelay: 10,
  retryDelayMax: 600,
} as const

/* ─────────────────────────────── queue shapes ────────────────────────────── */

interface QueueSpec {
  name: string
  policy?: 'standard' | 'singleton'
  expireInSeconds: number
  deleteAfterSeconds: number
  /**
   * Set on any queue whose handler can legitimately outlive `expireInSeconds`.
   * Without it pg-boss counts expiry from the moment work starts, marks a
   * still-running job expired, and hands a RETRY to a second worker — so an
   * eleven-minute agent turn was being run twice, side by side, on the same
   * chat. With it the worker touches the row every half-interval and the job
   * fails only when the process holding it is actually gone.
   */
  heartbeatSeconds?: number
}

/** Heartbeat for anything that runs a model turn or drives a browser. */
const LONG_JOB_HEARTBEAT_SECONDS = 60

const QUEUE_SPECS: QueueSpec[] = [
  // One active turn per chat (the worker supplies a per-chat singleton key), so
  // two messages from the same spouse never interleave, while the other chat
  // keeps moving. `singleton` rather than `key_strict_fifo` on purpose: strict
  // FIFO also holds a key back behind a *failed* job, which would silence a
  // chat until the failed row aged out.
  {
    name: QUEUES.tgUpdate,
    policy: 'singleton',
    expireInSeconds: 600,
    deleteAfterSeconds: 3600,
    heartbeatSeconds: LONG_JOB_HEARTBEAT_SECONDS,
  },
  {
    name: QUEUES.vapiEvent,
    expireInSeconds: 300,
    deleteAfterSeconds: 86_400,
  },
  {
    name: QUEUES.executeAction,
    expireInSeconds: 900,
    deleteAfterSeconds: 604_800,
    heartbeatSeconds: LONG_JOB_HEARTBEAT_SECONDS,
  },
  {
    name: QUEUES.fireReminder,
    expireInSeconds: 180,
    deleteAfterSeconds: 86_400,
  },
  {
    name: QUEUES.agentTask,
    expireInSeconds: 900,
    deleteAfterSeconds: 86_400,
    heartbeatSeconds: LONG_JOB_HEARTBEAT_SECONDS,
  },
  // One poll per watcher at a time; a slow mailbox must not pile up behind itself.
  {
    name: QUEUES.watcherPoll,
    policy: 'singleton',
    expireInSeconds: 600,
    deleteAfterSeconds: 86_400,
    heartbeatSeconds: LONG_JOB_HEARTBEAT_SECONDS,
  },
  {
    name: QUEUES.browserTask,
    policy: 'singleton',
    expireInSeconds: 1800,
    deleteAfterSeconds: 86_400,
    heartbeatSeconds: LONG_JOB_HEARTBEAT_SECONDS,
  },
  // One inbound text at a time. Two messages arriving together on the same
  // thread must not both decide they are inside the message cap.
  {
    name: QUEUES.smsInbound,
    policy: 'singleton',
    expireInSeconds: 600,
    deleteAfterSeconds: 86_400,
  },
  {
    name: CRON_QUEUE,
    expireInSeconds: 900,
    deleteAfterSeconds: 172_800,
  },
]

/** Human phrasing for the failure notice, so the card does not read like a stack trace. */
const QUEUE_LABELS: Record<string, string> = {
  [QUEUES.tgUpdate]: 'handling a Telegram message',
  [QUEUES.vapiEvent]: 'processing a phone-call event',
  [QUEUES.executeAction]: 'running an action you approved',
  [QUEUES.fireReminder]: 'firing a reminder',
  [QUEUES.agentTask]: 'a background task',
  [QUEUES.watcherPoll]: 'checking a watcher',
  [QUEUES.browserTask]: 'a browser task',
  [QUEUES.smsInbound]: 'handling an incoming text',
  [CRON_QUEUE]: 'a scheduled routine',
}

/* ───────────────────────────── boss lifecycle ────────────────────────────── */

let boss: PgBoss | null = null
let starting: Promise<PgBoss> | null = null
let workersRegistered = false

function buildBoss(): PgBoss {
  const { DATABASE_URL, isProd } = getConfig()
  return new PgBoss({
    connectionString: DATABASE_URL,
    application_name: 'home-assistant-jobs',
    max: 5,
    // Railway Postgres terminates TLS with a self-signed chain — same rule as src/db/client.ts.
    ssl: isProd && !DATABASE_URL.includes('localhost') ? { rejectUnauthorized: false } : undefined,
  })
}

/**
 * The started singleton. Safe to call concurrently; the second caller awaits
 * the first start rather than opening a second pool.
 */
export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss
  if (starting) return starting

  starting = (async () => {
    const instance = buildBoss()
    instance.on('error', (err) => log.error({ err }, 'pg-boss error'))
    instance.on('warning', (warning) => log.warn({ warning }, 'pg-boss warning'))
    await instance.start()

    // Created FIRST: every queue below names this as its deadLetter target, and
    // pg-boss rejects a reference to a queue that does not exist yet — which fails
    // the whole boot on a cold database. Caught by cold-starting against an empty DB.
    // The dead letter queue never retries and never dead-letters onward, or a
    // failing failure-notice would loop. Its jobs are kept a month so the
    // Retry button on an old card still resolves to something.
    await instance.createQueue(DEAD_LETTER_QUEUE, {
      policy: 'standard',
      retryLimit: 0,
      expireInSeconds: 300,
      deleteAfterSeconds: 2_592_000,
      retentionSeconds: 2_592_000,
    })


    for (const spec of QUEUE_SPECS) {
      const options = {
        expireInSeconds: spec.expireInSeconds,
        deleteAfterSeconds: spec.deleteAfterSeconds,
        deadLetter: DEAD_LETTER_QUEUE,
        ...RETRY,
      }
      await instance.createQueue(spec.name, {
        policy: spec.policy ?? 'standard',
        ...options,
        ...(spec.heartbeatSeconds === undefined ? {} : { heartbeatSeconds: spec.heartbeatSeconds }),
      })
      // `createQueue` is `ON CONFLICT DO NOTHING`: on every boot after the
      // first it changes nothing, so an edit to the spec above would never
      // reach a queue that already exists in production. Push it explicitly.
      // The policy is fixed at creation and cannot be updated; everything
      // else can.
      await instance.updateQueue(spec.name, {
        ...options,
        heartbeatSeconds: spec.heartbeatSeconds ?? null,
      })
    }
    boss = instance
    return instance
  })()

  try {
    return await starting
  } finally {
    starting = null
  }
}

/** Creates the queues, registers the workers, and upserts the cron schedules. */
export async function startQueue(): Promise<void> {
  const instance = await getBoss()
  if (!workersRegistered) {
    await registerWorkers(instance)
    workersRegistered = true
  }
  await scheduleHouseholdCrons(instance)

  // browserTask is deliberately excluded: nothing enqueues it today (the browser
  // tools run inline inside their own gated handler), so it is a reserved queue,
  // not a missing wire. Warning about it would train us to ignore this warning.
  const unwired = [QUEUES.watcherPoll].filter((q) => !handlers.has(q))
  if (unwired.length > 0) {
    log.warn(
      { queues: unwired },
      'no handler registered for these queues — call registerJobHandler() from the owning subsystem before startQueue()',
    )
  }
  log.info({ queues: QUEUE_SPECS.map((q) => q.name) }, 'job queue started')
}

/** Stops workers, lets in-flight jobs finish, and closes the pool. */
export async function stopQueue(): Promise<void> {
  const instance = boss
  if (!instance) return
  boss = null
  workersRegistered = false
  try {
    await instance.stop({ graceful: true, close: true, timeout: 30_000 })
    log.info('job queue stopped')
  } catch (err) {
    log.error({ err }, 'failed to stop pg-boss cleanly')
  }
}

/* ──────────────────────────── handler registry ───────────────────────────── */

export type JobHandler<T> = (data: T, job: Job<T>) => Promise<void>

const handlers = new Map<string, JobHandler<Record<string, unknown>>>()

/**
 * Plug a handler into one of the queues this module does not own
 * (`watcher-poll`, `browser-task`). Call it from the owning subsystem's module
 * — or from `src/index.ts` — **before** `startQueue()`.
 */
export function registerJobHandler<T extends object>(queue: string, handler: JobHandler<T>): void {
  handlers.set(queue, handler as unknown as JobHandler<Record<string, unknown>>)
  log.info({ queue }, 'job handler registered')
}

/** True when something has claimed this queue. Crons use it to avoid enqueuing into a void. */
export function hasJobHandler(queue: string): boolean {
  return handlers.has(queue)
}

async function dispatch(queue: string, data: Record<string, unknown>, job: Job): Promise<void> {
  const handler = handlers.get(queue)
  if (!handler) {
    await audit({
      actor: 'system',
      event: 'job.unhandled',
      toolName: queue,
      args: data,
      resultSummary: `No handler registered for queue "${queue}".`,
      ok: false,
    })
    throw new Error(
      `No handler registered for queue "${queue}". Call registerJobHandler('${queue}', fn) before startQueue().`,
    )
  }
  await handler(data, job as Job<Record<string, unknown>>)
}

/* ───────────────────────────── worker plumbing ───────────────────────────── */

/**
 * Runs every job in a fetched batch independently, so one bad payload cannot
 * take its neighbours down with it, then rethrows the first failure so pg-boss
 * still retries and eventually dead-letters.
 */
async function eachJob<J>(jobs: J[], fn: (job: J) => Promise<void>): Promise<void> {
  const settled = await Promise.allSettled(jobs.map((job) => fn(job)))
  const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (rejected.length === 0) return
  const first = rejected[0]
  throw first ? first.reason : new Error('job batch failed')
}

async function registerWorkers(instance: PgBoss): Promise<void> {
  // Telegram turns: parallel across chats, serialised within one chat by the
  // queue's `singleton` policy plus the per-chat singleton key set on send.
  await instance.work<TelegramUpdatePayload>(
    QUEUES.tgUpdate,
    { localConcurrency: 4, batchSize: 1, pollingIntervalSeconds: 1 },
    (jobs) =>
      eachJob(jobs, async (job) => {
        await handleTelegramUpdate(job.data?.update)
      }),
  )

  await instance.work<VapiEventPayload>(
    QUEUES.vapiEvent,
    { localConcurrency: 2, batchSize: 1, pollingIntervalSeconds: 2 },
    (jobs) =>
      eachJob(jobs, async (job) => {
        await handleVapiEvent(job.data?.payload)
      }),
  )

  // Concurrency 1: an inbound text mutates its thread's message count, and the
  // cap is the safety boundary. Two replies racing it is exactly the bug that
  // would hand a thread more messages than it was approved for.
  await instance.work<SmsInboundPayload>(
    QUEUES.smsInbound,
    { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 1 },
    (jobs) =>
      eachJob(jobs, async (job) => {
        const { handleInboundSms } = await import('./handle-sms-inbound.js')
        await handleInboundSms(job.data)
      }),
  )

  // Concurrency 1: approved actions run one at a time, in order, so two
  // approvals tapped seconds apart cannot race on the same calendar or inbox.
  await instance.work<ExecuteActionPayload>(
    QUEUES.executeAction,
    { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 1 },
    (jobs) =>
      eachJob(jobs, async (job) => {
        const pendingActionId = job.data?.pendingActionId
        if (!Number.isInteger(pendingActionId)) {
          log.warn({ data: job.data }, 'execute-action job has no pending action id')
          return
        }
        const { ok, summary } = await executeApprovedAction(pendingActionId)
        log.info({ pendingActionId, ok }, summary)
      }),
  )

  await instance.work<FireReminderPayload>(
    QUEUES.fireReminder,
    { localConcurrency: 4, batchSize: 1, pollingIntervalSeconds: 2 },
    (jobs) =>
      eachJob(jobs, async (job) => {
        await fireReminder(job.data)
      }),
  )

  await instance.work<AgentTaskPayload>(
    QUEUES.agentTask,
    { localConcurrency: 2, batchSize: 1, pollingIntervalSeconds: 2 },
    (jobs) => eachJob(jobs, async (job) => runAgentTask(job.data)),
  )

  await instance.work<Record<string, unknown>>(
    QUEUES.watcherPoll,
    { localConcurrency: 2, batchSize: 1, pollingIntervalSeconds: 5 },
    (jobs) => eachJob(jobs, async (job) => dispatch(QUEUES.watcherPoll, job.data ?? {}, job)),
  )

  await instance.work<Record<string, unknown>>(
    QUEUES.browserTask,
    { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 5 },
    (jobs) => eachJob(jobs, async (job) => dispatch(QUEUES.browserTask, job.data ?? {}, job)),
  )

  await instance.work<CronPayload>(
    CRON_QUEUE,
    { localConcurrency: 2, batchSize: 1, pollingIntervalSeconds: 5 },
    (jobs) =>
      eachJob(jobs, async (job) => {
        await runCronTask(job.data?.task ?? '')
      }),
  )

  await instance.work<Record<string, unknown>>(
    DEAD_LETTER_QUEUE,
    { localConcurrency: 1, batchSize: 1, includeMetadata: true, pollingIntervalSeconds: 5 },
    (jobs) => eachJob(jobs, announceDeadLetter),
  )
}

/* ───────────────────────────── job payloads ──────────────────────────────── */

/**
 * What `src/http/telegram-webhook.ts` puts on the queue. Only `update` is load
 * bearing — the worker replays it through grammY — but the envelope the
 * ingress already computed is carried along for logging and for any future
 * consumer that would otherwise re-derive it.
 */
export interface TelegramUpdatePayload {
  update: Update
  updateId?: number | null
  chatId?: string
  fromId?: string
  actor?: string
  text?: string | null
  callbackData?: string | null
  callbackQueryId?: string | null
  messageId?: number | null
  receivedAt?: string
}

export interface SmsInboundPayload {
  from?: string
  body?: string
  sid?: string
}

export interface VapiEventPayload {
  payload: unknown
}

export interface ExecuteActionPayload {
  pendingActionId: number
}

export interface FireReminderPayload {
  reminderId: number
}

export interface CronPayload {
  task: string
}

/** A background turn: the model is handed a prompt and narrates the outcome itself. */
export interface AgentTaskPayload {
  prompt: string
  /** Falls back to the household's primary chat when omitted. */
  chatId?: string
  actor?: string
  trigger?: 'chat' | 'cron' | 'approval' | 'watcher' | 'call' | 'workflow'
  systemAppend?: string
  resume?: boolean
  maxTurns?: number
  origin?: ToolOrigin
}

async function runAgentTask(data: AgentTaskPayload): Promise<void> {
  const chatId = data.chatId ?? (await primaryChatId())
  if (!chatId) {
    log.warn({ trigger: data.trigger }, 'agent task dropped: no chat to answer in')
    return
  }
  const result = await runTurn({
    chatId,
    actor: data.actor ?? 'system',
    prompt: data.prompt,
    trigger: data.trigger ?? 'workflow',
    systemAppend: data.systemAppend,
    resume: data.resume ?? true,
    maxTurns: data.maxTurns,
    origin: data.origin ?? 'agent',
  })
  log.info(
    { trigger: data.trigger, ok: result.ok, costUsd: result.costUsd },
    'agent task turn finished',
  )
  if (!result.ok) throw new Error(`agent task turn failed: ${result.text.slice(0, 200)}`)
}

/* ──────────────────────────── enqueue helpers ────────────────────────────── */

/**
 * Queue one Telegram update.
 *
 * The webhook route builds a richer envelope and sends it itself; this helper
 * exists for the paths that only hold an update (long polling, a replay). The
 * per-chat singleton key must match the one the webhook uses — it is what makes
 * turns for a single chat serialise.
 */
export async function enqueueTelegramUpdate(update: Update): Promise<string | null> {
  const chatId = telegramChatIdOf(update) ?? 'unknown'
  const instance = await getBoss()
  return instance.send(
    QUEUES.tgUpdate,
    {
      update,
      updateId: update.update_id ?? null,
      chatId,
      receivedAt: new Date().toISOString(),
    } satisfies TelegramUpdatePayload,
    { singletonKey: `chat:${chatId}` },
  )
}

export async function enqueueVapiEvent(payload: unknown): Promise<string | null> {
  const instance = await getBoss()
  return instance.send(QUEUES.vapiEvent, { payload } satisfies VapiEventPayload)
}

export async function enqueueExecuteAction(pendingActionId: number): Promise<string | null> {
  const instance = await getBoss()
  return instance.send(QUEUES.executeAction, {
    pendingActionId,
  } satisfies ExecuteActionPayload)
}

export async function enqueueAgentTask(payload: AgentTaskPayload): Promise<string | null> {
  const instance = await getBoss()
  return instance.send(QUEUES.agentTask, payload)
}

/** Schedules a reminder to fire at `fireAt`. Returns the pg-boss job id to store on the row. */
export async function enqueueReminder(reminderId: number, fireAt: Date): Promise<string | null> {
  const instance = await getBoss()
  return instance.sendAfter(
    QUEUES.fireReminder,
    { reminderId } satisfies FireReminderPayload,
    null,
    fireAt,
  )
}

export async function enqueueWatcherPoll(
  watcherId: number,
  data: Record<string, unknown> = {},
): Promise<string | null> {
  const instance = await getBoss()
  return instance.send(
    QUEUES.watcherPoll,
    { watcherId, ...data },
    { singletonKey: `watcher-${watcherId}` },
  )
}

export async function enqueueBrowserTask(
  key: string,
  data: Record<string, unknown>,
): Promise<string | null> {
  const instance = await getBoss()
  return instance.send(QUEUES.browserTask, data, { singletonKey: `browser-${key}` })
}

/* ─────────────────────────── dead letter handling ────────────────────────── */

function describeJobError(output: unknown): string {
  if (output === null || output === undefined) return 'no error detail was recorded'
  if (typeof output === 'string') return output
  if (typeof output !== 'object') return String(output)
  const o = output as Record<string, unknown>
  if (typeof o.message === 'string' && o.message.trim()) return o.message.trim()
  if (typeof o.value === 'string' && o.value.trim()) return o.value.trim()
  try {
    return JSON.stringify(o).slice(0, 400)
  } catch {
    return 'the error could not be serialised'
  }
}

/**
 * Runs once per permanently failed job. Writes the audit row and tells the
 * household, with a Retry button carrying `dlq:<deadLetterJobId>:retry` —
 * handled by `registerCallbackHandlers` in src/telegram/approvals.ts, which
 * calls `retryDeadLetterJob` below.
 */
async function announceDeadLetter(job: Job<Record<string, unknown>>): Promise<void> {
  // The worker sets `includeMetadata: true`, so sourceName / sourceId / output
  // are all present at runtime. pg-boss only widens the handler's job type when
  // it can infer the options object, which passing an explicit payload type
  // argument prevents — hence the narrowing here rather than in the signature.
  const meta = job as JobWithMetadata<Record<string, unknown>>
  const sourceQueue = meta.sourceName ?? 'unknown'
  const reason = describeJobError(meta.output)
  const label = QUEUE_LABELS[sourceQueue] ?? `the "${sourceQueue}" queue`

  log.error(
    { deadLetterJobId: job.id, sourceQueue, sourceJobId: meta.sourceId, reason },
    'job dead-lettered',
  )

  await audit({
    actor: 'system',
    event: 'job.dead_letter',
    toolName: sourceQueue,
    args: job.data,
    resultSummary: `Gave up after ${RETRY.retryLimit} retries: ${reason}`.slice(0, 1000),
    ok: false,
  })

  const text = [
    `⚠️ Something went wrong ${label} and I gave up after ${RETRY.retryLimit} retries.`,
    '',
    reason.slice(0, 500),
    '',
    'Nothing has been retried automatically. Tap Retry if you want me to try once more.',
  ].join('\n')

  try {
    await sendToAll(text, {
      replyMarkup: {
        inline_keyboard: [[{ text: '🔁 Retry', callback_data: `dlq:${job.id}:retry` }]],
      },
    })
  } catch (err) {
    // The audit row is already written; a failed notice must not re-fail the DLQ job.
    log.error({ err, deadLetterJobId: job.id }, 'failed to send dead-letter notice')
  }
}

/**
 * Re-runs a dead-lettered job. Called by the `dlq:<jobId>:retry` callback.
 *
 * Prefers resurrecting the original failed row so its id and history survive;
 * falls back to re-sending the stored payload when that row has already aged
 * out of its queue.
 */
export async function retryDeadLetterJob(
  deadLetterJobId: string,
): Promise<{ ok: boolean; message: string }> {
  if (!deadLetterJobId) return { ok: false, message: 'No job id on that button.' }

  const instance = await getBoss()
  let record: JobWithMetadata<Record<string, unknown>> | undefined
  try {
    const found = await instance.findJobs<Record<string, unknown>>(DEAD_LETTER_QUEUE, {
      id: deadLetterJobId,
    })
    record = found[0]
  } catch (err) {
    log.error({ err, deadLetterJobId }, 'dead-letter lookup failed')
    return { ok: false, message: 'I could not look that failed job up.' }
  }

  if (!record) return { ok: false, message: 'That failed job is no longer on file.' }

  const sourceQueue = record.sourceName
  if (!sourceQueue) {
    return { ok: false, message: 'That failed job has no source queue recorded, so I cannot replay it.' }
  }

  let replayedId: string | null = null
  if (record.sourceId) {
    try {
      const response = (await instance.retry(sourceQueue, record.sourceId)) as { affected?: number }
      if ((response.affected ?? 0) > 0) replayedId = record.sourceId
    } catch (err) {
      log.warn({ err, deadLetterJobId, sourceQueue }, 'in-place retry failed; re-sending payload')
    }
  }

  if (!replayedId) {
    try {
      replayedId = await instance.send(sourceQueue, record.data ?? {})
    } catch (err) {
      log.error({ err, deadLetterJobId, sourceQueue }, 'dead-letter replay failed')
      return { ok: false, message: 'I could not requeue that job.' }
    }
  }

  await audit({
    actor: 'system',
    event: 'job.retried',
    toolName: sourceQueue,
    args: record.data,
    resultSummary: `Requeued dead-lettered job ${deadLetterJobId} as ${replayedId ?? 'unknown'}`,
    ok: true,
  })
  log.info({ deadLetterJobId, sourceQueue, replayedId }, 'dead-lettered job requeued')

  return { ok: true, message: `Requeued — I will try ${QUEUE_LABELS[sourceQueue] ?? sourceQueue} again.` }
}
