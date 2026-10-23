/** Public composer-toolbar controls. No synthetic Tab events or submit calls. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from './action-locales.ts'
import type { SuggestionActionKey } from './action-locales.ts'
import { requestSuggestion, useSuggestionSource } from './suggestion-source.ts'

export type SuggestionActionsProps = PropsRuntime<'conversation.input.right'> & PropsLocale<'suggest-prompt.actions'>
const CSS = `
.dsh-suggest-actions { position: relative; display: inline-flex; flex: 0 0 auto; }
.dsh-suggest-action {
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  min-width: 44px; min-height: 32px; padding: 4px 8px; border-radius: 8px;
  border: 0;
  color: var(--dsw-alias-label-secondary, inherit); background: transparent;
  font: inherit; font-size: 12px; line-height: 1.2; white-space: nowrap;
  cursor: pointer; touch-action: manipulation;
}
.dsh-suggest-action:hover { background: var(--dsw-alias-fill-tertiary, #80808018); }
.dsh-suggest-action:focus-visible { outline: 2px solid var(--dsw-alias-tint, #729dff); outline-offset: 2px; }
.dsh-suggest-action:disabled { opacity: .6; cursor: wait; }
.dsh-suggest-feedback {
  position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 3;
  width: max-content; max-width: min(260px, calc(100vw - 48px));
  padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 1.5;
  color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-background-primary, #25262a);
  border: 1px solid var(--dsw-alias-separator, #80808040);
}
@media (pointer: coarse) { .dsh-suggest-action { min-height: 44px; } }
`
const REQUEST_TIMEOUT_MS = 60_000

/** Fill only on an explicit acceptance, never on generation completion. */
export function SuggestionActions({ sessionId, useSession, useInput, inputActions, t }: SuggestionActionsProps) {
  const running = useSession(state => state.running)
  const draft = useInput(state => state.draft)
  const phase = useInput(state => state.phase)
  const { suggestion, refresh } = useSuggestionSource(sessionId)
  const request = useRef<AbortController | null>(null)
  const accepted = useRef(false)
  const root = useRef<HTMLSpanElement | null>(null)
  const composing = useRef(false)

  // IME preedit may not yet be represented in the public draft snapshot. Track
  // native composition only in this action's own composer, not other editors.
  useEffect(() => {
    composing.current = false
    const belongsToComposer = (event: CompositionEvent): boolean => {
      const target = event.target
      const card = root.current?.closest('[data-composer-card]')
      return target instanceof Element && card !== null && card !== undefined
        && card.contains(target) && target.closest('[data-input-scroll], textarea, [contenteditable]') !== null
    }
    let compositionTarget: EventTarget | null = null
    const start = (event: CompositionEvent): void => {
      if (!belongsToComposer(event)) return
      compositionTarget = event.target
      composing.current = true
    }
    const end = (event: CompositionEvent): void => {
      // The controls can disappear once preedit reaches the public draft. End
      // must still release the guard even when the action span is now absent.
      if (event.target !== compositionTarget) return
      compositionTarget = null
      composing.current = false
    }
    document.addEventListener('compositionstart', start, true)
    document.addEventListener('compositionend', end, true)
    return () => {
      composing.current = false
      document.removeEventListener('compositionstart', start, true)
      document.removeEventListener('compositionend', end, true)
    }
  }, [sessionId])
  const live = useRef({ sessionId, running, draft, phase })
  live.current = { sessionId, running, draft, phase }
  const [result, setResult] = useState<{
    sessionId: string; busy: boolean; feedback: SuggestionActionKey | null
  } | null>(null)
  const busy = result?.sessionId === sessionId && result.busy
  const feedback = result?.sessionId === sessionId ? result.feedback : null
  const editable = !running && draft.trim() === '' && (phase === undefined || phase === 'plain')

  useEffect(() => {
    setResult(null)
    accepted.current = false
    return () => {
      request.current?.abort()
      request.current = null
    }
  }, [sessionId, running])
  useEffect(() => {
    if (draft.trim() !== '') accepted.current = false
  }, [draft])

  const accept = (): void => {
    const current = live.current
    if (composing.current || accepted.current || current.sessionId !== sessionId || current.running
      || current.draft.trim() !== '' || (current.phase !== undefined && current.phase !== 'plain')
      || suggestion === null) return
    accepted.current = true
    inputActions.setDraft(suggestion.text)
  }

  const generate = async (): Promise<void> => {
    if (composing.current || !editable || request.current !== null) return
    const controller = new AbortController()
    request.current = controller
    setResult({ sessionId, busy: true, feedback: null })
    const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
    controller.signal.addEventListener('abort', () => { clearTimeout(timer) }, { once: true })
    try {
      const response = await requestSuggestion(sessionId, controller.signal)
      if (request.current !== controller || live.current.sessionId !== sessionId || live.current.running) return
      // Generation only refreshes the suggestion. Even if the user started
      // typing during the request, no automatic draft write is possible here.
      if (response.status === 'generated' && !controller.signal.aborted) refresh()
      const message: SuggestionActionKey | null = controller.signal.aborted ? 'error'
        : response.status === 'no-context' ? 'noContext'
        : response.status === 'generated' ? null : response.status
      setResult({ sessionId, busy: false, feedback: message })
    } finally {
      clearTimeout(timer)
      if (request.current === controller) request.current = null
    }
  }

  if (!editable) return null
  return <span ref={root} className="dsh-suggest-actions" data-suggest-prompt-actions="">
    <style>{CSS}</style>
    <button type="button" className="dsh-suggest-action" disabled={busy} aria-busy={busy}
      aria-label={t(busy ? 'generating' : suggestion === null ? 'generate' : 'accept')}
      title={t(suggestion === null ? 'generateHint' : 'acceptHint')}
      onMouseDown={event => { event.preventDefault() }}
      onClick={() => { if (suggestion === null) void generate(); else accept() }}>
      <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d={suggestion === null ? 'M8 1v4m-2-2h4M3 7v4m-2-2h4M11 6l3 3-6 6-3-3z' : 'm3 8 3 3 7-7'} />
      </svg>
    </button>
    {feedback !== null && suggestion === null ? <span className="dsh-suggest-feedback" role="status">{t(feedback)}</span> : null}
  </span>
}
