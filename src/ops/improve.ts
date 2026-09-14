/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ASSISTANT NEVER MODIFIES ITS OWN RUNNING CODE.
 *
 * That is not a limitation we ran out of time to lift. It is the design.
 *
 * A household assistant that can rewrite itself has no reviewable history, no
 * rollback, and no answer to "why did it start doing that?". So the loop stops
 * here, deliberately, and hands off to people:
 *
 *   1. Someone says what should change  ->  /improve <idea>
 *   2. This module writes it up as a spec and files a GitHub issue.
 *   3. A human runs a coding session against that issue.
 *   4. The change arrives as a pull request and gets reviewed by a human.
 *   5. Railway deploys the merge.
 *
 * There is no step where this process writes to `src/`, no step where it opens
 * a shell, and no step where a model's output reaches production without a
 * person having read it. If a future change makes it look like there could be,
 * that change is wrong.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { DateTime } from 'luxon'
import { audit } from '../audit/log.js'
import { getConfig } from '../config.js'
import { getDb, schema } from '../db/client.js'
import { logger } from '../logger.js'

const log = logger.child({ mod: 'ops/improve' })

/** GitHub's REST base. Overridable only in tests, via `fileImprovement`'s options. */
export const GITHUB_API_BASE = 'https://api.github.com'

/** Version header GitHub asks every REST client to pin. */
const GITHUB_API_VERSION = '2022-11-28'

/** Label applied to filed issues, so a human can triage the household's queue. */
export const IMPROVEMENT_LABEL = 'household-request'

/** Where an idea is parked when there is no token to file it with. */
export const IMPROVEMENT_MEMORY_SUBJECT = 'improvement requests'

/** Longest idea we will file. Anything past this is truncated with a marker. */
const MAX_IDEA_CHARS = 4000
const MAX_CONTEXT_CHARS = 4000
const MAX_TITLE_CHARS = 72

/** GitHub is not on the critical path of a chat turn; give up rather than hang. */
const REQUEST_TIMEOUT_MS = 15_000

export type ImprovementResult = { url: string } | { error: string }

/* ─────────────────────────────── text shaping ────────────────────────────── */

function clean(text: unknown, max: number): string {
  if (typeof text !== 'string') return ''
  // Strip control characters; keep newlines and tabs so a multi-line idea survives.
  const stripped = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim()
  if (stripped.length <= max) return stripped
  return `${stripped.slice(0, max)}\n\n[truncated ${stripped.length - max} characters]`
}

/**
 * A one-line issue title from a free-form request. Takes the first sentence,
 * drops a leading "can you"/"please"/"I want", and caps the length on a word
 * boundary.
 */
