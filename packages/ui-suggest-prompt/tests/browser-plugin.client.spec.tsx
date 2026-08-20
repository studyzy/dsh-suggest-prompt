// @vitest-environment jsdom
/**
 * ui-suggest-prompt browser half on a real cordis Context with a minimal
 * SlotRegistry stand-in: the plugin registers the suggestion ghost entry at
 * conversation.input.overlay with the suggest-prompt id, and the registration
 * drops when the plugin fiber unloads (HMR safety). The node half is
 * exercised over the same Context.
 *
 * The npm `@deepseek-ai/dsh-client-runtime` package ships only the browser
 * bundle (bootstrapped through window.__ModuleLoader__), which jsdom cannot
 * import; the stand-in below mirrors the SlotRegistry surface the plugin uses
 * and the snapshot-store face `createSnapshotStore` provides.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

// The published runtime bundle bootstraps through window.__ModuleLoader__, which
// jsdom does not provide; stub the value imports the plugin chain uses so the
// tests keep working against the host's bundled output.
vi.mock('@deepseek-ai/dsh-client-runtime/client', () => ({
  createSnapshotStore: (init: unknown): SnapshotStore<unknown> => {
    let state = init
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => state,
      subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
      update: (mutator) => { mutator(state as never); for (const fn of listeners) fn() },
      set: (next) => { state = next; for (const fn of listeners) fn() },
    }
  },
}))

/** Slot-map declaration: which list slot keys are known and their scope. */
type SlotSpec = { kind: 'list'; scope: 'root' | 'session' }

/** One registered entry: the options the plugin declared plus its component. */
interface Entry {
  options: { name: string; id?: string; order?: number; key?: string; locale?: string }
  component: unknown
}

/**
 * Minimal stand-in for the host SlotRegistry surface the plugin uses:
 * `register` records declarations (children) and entries, `inject` runs a
 * callback once a declaration exists, `entries` reads the stored entries, and
 * a disposer drops an entry. The service extends cordis `Service` so calls
 * through `ctx.slots` see the registering fiber (`this.ctx.effect` lands on
 * the plugin's fiber, so unload drops the entries — the HMR contract). State
 * lives in closure: a service proxy would re-resolve instance-field reads.
 */
class SlotRegistryStandin extends Service {
  private readonly _declarations = new Map<string, SlotSpec>()
  private readonly _entriesByKey = new Map<string, Entry[]>()
  private readonly _injectControllers = new Map<string, Array<() => void>>()

  constructor(ctx: Context) {
    super(ctx, 'slots')
  }

  /** Declare a slot map or register an entry under an existing declaration. */
  register(options: { name: string; children?: Record<string, SlotSpec>; id?: string; order?: number; key?: string }, component: unknown): () => void {
    const { name } = options
    if (options.children !== undefined) {
      for (const [child, spec] of Object.entries(options.children)) this._declarations.set(child, spec)
      return () => { for (const child of Object.keys(options.children ?? {})) this._declarations.delete(child) }
    }
    const entry: Entry = { options, component }
    const entries = this._entriesByKey.get(name) ?? []
    entries.push(entry)
    this._entriesByKey.set(name, entries)
    // Run controllers waiting for this declaration (e.g. the ghost overlay).
    for (const run of this._injectControllers.get(name) ?? []) run()
    // Bind the entry's lifetime to the registering fiber: unloading the plugin
    // (HMR reload) drops its contributions exactly like the host.
    const ctx = this.ctx
    ctx.effect(() => () => {
      const list = this._entriesByKey.get(name) ?? []
      const index = list.indexOf(entry)
      if (index >= 0) list.splice(index, 1)
    })
    return () => {
      const list = this._entriesByKey.get(name) ?? []
      const index = list.indexOf(entry)
      if (index >= 0) list.splice(index, 1)
    }
  }

  /** Run a callback once a declaration exists; the returned disposer stops it. */
  inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void {
    let active: (() => void) | Iterable<() => void> | undefined
    let started = false
    let disposed = false
    const start = (): void => {
      // Re-entrancy guard: the callback may itself register into the same
      // slot (the ghost overlay does exactly that), which re-triggers this
      // controller while `active` is still being assigned.
      if (started || !this._declarations.has(key)) return
      started = true
      active = callback()
    }
    const stop = (): void => {
      if (disposed) return
      disposed = true
      if (active !== undefined) {
        if (typeof active === 'function') active()
        else for (const dispose of active) dispose()
        active = undefined
      }
      const list = this._injectControllers.get(key) ?? []
      const index = list.indexOf(start)
      if (index >= 0) list.splice(index, 1)
    }
    this._injectControllers.set(key, [...(this._injectControllers.get(key) ?? []), start])
    // The contribution's lifetime rides the registering fiber (HMR reload
    // unloads the plugin and drops its entries) exactly like the host's
    // inject controller.
    this.ctx.effect(() => stop)
    start()
    return stop
  }

  /** Stored entries for one key (the rendered surface's read). */
  entries(key: string): readonly Entry[] {
    return this._entriesByKey.get(key) ?? []
  }
}

describe('ui-suggest-prompt browser plugin', () => {
  it('registers the suggestion ghost overlay entry and drops it on unload', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistryStandin).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.input.overlay': { kind: 'list', scope: 'session' } },
    }, (() => null) as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('conversation.input.overlay').map(entry => entry.options.id))
      .toEqual(['suggest-prompt'])
    expect(ctx.slots.entries('conversation.input.overlay')[0]?.options).toMatchObject({
      id: 'suggest-prompt',
      order: 30,
    })
    await fiber.dispose()
    expect(ctx.slots.entries('conversation.input.overlay')).toHaveLength(0)
  })
})

describe('ui-suggest-prompt node half', () => {
  // The invariant companion is mounted by the vitest-wide invariant host on
  // every Context this suite creates; its registration is covered there.
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
