/**
 * Suggested-next-prompt surface plugin, browser half: a conversation.input.overlay
 * bridge entry that renders the host-computed suggest-prompt projection as light
 * placeholder text INSIDE the composer textarea, plus the plugin's card in the
 * WebUI Plugins settings tab (provider/model for the suggestion route).
 * Projection-mode surface — the suggestion arrives through
 * `useProjection('suggestPrompt')` (seeded by the history tail page, updated by
 * session/projection frames), so this plugin owns no store, no refresh chain,
 * and no event listener; accepting a suggestion rides the standard kit's
 * `inputActions.setDraft`.
 *
 * The overlay and settings registrations use the `dsh >= 0.2.0` shape: a slot's
 * `inject` callback resolves the face the entry needs, and the standard session
 * props (`useSession`, `useProjection`, `useInput`, `inputActions`) arrive on
 * the component rather than through a package-level client runtime module.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ui-conversation SlotMap merge (the input.overlay entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the settings.plugins.tab SlotMap merge, the ctx.configForms
// service merge, and the ctx.slots merge the renderer supplies.
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

/** Required services for the suggestion ghost bridge (the slot registry only). */
export const inject = ['slots']

/**
 * Client plugin body: the GhostSuggestion overlay bridge entry, plus the
 * suggest-prompt settings card when the Plugins settings surface is composed.
 * The settings card is an enhancement over the core ghost bridge, so it mounts
 * on a scoped inject rather than the top-level dependency list — a deployment
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
    // Bound once here: registration-time text (the tab label thunk) and the
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

    settingsCtx.slots.inject('settings.plugins.tab', () => settingsCtx.slots.register({
      name: 'settings.plugins.tab',
      id: SUGGEST_PROMPT_NS,
      order: 30,
      // Slot labels are plain strings or thunks; the Plugins section resolves
      // the thunk against the locale revision so the tab re-labels on switch.
      label: () => t('title'),
      locale: NS,
      inject: () => settings.inject(),
    }, SettingsCard))
  })
}