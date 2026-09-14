/**
 * The dry run.
 *
 * `DRY_RUN_CALLS=true` is not a mode where less happens — it is a mode where
 * everything happens except the dialling. A dry run that quietly skipped the
 * queue, the report handler, or the narration would be testing a code path that
 * production never runs, which is worse than no dry run at all.
 *
 * So the properties pinned here are:
 *   1. the Vapi HTTP client is never constructed and never called;
 *   2. a real `call_records` row is written, carrying the synthetic call id;
 *   3. the simulated report goes onto the same `vapi-event` queue a webhook
 *      feeds, in the same job shape;
 *   4. handing that job to the *real* `handleVapiEvent` completes the record
 *      and queues the narration turn, with the transcript fenced as untrusted;
 *   5. a redelivery of the same report changes nothing.
 *
 * The fake database renders every `where` clause with drizzle's own dialect and
 * evaluates it against the stored rows, so a guard dropped from the production
 * code (the `ended_at IS NULL` idempotency check, say) fails these tests rather
 * than passing them by accident.
 */
import { getTableColumns, getTableName } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../src/db/schema.js'
import type { ToolContext } from '../src/tools/types.js'

/* ══════════════════════════════ the fake database ═════════════════════════ */

const dialect = new PgDialect()

type Row = Record<string, unknown>

const TABLES = {
  households: schema.households,
  contacts: schema.contacts,
  call_records: schema.callRecords,
  conversations: schema.conversations,
}

/** db column name -> drizzle property name, per table. */
const KEY_MAP: Record<string, Record<string, string>> = {}
/** every drizzle property name, per table, so inserts can fill the gaps with null. */
const ALL_KEYS: Record<string, string[]> = {}

for (const [name, table] of Object.entries(TABLES)) {
  const columns = getTableColumns(table)
  KEY_MAP[name] = Object.fromEntries(Object.entries(columns).map(([key, col]) => [col.name, key]))
  ALL_KEYS[name] = Object.keys(columns)
}

function stripOuterParens(text: string): string {
  let s = text.trim()
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0
    let wraps = true
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++
      else if (s[i] === ')') depth--
      if (depth === 0 && i < s.length - 1) {
        wraps = false
        break
      }
    }
    if (!wraps) break
    s = s.slice(1, -1).trim()
  }
  return s
}

function literal(token: string, params: unknown[]): unknown {
  const t = token.trim()
  if (/^\$\d+$/.test(t)) return params[Number(t.slice(1)) - 1]
  if (t === 'null') return null
  if (t === 'true') return true
  if (t === 'false') return false
  if (t === 'now()') return new Date()
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  const quoted = /^'(.*)'$/.exec(t)
  if (quoted) return quoted[1]
  throw new Error(`fake db: unsupported SQL literal ${token}`)
}

const CLAUSE = /^"(\w+)"\."(\w+)"\s+(=|<>|!=|>=|<=|>|<|is not|is)\s+(.+)$/i

function normalizeValue(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value
}

function evalClause(clause: string, params: unknown[], row: Row): boolean {
  const m = CLAUSE.exec(clause.trim())
  if (!m) throw new Error(`fake db: unsupported SQL clause "${clause}"`)
  const [, table, colName, rawOp, rhs] = m
  const map = KEY_MAP[table ?? '']
  if (!map) throw new Error(`fake db: unknown table ${table}`)
  const key = map[colName ?? '']
  if (!key) throw new Error(`fake db: unknown column ${table}.${colName}`)

  const op = (rawOp ?? '').toLowerCase()
  const left = row[key]
  const right = (rhs ?? '').trim()

  switch (op) {
    case 'is':
      return right === 'null' ? left === null || left === undefined : false
    case 'is not':
      return right === 'null' ? left !== null && left !== undefined : false
    case '=':
      return normalizeValue(left) === normalizeValue(literal(right, params))
    case '<>':
    case '!=':
      return normalizeValue(left) !== normalizeValue(literal(right, params))
    case '>':
      return Number(normalizeValue(left)) > Number(normalizeValue(literal(right, params)))
    case '<':
      return Number(normalizeValue(left)) < Number(normalizeValue(literal(right, params)))
    case '>=':
      return Number(normalizeValue(left)) >= Number(normalizeValue(literal(right, params)))
    case '<=':
      return Number(normalizeValue(left)) <= Number(normalizeValue(literal(right, params)))
    default:
      throw new Error(`fake db: unsupported operator ${op}`)
  }
}

