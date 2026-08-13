// @vitest-environment jsdom
/**
 * GhostSuggestion bridge behavior: the computed ghost text (projection turn
 * matches the latest completed turn, session idle, empty draft) is pushed
 * through inputActions.setGhost, and the configured accept shortcut (default
 * Tab, like Claude Code) fills the draft through setDraft while the composer
 * textarea holds focus. The component renders nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { GhostSuggestion } from '../src/client/GhostSuggestion.tsx'
import type { GhostSuggestionProps } from '../src/client/GhostSuggestion.tsx'
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
  turnEnds?: ReadonlyMap<number, number>
  draft?: string
  projection?: SuggestPromptProjection | undefined
} = {}) {
  const setGhost = vi.fn()
  const setDraft = vi.fn()
  const session = {
    running: over.running ?? false,
    turnEnds: over.turnEnds ?? new Map([[3, 30]]),
  }
  const props = {
    sessionId: SID,
    useSession: (selector: (s: ConversationSnapshot) => unknown) => selector(session as ConversationSnapshot),
    useInput: (selector: (s: { draft: string }) => unknown) => selector({ draft: over.draft ?? '' }),
    useProjection: (key: string) => (key === 'suggestPrompt' ? over.projection : undefined),
    inputActions: { setGhost, setDraft },
  } as unknown as GhostSuggestionProps
  return { setGhost, setDraft, props }
}

/** Focus a throwaway textarea and return it (removed by the caller's cleanup). */
function focusedTextarea(): HTMLTextAreaElement {
  const textarea = document.createElement('textarea')
  document.body.appendChild(textarea)
  textarea.focus()
  return textarea
}

/** Dispatch a keydown on the window and return the (cancelable) event. */
function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(event)
  return event
}

describe('GhostSuggestion bridge', () => {
  it('pushes the suggestion into the ghost when it answers the latest completed turn on an idle empty draft', () => {
    const { setGhost, props } = kit({ projection: SUGGESTION })
    render(<GhostSuggestion {...props} />)
    expect(setGhost).toHaveBeenCalledWith('继续修复登录页')
  })

  it('clears the ghost while the agent is running', () => {
    const { setGhost, props } = kit({ projection: SUGGESTION, running: true })
    render(<GhostSuggestion {...props} />)
    expect(setGhost).toHaveBeenCalledWith('')
  })

  it('clears the ghost while the draft has text', () => {
    const { setGhost, props } = kit({ projection: SUGGESTION, draft: '在输入' })
    render(<GhostSuggestion {...props} />)
    expect(setGhost).toHaveBeenCalledWith('')
  })

  it('clears the ghost when the suggestion answers an older completed turn', () => {
    const { setGhost, props } = kit({ projection: SUGGESTION, turnEnds: new Map([[5, 50]]) })
    render(<GhostSuggestion {...props} />)
    expect(setGhost).toHaveBeenCalledWith('')
  })

  it('matches the suggestion against the latest of multiple completed turns', () => {
    const { setGhost, props } = kit({
      projection: { ...SUGGESTION, turn: 5 },
      turnEnds: new Map([[3, 30], [5, 50]]),
    })
    render(<GhostSuggestion {...props} />)
    expect(setGhost).toHaveBeenCalledWith('继续修复登录页')
  })

  it('clears the ghost before the first suggestion or without a projection', () => {
    for (const projection of [null, undefined]) {
      const { setGhost, props } = kit({ projection })
      render(<GhostSuggestion {...props} />)
      expect(setGhost).toHaveBeenCalledWith('')
      cleanup()
    }
  })

  it('renders nothing', () => {
    const { props } = kit({ projection: SUGGESTION })
    const { container } = render(<GhostSuggestion {...props} />)
    expect(container.firstChild).toBeNull()
  })

  it('Tab fills the draft with the ghost while the composer textarea holds focus', () => {
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

  it('an IME composition keydown never accepts the ghost', () => {
    const { setDraft, props } = kit({ projection: SUGGESTION })
    render(<GhostSuggestion {...props} />)
    const textarea = focusedTextarea()
    act(() => {
      press({ key: 'Tab', code: 'Tab', isComposing: true })
    })
    expect(setDraft).not.toHaveBeenCalled()
    textarea.remove()
  })

  it('Tab is ignored when there is no ghost to accept', () => {
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
