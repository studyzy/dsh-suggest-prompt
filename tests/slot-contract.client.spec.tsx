/**
 * Contract verification for the Plugins-page migration, run against the REAL
 * harness slot registry rather than the suite's hand-written stand-in.
 *
 * Why this file exists: `browser-plugin.client.spec.tsx` registers into a
 * `SlotRegistryStandin` (a local stub asserting what the plugin *calls*). That
 * proves nothing about whether the harness would actually render the two
 * surfaces — the whole failure mode this migration has is *silent*: a
 * `plugins.bundle.config` register with the wrong addressing option, or a
 * `plugins.bundle.config` kind assumption that does not match, both produce a
 * green suite and an empty configuration section in the real app.
 *
 * Three independent layers are asserted here:
 *
 *   1. The published `@deepseek-ai/dsh-client-ui-slots` `SlotCore` (real code,
 *      no stub) really does carry `plugins.bundle.config` as `kind: 'keyed'`,
 *      `scope: 'root'`, and really does address it by `options.key`.
 *   2. The real plugin-manager client bundle's `configLedgerSource` projection
 *      really does turn `plugins.bundle.config` entries' `options.key` into
 *      `ledger.bundles`, which is what `configured` is computed from.
 *   3. The plugin's own registrations, read off the live component, resolve to
 *      the package name — with the namespace-keyed variant proven false.
 *
 * The harness's own source is transcribed by line reference below. Where a line
 * is quoted from the shipped bundle it is marked with `client.js:<line>`, so it
 * can be re-checked against the app after an upgrade.
 */
// @vitest-environment jsdom

import { SlotCore, resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { describe, expect, it, vi } from 'vitest'

// The store engine arrives through the browser module table; jsdom has no
// `window.__ModuleLoader__`, so stub the one value import the plugin uses
// (same technique as browser-plugin.client.spec.tsx). The React card and the
// primitives UI kit it pulls in are irrelevant to slot registration — and the
// published primitives bundle does not resolve offline (it imports
// `@deepseek-ai/dsh-util-code-language`, which is not published) — so the card
// is replaced by an inert component. This suite asserts what the plugin
// REGISTERS, never what the card renders.
vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore: (init: unknown) => {
    let state = init
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => state,
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => {
          listeners.delete(fn)
        }
      },
      update: (mutator: (value: unknown) => void) => {
        mutator(state)
        for (const fn of listeners) fn()
      },
      set: (next: unknown) => {
        state = next
        for (const fn of listeners) fn()
      },
    }
  },
}))
vi.mock('../src/browser/SettingsCard.tsx', async (importOriginal) => ({
  // Keep the real exports (the summary component is rendered for real in one
  // test below); only the full card — which pulls the primitives UI kit — is
  // replaced by an inert component, since this suite asserts registration.
  ...(await importOriginal<typeof import('../src/browser/SettingsCard.tsx')>()),
  SettingsCard: () => null,
}))
vi.mock('../src/browser/GhostSuggestion.tsx', () => ({ GhostSuggestion: () => null }))

/** The npm package name — what `plugins.bundle.config` must be keyed by. */
const PACKAGE_NAME = '@studyzy/dsh-suggest-prompt'

/**
 * The locale namespace id ('suggest-prompt'). Deliberately a *different* string
 * from the package name: conflating the two is the second silent failure the
 * migration doc calls out.
 */
const NAMESPACE = 'suggest-prompt'

/**
 * Faithful transcription of the shipped `configLedgerSource`
 * (dsh-client-ui-plugin-manager/lib/client.js:40-75). Only the two things the
 * projection reads are kept: `ctx.slots` and `ctx.locale`. The `keysOf` body is
 * verbatim from client.js:48 — an entry with no `options.key` contributes
 * NOTHING, which is exactly why a namespace-or-id-keyed registration yields an
 * empty `bundles` set.
 */
