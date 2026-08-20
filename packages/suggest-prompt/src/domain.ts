/**
 * Host-side vocabulary of the suggest-prompt domain: durable event payloads
 * and the session-event map merge. Kept separate from ./types.ts (the pure
 * client-safe outlet) because these declarations pull dsh-llm into the
 * program — the one-program-per-side layout forbids that on client
 * aggregates.
 * @module @studyzy/dsh-suggest-prompt
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { SuggestPromptSuggestion } from './types.ts'

/** Exact model-visible request recorded before one auxiliary suggestion dispatch. */
export interface SuggestPromptRequested {
  /** Format version of the request payload. */
  readonly version: 1
  /** Completed turn whose completion prompted this request. */
  readonly turn: number
  /** Exact model-visible message seqs represented in `messages`. */
  readonly sourceMessageSeqs: number[]
  /** Exact auxiliary LLM route. */
  readonly route: { readonly provider: string; readonly model: string }
  /** Exact auxiliary system prompt. */
  readonly system: string
  /** Exact auxiliary message list. */
  readonly messages: readonly Message[]
  /** Exact auxiliary output-token cap. */
  readonly maxTokens: number
  /**
   * Whether the request carried `reasoningEffort: off`. `true` records a
   * reasoning-off attempt (which an adapter may refuse before dispatch, after
   * which the generation retries without the override); `false` records that
   * retry. Absent on events logged by older builds, where no reasoning
   * override was ever sent.
   */
  readonly reasoningOff?: boolean
}

/** Whole-value post-success suggestion recorded after the auxiliary call. */
export interface SuggestPromptSuggested extends SuggestPromptSuggestion {
  /** Format version of the payload. */
  readonly version: 1
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only pre-dispatch record of one suggest-prompt model request. */
    'suggest-prompt/request': SuggestPromptRequested
    /**
     * Log-only post-success suggestion: the whole-value source of the
     * `suggestPrompt` projection fold.
     */
    'suggest-prompt/suggested': SuggestPromptSuggested
  }
}
