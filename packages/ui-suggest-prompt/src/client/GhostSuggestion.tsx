/**
 * Suggested-next-prompt ghost text: reads the `suggestPrompt` projection and,
 * when the session just completed a turn and the draft is empty, renders the
 * current suggestion as light placeholder text INSIDE the composer textarea
 * (overlay slot, pointer-events: none, so it never blocks input). Pressing the
 * configured shortcut (default `Tab`, like Claude Code) while focus sits in the
 * composer fills the draft with the suggestion through `inputActions.setDraft`,
 * leaving it editable.
 */
import { useEffect, useMemo, type CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the `suggestPrompt` SessionProjectionMap key merge through
// the pure client outlet (the projection's ONE home).
import type {} from '@studyzy/dsh-suggest-prompt/client'
import type { SuggestPromptProjection } from '@studyzy/dsh-suggest-prompt/client'
import { parseAcceptKey } from './accept-key.ts'
import type { AcceptKeyMatcher } from './accept-key.ts'

/** Full props of the overlay ghost: session standard kit (session scope). */
export type GhostSuggestionProps = PropsRuntime<'conversation.input.overlay'>

/** Fallback shortcut when the projection carries no key or the configured one is unparseable. */
const DEFAULT_ACCEPT_KEY = 'Tab'
const DEFAULT_ACCEPT_MATCHER: AcceptKeyMatcher = event => event.code === 'Tab'
  && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey

const STYLE_TAG_ID = 'dsh-suggest-prompt-style'
let styleUsers = 0

const CSS_TEXT = `
.dsh-suggest-prompt-ghost {
  position: absolute;
  /* overlayAnchor sits at the composer card's top edge (inset: 0 0 auto).
     Align the ghost with the textarea's text origin: the card adds 10px top
     padding and the backdrop layer adds 4px top / 16px left (see InputBar).
     pointer-events:none keeps the caret and clicks on the textarea. */
  top: calc(10px + 4px);
  left: 16px;
  right: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: hidden;
  font: inherit;
  font-size: inherit;
  line-height: inherit;
  color: var(--dsw-alias-label-tertiary, #68707d);
  pointer-events: none;
  user-select: none;
}
/* The native composer placeholder (e.g. "给智能体发消息") renders at the same
   text origin as the ghost, so a suggestion would overlap it while the draft
   is empty. Hide it for the composer card that carries a visible ghost.
   WebKit paints placeholder glyphs with -webkit-text-fill-color (which
   outranks color), so BOTH properties must go transparent. */
[data-composer-card]:has(.dsh-suggest-prompt-ghost) textarea::placeholder {
  color: transparent;
  -webkit-text-fill-color: transparent;
}
`

const ROOT_STYLE: CSSProperties = { display: 'contents' }

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
 * The suggestion to surface, or `undefined` when none should show: the
 * `suggestPrompt` projection answers the session's latest completed turn while
 * the agent is idle and the draft is empty.
 * @param projection - the live `suggestPrompt` projection value.
 * @param running - whether the session agent is mid-turn.
 * @param lastTurn - the session's latest completed turn.
 * @param draft - the current composer draft.
 * @returns the suggestion text to surface, or `undefined` to show nothing.
 */
function currentSuggestion(
  projection: SuggestPromptProjection | undefined,
  running: boolean,
  lastTurn: number | undefined,
  draft: string,
): string | undefined {
  if (running) return undefined
  if (projection === null || projection === undefined) return undefined
  if (lastTurn === undefined || projection.turn !== lastTurn) return undefined
  if (draft.trim() !== '') return undefined
  return projection.text
}

/**
 * Render the suggestion as placeholder text inside the composer; accept on the
 * configured shortcut (default Tab).
 * @param props - standard kit faces (session snapshot, input state, actions, projection).
 */
export function GhostSuggestion({
  useSession, useInput, useProjection, inputActions,
}: GhostSuggestionProps) {
  const projection = useProjection('suggestPrompt')
  const running = useSession(s => s.running)
  const lastTurn = useSession(s => lastCompletedTurn(s.turnEnds))
  const draft = useInput(s => s.draft)

  const text = currentSuggestion(projection, running, lastTurn, draft)

  // A malformed configured shortcut degrades to the default Tab matcher
  // instead of disabling accept entirely.
  const acceptMatcher = useMemo(
    () => parseAcceptKey(projection?.acceptKey ?? DEFAULT_ACCEPT_KEY) ?? DEFAULT_ACCEPT_MATCHER,
    [projection?.acceptKey],
  )

  // Accept the suggestion into the draft (editable) on the configured
  // shortcut while the composer textarea holds focus. Intercepting Tab here
  // is what prevents the browser from moving focus instead.
  useEffect(() => {
    if (text === undefined) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      if (!acceptMatcher(event)) return
      if (!(document.activeElement instanceof HTMLTextAreaElement)) return
      event.preventDefault()
      inputActions.setDraft(text)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [text, acceptMatcher, inputActions])

  // Inject the ghost styles once for as long as this plugin is mounted.
  useEffect(() => {
    styleUsers += 1
    if (document.getElementById(STYLE_TAG_ID) === null) {
      const tag = document.createElement('style')
      tag.id = STYLE_TAG_ID
      tag.textContent = CSS_TEXT
      document.head.appendChild(tag)
    }
    return () => {
      styleUsers -= 1
      if (styleUsers !== 0) return
      document.getElementById(STYLE_TAG_ID)?.remove()
    }
  }, [])

  if (text === undefined) return null
  return (
    <div style={ROOT_STYLE} data-suggest-prompt-ghost="">
      <div className="dsh-suggest-prompt-ghost" aria-hidden>
        {text}
      </div>
    </div>
  )
}
