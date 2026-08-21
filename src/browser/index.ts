/**
 * Suggested-next-prompt surface plugin, browser half: a conversation.input.overlay
 * bridge entry that renders the host-computed suggest-prompt projection as light
 * placeholder text INSIDE the composer textarea, plus the plugin's settings card
 * in the WebUI plugin section (provider/model for the suggestion route).
 * Projection-mode surface — the suggestion arrives through
 * `useProjection('suggestPrompt')` (seeded by the history tail page, updated by
 * session/projection frames), so this plugin owns no store, no refresh chain,
 * and no event listener; accepting a suggestion rides the standard kit's
 * `inputActions.setDraft`.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.overlay entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the settings.plugin.item SlotMap merge and the ctx.settingsScope
// Context merge; both are provided by composed harness surfaces.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the ctx.locale Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { GhostSuggestion } from './GhostSuggestion.tsx'
import { SettingsCard } from './SettingsCard.tsx'
import { SuggestPromptCardController, SUGGEST_PROMPT_NS } from './settings-controller.ts'
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
 * suggest-prompt settings card when the settings surface is composed. The
 * settings card is an enhancement over the core ghost bridge, so it mounts on
 * a scoped inject rather than the top-level dependency list — a deployment
 * without the WebUI settings surface still gets ghost suggestions.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'suggest-prompt',
    order: 30,
  }, GhostSuggestion))

  ctx.inject(['settingsScope', 'locale'], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.locale.register(NS, { zh, en }),
      'ui-suggest-prompt: settings card dictionary',
    )

    const settings = new SuggestPromptCardController(
      settingsCtx.settingsScope.bind<{ provider?: string; model?: string }>({ namespace: SUGGEST_PROMPT_NS }),
      settingsCtx.settingsScope.bind<{ providers?: Record<string, { models?: Array<{ id: string }> }> }>({
        namespace: 'llm-pi-ai',
      }),
      settingsCtx.settingsScope.bind<{ models?: Array<{ id: string }> }>({ namespace: 'llm-deepseek' }),
    )
    // Unload the card's scope observers with this fiber (HMR reload must not
    // leave the controller wired into the bound scopes).
    settingsCtx.effect(() => () => { settings.dispose() }, 'ui-suggest-prompt: settings card scope observers')
    settingsCtx.slots.inject('settings.plugin.item', () => settingsCtx.slots.register({
      name: 'settings.plugin.item',
      key: SUGGEST_PROMPT_NS,
      locale: NS,
      inject: () => settings.inject(),
    }, SettingsCard))
  })
}
