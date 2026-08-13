/**
 * Ghost suggestion bridge: reads the `suggestPrompt` projection and pushes
 * the current suggestion into the composer's ghost decoration when the
 * session just completed a turn and the draft is empty. Accepts the ghost via
 * the configured shortcut (default `Tab`, like Claude Code) while focus sits
 * in the composer — pressing it fills the draft with the suggestion, leaving
 * it editable. Renders nothing — the ghost is the textarea placeholder, so
 * the visual surface is the input itself.
 */
import { useEffect, useMemo } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the `suggestPrompt` SessionProjectionMap key merge through
// the pure client outlet (the projection's ONE home).
import type {} from '@studyzy/dsh-suggest-prompt/client'
import { parseAcceptKey } from './accept-key.ts'
import type { AcceptKeyMatcher } from './accept-key.ts'

/** Full props of the dock bridge: InputZone owner share + session standard kit. */
export type GhostSuggestionProps = PropsRuntime<'conversation.input.dock'>

/** Fallback shortcut when the projection carries no key or the configured one is unparseable. */
const DEFAULT_ACCEPT_KEY = 'Tab'
const DEFAULT_ACCEPT_MATCHER: AcceptKeyMatcher = event => event.code === 'Tab'
  && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey

/**
 * The session's latest completed turn. `turnEnds` maps in-window turn numbers
 * to their `turn/end` event seqs in event order, so the last key is the newest
 * completed turn.
 */
function lastCompletedTurn(turnEnds: ReadonlyMap<number, number>): number | undefined {
  let last: number | undefined
  for (const turn of turnEnds.keys()) last = turn
  return last
}

/**
 * Push the ghost decoration for the current suggestion; accept on the
 * configured shortcut (default Tab).
 * @param props - standard kit faces (session snapshot, input state, actions, projection).
 * @returns null; all effects ride the input machine's ghost state.
 */
export function GhostSuggestion({
  useSession, useInput, useProjection, inputActions,
}: GhostSuggestionProps) {
  const projection = useProjection('suggestPrompt')
  const running = useSession(s => s.running)
  const lastTurn = useSession(s => lastCompletedTurn(s.turnEnds))
  const draft = useInput(s => s.draft)
  const ghostText = !running
    && projection !== null && projection !== undefined
    && lastTurn !== undefined && projection.turn === lastTurn
    && draft.trim() === ''
    ? projection.text
    : ''

  // A malformed configured shortcut degrades to the default Tab matcher
  // instead of disabling accept entirely.
  const acceptMatcher = useMemo(
    () => parseAcceptKey(projection?.acceptKey ?? DEFAULT_ACCEPT_KEY) ?? DEFAULT_ACCEPT_MATCHER,
    [projection?.acceptKey],
  )

  // Push the decoration; the machine no-ops on identical text, so unchanged
  // ghosts never re-render through this path.
  useEffect(() => {
    inputActions.setGhost(ghostText)
  }, [ghostText, inputActions])

  // Accept the suggestion into the draft (editable) on the configured
  // shortcut while the composer textarea holds focus. Intercepting Tab here
  // is what prevents the browser from moving focus instead.
  useEffect(() => {
    if (ghostText === '') return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      if (!acceptMatcher(event)) return
      if (!(document.activeElement instanceof HTMLTextAreaElement)) return
      event.preventDefault()
      inputActions.setDraft(ghostText)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [ghostText, acceptMatcher, inputActions])

  return null
}