export function titleFor(idea: string): string {
  const firstLine = idea.split(/\r?\n/).find((line) => line.trim().length > 0) ?? idea
  const firstSentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine
  let text = firstSentence
    .trim()
    .replace(/^(?:hey|hi|ok|okay)[,!\s]+/i, '')
    .replace(/^(?:could|can|would)\s+you\s+(?:please\s+)?/i, '')
    .replace(/^(?:please\s+)?(?:i\s+(?:would\s+like|want|need)\s+(?:you\s+)?(?:to\s+)?)/i, '')
    .replace(/^please\s+/i, '')
    .replace(/[.\s]+$/, '')
    .trim()

  if (text.length === 0) text = 'Household change request'
  if (text.length > MAX_TITLE_CHARS) {
    const cut = text.slice(0, MAX_TITLE_CHARS)
    const lastSpace = cut.lastIndexOf(' ')
    text = `${(lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
  }
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Domain-specific acceptance criteria. The point is to hand whoever picks the
 * issue up something concrete to verify, not to guess the implementation.
 */
const ACCEPTANCE_HINTS: ReadonlyArray<{ match: RegExp; test: string }> = [
  {
    match: /\bcalendar|event|schedule|appointment|meeting\b/i,
    test:
      'Given the household asks for this in chat, when the assistant proposes the calendar change, ' +
      'then the approval card names the event, its date and time in the household timezone, and the ' +
      'calendar it would land on — and nothing is written to Google until someone taps Approve.',
  },
  {
    match: /\bemail|inbox|gmail|reply|mail\b/i,
    test:
      'Given a matching message arrives, when the assistant drafts the reply, then the full draft ' +
      'is shown for approval before it is sent, and the quoted incoming text is wrapped as untrusted data.',
  },
  {
    match: /\bremind|reminder|nag|ping\b/i,
    test:
      'Given the trigger described above, when the reminder is due, then exactly one message is ' +
      'delivered at the right local time, quiet hours are respected, and a redeploy in between does not lose it.',
  },
  {
    match: /\bto-?do|task|list\b/i,
    test:
      'Given the described situation, when the assistant runs, then the to-do appears once with the ' +
      'right title, assignee, and due date, and running the same trigger twice does not create a duplicate.',
  },
  {
    match: /\bmeal|recipe|grocer|shopping|dinner|cook\b/i,
    test:
      'Given a week is planned, when the grocery list is generated, then the described behaviour holds, ' +
      'quantities consolidate correctly across recipes, and the family ratings and allergy facts are respected.',
  },
  {
    match: /\bcall|phone|vapi|voice\b/i,
    test:
      'Given the call is requested, when the assistant places it, then the goal and the callee are shown ' +
      'for approval first, DRY_RUN_CALLS is honoured, and the transcript comes back summarised into the chat.',
  },
  {
    match: /\bbuy|purchase|order|checkout|amazon|shop\b/i,
    test:
      'Given the purchase is proposed, when it is approved, then the dollar total is inside the monthly cap, ' +
      'the audit log records the amount, and a second tap on the same card does not buy it twice.',
  },
  {
    match: /\bapprov|policy|permission|ask me|without asking\b/i,
    test:
      'Given the policy described above, when the assistant reaches that tool, then the gate behaves as ' +
      'asked for both spouses, a watcher-origin call is still refused, and the decision is written to the audit log.',
  },
  {
    match: /\bbrief|morning|digest|summary|review\b/i,
    test:
      'Given the scheduled time arrives in the household timezone, when the brief is built, then it contains ' +
      'the described content, and it is skipped rather than duplicated if the process restarts mid-run.',
  },
  {
    match: /\bwatcher|school|daycare|newsletter|ics|feed\b/i,
    test:
      'Given the source publishes the described item, when the watcher polls, then it is extracted exactly once ' +
      '(the content hash dedupes a re-poll) and nothing inside the source text is treated as an instruction.',
  },
]

/** A verifiable acceptance test for the idea. Falls back to a generic one. */
export function acceptanceTestFor(idea: string): string {
  for (const hint of ACCEPTANCE_HINTS) {
    if (hint.match.test(idea)) return hint.test
  }
  return (
    'Given the situation the household described, when the assistant next handles it, then the new ' +
    'behaviour happens without being asked again, the old behaviour no longer happens, and the change ' +
    'is visible in the audit log.'
  )
}

/** The issue body: a spec a human can pick up cold. */
export function buildIssueBody(input: {
  idea: string
  context?: string
  filedAt: string
  repo: string
}): string {
  const sections = [
    '## What the household asked for',
    '',
    input.idea,
    '',
    '## Why',
    '',
    input.context && input.context.length > 0
      ? input.context
      : 'No reason was given beyond the request itself. Ask in chat before building if the intent is unclear — ' +
        'a wrong guess here costs a redeploy.',
    '',
    '## Context',
    '',
    `- Filed automatically by the household assistant at ${input.filedAt}.`,
    `- Repository: \`${input.repo}\`.`,
    '- The assistant does not and must not edit its own running code. This issue is the entire handoff: ' +
      'a human runs the coding session, the change arrives as a reviewed pull request, and Railway deploys the merge.',
    '- Anything touching the calendar, email, phone, money, or the browser stays behind the approval gate. ' +
      'A change that removes a gate needs an explicit decision from the household, written down in the PR.',
    '',
    '## Suggested acceptance test',
    '',
    acceptanceTestFor(input.idea),
    '',
    '## Definition of done',
    '',
    '- [ ] The acceptance test above passes, as an automated test where the behaviour is testable without a live service.',
    '- [ ] `npm run typecheck` and `npm test` are clean.',
    '- [ ] Any new consequential behaviour declares a policy category and is gated.',
    '- [ ] The household is told what changed, in one sentence, when it ships.',
  ]
  return sections.join('\n')
}

/* ──────────────────────────────── the filing ─────────────────────────────── */

interface GithubTarget {
  owner: string
  repo: string
}

