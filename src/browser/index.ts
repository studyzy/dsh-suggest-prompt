/**
 * Suggested-next-prompt surface plugin, browser half: a conversation.input.overlay
 * bridge entry that renders the host-computed suggest-prompt projection as light
 * placeholder text INSIDE the composer textarea, plus the plugin's configuration
 * card on the WebUI **Plugins** page (provider/model for the suggestion route).
 * Projection-mode surface — the suggestion arrives through
 * `useProjection('suggestPrompt')` (seeded by the history tail page, updated by
 * session/projection frames), so this plugin owns no store, no refresh chain,
 * and no event listener; accepting a suggestion rides the standard kit's
 * `inputActions.setDraft`.
 *
 * The overlay and configuration registrations use the `dsh >= 0.2.0` shape: a
 * slot's `inject` callback resolves the face the entry needs, and the standard
 * session props (`useSession`, `useProjection`, `useInput`, `inputActions`)
 * arrive on the component rather than through a package-level client runtime
 * module.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: declares the two Plugins-page seats this plugin registers into
// (`plugins.item`, `plugins.bundle.config`). They come from the plugin-manager
// client bundle at runtime, so this plugin transcribes them rather than
// depending on it — see the file for why.
import type {} from './plugins-page-slots.d.ts'
// Type-only: pulls the ui-conversation SlotMap merge (the input.overlay entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the ctx.configForms service merge, plus the ctx.slots merge the
// renderer supplies.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.locale Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { GhostSuggestion } from './GhostSuggestion.tsx'
import { SettingsCard } from './SettingsCard.tsx'
import { SuggestPromptCardController, SUGGEST_PROMPT_NS } from './settings-controller.ts'
import type {
  DeepSeekCatalog, PiAiProviderCatalog, SuggestPromptSettings,
} from './settings-controller.ts'
import { en, zh } from './settings-locales.ts'

// Re-export the shared pure types so the package's `./client` outlet keeps
// exposing the `suggestPrompt` projection declaration to client consumers
// (single-package: browser code lives in-package and reaches types directly).
export type * from '../types.ts'

export { GhostSuggestion } from './GhostSuggestion.tsx'
export { SettingsCard } from './SettingsCard.tsx'
export { SUGGEST_PROMPT_NS } from './settings-controller.ts'

/** Locale namespace of the settings card copy. */
const NS = 'suggest-prompt.settings'

/**
 * This package's name, which is the key its own bundle configuration registers
 * under.
 *
 * `plugins.bundle.config` is a **keyed** slot addressed by the *package* name,
 * not by the settings namespace: the page computes `configured` as
 * `ledger.bundles.has(pkg.name)`, so a namespace key (or an `id`, which a keyed
 * slot does not read at all) registers without erroring and then never matches
 * — the configuration section silently never renders.
 *
 * Spelled as a literal rather than imported from `package.json`: the client
 * bundle is a browser artifact, and pulling the manifest in would either inline
 * the whole file or need a bundler-specific JSON import. The value cannot drift
 * without the page losing the section outright, which is exactly what
 * tests/slot-contract.client.spec.tsx and scripts/verify-client-bundle.mjs
 * assert against.
 */
const PACKAGE_NAME = '@studyzy/dsh-suggest-prompt'

/**
 * The official-plugins seat this plugin's configuration card occupies.
 *
 * A root-scoped **list** slot declared at runtime by the Plugins page (the
 * plugin-manager client bundle), alongside `plugins.bundle.config` and
 * `plugins.row.config`. It is not merged into `SlotMap` by any published type
 * package, so the key is spelled here; `ctx.slots.register` is generic over the
 * key at runtime, and only type-only imports stay free of the merge.
 */
const PLUGINS_ITEM = 'plugins.item'

