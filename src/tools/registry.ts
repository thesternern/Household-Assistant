import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { PolicyCategory } from '../db/schema.js'
import { logger } from '../logger.js'
import { calendarTools } from './calendar.js'
import { browserTools } from './browser.js'
import { contactTools } from './contacts.js'
import { followupTools } from './followups.js'
import { gmailTools } from './gmail.js'
import { recipeTools } from './recipes.js'
import { memoryTools } from './memory.js'
import { phoneTools } from './phone.js'
import { shoppingTools } from './shopping.js'
import { smsTools } from './sms.js'
import { reminderTools } from './reminders.js'
import { ruleTools } from './rules.js'
import { todoTools } from './todos.js'
import { watcherTools } from '../watchers/index.js'
import { MCP_SERVER_NAME, bareName, qualifiedName } from './types.js'
import type { ToolContext, ToolDef, ToolResult } from './types.js'

/**
 * Every household tool, in one place. This registry is a security surface, not
 * just a convenience: `getTool()` is what the policy engine consults to learn a
 * tool's category, and what the executor uses to replay an approved action. A
 * name collision here would let one tool inherit another's approval, so
 * duplicates are a hard startup failure rather than a warning.
 *
 * The list is read inside a function, never at module-evaluation time, and that
 * is load-bearing rather than stylistic. Several tool modules sit on an import
 * cycle back to here — `phone.ts` reaches `integrations/vapi.ts`, which reaches
 * `jobs/queue.ts`, which reaches `agent/run-turn.ts`, which imports this file.
 * A top-level `const MODULES = [..., phoneTools]` reads those bindings while
 * they are still in their temporal dead zone whenever the cycle is entered from
 * the tool side, and the whole process dies on `Cannot access 'phoneTools'
 * before initialization`. Whether the app boots then depends on which file the
 * entrypoint happens to import first, which is not a thing to depend on.
 * Deferring the read to call time is the same discipline `jobs/queue.ts`
 * documents for its own cycle: cross-references live in function bodies.
 */
function toolModules(): ToolDef[][] {
  return [
    todoTools,
    reminderTools,
    followupTools,
    memoryTools,
    ruleTools,
    contactTools,
    calendarTools,
    gmailTools,
    phoneTools,
    smsTools,
    recipeTools,
    shoppingTools,
    browserTools,
    watcherTools,
  ]
}

function buildIndex(): Map<string, ToolDef> {
  const index = new Map<string, ToolDef>()
  for (const mod of toolModules()) {
    for (const def of mod) {
      const key = bareName(def.name)
      const existing = index.get(key)
      if (existing) {
        throw new Error(
          `duplicate tool name "${key}" — a collision would let one tool inherit another's ` +
            `policy category and approvals. Rename one of them.`,
        )
      }
      index.set(key, def)
    }
  }
  return index
}

let index: Map<string, ToolDef> | null = null

function getIndex(): Map<string, ToolDef> {
  if (!index) {
    index = buildIndex()
    logger.debug({ count: index.size }, 'tool registry built')
  }
  return index
}

export function allTools(): ToolDef[] {
  return [...getIndex().values()]
}

/** Accepts either `todo_add` or `mcp__household__todo_add`. */
export function getTool(name: string): ToolDef | undefined {
  return getIndex().get(bareName(name))
}

export function toolNamesForCategories(cats: PolicyCategory[]): string[] {
  const wanted = new Set<PolicyCategory>(cats)
  return allTools()
    .filter((t) => wanted.has(t.category))
    .map((t) => qualifiedName(t.name))
}

function toCallToolResult(result: ToolResult) {
  return {
    content: result.content,
    ...(result.isError ? { isError: true } : {}),
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
  }
}

/**
 * Wraps every ToolDef as an in-process MCP tool with `ctx` bound in. The agent
 * never supplies the context — it is closed over here, so a model cannot claim
 * a different actor or a more permissive origin by passing extra arguments.
 */
export function buildHouseholdMcpServer(ctx: ToolContext) {
  const tools = allTools().map((def) =>
    tool(
      def.name,
      def.description,
      def.schema,
      async (args: Record<string, unknown>) => {
        try {
          const result = await def.handler(args ?? {}, ctx)
          return toCallToolResult(result)
        } catch (err) {
          // A throwing handler must not kill the turn; give the model something
          // it can act on instead of a raw stack trace.
          const message = err instanceof Error ? err.message : String(err)
          logger.error({ err, tool: def.name }, 'tool handler threw')
          return {
            content: [{ type: 'text' as const, text: `${def.name} failed: ${message}` }],
            isError: true,
          }
        }
      },
      {
        annotations: { readOnlyHint: def.readOnly === true },
        // Deferred tools reach the model as a bare name. A tool whose
        // description is what steers the model off a look-alike name has to be
        // in the prompt before the model chooses, not after it has looked the
        // wrong name up. See `ToolDef.alwaysLoad`.
        ...(def.alwaysLoad === true ? { alwaysLoad: true } : {}),
      },
    ),
  )

  return createSdkMcpServer({ name: MCP_SERVER_NAME, version: '1.0.0', tools })
}
