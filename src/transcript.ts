/**
 * Host-only transcript fold for the suggest-prompt capability.
 *
 * `dsh >= 0.2.0` deprecates synchronous reads of arbitrary Session event
 * history (`Session.events`, `eventAt`, `snapshotEvents`, `ownEvents`) for new
 * production callers, and forbids new wrappers that reintroduce that
 * dependency. This module therefore reconstructs the model-visible transcript
 * the way the framework directs — as projection state maintained
 * incrementally from newly committed events — instead of scanning the log at
 * generation time.
 *
 * The fold retains only what suggestion generation reads: the newest
 * completed turn, the turn-start seq that bounds it, and the redacted
 * user/assistant pairs inside the window. Everything else (tool calls,
 * reasoning, intermediate assistant steps, harness-injected context) is
 * dropped at fold time, which also keeps the retained state small on a long
 * session.
 * @module @studyzy/dsh-suggest-prompt/transcript
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SuggestPromptTranscriptEntry, SuggestPromptTranscriptState } from './types.ts'
import { redactSecrets } from './sanitize.ts'

/**
 * Retained-turn window for the fold. The transcript builder only ever reads
 * the last `maxRecentTurns` completed turns (default 1), so the fold keeps a
 * little more than that and drops the rest as the session advances. Bounding
 * here — rather than at read time — is what keeps the state proportional to
 * the window instead of to the whole conversation.
 */
export const TRANSCRIPT_RETAINED_TURNS = 4

/** The empty fold: no completed turn, no retained pair, no prior suggestion. */
export const EMPTY_TRANSCRIPT_STATE: SuggestPromptTranscriptState = Object.freeze({
  lastCompletedTurn: 0,
  turnStarts: [],
  entries: [],
  lastSuggestedTurn: -1,
})

/** Render a message's text blocks; non-text blocks contribute nothing. */
function renderMessageText(message: Message): string {
  let out = ''
  for (const block of message.content) {
    if (block.type === 'text') out += block.text
  }
  return out
}

/**
 * The retained entry for one user/assistant message event, or `undefined` when
 * the event carries nothing the suggestion prompt may see.
 *
 * Harness-injected context is excluded here for the same reason it was
 * excluded from the old log scan: the workspace instructions, the runtime
 * snapshot and the skill catalog are written as `user/message` events, can be
 * very large, and are not the user's own words. Only `source.kind === 'user'`
 * counts as genuine typed input.
 * @param event - a committed `user/message` or `assistant/message` event.
 * @param turn - turn the event belongs to.
 * @returns the retained entry, or `undefined` when the event contributes no text.
 */
function retainedEntry(
  event: SessionEvent & { readonly type: 'user/message' | 'assistant/message' },
  turn: number,
): SuggestPromptTranscriptEntry | undefined {
  const message = deriveEventMessage(event)
  if (message === null) return undefined
  const text = renderMessageText(message).trim()
  if (text.length === 0) return undefined
  if (message.role === 'user' && (message.source as { kind?: unknown }).kind !== 'user') return undefined
  return {
    seq: event.seq,
    role: message.role === 'user' ? 'user' : 'assistant',
    text: redactSecrets(text),
    turn,
  }
}

/** Drop turn-start rows older than the retained window. */
function trimTurnStarts(
  turnStarts: readonly { readonly turn: number; readonly seq: number }[],
): readonly { readonly turn: number; readonly seq: number }[] {
  const cutoff = turnStarts.length - (TRANSCRIPT_RETAINED_TURNS + 1)
  return cutoff > 0 ? turnStarts.slice(cutoff) : turnStarts
}

/**
 * Pure transition for the `suggestPromptTranscript` unit: fold one committed
 * event into the retained transcript state. Returns the same reference for
 * every event the unit does not retain, which is what keeps the projection
 * drive's `Object.is` gate cheap.
 * @param state - the fold covering all prior events.
 * @param event - the next committed session event.
 * @returns the next state (same reference when the event is not retained).
 */
export function applyTranscriptProjection(
  state: SuggestPromptTranscriptState,
  event: SessionEvent,
): SuggestPromptTranscriptState {
  switch (event.type) {
    case 'turn/start':
      return {
        ...state,
        turnStarts: trimTurnStarts([...state.turnStarts, { turn: event.data.turn, seq: event.seq }]),
      }
    case 'turn/end': {
      // Retaining the completed turn is what makes the newest window readable;
      // intermediate turns age out through the same trim.
      const completed = { ...state, lastCompletedTurn: event.data.turn }
      const cutoffTurn = Math.max(1, event.data.turn - TRANSCRIPT_RETAINED_TURNS + 1)
      const kept = state.entries.filter(entry => entry.turn >= cutoffTurn)
      return kept.length === state.entries.length ? completed : { ...completed, entries: kept }
    }
    case 'user/message':
    case 'assistant/message': {
      const entry = retainedEntry(event, state.lastCompletedTurn + 1)
      if (entry === undefined) return state
      return { ...state, entries: [...state.entries, entry] }
    }
    case 'suggest-prompt/suggested':
      return { ...state, lastSuggestedTurn: event.data.turn }
    default:
      // Returning the SAME reference is the projection-contract requirement:
      // an unretained event must produce no downstream work.
      return state
  }
}