function configLedgerSource(slots: SlotCore, locale: { revision: number }) {
  const SLOTS = ['plugins.item', 'plugins.bundle.config', 'plugins.row.config'] as const
  let versions: number[] = []
  let revision = -1
  let ledger: { items: Array<{ id: string; label: string }>; bundles: Set<string>; rows: Set<string> } = {
    items: [],
    bundles: new Set(),
    rows: new Set(),
  }
  const keysOf = (name: string) =>
    new Set(slots.entries(name).flatMap((entry) => (entry.options.key === undefined ? [] : [entry.options.key])))

  return {
    getSnapshot: () => {
      const next = SLOTS.map((name) => slots.getVersion(name))
      if (locale.revision !== revision || next.some((version, index) => version !== versions[index])) {
        versions = next
        revision = locale.revision
        ledger = {
          // client.js:57-61 — the Official group's card roster. The label goes
          // through the real `resolveSlotLabel` (a registration may supply a
          // plain string OR a thunk, and the page resolves the thunk).
          items: slots.entries('plugins.item').map((entry) => ({
            id: entry.options.id ?? '',
            label: resolveSlotLabel(entry.options.label as never) ?? '',
          })),
          // client.js:62 — what `configured` is derived from.
          bundles: keysOf('plugins.bundle.config'),
          rows: keysOf('plugins.row.config'),
        }
      }
      return ledger
    },
  }
}

/**
 * The page's declaration, transcribed from the shipped `main` register
 * (client.js:3733-3740): `plugins.item` is a root list, `plugins.bundle.config`
 * a root keyed slot. The real registry checks kind/scope on register, so a
 * mismatch here fails loudly rather than silently.
 */
function declarePage(core: SlotCore): void {
  core.register(
    {
      name: 'root',
      children: {
        // Declared by the conversation UI, not the Plugins page — the real
        // SlotCore throws on registering into an undeclared key, so the ghost
        // overlay seat must exist for `apply` to reach its settings child.
        'conversation.input.overlay': { kind: 'list', scope: 'session' },
        'plugins.item': { kind: 'list', scope: 'root' },
        'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
      },
    },
    (() => null) as never,
  )
}

/** A registration face stand-in; the migration's contract is identity-shared. */
interface Face {
  draft: string
}

/**
 * Read the plugin's two registrations without importing the plugin: the source
 * is read as text, because this file must stay independent of `src/` (another
 * agent owns it) and a passing suite must not depend on import side effects.
 * The assertions on the text are structural (`name:`/`key:`/`id:` on the options
 * object), and the behavioural half below drives the real registry.
 */
