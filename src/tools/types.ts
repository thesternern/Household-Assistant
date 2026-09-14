import type { z } from 'zod'
import type { PolicyCategory } from '../db/schema.js'

/** What every household tool handler returns. Shape matches the Agent SDK `tool()` handler contract. */
export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

/** Who is driving the call. The policy engine treats `watcher` as least-privileged. */
/**
 * Who is driving a tool call.
 *
 * - `agent`: a household member's own turn, or one the household scheduled.
 * - `workflow`: a cron- or command-driven workflow (morning brief, meal prep).
 * - `watcher`: the deterministic ingestion pipeline. Never a model turn.
 * - `inbound`: a MODEL turn whose prompt was built from text a stranger wrote —
 *   an email reply in the assistant's mailbox, an inbound text on an open
 *   thread, the transcript of a finished call. It reasons like `agent`, but
 *   over attacker-controllable words, so it is contained: no web, no
 *   delegation, no writes that shape later turns, and nothing runs on its
 *   say-so alone — a proposal becomes an approval card or nothing.
 * - `executor`: replay of arguments a human already approved.
 */
export type ToolOrigin = 'agent' | 'watcher' | 'executor' | 'workflow' | 'inbound'

export interface ToolContext {
  chatId: string
  actor: string // display name of the requesting spouse, or 'system'
  origin: ToolOrigin
  conversationId?: number
  agentSessionId?: string
  pendingActionId?: number // set when replayed by the executor
}

export interface ToolDef {
  name: string // bare name, e.g. 'todo_add'
  description: string
  schema: z.ZodRawShape // raw shape for tool()
  category: PolicyCategory
  consequential: boolean // true => handler must verify an approved pending_action
  readOnly?: boolean
  /**
   * Keep the full definition in the prompt instead of deferring it behind
   * ToolSearch. A deferred tool reaches the model as a bare name; it reads the
   * description only after it has already chosen that name to look up. Reserve
   * this for a tool whose description exists to steer the model *off* a
   * look-alike name — a rule the model cannot read at decision time is not a
   * rule.
   */
  alwaysLoad?: boolean
  /** One-line human sentence for the approval card. Receives validated args. */
  summarize: (args: Record<string, unknown>) => string
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}

/** Successful tool result. Pass `structured` when the caller can use machine-readable output. */
export const ok = (text: string, structured?: Record<string, unknown>): ToolResult =>
  structured === undefined
    ? { content: [{ type: 'text', text }] }
    : { content: [{ type: 'text', text }], structuredContent: structured }

/** Failed tool result. The model sees the text and can recover or explain. */
export const fail = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
})

export const MCP_SERVER_NAME = 'household'

const QUALIFIED_PREFIX = `mcp__${MCP_SERVER_NAME}__`

/** 'todo_add' -> 'mcp__household__todo_add'. Already-qualified names pass through unchanged. */
export const qualifiedName = (bare: string): string =>
  bare.startsWith(QUALIFIED_PREFIX) ? bare : `${QUALIFIED_PREFIX}${bare}`

/**
 * 'mcp__household__todo_add' -> 'todo_add'; passes bare names through.
 *
 * Only the household prefix is stripped. A tool from any other MCP server keeps its qualified
 * name, so it can never collide with a household tool of the same bare name: the registry then
 * fails to resolve it, the policy engine denies it as unknown, and `hasApprovedAction` refuses
 * to match a stored approval against it.
 */
export const bareName = (qualified: string): string =>
  qualified.startsWith(QUALIFIED_PREFIX) ? qualified.slice(QUALIFIED_PREFIX.length) : qualified
