/**
 * The tool registry must survive being reached from either side of its import
 * cycle.
 *
 * `registry.ts` imports `tools/phone.ts`, which reaches `integrations/vapi.ts`,
 * which reaches `jobs/queue.ts`, which reaches `agent/run-turn.ts`, which
 * imports `registry.ts` again. That cycle is fine as long as the registry only
 * reads the other modules' bindings inside a function. Build the module list at
 * module-evaluation time instead and the graph explodes with
 * `ReferenceError: Cannot access 'phoneTools' before initialization` — but only
 * when the cycle is entered from a tool module, so the app boots or does not
 * boot depending on which file the entrypoint happened to import first.
 *
 * Both orders are pinned here because only one of them is broken by the
 * regression, and it is not the order the production entrypoint uses.
 */
import { describe, expect, it, vi } from 'vitest'

/** The tools that only exist once the registry is wired up correctly. */
const PHONE_TOOLS = ['phone_place_call', 'phone_get_call_result']

async function freshImport<T>(order: string[]): Promise<T> {
  vi.resetModules()
  let last: unknown
  for (const spec of order) last = await import(spec)
  return last as T
}

type Registry = typeof import('../src/tools/registry.js')

describe('tool registry import order', () => {
  it('builds when the cycle is entered from the registry', async () => {
    const registry = await freshImport<Registry>(['../src/tools/registry.js'])
    expect(registry.allTools().length).toBeGreaterThan(0)
  })

  it('builds when the cycle is entered from a tool module', async () => {
    // This is the order that fails if MODULES is a top-level const: phone.ts
    // starts evaluating, drags in vapi -> queue -> run-turn -> registry, and
    // registry reads `phoneTools` while it is still in its temporal dead zone.
    const registry = await freshImport<Registry>([
      '../src/tools/phone.js',
      '../src/tools/registry.js',
    ])
    expect(registry.allTools().length).toBeGreaterThan(0)
  })

  it('resolves the phone tools under both bare and qualified names', async () => {
    const registry = await freshImport<Registry>(['../src/tools/registry.js'])
    for (const name of PHONE_TOOLS) {
      expect(registry.getTool(name), name).toBeDefined()
      expect(registry.getTool(`mcp__household__${name}`), name).toBeDefined()
    }
  })

  it('gives phone_place_call the category the policy engine gates on', async () => {
    const registry = await freshImport<Registry>(['../src/tools/registry.js'])

    // Unregistered, `decide()` answers "unknown tool" and the whole capability
    // is invisible; registered under the wrong category it would skip approval.
    expect(registry.getTool('phone_place_call')).toMatchObject({
      category: 'phone_call',
      consequential: true,
    })
    expect(registry.getTool('phone_get_call_result')).toMatchObject({
      category: 'read',
      readOnly: true,
    })
    expect(registry.toolNamesForCategories(['phone_call'])).toContain(
      'mcp__household__phone_place_call',
    )
  })
})
