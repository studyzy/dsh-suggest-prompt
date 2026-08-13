/**
 * suggest-prompt plugin: after every completed agent turn, generate one
 * suggested next prompt for the user through a bounded auxiliary LLM call and
 * publish it as the `suggestPrompt` session projection (the web composer
 * renders it as ghost text). Host-driven on `turn/end` (completed); generation
 * is per-session deduplicated by turn and superseded on the next completed
 * turn. The projection unit activates only where a projection registry is
 * composed (headless assemblies stay unaffected).
 * @module @deepseek-ai/dsh-suggest-prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: resolves ctx.sessionProjections for the optional unit child.
import type {} from '@deepseek-ai/dsh-session-projection'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { generateSuggestion, resolveSuggestPromptConfig } from './generate.ts'
import type { ResolvedSuggestPromptConfig } from './generate.ts'
import type { SuggestPromptSuggestion } from './types.ts'

// The pure payload outlet (./types.ts, ONE home of the `suggestPrompt`
// projection-key declaration) re-exported onto the package root keeps the
// module edge in the emitted index.d.ts, so aggregate programs consuming the
// declarations still receive the SessionProjectionMap merge.
export type * from './types.ts'
export type * from './domain.ts'

/** Wire payload schema of the `suggestPrompt` projection (whole suggestion or null). */
const suggestPromptProjectionSchema: ZodType<SuggestPromptSuggestion | null> = zod.union([
  zod.object({
    turn: zod.number().int().positive(),
    baseSeq: zod.number().int().nonnegative(),
    text: zod.string().min(1),
    truncated: zod.boolean(),
    route: zod.object({
      provider: zod.string().min(1),
      model: zod.string().min(1),
    }).optional(),
    requestSeq: zod.number().int().nonnegative(),
    acceptKey: zod.string().min(1),
  }),
  zod.null(),
]) as ZodType<SuggestPromptSuggestion | null>

/**
 * Light last-wins fold of the `suggestPrompt` projection unit. The state is
 * plain JSON; any non-suggested event returns the same reference (the
 * registry's Object.is gate), and correctness of the written suggestion is
 * the write side's job (generateSuggestion sanitized and truncated it before
 * appending; the package invariant rejects a violating stream fail-loud where
 * it is installed).
 * @param state - the projection covering all prior events.
 * @param event - the next committed session event.
 * @returns the next projection (same reference when the event is not a suggestion).
 */
export function applySuggestPromptProjection(
  state: SuggestPromptSuggestion | null,
  event: SessionEvent,
): SuggestPromptSuggestion | null {
  if (event.type !== 'suggest-prompt/suggested') return state
  const data = event.data
  return {
    turn: data.turn,
    baseSeq: data.baseSeq,
    text: data.text,
    truncated: data.truncated,
    ...(data.route !== undefined ? { route: data.route } : {}),
    requestSeq: data.requestSeq,
    acceptKey: data.acceptKey,
  }
}

/** Per-session generation state: last committed turn and one in-flight call. */
interface SessionState {
  /** Latest turn whose suggestion is already durable (log-scanned seed). */
  lastSuggestedTurn: number
  /** One in-flight generation, superseded by abort on the next completed turn. */
  pending: { readonly turn: number; readonly controller: AbortController } | undefined
}

/** Seed the dedupe cursor from the log so reloads never regenerate a turn. */
function lastSuggestedTurnInLog(session: Session): number {
  const event = session.events.findLast(candidate => candidate.type === 'suggest-prompt/suggested')
  return event?.data.turn ?? -1
}

