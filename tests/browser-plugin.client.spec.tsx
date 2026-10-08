// @vitest-environment jsdom
/**
 * suggest-prompt browser half on a real cordis Context with a minimal
 * SlotRegistry stand-in.
 *
 * Two surfaces are asserted here. The ghost overlay bridge registers at
 * conversation.input.overlay, and the settings card now mounts on the **Plugins
 * page** instead of the Settings tab. The Plugins page renders an installed
 * profile bundle through *two* independent paths, so the card must be
 * registered twice:
 *
 * - `plugins.item` (list slot, `id: 'suggest-prompt'`, order 30) is the card in
 *   the Official group's ledger;
 * - `plugins.bundle.config` (KEYED slot, addressed by the bundle's package name
 *   `@studyzy/dsh-suggest-prompt`) is the config area of the Installed group's
 *   package card.
 *
 * A profile bundle that is both a `bundles` member and a `dependencies` member
 * is listed as installed, so it gets a package card in the Installed group *in
 * addition to* the Official card. Registering only `plugins.item` yields a
 * package card whose config area never renders (`configured` stays false) — a
 * silent half-migration with no error anywhere. Both registrations are required,
 * and both must share ONE face (`inject: () => face`, built once): a fresh face
 * per surface gives each its own draft table, so an edit made on one surface is
 * invisible on the other and Save writes the stale draft back.
 *
 * The published client bundles bootstrap through `window.__ModuleLoader__`,
 * which jsdom cannot provide. Rather than resolving the whole primitives UI-kit
 * dependency graph, the heavier chain is cut at its module edges: the store
 * engine the plugin builds on, and the settings card (whose only relevance to
 * the registration suite is its place in the Plugins page roster). The card's
 * real `summary` branch is exercised in its own case below, which imports the
 * component past that file-level stub.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'

// The store engine arrives through the browser module table; jsdom has no
// `window.__ModuleLoader__`, so stub the one value import the plugin uses.
vi.mock('@deepseek-ai/dsh-client-store', () => ({
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

// The card's registration is what this suite asserts, so the card itself is
// inert here. The real component (and its summary branch) is imported in the
// dedicated `summary` case through `vi.importActual`, so this stub cannot hide
// a broken card from that assertion.
vi.mock('../src/browser/SettingsCard.tsx', () => ({ SettingsCard: () => null }))

import { apply, inject } from '../src/browser/index.ts'

/** Slot-map declaration: which list slot keys are known and their scope. */
type SlotSpec = { kind: 'list' | 'keyed'; scope: 'root' | 'session' }

/** The npm package name `plugins.bundle.config` is addressed by. */
const PACKAGE_NAME = '@studyzy/dsh-suggest-prompt'

/** One registered entry: the options the plugin declared plus its component. */
interface Entry {
  options: { name: string; id?: string; order?: number; key?: string; locale?: string; inject?: () => unknown }
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
  register(options: { name: string; children?: Record<string, SlotSpec>; id?: string; order?: number; key?: string; locale?: string; inject?: () => unknown }, component: unknown): () => void {
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
      //
      // Crucially, the callback runs ONLY once its slot has been declared: an
      // undeclared slot is silently skipped, which is why the harness below
      // must declare both new keys before the plugin loads — otherwise the
      // assertions read empty arrays and conclude "not registered".
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

/** A config-form stub good enough for the card controller's constructor. */
function configFormStub(): {
  getSnapshot: () => { status: string; value: unknown; writable: boolean }
  subscribe: () => () => void
  set: () => Promise<boolean>
  unset: () => Promise<boolean>
} {
  return {
    getSnapshot: () => ({ status: 'ready', value: {}, writable: true }),
    subscribe: () => () => {},
    set: () => Promise.resolve(true),
    unset: () => Promise.resolve(true),
  }
}

/**
 * Boot a ctx with the SlotRegistry stand-in, the two Plugins-page slot
 * declarations, and the locale + configForms services the card's scoped inject
 * requires. Both new slots MUST be declared before the plugin loads (see
 * `SlotRegistryStandin.inject`).
 * @returns the ctx and the plugin fiber.
 */
async function bootPlugin(): Promise<{ ctx: Context; fiber: { dispose: () => Promise<void> } }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistryStandin).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.input.overlay': { kind: 'list', scope: 'session' },
      'plugins.item': { kind: 'list', scope: 'root' },
      'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
    },
  }, (() => null) as never)
  ctx.provide('locale', {
    register: () => {},
    bind: () => (key: string) => key,
  })
  ctx.provide('configForms', { get: () => configFormStub() })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber }
}

afterEach(cleanup)