/** `owner/name` -> parts. Returns null for anything else. */
export function parseRepo(value: string): GithubTarget | null {
  const trimmed = (value ?? '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '')
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.length !== 2) return null
  const owner = parts[0]
  const repo = parts[1]
  if (!owner || !repo) return null
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null
  return { owner, repo }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return 'GitHub did not answer within 15 seconds.'
    }
    return err.message || err.name
  }
  return typeof err === 'string' ? err : 'unknown error'
}

/** GitHub's own error text, when it sent one worth repeating. */
function githubMessage(body: unknown): string {
  if (body === null || typeof body !== 'object') return ''
  const b = body as { message?: unknown; errors?: unknown }
  const parts: string[] = []
  if (typeof b.message === 'string' && b.message.trim()) parts.push(b.message.trim())
  if (Array.isArray(b.errors)) {
    for (const entry of b.errors) {
      if (entry && typeof entry === 'object') {
        const m = (entry as { message?: unknown }).message
        if (typeof m === 'string' && m.trim()) parts.push(m.trim())
      }
    }
  }
  return parts.join(' — ')
}

function humanHttpError(status: number, repo: string, detail: string): string {
  const tail = detail ? ` GitHub said: ${detail}` : ''
  switch (status) {
    case 401:
      return `GITHUB_TOKEN was rejected. Generate a new fine-grained token with Issues: write on ${repo} and redeploy.${tail}`
    case 403:
      return `GITHUB_TOKEN is not allowed to open issues on ${repo}. It needs the Issues: write permission.${tail}`
    case 404:
      return `I cannot see ${repo}. Check GITHUB_REPO, and that the token has access to it.${tail}`
    case 410:
      return `Issues are turned off on ${repo}. Enable them in the repository settings.${tail}`
    case 422:
      return `GitHub refused the issue as invalid.${tail}`
    default:
      return `GitHub answered ${status}.${tail}`
  }
}

interface PostResult {
  ok: boolean
  status: number
  url: string
  detail: string
}

