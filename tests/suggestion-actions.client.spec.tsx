// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { SuggestionActions } from '../src/browser/SuggestionActions.tsx'
import type { SuggestionActionsProps } from '../src/browser/SuggestionActions.tsx'
import { GhostSuggestion } from '../src/browser/GhostSuggestion.tsx'
import { actionEn, actionZh } from '../src/browser/action-locales.ts'
import { SUGGEST_GENERATE_ROUTE_PATH } from '../src/rpc-contract.ts'
import { requestSuggestion } from '../src/browser/suggestion-source.ts'
import type { SuggestPromptSuggestion } from '../src/types.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })
const SUGGESTION: SuggestPromptSuggestion = { turn: 1, baseSeq: 5, text: '补充登录页测试', truncated: false, acceptKey: 'Tab' }
function kit(initial: SuggestPromptSuggestion | null = null) {
  const state = { draft: '', running: false, phase: 'plain' }
  const stored: { value: SuggestPromptSuggestion | null } = { value: initial }
  const setDraft = vi.fn((text: string) => { state.draft = text })
  const submit = vi.fn()
  const manual = vi.fn(async (): Promise<Response> => {
    stored.value = SUGGESTION
    return Response.json({ status: 'generated', suggestion: SUGGESTION })
  })
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === SUGGEST_GENERATE_ROUTE_PATH) return manual()
    return Response.json({ suggestion: stored.value })
  })
  vi.stubGlobal('fetch', fetchMock)
  const props = {
    sessionId: 's1',
    useSession: (selector: (value: { running: boolean }) => unknown) => selector(state),
    useInput: (selector: (value: { draft: string; phase: string }) => unknown) => selector(state),
    inputActions: { setDraft, submit },
    t: (key: keyof typeof actionZh) => actionZh[key],
  } as unknown as SuggestionActionsProps
  return { props, state, stored, setDraft, submit, manual, fetchMock }
}
async function mount(props: SuggestionActionsProps) {
  const view = render(<SuggestionActions {...props} />)
  await act(async () => { await Promise.resolve() })
  return view
}

