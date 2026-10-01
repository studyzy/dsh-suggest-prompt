/**
 * Pure types of the suggest-prompt domain: the ONE home of the
 * `suggestPrompt` projection-key declaration plus the durable payload
 * vocabulary it carries, free of this package's host-side imports (cordis
 * events, dsh-llm, the plugin). Two namespace projections serve it — `./types`
 * for host consumers, `./client` (the browser half-entry re-exports these) for
 * client aggregates — with zero content duplication. Host-coupled vocabulary
 * (event payloads, message sources) lives in ./domain.ts.
 *
 * @module @studyzy/dsh-suggest-prompt/types
 */

/**
 * Pure types of the suggest-prompt domain: the ONE home of the
 * `suggestPrompt` projection-key declaration plus the durable payload
 * vocabulary it carries, free of this package's host-side imports (cordis
 * events, dsh-llm, the plugin). The deployment {@link Config} lives on the
 * plugin itself (`src/index.ts`) because the config catalog pastes
 * declarations verbatim. Two namespace projections serve this outlet —
 * `./types` for host consumers, `./client` (the browser half-entry
 * re-exports these) for client aggregates — with zero content duplication.
 * Host-coupled vocabulary (event payloads, message sources) lives in
 * ./domain.ts.
 *
 * @module @studyzy/dsh-suggest-prompt/types
 */

/** The suggestion generated after one completed turn, whole-value per event. */
export interface SuggestPromptSuggestion {
  /** Completed turn whose completion this suggestion answers. */
  readonly turn: number
  /** Seq of the last model-visible message the transcript was built from. */
  readonly baseSeq: number
  /** Sanitized, single-line suggestion text (accepted into the composer). */
  readonly text: string
  /** Whether the model output was truncated to `maxSuggestionChars`. */
  readonly truncated: boolean
  /** Exact auxiliary LLM route. */
  readonly route?: { readonly provider: string; readonly model: string }
  /** Seq of the matching `suggest-prompt/request` event. */
  readonly requestSeq: number
  /**
   * Composer shortcut that accepts this suggestion into the draft (for
   * example `Tab` or `Alt+Slash`), as configured on the host plugin. The
   * client ghost text intercepts that key while a suggestion is displayed.
   */
  readonly acceptKey: string
}

/**
 * The `suggestPrompt` projection value: the latest `suggest-prompt/suggested`
 * whole value, or `null` before the first suggestion. The client ghost text
 * reads this; stale suggestions are matched against the session's latest
 * completed turn by `turn`.
 */
export type SuggestPromptProjection = SuggestPromptSuggestion | null

/**
 * One model-visible user/assistant exchange retained for the suggestion
 * transcript, with the log attribution needed to bound and cite it.
 */
export interface SuggestPromptTranscriptEntry {
  /** Log seq of the source `user/message` or `assistant/message` event. */
  readonly seq: number
  /** Speaker of the retained message. */
  readonly role: 'user' | 'assistant'
  /** Rendered, redacted, single-line text. */
  readonly text: string
  /** Turn this message belongs to (`0` before the first `turn/start`). */
  readonly turn: number
}

/**
 * Host-only fold state backing the suggestion transcript. `dsh >= 0.2.0`
 * deprecates synchronous session-history reads for new production callers, so
 * the plugin reconstructs what it needs from committed events instead of
 * scanning `session.events`: `turnStarts` bounds the completed-turn window,
 * `entries` carries the model-visible text, and `lastSuggestedTurn` seeds the
 * per-session dedupe cursor across reloads.
 */
export interface SuggestPromptTranscriptState {
  /** Turn number of the newest `turn/end` seen, or `0` before any completes. */
  readonly lastCompletedTurn: number
  /** Turn-start seq per turn, oldest first (bounds the transcript window). */
  readonly turnStarts: readonly { readonly turn: number; readonly seq: number }[]
  /** Retained model-visible pairs, oldest first, bounded by a fixed window. */
  readonly entries: readonly SuggestPromptTranscriptEntry[]
  /** Newest `suggest-prompt/suggested` turn, or `-1`; the dedupe cursor. */
  readonly lastSuggestedTurn: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The session's latest suggested next prompt (the whole value of the
     * newest `suggest-prompt/suggested` event), or `null` before the first
     * suggestion. Whole-value rule: every suggested event carries the
     * complete post-change suggestion, so the fold is last-wins.
     */
    suggestPrompt: SuggestPromptProjection
  }

  interface SessionProjectionStateMap {
    /**
     * Host-only transcript fold. Never client-visible: the retained text is
     * consumed on the host to build the bounded auxiliary request.
     */
    suggestPromptTranscript: SuggestPromptTranscriptState
  }
}
