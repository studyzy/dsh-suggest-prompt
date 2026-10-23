/**
 * Browser-side suggestion source: reads the host's stored suggestion from the
 * plugin's own route on the shared `/api` gateway.
 *
 * The suggestion does NOT travel through a session projection. A projection can
 * only be advanced by a committed session event, and writing a plugin-private
 * event type is exactly what made sessions unreadable on cold read (issue #4) —
 * `0.2.0-rc.2` has no way to mark an appended event `ignorable`. So the host
 * keeps the suggestion in its own storage domain and serves it over an exact
 * fetch route; nothing is written to the session log at all.
 *
 * A plain `fetch` is deliberate. `connection.rpc.call` would work here, but the
 * host cannot register that channel: `rpc.handle` reads `owner.webServer` on the
 * *connection* service's own fiber, which never injects `webServer`, so it
 * throws there no matter what the plugin declares. The fetch route has no such
 * dependency — and it keeps this module free of any `dsh-client-*` import, which
 * matters because the client bundle's module whitelist (`PLATFORM_MODULES`) does
 * not seed them.
 *
 * Refresh is a bounded poll (see {@link POLL_INTERVAL_MS}). A turn completes on
 * the host asynchronously after the client's own `running` flag drops, so a
 * purely reactive read would show nothing; the interval is deliberately modest
 * because each poll is one cheap local loopback call, and polling stops as soon
 * as the component unmounts.
 * @module @studyzy/dsh-suggest-prompt/browser/suggestion-source
 */

import { useCallback, useEffect, useState } from 'react'
import type { SuggestPromptSuggestion } from '../types.ts'
import { SUGGEST_GENERATE_ROUTE_PATH, SUGGEST_ROUTE_METHOD, SUGGEST_ROUTE_PATH } from '../rpc-contract.ts'

/**
 * Poll interval for the stored suggestion, in milliseconds.
 *
 * The host write lands shortly after a turn completes; a sub-second poll keeps
 * the ghost text feeling immediate while costing one loopback request per
 * interval per mounted composer (the composer is a singleton per session).
 */
export const POLL_INTERVAL_MS = 700

/**
 * Read the stored suggestion for one session.
 *
 * Every failure mode returns `null` rather than throwing: this feeds ghost text
 * inside the composer, and a broken read must degrade to "no suggestion"
 * instead of surfacing an error where the user is typing.
 * @param sessionId - session whose suggestion is read.
 * @param signal - abort signal for the request.
 * @returns the suggestion, or `null` when none is stored or the read failed.
 */
export async function fetchSuggestion(
  sessionId: string,
  signal: AbortSignal,
): Promise<SuggestPromptSuggestion | null> {
  try {
    const response = await fetch(SUGGEST_ROUTE_PATH, {
      method: SUGGEST_ROUTE_METHOD,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
      signal,
    })
    if (!response.ok) {
      warnOnce(`suggest-prompt: read failed with HTTP ${String(response.status)}`)
      return null
    }
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null || !('suggestion' in body)) return null
    return isSuggestion(body.suggestion) ? body.suggestion : null
  } catch (error) {
    // An aborted request is the normal unmount path; a genuine transport
    // failure shows nothing rather than a broken composer. It is still
    // reported once: a silent catch here is indistinguishable from "no
    // suggestion yet", which makes a misconfigured channel undebuggable.
    warnOnce(`suggest-prompt: read threw ${String(error)}`)
    return null
  }
}

/** Validate data before it can become editor text or a shortcut matcher. */
function isSuggestion(value: unknown): value is SuggestPromptSuggestion {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.text === 'string' && record.text.trim() !== ''
    && Number.isSafeInteger(record.turn) && Number(record.turn) >= 0
    && Number.isSafeInteger(record.baseSeq) && Number(record.baseSeq) >= 0
    && typeof record.truncated === 'boolean'
    && (record.acceptKey === undefined || typeof record.acceptKey === 'string')
}

