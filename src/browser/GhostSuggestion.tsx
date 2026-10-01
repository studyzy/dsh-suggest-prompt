/**
 * Suggested-next-prompt ghost text: reads the `suggestPrompt` projection and,
 * when the session is idle with an empty draft, renders the current suggestion
 * as light placeholder text INSIDE the composer (overlay slot,
 * `pointer-events: none`, so it never blocks input). Pressing the configured
 * shortcut (default `Tab`) while focus sits in the composer fills the draft
 * with the suggestion through `inputActions.setDraft`, leaving it editable.
 *
 * `dsh >= 0.2.0` note: the composer is a Lexical `contenteditable` host, not a
 * `<textarea>`, and its native placeholder is a sibling `<div>` rather than a
 * `::placeholder` pseudo-element. Both facts drive the selectors and the focus
 * check below.
 */
import { useEffect, useMemo, type CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the `suggestPrompt` SessionProjectionMap key merge (the
// projection's ONE home). In-package relative reference (no package self-import).
import type { SuggestPromptProjection } from '../types.ts'
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
     Align the ghost with the editor's text origin: the card adds 10px top
     padding and the editor scroll layer adds 4px top / 16px left (see
     InputBar/DraftEditor). pointer-events:none keeps the caret and clicks on
     the editor. */
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
/* The native composer placeholder ("给智能体发消息") occupies the SAME text
   origin as the ghost. In dsh >= 0.2.0 it is a real element, not a textarea
   ::placeholder pseudo-element, so hiding it means hiding that node: while a
   ghost is visible the two would otherwise paint on top of each other and
   neither reads. Scoped with :has() to the composer that actually carries a
   ghost, so the built-in placeholder is untouched everywhere else.

   Visibility (not display) is deliberate: the node still occupies its box, so
   the composer's height and the ghost's baseline do not shift when the
   suggestion appears or is accepted. */
[data-composer-card]:has(.dsh-suggest-prompt-ghost) [data-composer-placeholder] {
  visibility: hidden;
}
/* Older assemblies (and any future regression back to a textarea) paint the
   placeholder with the pseudo-element; WebKit uses -webkit-text-fill-color,
   which outranks color, so both must go transparent. */
[data-composer-card]:has(.dsh-suggest-prompt-ghost) textarea::placeholder {
  color: transparent;
  -webkit-text-fill-color: transparent;
}
`

const ROOT_STYLE: CSSProperties = { display: 'contents' }

/**
 * Whether focus currently sits in the chat composer's editor.
 *
 * The composer changed shape in `dsh >= 0.2.0` (Lexical `contenteditable` host
 * instead of a `<textarea>`), so this matches either form rather than
 * asserting one. The editor layer's `[data-input-scroll]` marker is the stable
 * anchor: it identifies the composer regardless of the inner element, and a
 * node inside it therefore means "the user is typing a prompt".
 * @returns true when the active element belongs to the composer editor.
 */
function isComposerFocused(): boolean {
  const active = document.activeElement
  if (active === null) return false
  if (active instanceof HTMLTextAreaElement) return true
  if (!(active instanceof HTMLElement)) return false
  // The editable host itself, or anything inside it (a chip portal, a decorator).
  return active.isContentEditable || active.closest('[data-input-scroll]') !== null
}

/**
 * The suggestion to surface, or `undefined` when none should show.
 *
 * `dsh >= 0.2.0` removed `turnEnds` from the Session snapshot, so the client no
 * longer has a local map of completed turns to compare against. The pairing is
 * instead derived from state the host already committed: the `suggestPrompt`
 * projection carries the turn it answers, and `running` tells us whether a
 * newer turn is currently in flight. A suggestion is therefore current while
 * the agent is idle, and is hidden the moment a new turn starts (which is when
 * the stale text would otherwise linger under a fresh draft).
 * @param projection - the live `suggestPrompt` projection value.
 * @param running - whether the session agent is mid-turn.
 * @param draft - the current composer draft.
 * @returns the suggestion text to surface, or `undefined` to show nothing.
 */
function currentSuggestion(
  projection: SuggestPromptProjection | undefined,
  running: boolean,
  draft: string,
): string | undefined {
  if (running) return undefined
  if (projection === null || projection === undefined) return undefined
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
  const draft = useInput(s => s.draft)

  const text = currentSuggestion(projection, running, draft)

  // A malformed configured shortcut degrades to the default Tab matcher
  // instead of disabling accept entirely.
  const acceptMatcher = useMemo(
    () => parseAcceptKey(projection?.acceptKey ?? DEFAULT_ACCEPT_KEY) ?? DEFAULT_ACCEPT_MATCHER,
    [projection?.acceptKey],
  )

  // Accept the suggestion into the draft (editable) on the configured
  // shortcut while the composer editor holds focus. Intercepting Tab here is
  // what stops the browser from moving focus instead of adopting the text.
  //
  // Focus detection must accept BOTH composer shapes: `dsh >= 0.2.0` replaced
  // the `<textarea>` with a Lexical `contenteditable` host, so an
  // `instanceof HTMLTextAreaElement` test never matches on a current build and
  // Tab silently did nothing.
  useEffect(() => {
    if (text === undefined) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      if (!acceptMatcher(event)) return
      if (!isComposerFocused()) return
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
