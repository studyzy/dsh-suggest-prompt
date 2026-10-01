// @vitest-environment jsdom
/**
 * Ghost suggestion bridge behavior: the computed suggestion (projection turn
 * matches the latest completed turn, session idle, empty draft) is rendered as
 * light placeholder text inside the composer (data-suggest-prompt-ghost), and
 * the configured accept shortcut (default Tab, like Claude Code) fills the
 * draft through setDraft while the composer textarea holds focus.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { GhostSuggestion } from '../src/browser/GhostSuggestion.tsx'
import type { GhostSuggestionProps } from '../src/browser/GhostSuggestion.tsx'
import type { SuggestPromptProjection } from '@studyzy/dsh-suggest-prompt/client'

afterEach(cleanup)

const SID = 's1' as SessionId

const SUGGESTION: NonNullable<SuggestPromptProjection> = {
  turn: 3,
  baseSeq: 40,
  text: '继续修复登录页',
  truncated: false,
  requestSeq: 42,
  acceptKey: 'Tab',
}

function kit(over: {
  running?: boolean
  draft?: string
  projection?: SuggestPromptProjection | undefined
} = {}) {
  const setDraft = vi.fn()
  const session = { running: over.running ?? false }
  const props = {
    sessionId: SID,
    useSession: (selector: (s: ConversationSnapshot) => unknown) => selector(session as ConversationSnapshot),
    useInput: (selector: (s: { draft: string }) => unknown) => selector({ draft: over.draft ?? '' }),
    useProjection: (key: string) => (key === 'suggestPrompt' ? over.projection : undefined),
    inputActions: { setDraft },
  } as unknown as GhostSuggestionProps
  return { setDraft, props }
}

/** The rendered ghost layer element, or null when no ghost shows. */
function ghostLayer(): HTMLElement | null {
  return document.querySelector('[data-suggest-prompt-ghost]')
}

/** The visible ghost text content, or '' when no ghost shows. */
function ghostText(): string {
  return ghostLayer()?.textContent ?? ''
}

/** Focus a throwaway textarea and return it (removed by the caller's cleanup). */
function focusedTextarea(): HTMLTextAreaElement {
  const textarea = document.createElement('textarea')
  document.body.appendChild(textarea)
  textarea.focus()
  return textarea
}

/**
 * Build the `dsh >= 0.2.0` composer shape and focus its editable host: a
 * `[data-input-scroll]` layer wrapping a Lexical `contenteditable` div. The
 * composer is no longer a `<textarea>`, which is exactly what the accept path
 * must tolerate.
 * @returns the focused contenteditable host element.
 */
function focusedContentEditable(): HTMLElement {
  const scroll = document.createElement('div')
  scroll.setAttribute('data-input-scroll', '')
  const host = document.createElement('div')
  host.setAttribute('contenteditable', 'true')
  host.tabIndex = 0
  scroll.appendChild(host)
  document.body.appendChild(scroll)
  host.focus()
  return host
}

/** Dispatch a keydown on the window and return the (cancelable) event. */
function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(event)
  return event
}

