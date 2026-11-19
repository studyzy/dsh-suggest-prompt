/**
 * Suggested-next-prompt ghost text: reads the host's STORED suggestion over the
 * plugin's own `connection.rpc` channel and, when the session is idle with an
 * empty draft, renders it as light placeholder text INSIDE the composer
 * (overlay slot, `pointer-events: none`, so it never blocks input). Pressing the
 * configured shortcut (default `Tab`) while focus sits in the composer fills the
 * draft with the suggestion through `inputActions.setDraft`, leaving it
 * editable.
 *
 * The suggestion deliberately does NOT arrive through a session projection: a
 * projection advances only on a committed session event, and a plugin-private
 * event type is what made sessions unreadable on cold read (issue #4). See
 * ./suggestion-source.ts for the storage + RPC path that replaced it.
 *
 * `dsh >= 0.2.0` note: the composer is a Lexical `contenteditable` host, not a
 * `<textarea>`, and its native placeholder is a sibling `<div>` rather than a
 * `::placeholder` pseudo-element. Both facts drive the selectors and the focus
 * check below.
 */
import {
  useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties,
} from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SuggestPromptSuggestion } from '../types.ts'
import { parseAcceptKey } from './accept-key.ts'
import type { AcceptKeyMatcher } from './accept-key.ts'
import { findComposerCard, measureGhostBox, sameGhostBox } from './ghost-geometry.ts'
import type { GhostBox } from './ghost-geometry.ts'
import { useStoredSuggestion } from './suggestion-source.ts'

/** Full props of the overlay ghost: session standard kit (session scope). */
export type GhostSuggestionProps = PropsRuntime<'conversation.input.overlay'>

/** Fallback shortcut when the suggestion carries no key or the configured one is unparseable. */
const DEFAULT_ACCEPT_KEY = 'Tab'
const DEFAULT_ACCEPT_MATCHER: AcceptKeyMatcher = event => event.code === 'Tab'
  && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey

const STYLE_TAG_ID = 'dsh-suggest-prompt-style'
let styleUsers = 0

const CSS_TEXT = `
.dsh-suggest-prompt-ghost {
  position: absolute;
  /* FALLBACK ONLY. The component measures the draft editor's text origin at
     runtime (ghost-geometry.ts) and overrides top/left/right with inline px.
     These numbers only apply where nothing can be measured (jsdom, a detached
     tree) and mirror the current composer: card padding-top 8px + editor
     padding-top 4px, editor padding-left 14px / padding-right 8px.

     A fixed offset alone cannot work: the card is a flex column whose children
     above the editor (accessory slot, the attachments row that carries pasted
     image chips) change height, so a stylesheet offset lands on those chips as
     soon as the composer has an attachment. */
  top: 12px;
  left: 14px;
  right: 8px;
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
 * longer has a local map of completed turns to compare against. Freshness is
 * derived from state the client does have: the stored suggestion carries the
 * turn it answers, and `running` tells us whether a newer turn is in flight. A
 * suggestion is therefore current while the agent is idle, and is hidden the
 * moment a new turn starts (which is when the stale text would otherwise linger
 * under a fresh draft).
 * @param suggestion - the latest stored suggestion, or `null`.
 * @param running - whether the session agent is mid-turn.
 * @param draft - the current composer draft.
 * @returns the suggestion text to surface, or `undefined` to show nothing.
 */
function currentSuggestion(
  suggestion: SuggestPromptSuggestion | null,
  running: boolean,
  draft: string,
): string | undefined {
  if (running) return undefined
  if (suggestion === null) return undefined
  if (draft.trim() !== '') return undefined
  return suggestion.text
}

/**
 * Render the suggestion as placeholder text inside the composer; accept on the
 * configured shortcut (default Tab).
 *
 * @param props - standard session kit (session snapshot, input state, actions).
 */
export function GhostSuggestion({
  useSession, useInput, inputActions, sessionId,
}: GhostSuggestionProps) {
  const suggestion = useStoredSuggestion(sessionId)
  const running = useSession(s => s.running)
  const draft = useInput(s => s.draft)
  const phase = useInput(s => s.phase)

  const text = phase === undefined || phase === 'plain'
    ? currentSuggestion(suggestion, running, draft) : undefined

  // A malformed configured shortcut degrades to the default Tab matcher
  // instead of disabling accept entirely.
  const acceptMatcher = useMemo(
    () => parseAcceptKey(suggestion?.acceptKey ?? DEFAULT_ACCEPT_KEY) ?? DEFAULT_ACCEPT_MATCHER,
    [suggestion?.acceptKey],
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

  // Align the ghost with the draft's text origin instead of trusting a
  // stylesheet offset: the overlay anchor sits at the CARD's top edge, while the
  // editor can be pushed down by the accessory slot and by the attachments row
  // (pasted image chips). Measuring keeps the ghost on the first text line no
  // matter what the composer stacks above it, and re-measuring on resize covers
  // an attachment appearing, a font-size preference change, or the composer
  // switching between hero and docked layouts.
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const [ghostBox, setGhostBox] = useState<GhostBox | undefined>(undefined)

  useLayoutEffect(() => {
    const node = ghostRef.current
    const card = node === null ? null : findComposerCard(node)
    if (node === null || card === null) {
      setGhostBox(previous => (previous === undefined ? previous : undefined))
      return
    }
    // rAF-debounced so a ResizeObserver callback cannot re-enter layout in the
    // same frame (which browsers report as an observer loop).
    let frame: number | undefined
    const sync = (): void => {
      const next = measureGhostBox(card)
      setGhostBox(previous => (sameGhostBox(previous, next) ? previous : next))
    }
    const schedule = (): void => {
      if (typeof requestAnimationFrame !== 'function') {
        sync()
        return
      }
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        sync()
      })
    }
    sync()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : undefined
    if (observer !== undefined) {
      observer.observe(card)
      const scroll = card.querySelector('[data-input-scroll]')
      if (scroll !== null) observer.observe(scroll)
    }
    window.addEventListener('resize', schedule)
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [text])

  if (text === undefined) return null
  const ghostStyle: CSSProperties | undefined = ghostBox === undefined
    ? undefined
    : {
      top: `${ghostBox.top}px`,
      left: `${ghostBox.left}px`,
      right: 'auto',
      width: `${ghostBox.width}px`,
    }
  return (
    <div style={ROOT_STYLE} data-suggest-prompt-ghost="">
      <div ref={ghostRef} className="dsh-suggest-prompt-ghost" style={ghostStyle} aria-hidden>
        {text}
      </div>
    </div>
  )
}