function matches(where: SQL | undefined, row: Row): boolean {
  if (!where) return true
  const query = dialect.sqlToQuery(where)
  return stripOuterParens(query.sql)
    .split(/\s+and\s+/i)
    .every((clause) => evalClause(clause, query.params as unknown[], row))
}

function project(row: Row, selection: Record<string, unknown> | undefined, table: string): Row {
  const copy: Row = { ...row }
  if (!selection) return copy
  const map = KEY_MAP[table] ?? {}
  const out: Row = {}
  for (const [alias, col] of Object.entries(selection)) {
    const name = (col as { name?: string }).name
    const key = name ? map[name] : undefined
    if (!key) throw new Error(`fake db: cannot map selected field ${alias}`)
    out[alias] = copy[key]
  }
  return out
}

type Runner = () => Row[]

function thenable<T extends object>(run: Runner, extra: T): T & PromiseLike<Row[]> {
  return Object.assign(extra, {
    then<A, B>(
      onOk?: ((rows: Row[]) => A | PromiseLike<A>) | null,
      onErr?: ((reason: unknown) => B | PromiseLike<B>) | null,
    ) {
      return Promise.resolve()
        .then(run)
        .then(onOk ?? undefined, onErr ?? undefined)
    },
  }) as T & PromiseLike<Row[]>
}

class FakeDb {
  rows: Record<string, Row[]> = {
    households: [],
    contacts: [],
    call_records: [],
    conversations: [],
  }
  private nextId = 1

  seed(table: string, row: Row): Row {
    const stored = this.blank(table)
    Object.assign(stored, row)
    if (stored.id === null) stored.id = this.nextId++
    ;(this.rows[table] ??= []).push(stored)
    return stored
  }

  private blank(table: string): Row {
    const out: Row = {}
    for (const key of ALL_KEYS[table] ?? []) out[key] = null
    out.createdAt = new Date()
    return out
  }

  insert(table: object) {
    const name = getTableName(table as Parameters<typeof getTableName>[0])
    return {
      values: (values: Row) => {
        const run = (selection?: Record<string, unknown>): Row[] => {
          const stored = this.blank(name)
          stored.id = this.nextId++
          for (const [key, value] of Object.entries(values)) {
            if (value !== undefined) stored[key] = value
          }
          ;(this.rows[name] ??= []).push(stored)
          return [project(stored, selection, name)]
        }
        return thenable(() => run(undefined), {
          returning: (selection?: Record<string, unknown>) => thenable(() => run(selection), {}),
        })
      },
    }
  }

  update(table: object) {
    const name = getTableName(table as Parameters<typeof getTableName>[0])
    return {
      set: (values: Row) => ({
        where: (where?: SQL) => {
          const run = (selection?: Record<string, unknown>): Row[] => {
            const hit = (this.rows[name] ?? []).filter((row) => matches(where, row))
            for (const row of hit) {
              for (const [key, value] of Object.entries(values)) {
                if (value !== undefined) row[key] = value
              }
            }
            return hit.map((row) => project(row, selection, name))
          }
          return thenable(() => run(undefined), {
            returning: (selection?: Record<string, unknown>) => thenable(() => run(selection), {}),
          })
        },
      }),
    }
  }

  select(fields?: Record<string, unknown>) {
    return {
      from: (table: object) => {
        const name = getTableName(table as Parameters<typeof getTableName>[0])
        let where: SQL | undefined
        let limit: number | undefined
        const run = (): Row[] => {
          let hit = (this.rows[name] ?? []).filter((row) => matches(where, row))
          if (limit !== undefined) hit = hit.slice(0, limit)
          return hit.map((row) => project(row, fields, name))
        }
        const builder: Record<string, unknown> = {}
        const api = thenable(run, builder)
        Object.assign(builder, {
          where: (w?: SQL) => {
            where = w
            return api
          },
          orderBy: () => api,
          limit: (n: number) => {
            limit = n
            return api
          },
        })
        return api
      },
    }
  }
}