describe('ui-suggest-prompt browser plugin', () => {
  it('registers the suggestion ghost overlay entry and drops it on unload', async () => {
    const { ctx, fiber } = await bootPlugin()
    expect(ctx.slots.entries('conversation.input.overlay').map(entry => entry.options.id))
      .toEqual(['suggest-prompt'])
    expect(ctx.slots.entries('conversation.input.overlay')[0]?.options).toMatchObject({
      id: 'suggest-prompt',
      order: 30,
    })
    await fiber.dispose()
    expect(ctx.slots.entries('conversation.input.overlay')).toHaveLength(0)
  })

  it('registers the card on both Plugins-page surfaces and no longer on the settings tab', async () => {
    const { ctx } = await bootPlugin()
    const item = ctx.slots.entries('plugins.item')
    const bundle = ctx.slots.entries('plugins.bundle.config')
    expect(item).toHaveLength(1)
    expect(bundle).toHaveLength(1)
    // The old seat must be gone: leaving it registered would keep a third card
    // in Settings → Built-in plugins.
    expect(ctx.slots.entries('settings.plugins.tab')).toHaveLength(0)
  })

  it('addresses plugins.item by id and plugins.bundle.config by the bundle package name', async () => {
    const { ctx } = await bootPlugin()
    const [item] = ctx.slots.entries('plugins.item')
    const [bundle] = ctx.slots.entries('plugins.bundle.config')
    expect(item?.options).toMatchObject({ id: 'suggest-prompt', order: 30 })
    // plugins.item is a list slot: its `key` is not used.
    expect(item?.options.key).toBeUndefined()
    // The keyed slot is addressed by package name; writing `id` there (or the
    // namespace 'suggest-prompt' as the key) never matches and the config area
    // silently stays hidden.
    expect(bundle?.options.key).toBe(PACKAGE_NAME)
    expect(bundle?.options.id).toBeUndefined()
  })

  it('shares one injected face across both surfaces so a draft is visible in both', async () => {
    const { ctx } = await bootPlugin()
    const [item] = ctx.slots.entries('plugins.item')
    const [bundle] = ctx.slots.entries('plugins.bundle.config')
    // Compare the *return value*: every `() => face` is a fresh closure, so
    // asserting `item.inject === bundle.inject` would fail even when correct.
    expect(item?.options.inject?.()).toBe(bundle?.options.inject?.())
  })

  it('drops both Plugins-page registrations when the plugin fiber unloads', async () => {
    const { ctx, fiber } = await bootPlugin()
    expect(ctx.slots.entries('plugins.item')).toHaveLength(1)
    expect(ctx.slots.entries('plugins.bundle.config')).toHaveLength(1)
    await fiber.dispose()
    // Guards against wiring only one of the two inject controllers to the fiber.
    expect(ctx.slots.entries('plugins.item')).toHaveLength(0)
    expect(ctx.slots.entries('plugins.bundle.config')).toHaveLength(0)
  })

  it('renders the summary branch as the description text, without touching the form face', async () => {
    // Import the REAL component past the file-level stub above.
    const actual = await vi.importActual<typeof import('../src/browser/SettingsCard.tsx')>(
      '../src/browser/SettingsCard.tsx',
    )
    const calls: string[] = []
    let hooksRead = 0
    const props = {
      view: 'summary',
      t: (key: string) => { calls.push(key); return `t:${key}` },
      // A form face that records any read: the summary branch must not need it.
      get useSuggestPromptCard(): never {
        hooksRead += 1
        throw new Error('the summary branch must not read the card store')
      },
    } as unknown as Parameters<typeof actual.SettingsCard>[0]

    const view = render(actual.SettingsCard(props) as never)
    const html = view.container.innerHTML
    // No form controls of any kind in the one-line card subtitle.
    expect(html).not.toMatch(/<input|<select|<button|<textarea/)
    expect(html).not.toContain('dsh-sug-footer')
    // It carries the card description, and only that copy.
    expect(view.container.textContent).toBe('t:description')
    expect(calls).toEqual(['description'])
    // The store was never read — an early return placed before the hooks would
    // instead have crashed here, which is the regression this case guards.
    expect(hooksRead).toBe(0)
  })

  it('renders the page view as the real form, so the summary case is not vacuous', async () => {
    // The complement of the case above: proves the same component really does
    // build the form when asked for `view: 'page'`. Without this, a component
    // that rendered nothing at all would satisfy "summary has no controls".
    const actual = await vi.importActual<typeof import('../src/browser/SettingsCard.tsx')>(
      '../src/browser/SettingsCard.tsx',
    )
    const face = {
      hooks: {
        suggestPromptCard: {
          getSnapshot: () => ({
            available: true,
            writable: true,
            dirty: false,
            invalid: false,
            saving: false,
            failed: false,
            provider: { text: '', overridden: false, invalid: false },
            model: { text: '', overridden: false, invalid: false },
            acceptKey: { text: '', overridden: false, invalid: false },
            providerOptions: [],
            modelOptions: [],
            modelSelectable: false,
          }),
          subscribe: () => () => {},
        },
      },
      edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {},
    }
    const props = {
      view: 'page',
      t: (key: string) => `t:${key}`,
      ...face,
      useSuggestPromptCard: (selector: (s: unknown) => unknown) => selector(face.hooks.suggestPromptCard.getSnapshot()),
    } as unknown as Parameters<typeof actual.SettingsCard>[0]

    const view = render(actual.SettingsCard(props) as never)
    const html = view.container.innerHTML
    // The real route fields, keyed by the ids the e2e helper drives.
    expect(html).toContain('suggest-prompt-settings-provider')
    expect(html).toContain('suggest-prompt-settings-model')
    expect(html).toContain('suggest-prompt-settings-accept-key')
    expect(html).toContain('dsh-sug-footer')
    // The tab panel's list root is gone: the detail page is not a <li> list.
    expect(view.container.querySelector('li')).toBeNull()
  })
})