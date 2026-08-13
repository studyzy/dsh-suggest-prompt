// @vitest-environment jsdom
/**
 * GhostSuggestion bridge behavior: the computed ghost text (projection turn
 * matches the latest completed turn, session idle, empty draft) is pushed
 * through inputActions.setGhost, and Alt-/ with composer focus fills the draft
 * through setDraft. The component renders nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { GhostSuggestion } from '../src/client/GhostSuggestion.tsx'
import type { GhostSuggestionProps } from '../src/client/GhostSuggestion.tsx'
import type { SuggestPromptProjection } from '@deepseek-ai/dsh-suggest-prompt/client'

afterEach(cleanup)

const SID = 's1' as SessionId

const SUGGESTION: NonNullable<SuggestPromptProjection> = {
  turn: 3,
  baseSeq: 40,
  text: '继续修复登录页',
  truncated: false,
  requestSeq: 42,
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

  it('Alt-/ fills the draft with the ghost while the composer textarea holds focus', () => {
    const { setDraft, props } = kit({ projection: SUGGESTION })
    render(<GhostSuggestion {...props} />)
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()
    expect(document.activeElement).toBe(textarea)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Slash', altKey: true, bubbles: true }))
    })
    expect(setDraft).toHaveBeenCalledWith('继续修复登录页')
    textarea.remove()
  })

  it('Alt-/ is ignored when the composer textarea does not hold focus', () => {
    const { setDraft, props } = kit({ projection: SUGGESTION })
    render(<GhostSuggestion {...props} />)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Slash', altKey: true, bubbles: true }))
    })
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('other keys never fill the draft', () => {
    const { setDraft, props } = kit({ projection: SUGGESTION })
    render(<GhostSuggestion {...props} />)
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
    })
    expect(setDraft).not.toHaveBeenCalled()
    textarea.remove()
  })
})