/* ══════════════════════════════════ mocks ═════════════════════════════════ */

interface SentJob {
  queue: string
  data: Record<string, unknown>
  afterSeconds?: number
}

const H = vi.hoisted(() => ({
  db: null as unknown,
  approved: true,
  sent: [] as Array<{ queue: string; data: Record<string, unknown>; afterSeconds?: number }>,
  agentTasks: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  vapiCtor: vi.fn(),
  vapiCreate: vi.fn(async () => ({ id: 'should-never-happen' })),
  vapiPhoneNumberGet: vi.fn(async () => ({ number: '+14155551000' })),
  config: {} as Record<string, unknown>,
}))

vi.mock('@vapi-ai/server-sdk', () => ({
  VapiClient: class {
    calls = { create: H.vapiCreate }
    phoneNumbers = { get: H.vapiPhoneNumberGet }
    constructor(options: unknown) {
      H.vapiCtor(options)
    }
  },
}))

vi.mock('../src/config.js', () => ({ getConfig: () => H.config }))

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const l: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop }
  l.child = () => l
  return { logger: l, child: () => l }
})

vi.mock('../src/audit/log.js', () => ({
  audit: async (entry: Record<string, unknown>) => {
    H.audits.push(entry)
  },
}))

vi.mock('../src/policy/pending.js', () => ({ hasApprovedAction: async () => H.approved }))

vi.mock('../src/db/client.js', async () => {
  const realSchema = await vi.importActual<typeof import('../src/db/schema.js')>(
    '../src/db/schema.js',
  )
  return {
    getDb: () => H.db,
    getPool: () => ({}),
    closeDb: async () => {},
    schema: realSchema,
  }
})

vi.mock('../src/jobs/queue.js', () => ({
  QUEUES: {
    tgUpdate: 'tg-update',
    vapiEvent: 'vapi-event',
    executeAction: 'execute-action',
    fireReminder: 'fire-reminder',
    agentTask: 'agent-task',
    watcherPoll: 'watcher-poll',
    browserTask: 'browser-task',
  },
  getBoss: async () => ({
    send: async (queue: string, data: Record<string, unknown>) => {
      H.sent.push({ queue, data })
      return 'job-immediate'
    },
    sendAfter: async (
      queue: string,
      data: Record<string, unknown>,
      _options: unknown,
      after: number,
    ) => {
      H.sent.push({ queue, data, afterSeconds: after })
      return 'job-delayed'
    },
  }),
  enqueueAgentTask: async (payload: Record<string, unknown>) => {
    H.agentTasks.push(payload)
    return 'job-agent'
  },
}))

/* ══════════════════════════════ subject imports ═══════════════════════════ */

const { phonePlaceCall, phoneGetCallResult } = await import('../src/tools/phone.js')
const { handleVapiEvent } = await import('../src/jobs/handle-vapi-event.js')
const { DRY_RUN_REPORT_DELAY_SECONDS, buildTransientAssistant, buildStructuredDataSchema } =
  await import('../src/integrations/vapi.js')

/* ════════════════════════════════ harness ═════════════════════════════════ */

const CONFIG = {
  DRY_RUN_CALLS: true,
  HOUSEHOLD_TIMEZONE: 'America/Los_Angeles',
  APP_URL: 'https://house.example.test/',
  VAPI_API_KEY: 'vapi-key',
  VAPI_PHONE_NUMBER_ID: 'pn-1',
  VAPI_WEBHOOK_SECRET: 'vapi-webhook-secret',
  vapiConfigured: true,
}

const ARGS = {
  goal: 'Book a table for four this Friday at seven under the name Smith.',
  callee_number: '(415) 555-2671',
  callee_name: 'Trattoria Esempio',
  context: 'One high chair is needed. Nothing spicy for the children.',
  structured_questions: ['Do you have a high chair?', 'What time is the last seating?'],
}

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  chatId: '4242',
  actor: 'Alex',
  origin: 'executor',
  pendingActionId: 11,
  ...over,
})

let fake: FakeDb