/** Required LLM and session policy; this plugin adds no defaults. */
export interface Config {
  /** Maximum UTF-8 bytes in the final JSON-framed user prompt. */
  readonly maxInputBytes: number
  /** Auxiliary generation output-token cap. */
  readonly maxOutputTokens: number
  /** End-to-end auxiliary request deadline in milliseconds. */
  readonly timeoutMs: number
  /** Transcript tail keeps at most this many recent completed turns (default 1: only the last completed turn). */
  readonly maxRecentTurns?: number
  /** Transcript tail character budget before JSON framing. */
  readonly maxTranscriptChars: number
  /** Visible-character cap for the generated suggestion. */
  readonly maxSuggestionChars: number
  /** Optional explicit provider route; must be paired with `model`. */
  readonly provider?: string
  /** Optional explicit model id; must be paired with `provider`. */
  readonly model?: string
  /**
   * Composer shortcut that accepts a displayed suggestion into the draft
   * (for example `Tab`, `Alt+Slash`, or `Ctrl+Enter`). Default `Tab`.
   */
  readonly acceptKey?: string
}

/** Loader schema: every bound is required and provider/model pair optionally overrides the logged route. */
export const Config: z<Config> = z.object({
  maxInputBytes: z.number().step(1).min(1).required(),
  maxOutputTokens: z.number().step(1).min(1).required(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
  maxRecentTurns: z.number().step(1).min(1).default(1),
  maxTranscriptChars: z.number().step(1).min(1).required(),
  maxSuggestionChars: z.number().step(1).min(1).required(),
  provider: z.string(),
  model: z.string(),
  acceptKey: z.string().default('Tab'),
})

/** Cordis plugin identity. */
export const name = 'suggest-prompt'
/** Services required before this plugin activates. */
export const inject = ['llm', 'sessions']

/**
 * Mount the plugin: listen for completed turns, generate per-session
 * suggestions, and register the `suggestPrompt` projection unit.
 * @param ctx - context exposing the LLM and session services.
 * @param config - required bounded-generation policy.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedSuggestPromptConfig = resolveSuggestPromptConfig(config)
  const states = new WeakMap<Session, SessionState>()
  const tracked = new Set<SessionState>()

  const handleTurnEnd = (session: Session, turn: number): void => {
    let state = states.get(session)
    if (state === undefined) {
      state = { lastSuggestedTurn: lastSuggestedTurnInLog(session), pending: undefined }
      states.set(session, state)
      tracked.add(state)
    }
    if (state.lastSuggestedTurn === turn) return
    const pending = state.pending
    if (pending !== undefined) {
      if (pending.turn === turn) return
      pending.controller.abort()
    }
    const controller = new AbortController()
    state.pending = { turn, controller }
    // session/event is dispatched synchronously inside the committing append;
    // re-appending from that stack reenters the session. Defer to a microtask
    // so the suggestion's own request/suggested events publish cleanly.
    void Promise.resolve().then(() => generateSuggestion(ctx, resolved, session, turn, controller.signal)).then(
      () => {
        // A superseded generation always rejects instead: generateSuggestion
        // checks the deadline signal after every chunk, so success can never
        // observe a replaced pending slot.
        /* v8 ignore next 2 -- the superseded-success arm is unreachable by construction */
        if (state.pending?.controller !== controller) return
        state.pending = undefined
        state.lastSuggestedTurn = turn
      },
      (error: unknown) => {
        if (state.pending?.controller === controller) state.pending = undefined
        // Superseded calls abort with the new controller; their failure is expected.
        if (controller.signal.aborted) return
        // The LLM layer wraps adapter rejections into Errors, so the non-Error
        // arm is defensive only.
        /* v8 ignore next 2 -- non-Error rejections are wrapped by the LLM layer */
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`suggest-prompt: suggestion generation failed: ${message}`)
      },
    )
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end' && event.data.reason.kind === 'completed') {
      handleTurnEnd(session, event.data.turn)
    }
  })

  // Abort every in-flight generation when the plugin unloads.
  ctx.effect(() => () => {
    for (const state of tracked) state.pending?.controller.abort()
  })

  // The `suggestPrompt` projection unit: last-wins fold of whole values (see
  // applySuggestPromptProjection). The unit child activates only when a
  // projection registry is composed (headless assemblies stay unaffected).
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register<'suggestPrompt', SuggestPromptSuggestion | null>({
      key: 'suggestPrompt',
      schema: suggestPromptProjectionSchema,
      init: () => null,
      apply: applySuggestPromptProjection,
      view: state => state,
      stateVersion: 1,
    })
  })
}