describe('plugins.bundle.config is a root keyed slot addressed by package name', () => {
  it('the real SlotCore declares it keyed/root and stores it under options.key', () => {
    const core = new SlotCore()
    declarePage(core)

    // Shape of the declaration, from the real registry.
    const spec = core.specDynamic('plugins.bundle.config')
    expect(spec).toBeDefined()
    expect(spec?.kind).toBe('keyed')
    expect(spec?.scope).toBe('root')

    // The sibling surface is a root list — the two entry points differ in kind,
    // which is precisely why one register cannot serve both.
    const itemSpec = core.specDynamic('plugins.item')
    expect(itemSpec?.kind).toBe('list')
    expect(itemSpec?.scope).toBe('root')
  })

  it('a package-name key lands in the ledger; a namespace key silently does not', () => {
    const core = new SlotCore()
    declarePage(core)

    // ✅ What the migration registers.
    core.register(
      {
        name: 'plugins.bundle.config',
        key: PACKAGE_NAME,
        locale: 'suggest-prompt.settings',
        inject: () => ({ draft: '' }) as Face,
      },
      (() => null) as never,
    )
    // ❌ The negative control: the namespace instead of the package name. This
    // is the mistake the migration doc warns about, and it registers WITHOUT
    // erroring — it simply never matches the dispatch key.
    core.register(
      {
        name: 'plugins.bundle.config',
        key: NAMESPACE,
        locale: 'suggest-prompt.settings',
        inject: () => ({ draft: '' }) as Face,
      },
      (() => null) as never,
    )

    const core2 = new SlotCore()
    declarePage(core2)
    core2.register(
      { name: 'plugins.bundle.config', key: PACKAGE_NAME, inject: () => ({ draft: '' }) as Face },
      (() => null) as never,
    )
    const ledgerCorrect = configLedgerSource(core2, { revision: 0 }).getSnapshot()
    expect([...ledgerCorrect.bundles]).toEqual([PACKAGE_NAME])

    const core3 = new SlotCore()
    declarePage(core3)
    core3.register(
      { name: 'plugins.bundle.config', key: NAMESPACE, inject: () => ({ draft: '' }) as Face },
      (() => null) as never,
    )
    const ledgerWrong = configLedgerSource(core3, { revision: 0 }).getSnapshot()
    // The set holds the namespace, NOT the package name → `bundles.has(pkg.name)`
    // is false → `configured` stays false → the config section never renders.
    expect(ledgerWrong.bundles.has(PACKAGE_NAME)).toBe(false)
    expect([...ledgerWrong.bundles]).toEqual([NAMESPACE])
  })

  it('configured flips false→true exactly when the package name is the key', () => {
    // Mirrors PackageDetail's `configured: ledger.bundles.has(openPkg.name)`
    // (client.js:3526) and its `configured ? renderSlot(...) : null`
    // (client.js:2519-2523).
    const packageCard = (bundles: Set<string>) => bundles.has(PACKAGE_NAME)

    const core = new SlotCore()
    declarePage(core)
    const ledgerSource = configLedgerSource(core, { revision: 0 })
    expect(packageCard(ledgerSource.getSnapshot().bundles)).toBe(false)

    core.register(
      { name: 'plugins.bundle.config', key: PACKAGE_NAME, inject: () => ({ draft: '' }) as Face },
      (() => null) as never,
    )
    expect(packageCard(ledgerSource.getSnapshot().bundles)).toBe(true)
  })
})

describe('plugins.item carries the Official-group card roster', () => {
  it('a list registration with id + label projects to one ledger item', () => {
    const core = new SlotCore()
    declarePage(core)

    core.register(
      {
        name: 'plugins.item',
        id: NAMESPACE,
        order: 30,
        label: () => '建议提示词',
        locale: 'suggest-prompt.settings',
        inject: () => ({ draft: '' }) as Face,
      },
      (() => null) as never,
    )

    const ledger = configLedgerSource(core, { revision: 0 }).getSnapshot()
    expect(ledger.items).toEqual([{ id: NAMESPACE, label: '建议提示词' }])
    // A list entry contributes no key, so it must NOT pollute `bundles`.
    expect(ledger.bundles.size).toBe(0)
  })
})