describe('Touch suggestion actions', () => {
  it('accepts without focus, stays editable, and never submits a surrounding form', async () => {
    const k = kit(SUGGESTION)
    const onSubmit = vi.fn((event: React.FormEvent) => { event.preventDefault() })
    const view = render(<form onSubmit={onSubmit}><SuggestionActions {...k.props} /></form>)
    const button = await view.findByRole('button', { name: '采纳' })
    expect(button.getAttribute('type')).toBe('button')
    expect(button.getAttribute('title')).toBe('将建议填入草稿，不自动发送')
    act(() => { fireEvent.click(button); fireEvent.click(button) })
    expect(k.setDraft).toHaveBeenCalledExactlyOnceWith(SUGGESTION.text)
    expect(k.submit).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(k.manual).not.toHaveBeenCalled()
  })

  it('does not overwrite active IME preedit before it reaches the public draft', async () => {
    const k = kit(SUGGESTION)
    const view = render(<div data-composer-card=""><div data-input-scroll=""><div contentEditable suppressContentEditableWarning data-testid="ime-editor" /></div><SuggestionActions {...k.props} /></div>)
    const button = await view.findByRole('button', { name: '采纳' })
    const editor = view.getByTestId('ime-editor')
    fireEvent.compositionStart(editor)
    fireEvent.click(button)
    expect(k.state.draft).toBe('')
    expect(k.setDraft).not.toHaveBeenCalled()
    expect(k.submit).not.toHaveBeenCalled()
    fireEvent.compositionEnd(editor)
    fireEvent.click(button)
    expect(k.setDraft).toHaveBeenCalledExactlyOnceWith(SUGGESTION.text)
  })

  it('releases the IME guard when the action temporarily disappears during composition', async () => {
    const k = kit(SUGGESTION)
    const tree = () => <div data-composer-card=""><textarea data-testid="ime-editor" /><SuggestionActions {...k.props} /></div>
    const view = render(tree())
    await view.findByRole('button', { name: '采纳' })
    const editor = view.getByTestId('ime-editor')
    fireEvent.compositionStart(editor)
    k.state.draft = '输入中'
    view.rerender(tree())
    expect(view.queryByRole('button')).toBeNull()
    fireEvent.compositionEnd(editor)
    k.state.draft = ''
    view.rerender(tree())
    fireEvent.click(view.getByRole('button', { name: '采纳' }))
    expect(k.setDraft).toHaveBeenCalledExactlyOnceWith(SUGGESTION.text)
  })

  it('does not generate while the same composer has uncommitted IME input', async () => {
    const k = kit()
    const view = render(<div data-composer-card=""><textarea data-testid="ime-editor" /><SuggestionActions {...k.props} /></div>)
    const button = await view.findByRole('button', { name: '生成建议' })
    fireEvent.compositionStart(view.getByTestId('ime-editor'))
    fireEvent.click(button)
    expect(k.manual).not.toHaveBeenCalled()
  })

  it('ignores composition in another composer or an unrelated text field', async () => {
    const k = kit(SUGGESTION)
    const view = render(<><div data-composer-card=""><textarea data-testid="other-editor" /></div><div data-composer-card=""><input data-testid="settings-field" /><SuggestionActions {...k.props} /></div></>)
    const button = await view.findByRole('button', { name: '采纳' })
    fireEvent.compositionStart(view.getByTestId('other-editor'))
    fireEvent.compositionStart(view.getByTestId('settings-field'))
    fireEvent.click(button)
    expect(k.setDraft).toHaveBeenCalledExactlyOnceWith(SUGGESTION.text)
  })

  it('renders an accessible icon only, without a button border', async () => {
    const k = kit()
    const view = await mount(k.props)
    const button = view.getByRole('button', { name: '生成建议' })
    expect(button.textContent).toBe('')
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(button.getAttribute('title')).toBeTruthy()
    expect(getComputedStyle(button).borderTopWidth).toBe('0px')
  })

  it('generates on demand, surfaces the new ghost, and fills only after explicit acceptance', async () => {
    const k = kit()
    const view = render(<><GhostSuggestion {...k.props} /><SuggestionActions {...k.props} /></>)
    fireEvent.click(await view.findByRole('button', { name: '生成建议' }))
    const accept = await view.findByRole('button', { name: '采纳' })
    await waitFor(() => { expect(document.querySelector('.dsh-suggest-prompt-ghost')?.textContent).toBe(SUGGESTION.text) })
    expect(k.setDraft).not.toHaveBeenCalled()
    expect(k.submit).not.toHaveBeenCalled()
    const generation = k.fetchMock.mock.calls.find(([url]) => String(url) === SUGGEST_GENERATE_ROUTE_PATH)
    expect(generation?.[1]?.method).toBe('POST')
    expect(JSON.parse(String(generation?.[1]?.body))).toEqual({ sessionId: 's1' })
    fireEvent.click(accept)
    expect(k.setDraft).toHaveBeenCalledExactlyOnceWith(SUGGESTION.text)
    expect(k.submit).not.toHaveBeenCalled()
  })

  it('keeps one request in flight even across rapid clicks', async () => {
    const k = kit()
    let release!: (response: Response) => void
    k.manual.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const view = await mount(k.props)
    const button = view.getByRole('button', { name: '生成建议' })
    act(() => { fireEvent.click(button); fireEvent.click(button); fireEvent.click(button) })
    expect(k.manual).toHaveBeenCalledTimes(1)
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.textContent).toBe('')
    expect(button.getAttribute('aria-label')).toBe('生成中…')
    expect(button.querySelector('svg')).not.toBeNull()
    await act(async () => { release(Response.json({ status: 'empty', suggestion: null })) })
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(view.getByRole('status').textContent).toBe(actionZh.empty)
  })

  it.each([
    ['empty', 200, 'empty'], ['busy', 409, 'busy'], ['no-context', 200, 'noContext'], ['error', 502, 'error'],
  ] as const)('reports %s and permits an explicit retry', async (status, http, copy) => {
    const k = kit()
    k.manual.mockResolvedValue(Response.json({ status, suggestion: null }, { status: http }))
    const view = await mount(k.props)
    fireEvent.click(view.getByRole('button', { name: '生成建议' }))
    await waitFor(() => { expect(view.getByRole('status').textContent).toBe(actionZh[copy]) })
    expect(k.setDraft).not.toHaveBeenCalled()
    expect(k.submit).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: '生成建议' }))
    await waitFor(() => { expect(k.manual).toHaveBeenCalledTimes(2) })
  })

  it('does not replace text typed while generation is pending', async () => {
    const k = kit()
    let release!: (response: Response) => void
    k.manual.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const view = await mount(k.props)
    fireEvent.click(view.getByRole('button', { name: '生成建议' }))
    k.state.draft = '我的草稿'
    view.rerender(<SuggestionActions {...k.props} />)
    k.stored.value = SUGGESTION
    await act(async () => { release(Response.json({ status: 'generated', suggestion: SUGGESTION })) })
    expect(view.queryByRole('button')).toBeNull()
    expect(k.state.draft).toBe('我的草稿')
    expect(k.setDraft).not.toHaveBeenCalled()
  })

  it.each(['adjudicating', 'claimed', 'submitting'])('never offers acceptance during input %s', async phase => {
    const k = kit(SUGGESTION)
    k.state.phase = phase
    const view = await mount(k.props)
    expect(view.queryByRole('button')).toBeNull()
    expect(k.setDraft).not.toHaveBeenCalled()
  })

  it('hides controls while running or while a draft exists', async () => {
    const k = kit(SUGGESTION)
    k.state.running = true
    const view = await mount(k.props)
    expect(view.queryByRole('button')).toBeNull()
    k.state.running = false
    k.state.draft = '不要覆盖'
    view.rerender(<SuggestionActions {...k.props} />)
    expect(view.queryByRole('button')).toBeNull()
    expect(k.setDraft).not.toHaveBeenCalled()
  })

  it('aborts on session switch and ignores the old session response', async () => {
    const k = kit()
    let release!: (response: Response) => void
    let signal: AbortSignal | undefined
    k.manual.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const original = globalThis.fetch
    vi.stubGlobal('fetch', (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === SUGGEST_GENERATE_ROUTE_PATH) signal = init?.signal ?? undefined
      return original(url, init)
    })
    const view = await mount(k.props)
    fireEvent.click(view.getByRole('button', { name: '生成建议' }))
    view.rerender(<SuggestionActions {...k.props} sessionId={'s2' as SuggestionActionsProps['sessionId']} />)
    expect(signal?.aborted).toBe(true)
    await act(async () => { release(Response.json({ status: 'empty', suggestion: null })) })
    expect(view.queryByRole('status')).toBeNull()
    expect(k.setDraft).not.toHaveBeenCalled()
  })

  it('never serves the previous session suggestion before a new read settles', async () => {
    const k = kit(SUGGESTION)
    const view = await mount(k.props)
    await view.findByRole('button', { name: '采纳' })
    const never = new Promise<Response>(() => {})
    vi.stubGlobal('fetch', () => never)
    view.rerender(<SuggestionActions {...k.props} sessionId={'s2' as SuggestionActionsProps['sessionId']} />)
    expect(view.queryByRole('button', { name: '采纳' })).toBeNull()
    expect(view.getByRole('button', { name: '生成建议' })).toBeTruthy()
  })

  it('bounds the client wait and makes a timed-out request retryable', async () => {
    vi.useFakeTimers()
    const k = kit()
    const original = globalThis.fetch
    vi.stubGlobal('fetch', (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) !== SUGGEST_GENERATE_ROUTE_PATH) return original(url, init)
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
      })
    })
    const view = await mount(k.props)
    fireEvent.click(view.getByRole('button', { name: '生成建议' }))
    expect(view.getByRole('button').hasAttribute('disabled')).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(view.getByRole('status').textContent).toBe(actionZh.error)
    expect(view.getByRole('button', { name: '生成建议' }).hasAttribute('disabled')).toBe(false)
    expect(k.setDraft).not.toHaveBeenCalled()
    expect(k.submit).not.toHaveBeenCalled()
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts a manual request on unmount', async () => {
    const k = kit()
    k.manual.mockImplementation(() => new Promise(() => {}))
    const view = await mount(k.props)
    fireEvent.click(view.getByRole('button', { name: '生成建议' }))
    const call = k.fetchMock.mock.calls.find(([url]) => String(url) === SUGGEST_GENERATE_ROUTE_PATH)
    view.unmount()
    expect(call?.[1]?.signal?.aborted).toBe(true)
    expect(k.submit).not.toHaveBeenCalled()
  })

  it('uses locale-bound copy, including English', async () => {
    const k = kit()
    const view = await mount({ ...k.props, t: key => actionEn[key] } as SuggestionActionsProps)
    expect(view.getByRole('button', { name: 'Suggest' })).toBeTruthy()
  })
})

describe('Manual response boundary', () => {
  it.each([null, {}, { status: 'generated', suggestion: { text: 'bad' } }, { status: 'unrecognized' }])(
    'rejects a malformed response %j', async body => {
      vi.stubGlobal('fetch', async () => Response.json(body))
      expect(await requestSuggestion('s1', new AbortController().signal)).toEqual({ status: 'error', suggestion: null })
    },
  )
})