function callRows(): Row[] {
  return fake.rows.call_records ?? []
}

function reportJob(): SentJob | undefined {
  return H.sent.find(
    (job) =>
      job.queue === 'vapi-event' &&
      (job.data as { messageType?: string }).messageType === 'end-of-call-report',
  )
}

beforeEach(() => {
  fake = new FakeDb()
  fake.seed('households', { name: 'Smith', timezone: 'America/Los_Angeles' })
  H.db = fake
  H.approved = true
  H.sent.length = 0
  H.agentTasks.length = 0
  H.audits.length = 0
  H.vapiCtor.mockClear()
  H.vapiCreate.mockClear()
  H.vapiPhoneNumberGet.mockClear()
  H.config = { ...CONFIG }
})

/* ═════════════════════════════════ the tests ══════════════════════════════ */

describe('dry-run call placement', () => {
  it('never touches the Vapi HTTP client', async () => {
    const result = await phonePlaceCall.handler(ARGS, ctx())

    expect(result.isError).toBeUndefined()
    expect(H.vapiCreate).toHaveBeenCalledTimes(0)
    expect(H.vapiPhoneNumberGet).toHaveBeenCalledTimes(0)
    expect(H.vapiCtor).toHaveBeenCalledTimes(0)
  })

  it('writes a real call record carrying the synthetic call id', async () => {
    const result = await phonePlaceCall.handler(ARGS, ctx())

    expect(callRows()).toHaveLength(1)
    const row = callRows()[0]
    expect(row).toMatchObject({
      goal: ARGS.goal,
      calleeName: 'Trattoria Esempio',
      calleeNumber: '+14155552671',
      dryRun: true,
      status: 'in-progress',
      pendingActionId: 11,
    })
    expect(String(row?.vapiCallId)).toMatch(/^dry-run-/)
    expect(result.structuredContent).toMatchObject({
      dryRun: true,
      vapiCallId: row?.vapiCallId,
    })
  })

  it('tells the household plainly that nothing was dialled', async () => {
    const result = await phonePlaceCall.handler(ARGS, ctx())
    const text = result.content.map((p) => p.text).join('\n')

    expect(text).toMatch(/DRY RUN/)
    expect(text).toMatch(/not contacted/i)
  })

  it('persists the call id before the report is queued', async () => {
    await phonePlaceCall.handler(ARGS, ctx())

    // The report is looked up by call id, so the row must already carry it —
    // otherwise the handler would drop the report as unattributed.
    const job = reportJob()
    expect(job).toBeDefined()
    expect(job?.data.callId).toBe(callRows()[0]?.vapiCallId)
  })

  it('queues the simulated report onto the same vapi-event queue a webhook feeds', async () => {
    await phonePlaceCall.handler(ARGS, ctx())

    const job = reportJob()
    expect(job).toBeDefined()
    expect(job?.afterSeconds).toBe(DRY_RUN_REPORT_DELAY_SECONDS)
    expect(job?.data).toMatchObject({
      messageType: 'end-of-call-report',
      callRecordId: callRows()[0]?.id,
    })

    // Same field the real worker reads: job.data.payload.
    const payload = job?.data.payload as { message?: Record<string, unknown> } | undefined
    expect(payload?.message?.type).toBe('end-of-call-report')
  })

  it('makes the synthetic transcript and summary say DRY RUN on their face', async () => {
    await phonePlaceCall.handler(ARGS, ctx())

    const payload = reportJob()?.data.payload as {
      message: { artifact: { transcript: string }; analysis: { summary: string } }
    }
    expect(payload.message.artifact.transcript).toMatch(/DRY RUN/)
    expect(payload.message.analysis.summary).toMatch(/^DRY RUN/)
  })

  it('answers the questions it was asked to bring back', async () => {
    await phonePlaceCall.handler(ARGS, ctx())

    const payload = reportJob()?.data.payload as {
      message: { analysis: { structuredData: Record<string, unknown> } }
    }
    const data = payload.message.analysis.structuredData
    expect(data.outcome).toBe('success')
    expect(Object.keys(data.answers as Record<string, unknown>)).toEqual([
      'do_you_have_a_high_chair',
      'what_time_is_the_last_seating',
    ])
  })

  it('refuses and writes nothing when the action was never approved', async () => {
    H.approved = false

    const result = await phonePlaceCall.handler(ARGS, ctx())

    expect(result.isError).toBe(true)
    expect(callRows()).toHaveLength(0)
    expect(H.sent).toHaveLength(0)
    expect(H.vapiCreate).toHaveBeenCalledTimes(0)
  })
})

