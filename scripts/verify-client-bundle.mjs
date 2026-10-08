#!/usr/bin/env node
/**
 * Verify the built client bundle against the browser kernel's contract.
 *
 * The configuration card reaches users only if `lib/client.js` satisfies rules
 * that are enforced in the *browser*, not at build time: the bundle must register
 * a factory under the plugin id, request only modules the shell seeds, and export
 * the face the kernel activates. A mistake in any of those fails at page load for
 * the user and nowhere in `pnpm typecheck` / `pnpm test` / `pnpm build`, so this
 * script closes that gap by executing the real artifact through a stand-in module
 * loader.
 *
 * It also cross-checks the manifest, because the bundle is useless if `dsh.client`
 * is missing or `exports["./client"]` points somewhere else — the two halves of
 * the declaration are easy to update independently by accident.
 *
 * The apply() half encodes what the *Plugins page* demands of this plugin. A
 * profile dependency that is both a `dsh.profile.bundles` member and a
 * `dependencies` member is rendered by TWO independent paths, so the card needs
 * BOTH slots — see `docs/move-config-to-plugins-page.md`:
 *
 * - `plugins.item` (list slot): the configuration card in the Official group,
 *   addressed by `id` and labelled through `label`.
 * - `plugins.bundle.config` (keyed slot): the form injected into the detail page
 *   of the Installed package card, addressed by `key` === the npm package name.
 *
 * The page gates that second surface on
 * `ledger.bundles.has(openPkg.name)`, and the ledger is built as
 * `keysOf('plugins.bundle.config')` reading `entry.options.key`. Registering the
 * bundle surface with an `id` instead of a `key` is therefore silently dead: it
 * never matches a package name and the configuration area simply does not render.
 * That is exactly the failure this script exists to catch, so `id === undefined`
 * on the bundle entry is asserted rather than tolerated.
 *
 * Both surfaces must also share ONE face. If each `inject` built its own, an edit
 * staged on one page would be invisible to the other and a save on the wrong page
 * would write an empty draft — the user thinks they saved and nothing was written.
 * Because each registration gets its own closure over the shared face, the
 * invariant is on what `inject()` RETURNS, never on the inject function itself.
 *
 * Usage: node scripts/verify-client-bundle.mjs
 * @module @studyzy/dsh-suggest-prompt/scripts/verify-client-bundle
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(packageRoot, 'package.json')

/** Failures collected so one run reports every problem, not just the first. */
const failures = []
const checks = []

/**
 * Record one check's outcome.
 * @param label - what was verified.
 * @param ok - whether it held.
 * @param detail - optional evidence to print.
 */
function check(label, ok, detail = '') {
  checks.push({ label, ok, detail })
  if (!ok) failures.push(label)
}

const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
const packageName = pkg.name

/**
 * Plugin id the bundle registers its factory under. Mirrors `CLIENT_ID` in
 * `tsdown.config.ts`; it is the `<package>/client` outlet, not the package name.
 */
const CLIENT_ID = '@studyzy/dsh-suggest-prompt/client'
/** Locale namespace the card's dictionaries register under. */
const NS = 'suggest-prompt.settings'
/** Profile entry id of the host plugin, reused as this package's settings namespace. */
const ENTRY_ID = 'suggest-prompt'
/** The keyed `plugins.bundle.config` slot is addressed by npm package name. */
const BUNDLE_KEY = '@studyzy/dsh-suggest-prompt'

// --- Manifest: the declaration the host scans -----------------------------
const decl = pkg.dsh?.client
check('manifest declares dsh.client', typeof decl === 'object' && decl !== null)
check('dsh.client.platform is "web"', decl?.platform === 'web', `platform=${decl?.platform}`)
check(
  'dsh.client.inject is a string array',
  decl?.inject === undefined || (Array.isArray(decl.inject) && decl.inject.every((v) => typeof v === 'string')),
  JSON.stringify(decl?.inject),
)
// The loader inject list is about LOAD ORDER, not type dependencies. The
// type-only `dsh-client-*` packages must stay off it: a `link:`ed profile
// dependency cannot resolve them (they live in the app's node_modules), and
// listing one buys nothing while hiding a resolution failure.
check(
  'dsh.client.inject lists only the conversation client',
  Array.isArray(decl?.inject) && decl.inject.length === 1 && decl.inject[0] === '@deepseek-ai/dsh-client-ui-conversation',
  JSON.stringify(decl?.inject),
)

const clientExport = pkg.exports?.['./client']
const clientRel = typeof clientExport === 'string' ? clientExport : clientExport?.default
check('exports["./client"] resolves to a path', typeof clientRel === 'string', String(clientRel))

