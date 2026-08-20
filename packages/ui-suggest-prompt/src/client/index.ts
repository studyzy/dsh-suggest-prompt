/**
 * Suggested-next-prompt surface plugin, browser half: a conversation.input.overlay
 * bridge entry that renders the host-computed suggest-prompt projection as light
 * placeholder text INSIDE the composer textarea. Projection-mode surface — the
 * suggestion arrives through `useProjection('suggestPrompt')` (seeded by the
 * history tail page, updated by session/projection frames), so this plugin owns
 * no store, no refresh chain, and no event listener; accepting a suggestion
 * rides the standard kit's `inputActions.setDraft`.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.overlay entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { GhostSuggestion } from './GhostSuggestion.tsx'

export { GhostSuggestion } from './GhostSuggestion.tsx'

/** Required services for the suggestion ghost bridge: the slot registry only. */
export const inject = ['slots']

/**
 * Client plugin body: the GhostSuggestion overlay bridge entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'suggest-prompt',
    order: 30,
  }, GhostSuggestion))
}