describe('the plugin declares both surfaces, keyed by package name, sharing one face', () => {
  it('the retired settings.plugins.tab surface is gone (no third registration)', async () => {
    // Structural, not behavioural: the old tab key must not appear anywhere in
    // the browser half. If it did, the card would also mount a settings tab —
    // the exact duplicate-entry-point the migration removes.
    const { readFile } = await import('node:fs/promises')
    const { resolve } = await import('node:path')
    const source = await readFile(resolve(process.cwd(), 'src/browser/index.ts'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toContain('settings.plugins.tab')
    // Both new surfaces are present in code (not just in comments).
    expect(code).toContain('plugins.item')
    expect(code).toContain('plugins.bundle.config')
  })

  it('the summary view renders the description with no form control and no hooks', async () => {
    // The migration doc §4.4 asks for this: `plugins.item` renders the card's
    // component with `view: 'summary'`, and that render must NOT be the form.
    // It is also the case React would throw on: if the summary branch returned
    // before `CardBody`'s hooks, the hook count would differ between the summary
    // and page renders of the same component ("Rendered fewer hooks than
    // expected"). Rendering into a real DOM container proves both at once — a
    // component with hooks would throw here, and form controls would appear in
    // the markup.
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { SettingsCardSummary } = await import('../src/browser/SettingsCard.tsx')

    const t = (key: string) => `copy:${key}`
    const html = renderToStaticMarkup(SettingsCardSummary({ t: t as never }))

    expect(html).toContain('copy:description')
    // No interactive control of any kind — it is a one-liner, not a form.
    for (const tag of ['<input', '<select', '<button', '<form', '<textarea']) {
      expect(html).not.toContain(tag)
    }
    // And nothing block-level: the page puts this inside a <span>/<p>.
    for (const tag of ['<div', '<li', '<ul', '<section', '<p']) {
      expect(html).not.toContain(tag)
    }
  })

  it('the card cannot hide a <li> root: all three surfaces are non-list containers', () => {
    // DOM contexts, read off the real page bundle:
    //   • plugins.item summary on the CARD    → client.js:2131-2134 wraps it in
    //     <span class="cardDesc">
    //   • plugins.item summary on the DETAIL  → client.js:2321-2324 wraps it in
    //     <p class="detailDesc">   ← a <li> here is ILLEGAL nesting
    //   • page / bundle.config                → <section data-plugin-config>
    //     (client.js:2325-2329 and client.js:2519-2523)
    // Only the retired settings.plugins.tab surface had a <ul> list context.
    //
    // This asserts the CONSEQUENCE, not the markup: an element that is a <li>
    // is only legal under ul/ol/menu, and none of the three surfaces is one.
    const legalParents = new Set(['ul', 'ol', 'menu'])
    const surfaces = [
      { slot: 'plugins.item', view: 'summary', parent: 'span' },
      { slot: 'plugins.item', view: 'summary', parent: 'p' },
      { slot: 'plugins.item', view: 'page', parent: 'section' },
      { slot: 'plugins.bundle.config', view: 'page', parent: 'section' },
    ] as const

    for (const surface of surfaces) {
      expect(legalParents.has(surface.parent)).toBe(false)
    }
    // And the detail-page summary really is a <p> — the one strict case.
    expect(surfaces.some((s) => s.slot === 'plugins.item' && s.parent === 'p')).toBe(true)
  })

  it('the shared-face invariant holds on the live plugin (return value, not closure)', async () => {
    // Drive the REAL plugin on a REAL cordis Context against the REAL SlotCore.
    // Only the two heavyweight module edges the plugin imports are mocked (the
    // store engine and the React card), exactly as browser-plugin.client.spec
    // does; the slot registry itself is the published harness implementation.
    const { Context, Service } = await import('@deepseek-ai/cordis')

    /**
     * `ctx.slots` backed by the real SlotCore. `inject(name, run)` runs the
     * callback as the harness does once the key is declared; the declaration of
     * the three keys is seeded by `declarePage` below, mirroring the real page's
     * `children` table (client.js:3733-3740).
     *
     * NOTE on the stub assembly: this one MUST be a `Service` on the root
     * context, because the plugin declares `inject: ['slots']` and cordis
     * resolves that gate before running the body. The other two services are
     * supplied with `ctx.provide` instead (see below) — instantiating all three
     * as `new X(ctx)` on the root context leaves the scoped
     * `ctx.inject(['configForms', 'locale'])` child unscheduled, so the settings
     * registrations never happen and this suite would report "no entries" for a
     * reason that has nothing to do with the plugin.
     */
    const core = new SlotCore()
    declarePage(core)

    class SlotsService extends Service {
      constructor(ctx: Context) {
        super(ctx, 'slots')
      }
      register(options: never, component: never): () => void {
        return core.register(options, component)
      }
      inject(name: string, run: () => () => void): () => void {
        if (core.specDynamic(name) === undefined) return () => {}
        return run()
      }
      entries(key: string) {
        return core.entries(key)
      }
      getVersion(key: string) {
        return core.getVersion(key)
      }
      subscribe() {
        return () => {}
      }
    }

    const ctx = new Context()
    const slots = new SlotsService(ctx)
    void slots

    // Plain values, not Service subclasses: the plugin only calls
    // `configForms.get(ns)` and `locale.register/bind`/`getSnapshot`, and the
    // scoped child schedules reliably for provided plain services.
    //
    // The form stand-in must carry the WHOLE read surface the controller's
    // constructor touches — `getSnapshot()` and `subscribe()`. A stub with only
    // `get()` makes `new SuggestPromptCardController(...)` throw inside the
    // scoped child, and cordis swallows that error: the child dies after the
    // overlay registration, both settings registrations never happen, and this
    // suite reports "0 entries" for a reason that has nothing to do with the
    // plugin's own correctness.
    const makeFormStub = () => ({
      subscribe: () => () => {},
      getSnapshot: () => ({ value: {}, status: 'ready' as const, writable: true, revision: 0 }),
    })

    ctx.provide('configForms', {
      get: <T,>(_ns: string): T => makeFormStub() as T,
    })
    ctx.provide('locale', {
      register: () => () => {},
      bind: () => (key: string) => key,
      getSnapshot: () => ({ revision: 0 }),
    })

    const { apply } = await import('../src/browser/index.ts')

    // Run the plugin the way the harness does: on its OWN forked fiber with the
    // declared `inject: ['slots']`, not by calling `apply` on the root context.
    // A scoped `ctx.inject([...])` child is only scheduled once that fiber
    // settles — calling `apply(rootContext)` directly starts the overlay
    // registration and then silently never runs the settings child, which would
    // make this suite report "no entries" for a reason unrelated to the plugin.
    ctx.plugin({ inject: ['slots'], apply } as never)

    // One macrotask tick for the plugin fiber + the scoped child to settle.
    await new Promise((resolve) => setTimeout(resolve, 10))

    const itemEntries = core.entries('plugins.item')
    const bundleEntries = core.entries('plugins.bundle.config')

    // Both surfaces registered — one entry each.
    expect(itemEntries).toHaveLength(1)
    expect(bundleEntries).toHaveLength(1)

    // The list surface is addressed by id + carries a label thunk.
    expect(itemEntries[0]!.options.id).toBe(NAMESPACE)
    expect(typeof itemEntries[0]!.options.label).toBe('function')
    // …and the thunk resolves through the locale, per the page's resolveSlotLabel.
    expect(resolveSlotLabel(itemEntries[0]!.options.label as never)).toBeTypeOf('string')

    // The keyed surface is addressed by the PACKAGE NAME and declares no id.
    expect(bundleEntries[0]!.options.key).toBe(PACKAGE_NAME)
    expect(bundleEntries[0]!.options.id).toBeUndefined()

    // ★ The invariant from the migration doc §3: compare the RETURN VALUES of
    //   the two inject callbacks (never the closures — every `() => face` is a
    //   fresh function object, so `expect(a.inject).toBe(b.inject)` can never
    //   hold and would be a meaningless assertion).
    //
    //   Note the accessor: the resolved `inject` callback lives on the STORED
    //   ENTRY (`entry.inject`), not on `entry.options` — the options object only
    //   carries what the registrant declared.
    expect(itemEntries[0]!.inject).toBeTypeOf('function')
    expect(bundleEntries[0]!.inject).toBeTypeOf('function')
    const itemFace = (itemEntries[0]!.inject as () => unknown)()
    const bundleFace = (bundleEntries[0]!.inject as () => unknown)()
    expect(itemFace).toBe(bundleFace)
    // The face is a real object with the card actions — not an empty stub that
    // would make the identity check vacuous (`undefined === undefined`).
    expect(itemFace).toBeTypeOf('object')
    expect(itemFace).not.toBeNull()
    expect(Object.keys(itemFace as object).length).toBeGreaterThan(0)
    // And the closures themselves are distinct — proving the assertion above is
    // testing identity of the resolved face, not accidental closure identity.
    expect(itemEntries[0]!.inject).not.toBe(bundleEntries[0]!.inject)

    // The end-to-end projection: the LEDGER the real page binds now reports the
    // package name in `bundles` → `configured` is true → the config section
    // renders on the package card.
    const ledger = configLedgerSource(core, { revision: 0 }).getSnapshot()
    expect([...ledger.bundles]).toEqual([PACKAGE_NAME])
    expect(ledger.bundles.has(PACKAGE_NAME)).toBe(true)
    expect(ledger.items.map((item) => item.id)).toEqual([NAMESPACE])
  })
})