const bundlePath = clientRel === undefined ? undefined : join(packageRoot, clientRel)
check('built client bundle exists (run `pnpm build`)', bundlePath !== undefined && existsSync(bundlePath), clientRel)

if (failures.length > 0) {
  report()
  process.exit(1)
}

// --- Bundle: the runtime contract the kernel enforces ---------------------
const bundle = readFileSync(bundlePath, 'utf8')
const registry = new Map()
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      if (registry.has(registration.id)) failures.push(`registered "${registration.id}" twice`)
      registry.set(registration.id, registration.factory)
    },
  },
}

try {
  // Evaluate exactly as a browser <script> would.
  new Function(bundle)()
} catch (error) {
  check('bundle evaluates as a script', false, String(error))
  report()
  process.exit(1)
}

check('bundle registers a factory under the plugin id', registry.has(CLIENT_ID), CLIENT_ID)

const factory = registry.get(CLIENT_ID)
// Only the shell's platform singletons may be requested; anything else means the
// bundle inlined a dependency the shell also provides, or asked for a module the
// frozen table cannot answer. Mirrors `CLIENT_EXTERNALS` / `PLATFORM_MODULES`;
// the list is an upper bound — a bundle that requests fewer is fine, since
// react-dom and friends are legitimately inlined by tsdown.
const ALLOWED_EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])
const requested = []
// Snapshot-store stand-in: the controller builds one at construction and the
// real card subscribes to it. `getSnapshot` is what the projection reads.
const snapshotStoreStub = () => {
  let state
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    update: (mutator) => { mutator(state) },
    set: (next) => { state = next },
  }
}

let face
try {
  face = factory((spec) => {
    requested.push(spec)
    if (!ALLOWED_EXTERNALS.has(spec)) throw new Error(`unexpected external "${spec}"`)
    if (spec === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: snapshotStoreStub }
    // react / primitives / dockkit are needed only by the components, which this
    // script never renders; the module table hands back a placeholder so the
    // factory can materialize and expose its face.
    return new Proxy({}, {
      get: (_target, property) => (property === '__esModule' ? true : () => undefined),
      has: () => true,
    })
  })
} catch (error) {
  check('factory materializes with the shell module table', false, String(error))
  report()
  process.exit(1)
}

check(
  'factory requests only shell-provided modules',
  requested.every((s) => ALLOWED_EXTERNALS.has(s)),
  requested.join(', ') || '(none)',
)
// The kernel activates the face by calling `apply` and reads `inject` for the
// loader's dependency list; a bundle missing either is never a plugin at all.
check('exports apply()', typeof face.apply === 'function')
check('exports inject', Array.isArray(face.inject), JSON.stringify(face.inject))
check('inject declares the slots service', Array.isArray(face.inject) && face.inject.includes('slots'), JSON.stringify(face.inject))

// --- Apply: what the page actually registers ------------------------------
const seen = { dictionaries: [], slots: [], entries: [], forms: [] }
const snapshot = {
  status: 'ready',
  writable: true,
  revision: 1,
  value: {},
  base: {},
  user: {},
}
// One stub form per namespace: `ctx.configForms.get` is called for the entry
// itself plus the two read-only catalog sections the dropdowns read.
const formStub = () => ({
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
  mutate: async () => true,
  set: async () => true,
  unset: async () => true,
})
try {
  face.apply({
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject: (names, body) => {
      // Scoped inject: the card is an enhancement, so it mounts on a child
      // context. Run the body eagerly (the harness does this once the named
      // services exist) so the registrations below are observable.
      void names
      return body({
        effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
        locale: {
          register: (ns) => { seen.dictionaries.push(ns); return () => {} },
          bind: () => (key) => key,
        },
        configForms: {
          get: (ns) => { seen.forms.push(ns); return formStub() },
        },
        slots: { inject: slotInject, register: slotRegister },
      })
    },
    locale: {
      register: (ns) => { seen.dictionaries.push(ns); return () => {} },
      bind: () => (key) => key,
    },
    configForms: {
      get: (ns) => { seen.forms.push(ns); return formStub() },
    },
    slots: { inject: slotInject, register: slotRegister },
  })
} catch (error) {
  check('apply() runs against the client services', false, String(error))
  report()
  process.exit(1)
}

/** Record one `slots.inject` and immediately run the callback, as the registry does. */
function slotInject(name, register) {
  seen.slots.push(name)
  return register()
}