describe('GhostSuggestion bridge', () => {
  it('renders the suggestion when it answers the latest completed turn on an idle empty draft', () => {
    const { props } = kit({ projection: SUGGESTION })
    render(<GhostSuggestion {...props} />)
    expect(ghostText()).toBe('继续修复登录页')
  })

  it('renders nothing while the agent is running', () => {
    const { props } = kit({ projection: SUGGESTION, running: true })
    render(<GhostSuggestion {...props} />)
    expect(ghostLayer()).toBeNull()
  })

  it('renders nothing while the draft has text', () => {
    const { props } = kit({ projection: SUGGESTION, draft: '在输入' })
    render(<GhostSuggestion {...props} />)
    expect(ghostLayer()).toBeNull()
  })

  it('renders nothing once a new turn starts, so stale text never outlives its turn', () => {
    // rc.2 removed the client's `turnEnds` map, so freshness is derived from the
    // running flag: a suggestion is current only while the agent is idle.
    const { props } = kit({ projection: SUGGESTION, running: true })
    render(<GhostSuggestion {...props} />)
    expect(ghostLayer()).toBeNull()
  })

  it('re-shows the persisted suggestion when the draft is cleared again', () => {
    const { props } = kit({ projection: SUGGESTION, draft: '在输入' })
    const view = render(<GhostSuggestion {...props} />)
    expect(ghostLayer()).toBeNull()
    const { props: cleared } = kit({ projection: SUGGESTION })
    view.rerender(<GhostSuggestion {...cleared} />)
    expect(ghostText()).toBe('继续修复登录页')
  })

  it('renders nothing before the first suggestion or without a projection', () => {
    for (const projection of [null, undefined]) {
      const { props } = kit({ projection })
      render(<GhostSuggestion {...props} />)
      expect(ghostLayer()).toBeNull()
      cleanup()
    }
  })

  it('Tab fills the draft with the suggestion while the composer textarea holds focus', () => {
    const { setDraft, props } = kit({ projection: SUGGESTION })
    render(<GhostSuggestion {...props} />)
    const textarea = focusedTextarea()
    let event: KeyboardEvent | undefined
    act(() => {
      event = press({ key: 'Tab', code: 'Tab' })
    })
    expect(event?.defaultPrevented).toBe(true)
    expect(setDraft).toHaveBeenCalledWith('继续修复登录页')
    textarea.remove()
  })

  it('Tab is ignored when the composer textarea does not hold focus', () => {
    const { setDraft, props } = kit({ projection: SUGGESTION })
    render(<GhostSuggestion {...props} />)
    const event = press({ key: 'Tab', code: 'Tab' })
    expect(event.defaultPrevented).toBe(false)
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('Tab with a modifier is not the accept shortcut', () => {
    const { setDraft, props } = kit({ projection: SUGGESTION })
    render(<GhostSuggestion {...props} />)
    const textarea = focusedTextarea()
    act(() => {
      press({ key: 'Tab', code: 'Tab', shiftKey: true })
    })
    expect(setDraft).not.toHaveBeenCalled()
    textarea.remove()
  })

  it('an IME composition keydown never accepts the suggestion', () => {
    const { setDraft, props } = kit({ projection: SUGGESTION })
    render(<GhostSuggestion {...props} />)
    const textarea = focusedTextarea()
    act(() => {
      press({ key: 'Tab', code: 'Tab', isComposing: true })
    })
    expect(setDraft).not.toHaveBeenCalled()
    textarea.remove()
  })

  it('Tab is ignored when there is no suggestion to accept', () => {
    const { setDraft, props } = kit({ projection: null })
    render(<GhostSuggestion {...props} />)
    const textarea = focusedTextarea()
    const event = press({ key: 'Tab', code: 'Tab' })
    expect(event.defaultPrevented).toBe(false)
    expect(setDraft).not.toHaveBeenCalled()
    textarea.remove()
  })

  it('a configured custom shortcut fills the draft instead of Tab', () => {
    const { setDraft, props } = kit({ projection: { ...SUGGESTION, acceptKey: 'Alt+Slash' } })
    render(<GhostSuggestion {...props} />)
    const textarea = focusedTextarea()
    act(() => {
      press({ key: '/', code: 'Slash', altKey: true })
    })
    expect(setDraft).toHaveBeenCalledWith('继续修复登录页')
    act(() => {
      press({ key: 'Tab', code: 'Tab' })
    })
    expect(setDraft).toHaveBeenCalledTimes(1)
    textarea.remove()
  })

  // `dsh >= 0.2.0` replaced the composer `<textarea>` with a Lexical
  // `contenteditable` host. An `instanceof HTMLTextAreaElement` focus test made
  // Tab silently do nothing on a current build, so both shapes must accept.
  it('Tab fills the draft when the contenteditable composer host holds focus', () => {
    const { setDraft, props } = kit({ projection: SUGGESTION })
    render(<GhostSuggestion {...props} />)
    const host = focusedContentEditable()
    let event: KeyboardEvent | undefined
    act(() => {
      event = press({ key: 'Tab', code: 'Tab' })
    })
    expect(event?.defaultPrevented).toBe(true)
    expect(setDraft).toHaveBeenCalledWith('继续修复登录页')
    host.parentElement?.remove()
  })

  it('Tab is ignored when focus sits outside the composer', () => {
    const { setDraft, props } = kit({ projection: SUGGESTION })
    render(<GhostSuggestion {...props} />)
    // A plain focusable element that is not part of the composer editor.
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    const event = press({ key: 'Tab', code: 'Tab' })
    expect(event.defaultPrevented).toBe(false)
    expect(setDraft).not.toHaveBeenCalled()
    outside.remove()
  })

  it('a malformed configured shortcut falls back to the default Tab', () => {
    const { setDraft, props } = kit({ projection: { ...SUGGESTION, acceptKey: 'Bogus+Key' } })
    render(<GhostSuggestion {...props} />)
    const textarea = focusedTextarea()
    act(() => {
      press({ key: 'Tab', code: 'Tab' })
    })
    expect(setDraft).toHaveBeenCalledWith('继续修复登录页')
    textarea.remove()
  })

  it('unconfigured keys never fill the draft', () => {
    const { setDraft, props } = kit({ projection: SUGGESTION })
    render(<GhostSuggestion {...props} />)
    const textarea = focusedTextarea()
    act(() => {
      press({ key: 'Enter', code: 'Enter' })
    })
    expect(setDraft).not.toHaveBeenCalled()
    textarea.remove()
  })
})

describe('GhostSuggestion placeholder handling', () => {
  /** The injected style tag's text, or '' when the plugin is not mounted. */
  function injectedCss(): string {
    return document.getElementById('dsh-suggest-prompt-style')?.textContent ?? ''
  }

  it('hides the native placeholder element while a ghost is visible', () => {
    const { props } = kit({ projection: SUGGESTION })
    render(<GhostSuggestion {...props} />)
    const css = injectedCss()
    // `dsh >= 0.2.0` renders the composer placeholder as a real element
    // ([data-composer-placeholder]); the old textarea pseudo-element rule is
    // kept only as a fallback for older assemblies.
    expect(css).toContain('[data-composer-placeholder]')
    expect(css).toContain('[data-composer-card]:has(.dsh-suggest-prompt-ghost)')
    // Hiding must preserve the box (an absolutely positioned sibling) so the
    // composer height does not jump when a suggestion appears or is accepted.
    expect(css).toMatch(/\[data-composer-placeholder\]\s*\{\s*visibility:\s*hidden/)
  })

  it('removes the style tag once the last ghost unmounts', () => {
    const { props } = kit({ projection: SUGGESTION })
    render(<GhostSuggestion {...props} />)
    expect(injectedCss()).not.toBe('')
    cleanup()
    expect(document.getElementById('dsh-suggest-prompt-style')).toBeNull()
  })
})
