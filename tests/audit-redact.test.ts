import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The audit module talks to Postgres and pino. Both are stubbed so these tests
 * exercise only the redaction, truncation, and never-throw behaviour.
 */
const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  failInsert: false,
  failLogger: false,
  errors: [] as unknown[][],
}))

vi.mock('../src/db/client.js', () => ({
  schema: { auditLog: { _: 'audit_log' } },
  getDb: () => ({
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        if (h.failInsert) throw new Error('connection terminated unexpectedly')
        h.rows.push(row)
      },
    }),
  }),
}))

vi.mock('../src/logger.js', () => {
  const fn = (...args: unknown[]) => {
    h.errors.push(args)
    if (h.failLogger) throw new Error('log transport closed')
  }
  const log = { error: fn, warn: fn, info: fn, debug: fn, trace: fn, fatal: fn }
  return { logger: log, child: () => log }
})

import { audit, prepareArgsJson, redactArgs } from '../src/audit/log.js'

function lastRow(): Record<string, unknown> {
  const row = h.rows[h.rows.length - 1]
  if (!row) throw new Error('test: no audit row was written')
  return row
}

beforeEach(() => {
  h.rows.length = 0
  h.errors.length = 0
  h.failInsert = false
  h.failLogger = false
})

/** Matches the `\udXXX` escape `JSON.stringify` emits for an unpaired surrogate. */
const LONE_SURROGATE_ESCAPE = /\\ud[89ab][0-9a-f]{2}/i

describe('redaction', () => {
  it('redacts every matching key at every depth', async () => {
    await audit({
      actor: 'Alex',
      event: 'tool.execute',
      args: {
        token: 'tok-1',
        access_token: 'tok-2',
        refreshToken: 'tok-3',
        refresh: 'tok-4',
        password: 'hunter2',
        client_secret: 'shh',
        apiKey: 'ak-1',
        api_key: 'ak-2',
        'api-key': 'ak-3',
        Authorization: 'Bearer abc',
        nested: {
          level2: {
            SECRET_VALUE: 'nope',
            keep: 'visible',
            level3: [{ userToken: 'tok-5' }, { plain: 'fine' }],
          },
        },
        list: [{ password: 'p1' }, 'a bare string', 42],
      },
    })

    const argsJson = lastRow().argsJson as Record<string, unknown>
    const flat = JSON.stringify(argsJson)

    for (const leaked of [
      'tok-1',
      'tok-2',
      'tok-3',
      'tok-4',
      'hunter2',
      'shh',
      'ak-1',
      'ak-2',
      'ak-3',
      'Bearer abc',
      'nope',
      'tok-5',
      'p1',
    ]) {
      expect(flat).not.toContain(leaked)
    }

    expect(argsJson.token).toBe('[redacted]')
    expect(argsJson.Authorization).toBe('[redacted]')

    const nested = argsJson.nested as { level2: Record<string, unknown> }
    expect(nested.level2.keep).toBe('visible')
    expect(nested.level2.SECRET_VALUE).toBe('[redacted]')
    expect(nested.level2.level3).toEqual([{ userToken: '[redacted]' }, { plain: 'fine' }])

    expect(argsJson.list).toEqual([{ password: '[redacted]' }, 'a bare string', 42])
  })

  it('leaves non-matching keys and non-object args alone', () => {
    expect(redactArgs({ title: 'Buy milk', count: 3, done: false, missing: null })).toEqual({
      title: 'Buy milk',
      count: 3,
      done: false,
      missing: null,
    })
    expect(redactArgs('a plain string')).toBe('a plain string')
    expect(redactArgs(7)).toBe(7)
    expect(redactArgs(null)).toBe(null)
  })

  it('survives circular references', () => {
    const cyclic: Record<string, unknown> = { name: 'loop', token: 'tok' }
    cyclic.self = cyclic
    const out = redactArgs(cyclic) as Record<string, unknown>
    expect(out.name).toBe('loop')
    expect(out.token).toBe('[redacted]')
    expect(out.self).toBe('[circular]')
    expect(() => JSON.stringify(out)).not.toThrow()
  })

  it('does not collapse repeated (non-cyclic) siblings', () => {
    const shared = { keep: 'yes' }
    expect(redactArgs({ a: shared, b: shared })).toEqual({ a: { keep: 'yes' }, b: { keep: 'yes' } })
  })
})

describe('truncation', () => {
  it('stores oversized args as a truncation stub', async () => {
    await audit({
      actor: 'system',
      event: 'gmail.fetch',
      args: { body: 'x'.repeat(30_000) },
    })

    const argsJson = lastRow().argsJson as { _truncated?: boolean; preview?: string }
    expect(argsJson._truncated).toBe(true)
    expect(typeof argsJson.preview).toBe('string')
    expect((argsJson.preview as string).length).toBeLessThanOrEqual(2_000)
    expect(argsJson.preview as string).toContain('"body":"xxx')
    expect(JSON.stringify(argsJson).length).toBeLessThan(20_000)
  })

  it('keeps args just under the cap intact', () => {
    const under = { body: 'y'.repeat(19_000) }
    expect(prepareArgsJson(under)).toEqual(under)
  })

  it('redacts before truncating, so the preview cannot leak a secret', () => {
    const out = prepareArgsJson({
      token: 'LEAKED-TOKEN-VALUE',
      body: 'z'.repeat(30_000),
    }) as { _truncated: boolean; preview: string }

    expect(out._truncated).toBe(true)
    expect(out.preview).toContain('"token":"[redacted]"')
    expect(out.preview).not.toContain('LEAKED-TOKEN-VALUE')
  })
})