/** Record one `slots.register` entry: its slot, keyed id/key, and its inject face. */
function slotRegister(options, component) {
  seen.entries.push({
    slot: options.name,
    id: options.id,
    key: options.key,
    order: options.order,
    label: options.label,
    locale: options.locale,
    inject: options.inject,
    component,
  })
  return () => {}
}

check('registers exactly one dictionary namespace', seen.dictionaries.length === 1, seen.dictionaries.join(', '))
check('dictionary namespace is the card namespace', seen.dictionaries[0] === NS, String(seen.dictionaries[0]))
check('binds the entry config form', seen.forms.includes(ENTRY_ID), seen.forms.join(', '))

// --- The ghost overlay (unchanged surface, still load-bearing) -------------
const overlayEntry = seen.entries.find((entry) => entry.slot === 'conversation.input.overlay')
check('registers the conversation.input.overlay ghost entry', overlayEntry !== undefined)
check(
  'ghost entry keeps the suggest-prompt id and order',
  overlayEntry?.id === ENTRY_ID && overlayEntry?.order === 30,
  JSON.stringify(overlayEntry ? { id: overlayEntry.id, order: overlayEntry.order } : null),
)

// --- The two Plugins-page surfaces ----------------------------------------
// The configuration form appears on two surfaces because the Plugins page files
// a profile dependency as a package card as well as an official-plugin card.
// Missing either one is invisible at build time — the page just shows no form.
check(
  'registers the configuration form on both Plugins-page surfaces',
  seen.slots.includes('plugins.item') && seen.slots.includes('plugins.bundle.config'),
  seen.slots.join(', '),
)

const itemEntry = seen.entries.find((entry) => entry.slot === 'plugins.item')
const bundleEntry = seen.entries.find((entry) => entry.slot === 'plugins.bundle.config')

check('registers the official-plugin card', itemEntry !== undefined)
check(
  'official-plugin card is addressed by the entry id',
  itemEntry?.id === ENTRY_ID,
  JSON.stringify(itemEntry ? { id: itemEntry.id, order: itemEntry.order } : null),
)
check('official-plugin card keeps order 30', itemEntry?.order === 30, String(itemEntry?.order))
// `label` is what the ledger projects for the card title, and the page resolves a
// thunk at read time; a missing label leaves the card titleless even though the
// registration exists. The stub `bind` returns the key itself, so the resolved
// value proves the thunk reads a real locale key rather than a baked string.
check('official-plugin card has a label', itemEntry?.label !== undefined, typeof itemEntry?.label)
check(
  'official-plugin card label resolves through the locale',
  typeof itemEntry?.label === 'function' && itemEntry.label() === 'title',
  typeof itemEntry?.label === 'function' ? String(itemEntry.label()) : String(itemEntry?.label),
)
check('official-plugin card carries the card locale namespace', itemEntry?.locale === NS, String(itemEntry?.locale))

check('registers the package page configuration slot', bundleEntry !== undefined)
// THE load-bearing assertion: this is a KEYED slot and the page matches it with
// `keysOf` over `entry.options.key` against the npm package name. An `id` here
// never matches, so the detail page renders no configuration area at all.
check(
  'package page is keyed by the npm package name',
  bundleEntry?.key === BUNDLE_KEY,
  String(bundleEntry?.key),
)
check(
  'package page carries no id (keyed slot is addressed by key)',
  bundleEntry?.id === undefined,
  String(bundleEntry?.id),
)

// Both surfaces must share one face, or an edit staged on one page would be
// invisible to the other and a save on the wrong page would write nothing.
// Compared on what `inject` RETURNS: each registration gets its own closure over
// the shared face, so the closures legitimately differ and comparing `inject`
// itself would fail always.
const itemFace = itemEntry?.inject?.()
const bundleFace = bundleEntry?.inject?.()
check(
  'shares one controller face across both surfaces',
  itemFace !== undefined && itemFace === bundleFace,
  itemFace === undefined || bundleFace === undefined
    ? 'a surface did not register, so there is no face to compare'
    : itemFace === bundleFace ? 'same object' : 'DIFFERENT objects',
)

report()
process.exit(failures.length === 0 ? 0 : 1)

/** Print every check with its evidence. */
function report() {
  for (const { label, ok, detail } of checks) {
    const mark = ok ? 'PASS' : 'FAIL'
    console.log(`${mark}  ${label}${detail ? `  [${detail}]` : ''}`)
  }
  if (failures.length === 0) console.log('\nclient bundle satisfies the browser kernel contract.')
  else console.log(`\n${failures.length} check(s) failed.`)
}