import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'

/**
 * Append-only audit trail. Every policy decision, approval, and consequential
 * tool execution lands here.
 *
 * Two rules govern this module:
 *  1. `audit()` never throws. A broken audit write must not fail the action it
 *     was describing — it logs and returns.
 *  2. Nothing sensitive is stored. Args are redacted by key name and capped in
 *     size before they reach Postgres.
 *
 * A third rule follows from the first: a row we could have written must not be
 * lost to a value Postgres refuses. See `scrub()`.
 */

/** Key names whose values are replaced wholesale, at any depth. */
const REDACT_KEY_RE =
  /token|secret|password|passphrase|credential|refresh|api[_-]?key|private[_-]?key|authorization|bearer|signature/i
const REDACTED = '[redacted]'

/** Serialised args longer than this are stored as a truncation stub instead. */
const MAX_ARGS_JSON_CHARS = 20_000
/** How much of the (already redacted) serialisation the stub keeps. */
const PREVIEW_CHARS = 2_000
/** Guards against pathological nesting; cycles are caught separately. */
const MAX_DEPTH = 16
/**
 * Guards against object graphs that are shallow but wide, and against DAGs that
 * re-expand a shared subtree at every branch. Cycle detection is ancestor-only
 * (see below), so a shared subgraph is legitimately walked more than once and
 * depth alone does not bound the work. Exceeding the budget must degrade the
 * row, never hang or OOM the process that was placing a call or spending money.
 */
const MAX_NODES = 5_000

/**
 * Postgres `jsonb` refuses two things that appear in real payloads:
 *   - a NUL character (JSON escape "backslash-u0000") — "unsupported Unicode
 *     escape sequence ... cannot be converted to text" (verified against a live
 *     Postgres, not assumed).
 *   - an unpaired UTF-16 surrogate — "Unicode low surrogate must follow a high
 *     surrogate". `JSON.stringify` emits lone surrogates as `\udXXX` escapes, so
 *     they survive all the way to the server and fail the INSERT.
 * Either one aborts the write, costing us the audit row for exactly the traffic
 * we most want recorded: scraped pages, email bodies, call transcripts. Replace
 * them with U+FFFD on the way in.
 */
const UNSTORABLE_SOURCE = '\\u0000|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]'
const UNSTORABLE_TEST = new RegExp(UNSTORABLE_SOURCE)
const UNSTORABLE_ALL = new RegExp(UNSTORABLE_SOURCE, 'g')

function scrub(s: string): string {
  return UNSTORABLE_TEST.test(s) ? s.replace(UNSTORABLE_ALL, '\uFFFD') : s
}

function isBinary(value: object): boolean {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer
}

interface Walk {
  seen: WeakSet<object>
  /** Remaining node budget; shared across the whole walk. */
  nodes: number
}

/**
 * Assigns without tripping the `Object.prototype.__proto__` setter. Plain
 * `out[key] = v` on the key `"__proto__"` (which `JSON.parse` happily produces
 * as an own property) reparents `out` instead of storing anything, so the value
 * vanishes from the audit row.
 */
function put(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
    return
  }
  out[key] = value
}

function redactEntries(
  entries: Iterable<readonly [string, unknown]>,
  depth: number,
  walk: Walk,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, item] of entries) {
    const safeKey = scrub(key)
    put(out, safeKey, REDACT_KEY_RE.test(key) ? REDACTED : redactValue(item, depth + 1, walk))
  }
  return out
}

function redactValue(value: unknown, depth: number, walk: Walk): unknown {
  if (typeof value === 'string') return scrub(value)
  if (value === null || typeof value !== 'object') return value
  if (depth > MAX_DEPTH) return '[depth-limit]'
  if (walk.seen.has(value)) return '[circular]'
  if (value instanceof Date) return value.toISOString()
  if (isBinary(value)) return '[binary]'
  if (walk.nodes <= 0) return '[size-limit]'
  walk.nodes -= 1

  walk.seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, depth + 1, walk))
    }
    // Map and Set have no own enumerable properties, so the generic branch
    // would flatten them to `{}` and silently drop their contents.
    if (value instanceof Set) {
      return Array.from(value, (item) => redactValue(item, depth + 1, walk))
    }
    if (value instanceof Map) {
      return redactEntries(
        Array.from(value, ([k, v]) => [typeof k === 'string' ? k : String(k), v] as const),
        depth,
        walk,
      )
    }
    let entries: Array<[string, unknown]>
    try {
      entries = Object.entries(value as Record<string, unknown>)
    } catch {
      // A throwing getter or a hostile Proxy must not take the whole row down.
      return '[unreadable]'
    }
    return redactEntries(entries, depth, walk)
  } finally {
    // Sibling branches may legitimately reference the same object; only true
    // ancestor cycles should be collapsed.
    walk.seen.delete(value)
  }
}

/**
 * Recursively replaces the value of any key matching `REDACT_KEY_RE` with
 * `[redacted]`. Exported for tests and for callers that want to log a redacted
 * copy of the same args somewhere else. Does not mutate its input, and does not
 * throw.
 *
 * Redaction is by key name only. A secret that a caller has already inlined
 * into a value — an `access_token=` query parameter inside a `url` string, say
 * — is not caught here. Pass such things under a matching key, or strip them
 * before calling.
 */
export function redactArgs(args: unknown): unknown {
  return redactValue(args, 0, { seen: new WeakSet<object>(), nodes: MAX_NODES })
}

/**
 * Redacts, then caps. Returns either the redacted value or, when it serialises
 * to more than `MAX_ARGS_JSON_CHARS`, `{ _truncated: true, preview }`.
 * Redaction always runs first, so a preview can never expose a secret.
 */
export function prepareArgsJson(args: unknown): unknown {
  const redacted = redactArgs(args)
  let serialised: string | undefined
  try {
    serialised = JSON.stringify(redacted)
  } catch {
    return { _truncated: true, preview: '[unserialisable args]' }
  }
  // `undefined` means the value has no JSON form at all (a function, a symbol).
  // Storing it as-is would hand Postgres a `jsonb` parameter it cannot encode.
  if (serialised === undefined) return null
  if (serialised.length <= MAX_ARGS_JSON_CHARS) return redacted
  // Slicing a serialisation can cut an emoji in half; re-scrub the fragment so
  // the stub itself is storable.
  return { _truncated: true, preview: scrub(serialised.slice(0, PREVIEW_CHARS)) }
}

export interface AuditEntry {
  actor: string
  event: string
  category?: string | null
  toolName?: string | null
  args?: unknown
  resultSummary?: string
  ok?: boolean
  pendingActionId?: number
}

/** Writes one audit row. Swallows every failure — see rule 1 above. */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    const row: typeof schema.auditLog.$inferInsert = {
      actor: scrub(String(entry.actor)),
      event: scrub(String(entry.event)),
      category: entry.category == null ? null : scrub(String(entry.category)),
      toolName: entry.toolName == null ? null : scrub(String(entry.toolName)),
      argsJson: entry.args === undefined ? null : prepareArgsJson(entry.args),
      resultSummary: entry.resultSummary == null ? null : scrub(String(entry.resultSummary)),
      ok: entry.ok ?? true,
      pendingActionId: entry.pendingActionId ?? null,
    }
    await getDb().insert(schema.auditLog).values(row)
  } catch (err) {
    try {
      // Never include `entry.args` here — that is the unredacted original.
      logger.error(
        { err, event: entry.event, actor: entry.actor, toolName: entry.toolName ?? null },
        'audit write failed',
      )
    } catch {
      // The contract is "never throws". Even the failure path honours it.
    }
  }
}