describe('the simulated report through the real handler', () => {
  async function placeAndDeliver(): Promise<void> {
    await phonePlaceCall.handler(ARGS, ctx())
    const job = reportJob()
    if (!job) throw new Error('no end-of-call-report was queued')
    await handleVapiEvent(job.data.payload)
  }

  it('completes the call record exactly as a real report would', async () => {
    await placeAndDeliver()

    const row = callRows()[0]
    expect(row?.status).toBe('ended')
    expect(row?.success).toBe(true)
    expect(row?.costUsd).toBe(0)
    expect(row?.endedAt).toBeInstanceOf(Date)
    expect(String(row?.transcript)).toMatch(/DRY RUN/)
    expect(String(row?.summary)).toMatch(/DRY RUN/)
    expect(row?.structuredData).toMatchObject({ outcome: 'success' })
  })

  it('queues the narration turn with the transcript fenced as untrusted', async () => {
    await placeAndDeliver()

    expect(H.agentTasks).toHaveLength(1)
    const prompt = String(H.agentTasks[0]?.prompt)
    expect(prompt).toContain('<untrusted source="vapi:transcript">')
    expect(prompt).toContain('SECURITY NOTICE')
    expect(prompt).toMatch(/DRY RUN/)
    expect(H.agentTasks[0]?.trigger).toBe('call')
  })

  it('asks for a structured report instead of one short message', async () => {
    await placeAndDeliver()
    const prompt = String(H.agentTasks[0]?.prompt)

    expect(prompt).toContain('*Answers*')
    expect(prompt).toContain('*Agreed*')
    expect(prompt).toContain('*Still open*')
    // The instruction that made the reports thin must be gone, not merely
    // outweighed by the new wording.
    expect(prompt).not.toMatch(/one short Telegram message/i)
    expect(prompt).not.toMatch(/do not quote the transcript at length/i)
  })

  it('forbids dropping a question just because it went unanswered', async () => {
    await placeAndDeliver()
    const prompt = String(H.agentTasks[0]?.prompt)

    // The complaint this exists for: a call that failed on payment reported the
    // failure and none of the answers it had actually collected.
    expect(prompt).toMatch(/never drop a question because it went unanswered/i)
    expect(prompt).toMatch(/an unanswered question is information/i)
    expect(prompt).toMatch(/even when the call did not achieve its goal/i)
  })

  it('tells the report to carry specifics and to separate agreed from discussed', async () => {
    await placeAndDeliver()
    const prompt = String(H.agentTasks[0]?.prompt)

    expect(prompt).toMatch(/specifics beat summary/i)
    expect(prompt).toMatch(/cannot point at in the transcript/i)
    expect(prompt).toMatch(/say that first and plainly/i)
    // Household rules stay above the hardcoded shape.
    expect(prompt).toMatch(/household rules[\s\S]*win over the shape/i)
  })

  it('audits the completed call', async () => {
    await placeAndDeliver()

    expect(H.audits.map((a) => a.event)).toContain('call.placed')
    expect(H.audits.map((a) => a.event)).toContain('call.completed')
  })

  it('ignores a redelivery of the same report', async () => {
    await placeAndDeliver()
    const job = reportJob()
    await handleVapiEvent(job?.data.payload)

    // One narration, not two. The `ended_at IS NULL` guard is what does this.
    expect(H.agentTasks).toHaveLength(1)
    expect(H.audits.filter((a) => a.event === 'call.completed')).toHaveLength(1)
  })

  it('reads back through phone_get_call_result with the transcript wrapped', async () => {
    await placeAndDeliver()
    const id = callRows()[0]?.id as number

    const result = await phoneGetCallResult.handler({ call_id: id }, ctx())
    const text = result.content.map((p) => p.text).join('\n')

    expect(result.isError).toBeUndefined()
    expect(text).toContain(`<untrusted source="vapi:transcript:${id}">`)
    expect(text).toContain(`<untrusted source="vapi:structured-data:${id}">`)
    expect(text).toMatch(/DRY RUN/)
    expect(result.structuredContent).toMatchObject({ dryRun: true, status: 'ended' })
  })
})