export type ManualSuggestionResult =
  | { readonly status: 'generated'; readonly suggestion: SuggestPromptSuggestion }
  | { readonly status: 'empty' | 'busy' | 'no-context' | 'error'; readonly suggestion: null }

/** One explicit, bounded host request. It never writes the composer draft. */
export async function requestSuggestion(sessionId: string, signal: AbortSignal): Promise<ManualSuggestionResult> {
  try {
    const response = await fetch(SUGGEST_GENERATE_ROUTE_PATH, {
      method: SUGGEST_ROUTE_METHOD,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
      signal,
    })
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null || !('status' in body)) {
      return { status: 'error', suggestion: null }
    }
    if (response.status === 409 && body.status === 'busy') return { status: 'busy', suggestion: null }
    if (!response.ok) return { status: 'error', suggestion: null }
    if (body.status === 'generated' && 'suggestion' in body && isSuggestion(body.suggestion)) {
      return { status: 'generated', suggestion: body.suggestion }
    }
    if (body.status === 'empty' || body.status === 'no-context') return { status: body.status, suggestion: null }
    return { status: 'error', suggestion: null }
  } catch {
    return { status: 'error', suggestion: null }
  }
}

/** Whether the one-shot transport diagnostic has already been emitted. */
let warned = false

/**
 * Report a transport failure once per page.
 *
 * Rate-limited because the caller polls: an unreachable host would otherwise
 * write the same line every {@link POLL_INTERVAL_MS}.
 * @param message - the diagnostic to emit.
 */
function warnOnce(message: string): void {
  if (warned) return
  warned = true
  console.warn(message)
}

/**
 * Subscribe to the stored suggestion for one session, polling while mounted.
 *
 * The first read is immediate so a suggestion stored before this page loaded
 * (a reload, or a session reopened from history) reappears without waiting a
 * full interval.
 * @param sessionId - session whose suggestion is tracked.
 * @returns the latest suggestion, or `null` while none is stored.
 */
export function useStoredSuggestion(sessionId: string): SuggestPromptSuggestion | null {
  return useSuggestionSource(sessionId).suggestion
}

/** A session-fenced source with an explicit refresh after manual generation. */
export function useSuggestionSource(sessionId: string) {
  const [stored, setStored] = useState<{ sessionId: string; value: SuggestPromptSuggestion | null } | null>(null)
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => { setRevision(value => value + 1) }, [])

  useEffect(() => {
    let cancelled = false
    let pending = false
    const controller = new AbortController()
    const read = (): void => {
      // Do not pile up requests on a slow mobile connection, nor let older
      // overlapping reads overwrite the newest result.
      if (pending) return
      pending = true
      void fetchSuggestion(sessionId, controller.signal).then((value) => {
        if (cancelled) return
        setStored(previous => previous?.sessionId === sessionId && sameSuggestion(previous.value, value)
          ? previous : { sessionId, value })
      }).finally(() => { pending = false })
    }
    read()
    const timer = setInterval(read, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      controller.abort()
      clearInterval(timer)
    }
  }, [sessionId, revision])

  // Never render the old session's suggestion during the render before the
  // effect for the new session has run.
  return { suggestion: stored?.sessionId === sessionId ? stored.value : null, refresh }
}

/**
 * Whether two reads carry the same suggestion.
 *
 * Compared field-by-field rather than by deep equality: the payload is flat, so
 * this is both cheaper and total (no cycle or prototype concerns on data that
 * crossed the transport boundary).
 * @param left - previously displayed suggestion.
 * @param right - newly read suggestion.
 * @returns true when the two describe the same suggestion.
 */
function sameSuggestion(
  left: SuggestPromptSuggestion | null,
  right: SuggestPromptSuggestion | null,
): boolean {
  if (left === null || right === null) return left === right
  return left.turn === right.turn
    && left.baseSeq === right.baseSeq
    && left.text === right.text
    && left.truncated === right.truncated
    && left.acceptKey === right.acceptKey
    && left.route?.provider === right.route?.provider
    && left.route?.model === right.route?.model
}