describe('audit()', () => {
  it('applies column defaults', async () => {
    await audit({ actor: 'Alex', event: 'policy.decide' })
    expect(lastRow()).toMatchObject({
      actor: 'Alex',
      event: 'policy.decide',
      category: null,
      toolName: null,
      argsJson: null,
      resultSummary: null,
      ok: true,
      pendingActionId: null,
    })
  })

  it('passes through the supplied fields', async () => {
    await audit({
      actor: 'system',
      event: 'action.execute',
      category: 'email_send',
      toolName: 'gmail_send',
      resultSummary: 'sent to school@example.com',
      ok: false,
      pendingActionId: 12,
      args: { to: 'school@example.com' },
    })
    expect(lastRow()).toMatchObject({
      category: 'email_send',
      toolName: 'gmail_send',
      resultSummary: 'sent to school@example.com',
      ok: false,
      pendingActionId: 12,
      argsJson: { to: 'school@example.com' },
    })
  })

  it('never throws when the insert fails, and logs instead', async () => {
    h.failInsert = true
    await expect(audit({ actor: 'Alex', event: 'tool.execute', args: { token: 'tok' } })).resolves
      .toBeUndefined()
    expect(h.errors).toHaveLength(1)
    // The failure log must not carry the original args.
    expect(JSON.stringify(h.errors[0])).not.toContain('tok')
  })

  it('never throws even when the failure log itself throws', async () => {
    h.failInsert = true
    h.failLogger = true
    await expect(audit({ actor: 'Alex', event: 'tool.execute' })).resolves.toBeUndefined()
  })
})

/**
 * Regression guards. Postgres `jsonb` rejects a NUL character and any unpaired
 * UTF-16 surrogate outright, so either one aborts the INSERT and costs us the
 * audit row — precisely for the traffic (scraped pages, mail bodies, call
 * transcripts) that most needs recording.
 */
describe('values Postgres jsonb refuses', () => {
  it('scrubs NUL characters out of both values and keys', () => {
    const out = redactArgs({ ['bo\u0000dy']: 'transcript\u0000tail' }) as Record<string, unknown>
    expect(JSON.stringify(out)).not.toContain('\\u0000')
    expect(out['bo\uFFFDdy']).toBe('transcript\uFFFDtail')
  })

  it('scrubs unpaired surrogates', () => {
    const out = redactArgs({ body: 'ok \uD83C tail', trailing: 'end \uDFE0' }) as Record<
      string,
      string
    >
    expect(JSON.stringify(out)).not.toMatch(LONE_SURROGATE_ESCAPE)
    expect(out.body).toBe('ok \uFFFD tail')
    expect(out.trailing).toBe('end \uFFFD')
  })

  it('leaves well-formed astral characters alone', () => {
    expect(redactArgs({ body: '\u{1F3E0} home' })).toEqual({ body: '\u{1F3E0} home' })
  })

  it('never cuts the truncation preview mid-surrogate-pair', () => {
    const out = prepareArgsJson({ body: '\u{1F3E0}'.repeat(20_000) }) as {
      _truncated: boolean
      preview: string
    }
    expect(out._truncated).toBe(true)
    expect(JSON.stringify(out)).not.toMatch(LONE_SURROGATE_ESCAPE)
  })

  it('stores null for args with no JSON form at all', () => {
    expect(prepareArgsJson(() => 'nope')).toBe(null)
  })
})

describe('hostile and exotic arg shapes', () => {
  it('keeps a JSON "__proto__" key as an own property instead of reparenting', () => {
    const args: unknown = JSON.parse('{"__proto__":{"token":"leak","keep":"visible"},"ok":1}')
    const out = redactArgs(args) as Record<string, unknown>
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true)
    const flat = JSON.stringify(out)
    expect(flat).toContain('"__proto__"')
    expect(flat).toContain('"keep":"visible"')
    expect(flat).not.toContain('leak')
    expect((({} as Record<string, unknown>).token)).toBeUndefined()
  })

  it('walks Map and Set contents instead of flattening them to {}', () => {
    expect(
      redactArgs({
        m: new Map([
          ['api_key', 'ak-1'],
          ['city', 'Reno'],
        ]),
      }),
    ).toEqual({ m: { api_key: '[redacted]', city: 'Reno' } })
    expect(redactArgs({ s: new Set(['a', 'b']) })).toEqual({ s: ['a', 'b'] })
  })

  it('degrades rather than throws on a getter that throws', () => {
    const hostile = {
      fine: 'yes',
      get boom(): string {
        throw new Error('getter exploded')
      },
    }
    expect(() => redactArgs({ hostile })).not.toThrow()
    expect(redactArgs({ hostile })).toEqual({ hostile: '[unreadable]' })
  })

  it('bounds a shared-subgraph blow-up instead of hanging the caller', () => {
    // Cycle detection is ancestor-only, so a shared child is re-expanded at
    // every branch: this graph is 2^16 nodes if nothing bounds the walk.
    let node: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 16; i += 1) node = { a: node, b: node }
    const flat = JSON.stringify(redactArgs(node))
    expect(flat).toContain('[size-limit]')
    expect(flat.length).toBeLessThan(500_000)
  })
})
