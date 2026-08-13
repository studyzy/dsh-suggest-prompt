/**
 * Ghost suggestion surface plugin, browser half: a conversation.input.dock
 * bridge entry that pushes the host-computed suggest-prompt projection into
 * the composer's ghost decoration. Projection-mode surface — the suggestion
 * arrives through `useProjection('suggestPrompt')` (seeded by the history tail
 * page, updated by session/projection frames), so this plugin owns no store,
 * no refresh chain, and no event listener; the standard kit's
 * `inputActions.setGhost`/`setDraft` are the only verbs.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.dock entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { GhostSuggestion } from './GhostSuggestion.tsx'

export { GhostSuggestion } from './GhostSuggestion.tsx'

/** Required services for the ghost bridge: the slot registry only. */
export const inject = ['slots']

/**
 * Client plugin body: the GhostSuggestion dock bridge entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'suggest-prompt',
    order: 30,
  }, GhostSuggestion))
}