describe('the transient assistant', () => {
  const input = {
    goal: ARGS.goal,
    householdName: 'Smith',
    calleeName: 'Trattoria Esempio',
    context: ARGS.context,
    structuredQuestions: ARGS.structured_questions,
    callbackNumber: '+14155551000',
    timezone: 'America/Los_Angeles',
    callRecordId: 7,
  }

  it('points the webhook at this deployment and carries the shared secret', () => {
    const assistant = buildTransientAssistant(input) as {
      server: { url: string; headers: Record<string, string> }
      serverMessages: string[]
    }

    expect(assistant.server.url).toBe('https://house.example.test/webhooks/vapi')
    expect(assistant.server.headers['x-vapi-secret']).toBe('vapi-webhook-secret')
    expect(assistant.serverMessages).toEqual(['status-update', 'end-of-call-report'])
  })

  it('states every rule the household depends on', () => {
    const assistant = buildTransientAssistant(input) as {
      model: { messages: Array<{ role: string; content: string }> }
    }
    const prompt = assistant.model.messages[0]?.content ?? ''

    expect(prompt).toContain('on behalf of the Smith household')
    expect(prompt).toContain(ARGS.goal)
    expect(prompt).toMatch(/polite, brief, and natural/i)
    expect(prompt).toMatch(/assistant calling for the Smith family/i)
    expect(prompt).toMatch(/VOICEMAIL/i)
    expect(prompt).toContain('+14155551000')
    expect(prompt).toMatch(/never provide payment card details/i)
    expect(prompt).toMatch(/social security number/i)
    expect(prompt).toMatch(/password, PIN, or one-time code/i)
    expect(prompt).toMatch(/never invent an answer/i)
    expect(prompt).toMatch(/read the details back/i)
  })

  it('lets the model write the opener so the reason lands in the first sentence', () => {
    const assistant = buildTransientAssistant(input) as {
      firstMessageMode: string
      firstMessage: string
      model: { messages: Array<{ role: string; content: string }> }
    }
    const prompt = assistant.model.messages[0]?.content ?? ''

    expect(assistant.firstMessageMode).toBe('assistant-speaks-first-with-model-generated-message')
    expect(prompt).toMatch(/HOW TO OPEN/)
    expect(prompt).toMatch(/who you are, who you are calling for, and what you want/i)
    expect(prompt).toMatch(/never open with/i)
    expect(prompt).toMatch(/do you have a quick moment/i)

    // The fallback still has to disclose on its own, and must not be the
    // withholding opener the prompt forbids.
    expect(assistant.firstMessage).toMatch(/calling for the Smith family/i)
    expect(assistant.firstMessage).not.toMatch(/quick moment/i)
  })

  it('gives her a way to say she does not know, so she does not stall on the question', () => {
    const assistant = buildTransientAssistant(input) as {
      model: { messages: Array<{ role: string; content: string }> }
    }
    const prompt = assistant.model.messages[0]?.content ?? ''

    // Its own section, not a line buried among the credit-card rules. Call #7
    // died on "when do they need those by?" — a question she had no answer to
    // and no way to say so.
    expect(prompt).toMatch(/IF YOU ARE ASKED SOMETHING YOU DO NOT KNOW/)
    expect(prompt).toMatch(/not sure/i)
    expect(prompt).toMatch(/check and come back/i)
    expect(prompt).toMatch(/never invent an answer/i)
  })

  it('tells her not to fill a gap by starting her introduction over', () => {
    const assistant = buildTransientAssistant(input) as {
      model: { messages: Array<{ role: string; content: string }> }
    }
    const prompt = assistant.model.messages[0]?.content ?? ''

    // What reads as a broken robot is her restarting the opener every time she
    // loses the thread, instead of answering what was asked.
    expect(prompt).toMatch(/never repeat your opening/i)
    expect(prompt).toMatch(/answer what was actually asked/i)
  })

  it('does not leave the do-not-know rule sitting in two places to drift apart', () => {
    const assistant = buildTransientAssistant(input) as {
      model: { messages: Array<{ role: string; content: string }> }
    }
    const prompt = assistant.model.messages[0]?.content ?? ''

    expect(prompt.match(/never invent an answer/gi) ?? []).toHaveLength(1)
  })

  it('never claims to be human, however the opener is produced', () => {
    const assistant = buildTransientAssistant(input) as {
      model: { messages: Array<{ role: string; content: string }> }
    }
    const prompt = assistant.model.messages[0]?.content ?? ''

    expect(prompt).toMatch(/never claim to be human/i)
    expect(prompt).toMatch(/never imply you are a member of the family/i)
  })

  it('carries turn-taking plans so it does not answer over people', () => {
    const assistant = buildTransientAssistant(input) as {
      startSpeakingPlan: { waitSeconds: number; smartEndpointingPlan: { provider: string } }
      stopSpeakingPlan: { numWords: number; backoffSeconds: number }
    }

    // livekit endpointing is the SDK's recommendation for English, and the
    // transcriber is pinned to English.
    expect(assistant.startSpeakingPlan.smartEndpointingPlan.provider).toBe('livekit')
    expect(assistant.startSpeakingPlan.waitSeconds).toBeGreaterThan(0.4)
    // numWords 0 would let a cough cut her off mid-sentence.
    expect(assistant.stopSpeakingPlan.numWords).toBeGreaterThan(0)
    expect(assistant.stopSpeakingPlan.backoffSeconds).toBeGreaterThan(1)
  })

  it('does not share nested plan objects between calls', () => {
    const a = buildTransientAssistant(input) as {
      startSpeakingPlan: { smartEndpointingPlan: Record<string, unknown> }
    }
    const b = buildTransientAssistant(input) as {
      startSpeakingPlan: { smartEndpointingPlan: Record<string, unknown> }
    }
    expect(a.startSpeakingPlan.smartEndpointingPlan).not.toBe(
      b.startSpeakingPlan.smartEndpointingPlan,
    )
  })

  it('carries an analysis plan whose schema always has an outcome and a summary', () => {
    const assistant = buildTransientAssistant(input) as {
      analysisPlan: { structuredDataPlan: { enabled: boolean; schema: Record<string, unknown> } }
    }
    const plan = assistant.analysisPlan.structuredDataPlan
    const properties = plan.schema.properties as Record<string, { enum?: string[] }>

    expect(plan.enabled).toBe(true)
    expect(plan.schema.required).toEqual(['outcome', 'summary'])
    expect(properties.outcome?.enum).toEqual([
      'success',
      'partial',
      'failed',
      'voicemail',
      'no_answer',
    ])
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining([
        'summary',
        'booking_date',
        'booking_time',
        'party_size',
        'confirmation_name',
      ]),
    )
  })

  it('keeps a question named after a reserved field from colliding with it', () => {
    const built = buildStructuredDataSchema(['What is the outcome?', 'What is the summary?'])
    const properties = built.properties as Record<string, { properties?: Record<string, unknown> }>

    expect(properties.outcome).toBeDefined()
    expect(Object.keys(properties.answers?.properties ?? {})).toEqual([
      'what_is_the_outcome',
      'what_is_the_summary',
    ])
  })

  it('carries a voice its provider will actually accept', () => {
    const assistant = buildTransientAssistant(input) as {
      voice: Record<string, unknown>
    }

    // `version` belongs to the `vapi` provider and `model` to `11labs`. Carrying
    // the wrong one is not a type error and does not fail until a call is live.
    expect(assistant.voice.provider).toBe('11labs')
    expect(assistant.voice.voiceId).toBe('XrExE9yKIg1WjnnlVkGX')
    expect(assistant.voice.model).toMatch(/^eleven_/)
    expect(assistant.voice.version).toBeUndefined()
  })

  it('records no audio, because nobody on the other end consented to being recorded', () => {
    const assistant = buildTransientAssistant(input) as {
      artifactPlan: { recordingEnabled: boolean }
    }
    expect(assistant.artifactPlan.recordingEnabled).toBe(false)
  })

  it('places the call in silence, not in a fake open-plan office', () => {
    const assistant = buildTransientAssistant(input) as { backgroundSound: string }

    // Vapi defaults phone calls to `office` ambience. A household assistant
    // calling a clinic should not sound like it is dialling from a call centre.
    expect(assistant.backgroundSound).toBe('off')
  })

  it('carries a voicemail message so a detected machine is never met with silence', () => {
    const assistant = buildTransientAssistant({
      ...input,
      assistantName: 'Chessy',
    }) as { voicemailMessage: string }

    // Who is calling, what for, and where to call back — the same three things
    // the prompt's voicemail branch asks for, minus the model's involvement.
    expect(assistant.voicemailMessage).toMatch(/Chessy/)
    expect(assistant.voicemailMessage).toMatch(/Smith family/i)
    expect(assistant.voicemailMessage).toMatch(/table for four/i)
    expect(assistant.voicemailMessage).toContain('+14155551000')
  })

  it('still leaves a usable message when it does not know its own callback number', () => {
    const { callbackNumber, ...withoutNumber } = input
    const assistant = buildTransientAssistant({
      ...withoutNumber,
      assistantName: 'Chessy',
    }) as { voicemailMessage: string }

    expect(assistant.voicemailMessage).toMatch(/Chessy/)
    expect(assistant.voicemailMessage).toMatch(/table for four/i)
    expect(assistant.voicemailMessage).not.toMatch(/undefined|null/)
  })

  it('introduces itself unnamed in the voicemail when the household has not named it', () => {
    const assistant = buildTransientAssistant({
      ...input,
      assistantName: '',
    }) as { voicemailMessage: string }

    expect(assistant.voicemailMessage).toMatch(/an assistant calling for the Smith family/i)
    expect(assistant.voicemailMessage).not.toMatch(/undefined/)
  })

  it('leaves the request on the machine without reading its own briefing aloud', () => {
    const assistant = buildTransientAssistant({
      ...input,
      assistantName: 'Chessy',
      goal:
        "Order 8 hotdogs to be mailed to the household's address, which the " +
        'recipient already has on file. Confirm the order and mailing details. If it goes to ' +
        'voicemail again, leave a message with this order request and ask them to call back.',
    }) as { voicemailMessage: string }

    // The goal is written to her, not to the recipient. The request is the part
    // a stranger should hear; the rest is stage directions.
    expect(assistant.voicemailMessage).toMatch(/order 8 hotdogs/i)
    expect(assistant.voicemailMessage).not.toMatch(/confirm the order and mailing details/i)
    expect(assistant.voicemailMessage).not.toMatch(/if it goes to voicemail/i)
    expect(assistant.voicemailMessage).not.toMatch(/leave a message/i)
  })

  it('keeps a one-sentence goal whole', () => {
    const assistant = buildTransientAssistant({
      ...input,
      assistantName: 'Chessy',
    }) as { voicemailMessage: string }

    expect(assistant.voicemailMessage).toMatch(/book a table for four this Friday at seven/i)
  })

  it('does not cut a request in half at an abbreviation', () => {
    const assistant = buildTransientAssistant({
      ...input,
      assistantName: 'Chessy',
      goal: 'Call Dr. Weiss about the rash.',
    }) as { voicemailMessage: string }

    expect(assistant.voicemailMessage).toMatch(/Dr\. Weiss about the rash/i)
    // "I'm calling to call Dr. Weiss" is how she sounds broken.
    expect(assistant.voicemailMessage).not.toMatch(/calling to call/i)
  })

  it('does not sit in silence for half a minute waiting for a beep that never comes', () => {
    const assistant = buildTransientAssistant(input) as {
      voicemailDetection: { beepMaxAwaitSeconds: number }
    }

    // iPhone Live Voicemail screens the call and never beeps. Every second of
    // this window is dead air on the other end when detection misfires.
    expect(assistant.voicemailDetection.beepMaxAwaitSeconds).toBeLessThanOrEqual(15)
  })
})