async function postIssue(
  target: GithubTarget,
  token: string,
  payload: Record<string, unknown>,
  base: string,
): Promise<PostResult> {
  const response = await fetch(`${base}/repos/${target.owner}/${target.repo}/issues`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'home-assistant-household-bot',
      'x-github-api-version': GITHUB_API_VERSION,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  let parsed: unknown = null
  try {
    parsed = (await response.json()) as unknown
  } catch {
    // A body we cannot parse is not fatal; the status carries the verdict.
  }

  const url =
    parsed && typeof parsed === 'object' && typeof (parsed as { html_url?: unknown }).html_url === 'string'
      ? ((parsed as { html_url: string }).html_url)
      : ''

  return {
    ok: response.ok && url.length > 0,
    status: response.status,
    url,
    detail: githubMessage(parsed),
  }
}

/**
 * Parks the idea in memory so it is not lost when it cannot be filed. Best
 * effort — a failed park is logged, never thrown.
 */
async function rememberIdea(idea: string, context: string): Promise<boolean> {
  try {
    const fact = context ? `${idea}\n\n(context: ${context})` : idea
    await getDb()
      .insert(schema.memoryFacts)
      .values({
        subject: IMPROVEMENT_MEMORY_SUBJECT,
        category: 'improvement',
        fact: fact.slice(0, 4000),
        source: 'improve',
        active: true,
      })
    return true
  } catch (err) {
    log.error({ err }, 'could not park an improvement idea in memory')
    return false
  }
}

/**
 * Turns an idea into a GitHub issue that reads like a spec.
 *
 * Returns `{ url }` on success. Every failure path returns `{ error }` with a
 * sentence a non-technical spouse can act on — this is never thrown, because
 * the caller is a Telegram command handler.
 *
 * @param idea what should change, in the household's own words
 * @param context why, and anything the builder needs to know
 * @param opts test seam only — `apiBase` points the REST call somewhere else
 */
export async function fileImprovement(
  idea: string,
  context?: string,
  opts?: { apiBase?: string },
): Promise<ImprovementResult> {
  const body = clean(idea, MAX_IDEA_CHARS)
  const why = clean(context, MAX_CONTEXT_CHARS)

  if (body.length === 0) {
    return { error: 'There was nothing in that request to write down. Tell me what should change.' }
  }

  let token = ''
  let repoSetting = ''
  let zone = 'UTC'
  try {
    const cfg = getConfig()
    token = cfg.GITHUB_TOKEN.trim()
    repoSetting = cfg.GITHUB_REPO.trim()
    zone = cfg.HOUSEHOLD_TIMEZONE
  } catch (err) {
    log.error({ err }, 'cannot file an improvement: config unavailable')
    return { error: 'My configuration is not readable right now, so I cannot file that.' }
  }

  const title = titleFor(body)

  if (token.length === 0) {
    const parked = await rememberIdea(body, why)
    await audit({
      actor: 'system',
      event: 'improvement.parked',
      resultSummary: title,
      args: { idea: body, context: why, reason: 'GITHUB_TOKEN is not set' },
      ok: false,
    })
    return {
      error:
        'I have no GitHub token, so I cannot open an issue. ' +
        (parked
          ? 'I have written the idea into memory so it is not lost — ask me for it later. '
          : '') +
        'Set GITHUB_TOKEN (a fine-grained token with Issues: write on ' +
        `${repoSetting || 'the repository'}) in Railway and redeploy, then send /improve again.`,
    }
  }

  /**
   * Belt and braces for the one secret in play: no string that came anywhere
   * near the GitHub call reaches a chat message or an audit row with the token
   * still in it. In practice neither fetch errors nor GitHub's response bodies
   * echo the Authorization header — this guards the pathological cases.
   */
  const hideToken = (text: string): string =>
    token.length > 0 ? text.split(token).join('[github-token]') : text

  const target = parseRepo(repoSetting)
  if (!target) {
    const parked = await rememberIdea(body, why)
    await audit({
      actor: 'system',
      event: 'improvement.parked',
      resultSummary: `GITHUB_REPO is not "owner/name": ${repoSetting || '(empty)'}`,
      args: { idea: body, context: why, repo: repoSetting, reason: 'GITHUB_REPO is malformed' },
      ok: false,
    })
    return {
      error:
        `GITHUB_REPO is set to "${repoSetting}", which is not an owner/name pair. ` +
        (parked ? 'I have kept the idea in memory in the meantime. ' : '') +
        'Fix it in Railway and redeploy.',
    }
  }

  const repoText = `${target.owner}/${target.repo}`
  const filedAt = DateTime.now().setZone(zone).toFormat("cccc d LLLL yyyy 'at' HH:mm ZZZZ")
  const issueBody = buildIssueBody({ idea: body, context: why, filedAt, repo: repoText })
  const base = opts?.apiBase ?? GITHUB_API_BASE

  let result: PostResult
  try {
    result = await postIssue(target, token, { title, body: issueBody, labels: [IMPROVEMENT_LABEL] }, base)
    // A repository without the label rejects the whole issue. Losing the label
    // is a far smaller loss than losing the request, so file it bare.
    if (!result.ok && result.status === 422) {
      log.warn({ repo: repoText }, 'issue rejected with a label; retrying without one')
      result = await postIssue(target, token, { title, body: issueBody }, base)
    }
  } catch (err) {
    const detail = hideToken(describeError(err))
    log.error({ err, repo: repoText }, 'could not reach GitHub')
    await audit({
      actor: 'system',
      event: 'improvement.failed',
      resultSummary: detail.slice(0, 500),
      args: { idea: body, repo: repoText },
      ok: false,
    })
    await rememberIdea(body, why)
    return {
      error: `I could not reach GitHub (${detail}). I have kept the idea in memory — try /improve again in a minute.`,
    }
  }

  if (!result.ok) {
    const message = hideToken(humanHttpError(result.status, repoText, result.detail))
    log.error({ status: result.status, repo: repoText, detail: result.detail }, 'GitHub refused the issue')
    await audit({
      actor: 'system',
      event: 'improvement.failed',
      resultSummary: message.slice(0, 500),
      args: { idea: body, repo: repoText, status: result.status },
      ok: false,
    })
    await rememberIdea(body, why)
    return { error: `${message} I have kept the idea in memory in the meantime.` }
  }

  log.info({ repo: repoText, url: result.url }, 'improvement filed')
  await audit({
    actor: 'system',
    event: 'improvement.filed',
    resultSummary: `${title} — ${result.url}`,
    args: { idea: body, context: why, repo: repoText, url: result.url },
    ok: true,
  })

  return { url: result.url }
}
