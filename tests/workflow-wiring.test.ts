/**
 * How workflows are reached, and what may reach the model.
 *
 * There used to be a registry here: `router.ts` classified a message into a
 * label and `workflows/index.ts` mapped the label to a function. The router
 * was never called by anything, so the registry existed only to serve it, and
 * both are gone. Workflows are reached the way they always actually were, by
 * slash command and by cron, importing the module directly.
 *
 * Three invariants survive that deletion, and each one failed in production at
 * least once:
 *
 *  1. Every workflow module is reachable from something. An unreachable
 *     workflow is dead weight that still reads like a feature.
 *  2. `src/agent/run-turn.ts` is the only place in `src/` that calls the Agent
 *     SDK's `query()`. That single entry point is where the policy hooks, the
 *     household MCP server, session persistence and the cost row get attached.
 *     A second call site — especially in a workflow — would be a turn with no
 *     approval gate and no accounting, and it would look normal in review.
 *  3. No prompt tells the model to use a tool it does not have. Two playbooks
 *     said "delegate the lookup to the research subagent when the Task tool is
 *     available to you". `Task` has never been available, and the research
 *     subagent never existed at runtime, so that instruction spent every
 *     /book and every short-library /mealprep pointing the model at nothing.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { splitCallRequest } from '../src/workflows/call.js'
import { normaliseWeekStart } from '../src/workflows/mealprep.js'

/** `fileURLToPath`, not `URL.pathname`: the repo path contains spaces. */
const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/** Repo-relative, POSIX-separated, so the assertions read the same everywhere. */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full))
    } else if (entry.endsWith('.ts')) {
      out.push(relative(SRC, full).split(sep).join('/'))
    }
  }
  return out.sort()
}

const SOURCES = walk(SRC)

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
}

/**
 * Comments are not code. `run-turn.ts` mentions `query()` in prose, and a doc
 * comment must not count as a call site.
 *
 * The `//` rule ignores a slash pair preceded by a colon so that a URL inside a
 * string literal survives.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
}

/** A bare `query(` call. `pool.query(` and `ctx.callbackQuery(` are not it. */
const QUERY_CALL = /(?<![.\w$])query\s*\(/

/** An import that pulls `query` in from the Agent SDK, however it is spelled. */
const QUERY_IMPORT =
  /import\s*(?:type\s*)?\{[^}]*\bquery\b[^}]*\}\s*from\s*['"]@anthropic-ai\/claude-agent-sdk['"]/

/** Everything in `src/workflows/` that is a workflow rather than shared helpers. */
const WORKFLOW_MODULES = SOURCES.filter(
  (rel) => rel.startsWith('workflows/') && rel !== 'workflows/common.ts',
)

/** The two places a workflow is actually started from. */
const ENTRY_POINTS = ['telegram/commands.ts', 'jobs/crons.ts'] as const

describe('workflow reachability', () => {
  it('finds the workflow modules', () => {
    expect(WORKFLOW_MODULES.length).toBeGreaterThan(0)
    expect(WORKFLOW_MODULES).toContain('workflows/mealprep.ts')
  })

  it('reaches every workflow module from a slash command or a cron', () => {
    const callers = ENTRY_POINTS.map(read).join('\n')
    for (const rel of WORKFLOW_MODULES) {
      const specifier = `../${rel.replace(/\.ts$/, '.js')}`
      expect(callers, `${rel} is imported by neither commands.ts nor crons.ts`).toContain(specifier)
    }
  })
})

describe('single agent entry point', () => {
  it('finds source files to check', () => {
    expect(SOURCES).toContain('agent/run-turn.ts')
    expect(SOURCES.some((f) => f.startsWith('workflows/'))).toBe(true)
  })

  it('calls query() only from src/agent/run-turn.ts', () => {
    const callers = SOURCES.filter((rel) => QUERY_CALL.test(stripComments(read(rel))))
    expect(callers).toEqual(['agent/run-turn.ts'])
  })

  it('imports query from the Agent SDK only in src/agent/run-turn.ts', () => {
    const importers = SOURCES.filter((rel) => QUERY_IMPORT.test(stripComments(read(rel))))
    expect(importers).toEqual(['agent/run-turn.ts'])
  })

  it('keeps the Agent SDK out of src/workflows entirely', () => {
    const leaks = SOURCES.filter(
      (rel) => rel.startsWith('workflows/') && read(rel).includes('@anthropic-ai/claude-agent-sdk'),
    )
    expect(leaks).toEqual([])
  })

  it('keeps direct model calls and subprocesses out of src/workflows', () => {
    // query() is not the only way around runTurn: the plain Anthropic SDK or a
    // spawned CLI would also be a turn with no policy gate and no cost row.
    const leaks = SOURCES.filter(
      (rel) =>
        rel.startsWith('workflows/') &&
        /@anthropic-ai\/sdk|['"](?:node:)?child_process['"]/.test(stripComments(read(rel))),
    )
    expect(leaks).toEqual([])
  })
})

describe('prompts name only tools that exist', () => {
  /** Where a prompt handed to the model is built. */
  const PROMPT_SOURCES = [...WORKFLOW_MODULES, 'agent/orchestrator.ts']

  it('never tells the model to delegate', () => {
    // `Agent` and `Task` are both in DISALLOWED_TOOLS and both denied by the
    // PreToolUse hook. A prompt that asks for delegation is asking for a tool
    // call that cannot happen, and the model either abandons the step or
    // improvises around it. Comments are stripped: this file's own prose about
    // the deletion, and orchestrator.ts's, must not trip it.
    const offenders = PROMPT_SOURCES.filter((rel) =>
      /subagent|Task tool|delegate (?:the|this|it)/i.test(stripComments(read(rel))),
    )
    expect(offenders).toEqual([])
  })
})

describe('workflow argument parsing', () => {
  it('splits a call request on a colon or the first word', () => {
    expect(splitCallRequest('dentist: move Thursday')).toEqual({
      who: 'dentist',
      goal: 'move Thursday',
    })
    expect(splitCallRequest('dentist move Thursday')).toEqual({
      who: 'dentist',
      goal: 'move Thursday',
    })
    expect(splitCallRequest('  Dr Patel | reschedule  ')).toEqual({
      who: 'Dr Patel',
      goal: 'reschedule',
    })
    expect(splitCallRequest('dentist')).toEqual({ who: 'dentist', goal: '' })
    expect(splitCallRequest('   ')).toEqual({ who: '', goal: '' })
  })

  it('normalises any date in the week to the Monday of that week', () => {
    // 2026-09-09 is a Wednesday; 2026-09-07 is the Monday before it.
    expect(normaliseWeekStart('2026-09-09')).toBe('2026-09-07')
    expect(normaliseWeekStart('2026-09-07')).toBe('2026-09-07')
    expect(normaliseWeekStart('2026-09-13')).toBe('2026-09-07')
  })

  it('falls back to a real Monday when the date is unusable', () => {
    for (const input of [undefined, '', 'next week', '2026-13-45']) {
      const result = normaliseWeekStart(input)
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(new Date(`${result}T00:00:00Z`).getUTCDay()).toBe(1)
    }
  })
})