/**
 * The per-bundle configuration seat, a root-scoped **keyed** slot.
 *
 * Declared by the same Plugins page as {@link PLUGINS_ITEM}. This package needs
 * it in addition to the official card because it is a *profile dependency*: it
 * is both a `bundles` member and a `dependencies` member of the profile, so the
 * page files it under the "Installed" group as a package card too. That card's
 * detail page — the one carrying the enable switch, which is where users look
 * first — renders its configuration from this seat, and only when `configured`
 * is true, i.e. only when this registration carries the package name as its key.
 */
const BUNDLE_CONFIG = 'plugins.bundle.config'

/** Registration order of the official-plugins card among the contributed cards. */
const ITEM_ORDER = 30

/** Required services for the suggestion ghost bridge (the slot registry only). */
export const inject = ['slots']

/**
 * Client plugin body: the GhostSuggestion overlay bridge entry, plus the
 * suggest-prompt configuration card when the WebUI Plugins surface is composed.
 * The card is an enhancement over the core ghost bridge, so it mounts on a
 * scoped inject rather than the top-level dependency list — a deployment
 * without the WebUI settings surface still gets ghost suggestions.
 *
 * The card reads and writes the entry's config form through `ctx.configForms`
 * (provided by ui-settings), which is named in the scoped inject: without it the
 * scoped child never runs and the ghost bridge is unaffected.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'suggest-prompt',
    order: 30,
  }, GhostSuggestion))

  ctx.inject(['configForms', 'locale'], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.locale.register(NS, { zh, en }),
      'ui-suggest-prompt: settings card dictionary',
    )
    // Bound once here: registration-time text (the card label thunk) and the
    // card's injected face share one translate, so copy freshness rides the
    // locale revision.
    const t = settingsCtx.locale.bind(NS)

    const settings = new SuggestPromptCardController(
      settingsCtx.configForms.get<SuggestPromptSettings>(SUGGEST_PROMPT_NS),
      settingsCtx.configForms.get<PiAiProviderCatalog>('llm-pi-ai'),
      settingsCtx.configForms.get<DeepSeekCatalog>('llm-deepseek'),
    )
    // Unload the card's form observers with this fiber (HMR reload must not
    // leave the controller wired into the shared forms).
    settingsCtx.effect(() => () => { settings.dispose() }, 'ui-suggest-prompt: settings card form observers')

    // ONE face for BOTH surfaces. The renderer calls a registration's `inject`
    // once per surface, so `() => settings.inject()` would hand each surface its
    // own copy of the staged-edit table: an edit made on one page would be
    // invisible on the other, and saving from the stale page would write its own
    // empty draft — a silent "I did change that" bug the browser never reports.
    // Binding once makes the draft and the revision-fenced write shared.
    const face = settings.inject()

    // The two seats the Plugins page can show this plugin's configuration in.
    // Both are required, because the page renders a profile dependency twice:
    // an official-plugins card (`plugins.item`, by id) and an installed-package
    // card (`plugins.bundle.config`, by package name). Registering only one
    // leaves the other entry point showing a description and a component list
    // with no way to configure anything.
    //
    // No separate `effect` wrapper: `slots.inject` already rides this fiber's
    // lifetime, so unloading the plugin (or an HMR reload) drops both entries.
    settingsCtx.slots.inject(PLUGINS_ITEM, () => settingsCtx.slots.register({
      name: PLUGINS_ITEM,
      id: SUGGEST_PROMPT_NS,
      order: ITEM_ORDER,
      // Slot labels are plain strings or thunks; the Plugins page resolves the
      // thunk against the locale revision so the card re-labels on switch.
      label: () => t('title'),
      locale: NS,
      inject: () => face,
    }, SettingsCard))

    // Keyed by package name, and asked for `view: 'page'` only: the package page
    // renders one configuration section, with no summary render to answer.
    settingsCtx.slots.inject(BUNDLE_CONFIG, () => settingsCtx.slots.register({
      name: BUNDLE_CONFIG,
      key: PACKAGE_NAME,
      locale: NS,
      inject: () => face,
    }, SettingsCard))
  })
}