/**
 * suggest-prompt plugin: after every completed agent turn, generate one
 * suggested next prompt for the user through a bounded auxiliary LLM call and
 * deliver it to the web composer, which renders it as ghost placeholder text.
 *
 * Delivery does NOT go through the session log. The pre-1.2 build appended
 * private `SessionEventMap` types (`suggest-prompt/…`), which are outside the
 * harness's closed `KNOWN_SESSION_EVENT_TYPES`; `0.2.0-rc.2` offers no way to
 * mark an appended event `ignorable`, so `validateStoredEvents` refused the
 * whole log on the next cold read and the session could not be reopened
 * (issue #4). A suggestion is plugin-owned derived state, so it is persisted in
 * this plugin's own storage domain and served to the browser over a
 * plugin-owned `connection.rpc` channel. With zero session-log writes, issue #4
 * cannot recur by construction.
 *
 * The plugin is scoped to the projection registry, whose host-only transcript
 * fold supplies the bounded transcript: generation reads that fold rather than
 * scanning session history, which `dsh >= 0.2.0` deprecates for new callers.
 * @module @studyzy/dsh-suggest-prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: resolves ctx.sessionProjections for the scoped unit child.
import type {} from '@deepseek-ai/dsh-session-projection'
// Type-only: resolves ctx.storageDomain for the durable suggestion store.
import type {} from '@deepseek-ai/dsh-storage-domain'
// Type-only: resolves ctx.connection for the browser RPC channel.
import type {} from '@deepseek-ai/dsh-client-connection'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { generateSuggestion, resolveSuggestPromptConfig } from './generate.ts'
import {
  clearSuggestion,
  readSuggestion,
  suggestPromptDomainSpec,
  writeSuggestion,
} from './records.ts'
import type { SuggestPromptDomain } from './records.ts'
import type { SuggestPromptStorageRecord } from './domain.ts'
import { applyTranscriptProjection, EMPTY_TRANSCRIPT_STATE } from './transcript.ts'
import { SUGGEST_GENERATE_ROUTE_PATH, SUGGEST_ROUTE_METHOD, SUGGEST_ROUTE_PATH } from './rpc-contract.ts'
import type { SuggestPromptGenerateStatus } from './rpc-contract.ts'
import type { SuggestPromptSuggestion, SuggestPromptTranscriptState } from './types.ts'

// The pure payload outlet (./types.ts, ONE home of the `suggestPrompt`
// projection-key declaration) re-exported onto the package root keeps the
// module edge in the emitted index.d.ts, so aggregate programs consuming the
// declarations still receive the SessionProjectionMap merge.
export type * from './types.ts'
export type * from './domain.ts'

/**
 * The browser-facing RPC channel this plugin owns. Absolute by contract
 * (`/^\/[A-Za-z0-9._~-]+$/`), and never the reserved `/api`.
 */
export { SUGGEST_GENERATE_ROUTE_PATH, SUGGEST_ROUTE_METHOD, SUGGEST_ROUTE_PATH }

interface SuggestPromptLifecycle {
  readonly running: boolean
  readonly turn: number
  readonly completed: boolean
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    suggestPromptLifecycle: SuggestPromptLifecycle
  }
}

/** Persisted-state schema of the host-only `suggestPromptTranscript` fold. */
const transcriptStateSchema: ZodType<SuggestPromptTranscriptState> = zod.object({
  lastCompletedTurn: zod.number().int().nonnegative(),
  turnStarts: zod.array(zod.object({
    turn: zod.number().int().positive(),
    seq: zod.number().int().nonnegative(),
  })),
  entries: zod.array(zod.object({
    seq: zod.number().int().nonnegative(),
    role: zod.union([zod.literal('user'), zod.literal('assistant')]),
    text: zod.string(),
    turn: zod.number().int().positive(),
  })),
  lastSuggestedTurn: zod.number().int().min(-1),
}) as ZodType<SuggestPromptTranscriptState>

/** Per-session generation state: last committed turn and one in-flight call. */
interface SessionState {
  /** Latest turn whose suggestion is already durable (seeded from storage). */
  lastSuggestedTurn: number
  /** One in-flight generation, superseded by abort on the next completed turn. */
  pending: { readonly turn: number; readonly controller: AbortController } | undefined
  /** Order durable mutations so an older asynchronous put cannot win last. */
  mutation?: Promise<void>
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
  /** Optional explicit provider route; missing falls back to the session route. */
  readonly provider?: string
  /** Optional explicit model id; missing falls back to the session route. */
  readonly model?: string
  /**
   * Composer shortcut that accepts a displayed suggestion into the draft
   * (for example `Tab`, `Alt+Slash`, or `Ctrl+Enter`). Default `Tab`.
   */
  readonly acceptKey?: string
}

/**
 * Loader schema for the deployment policy.
 *
 * `dsh >= 0.2.0` derives a plugin's settings form from this schema, and a field
 * appears there only when it is marked `volatile()`. That marking is what makes
 * the entry describable at all: with no volatile field the host omits the entry
 * from `settings.describe`, so the WebUI card would mount and then render
 * nothing. Only the three user-editable preferences are volatile — the
 * deployment bounds stay ordinary configuration, so the generated form does not
 * invite edits to them.
 *
 * The schema is declared separately from {@link Config} because `volatile()`
 * brands its output (`Volatile<T>`), which would otherwise leak that brand into
 * every consumer of the runtime policy type. `Config` stays the plain shape the
 * plugin actually reads.
 *
 * Requires `@deepseek-ai/schemastery >= 3.18.3`, the first release with
 * `volatile()`.
 */
const ConfigSchema = z.object({
  maxInputBytes: z.number().step(1).min(1).required(),
  maxOutputTokens: z.number().step(1).min(1).required(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
  maxRecentTurns: z.number().step(1).min(1).default(1),
  maxTranscriptChars: z.number().step(1).min(1).required(),
  maxSuggestionChars: z.number().step(1).min(1).required(),
  provider: z.string().volatile(),
  model: z.string().volatile(),
  acceptKey: z.string().default('Tab').volatile(),
})

/**
 * Exported loader schema. Cast to the runtime shape: `volatile()` only affects
 * how the settings form projects the field, not the value the plugin receives.
 */
export const Config = ConfigSchema as unknown as z<Config>

/** Cordis plugin identity. */
export const name = 'suggest-prompt'
/**
 * Services required before this plugin activates. `storageDomain` is the
 * durable suggestion store (`@deepseek-ai/dsh-base` mounts it, so it is present
 * in every profile); `connection` carries the shared `/api` gateway this
 * plugin's browser route hangs off.
 *
 * `webServer` is deliberately NOT here. The plugin never touches it: it
 * registers through `connection.fetch.register`, which writes only to the
 * connection service's own route table. The sibling surface `rpc.handle` does
 * read `owner.webServer`, but on the *connection* fiber — which injects neither
 * `webServer` nor anything that provides it — so that call throws there
 * regardless of this plugin's own list. See `SUGGEST_ROUTE_PATH`.
 */
export const inject = ['llm', 'sessions', 'storageDomain', 'connection']

/**
 * Settings namespace of the suggestion route. `dsh >= 0.2.0` keys a plugin's
 * settings page by its profile entry id and derives the form from the plugin's
 * own `Config` schema, so this value names that entry/page rather than a
 * separately registered namespace. It is what the WebUI settings card binds to
 * and what `configEditor` writes through.
 */
export const SUGGEST_PROMPT_NS = 'suggest-prompt'

/** Payload of the browser `get` call. */
interface GetPayload {
  readonly sessionId: string
}

/**
 * Narrow an untrusted RPC payload to the session id the caller asked about.
 * @param payload - decoded request payload.
 * @returns the session id, or `undefined` when the payload is malformed.
 */
function sessionIdOf(payload: unknown): SessionId | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const candidate = (payload as GetPayload).sessionId
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate as SessionId
    : undefined
}


/**
 * Mount the plugin: open the suggestion store, expose the browser read
 * endpoint, and generate one suggestion per completed turn.
 * @param ctx - context exposing LLM, session, storage, and connection services.
 * @param config - required bounded-generation policy.
 */
export function apply(ctx: Context, config: Config): void {
  // Everything runs under the projection registry: generation reads the
  // retained transcript from `suggestPromptTranscript` rather than scanning
  // session history, so an assembly without the registry cannot generate. The
  // scoped inject keeps the absence graceful — a headless assembly simply never
  // mounts the suggestion capability instead of throwing at every turn end.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    applyWithProjections(projectionCtx, config)
  })
}

/**
 * Body of the plugin once the projection registry is present.
 *
 * The domain open is asynchronous, so the body is async and every reader awaits
 * the same open promise: the browser endpoint answers `null` until the store is
 * ready rather than failing, and generation waits for it before its first
 * write.
 * @param ctx - context exposing the LLM, session, projection, storage, and connection services.
 * @param config - required bounded-generation policy.
 */
function applyWithProjections(ctx: Context, config: Config): void {
  const states = new WeakMap<Session, SessionState>()
  const tracked = new Set<SessionState>()
  let disposed = false
  const stateOf = (session: Session): SessionState => {
    let state = states.get(session)
    if (state === undefined) {
      state = { lastSuggestedTurn: -1, pending: undefined }
      states.set(session, state)
      tracked.add(state)
    }
    return state
  }

  // Lazy, shared, and single-flight: the RPC handler and the generator both
  // read this promise, so the domain is opened exactly once per plugin mount.
  let domainPromise: Promise<SuggestPromptDomain> | undefined
  const domain = (): Promise<SuggestPromptDomain> => {
    domainPromise ??= ctx.storageDomain.open(suggestPromptDomainSpec)
    return domainPromise
  }

  const mutate = (state: SessionState, action: () => Promise<void>): Promise<void> => {
    const next = (state.mutation ?? Promise.resolve()).then(action, action)
    state.mutation = next.catch(() => {})
    return next
  }

  /** The retained transcript fold for one session. */
  const transcriptStateOf = (session: Session): SuggestPromptTranscriptState =>
    ctx.sessionProjections.stateOf(session, 'suggestPromptTranscript') ?? EMPTY_TRANSCRIPT_STATE

  /**
   * Answer one browser read. Every failure mode resolves to `null` rather than
   * throwing: the caller is the composer, which renders "no suggestion" for an
   * absent value and nothing at all for an error.
   * @param request - the buffered POST the browser sent.
   * @returns the stored suggestion, or `null` when there is none to show.
   */
  const readForBrowserRequest = async (request: Request): Promise<unknown> => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return null
    }
    const sessionId = sessionIdOf(body)
    if (sessionId === undefined) return null
    const opened = await domain()
    const session = ctx.sessions.get(sessionId)
    if (session !== undefined) {
      const lifecycle = ctx.sessionProjections.stateOf(session, 'suggestPromptLifecycle')
      if (lifecycle?.running) return null
    }
    return readSuggestion(opened, sessionId) ?? null
  }

  const handleTurnEnd = (session: Session, turn: number): void => {
    const state = stateOf(session)
    if (disposed) return
    if (state.pending?.turn === turn) return
    const pending = state.pending
    if (pending !== undefined) pending.controller.abort()
    const controller = new AbortController()
    state.pending = { turn, controller }
    // Resolve the policy fresh at each turn: the composition entry's `config`
    // is the settings-backed value, so a settings edit lands on the next
    // completed turn. The microtask reads it when the turn settles.
    const resolved = resolveSuggestPromptConfig(config)

    /**
     * Retire the previous turn's suggestion before generating this one.
     *
     * Without this the browser serves the *superseded* suggestion for the whole
     * duration of the new generation: the composer stops hiding ghost text the
     * moment the turn ends, the poll then reads a store that still holds the
     * older turn's text, and only the write at the end of this function
     * displaces it. The user sees the old prompt flash and then swap — the
     * stale window is exactly the model's latency, which is why it reads as
     * "about a second".
     *
     * Clearing is a microtask that races generation but NOT the poll: the read
     * path stays a single awaited step of the same async chain that does the
     * work, so a poll landing in between answers `null` ("no suggestion yet")
     * rather than a retracted one. A cleared store is also honest about what
     * the host knows at that instant — this turn has no suggestion yet.
     *
     * A failed clear is not fatal: it costs the stale flash, not correctness,
     * and the write below still lands. It is reported once so a persistently
     * unwritable store is not silent.
     * @returns nothing; the clear is awaited by the caller's chain.
     */
    const retirePrevious = async (): Promise<void> => {
      // Only worth a write when a record could actually be served: the cursor
      // is seeded from the store, so a turn at or below it has nothing stale.
      if (state.lastSuggestedTurn < 0) return
      try {
        const opened = await domain()
        if (state.pending?.controller !== controller) return
        await mutate(state, async () => {
          if (state.pending?.controller === controller) await clearSuggestion(opened, session.id)
        })
      } catch (error) {
        // Superseded clears are expected to lose their slot; only a live
        // failure is worth reporting, and only once per turn.
        if (state.pending?.controller !== controller) return
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`suggest-prompt: could not retire the previous suggestion: ${message}`)
      }
    }

    /**
     * Whether this turn already has a durable suggestion.
     *
     * The cursor is seeded from the store, not from the log: a session reopened
     * from history must not regenerate a turn it already answered. The read is
     * awaited (not fired alongside generation) because the decision it informs
     * is whether to call the model at all — racing it would let every reload
     * issue one redundant request before the seed landed.
     * @returns true when the stored record already answers this turn.
     */
    const alreadySuggested = async (): Promise<boolean> => {
      if (state.lastSuggestedTurn >= turn) return true
      const stored = readSuggestion(await domain(), session.id)
      if (stored === undefined) return false
      // A store that cannot be read stays pessimistic: the cursor only ever
      // rises, so an unreadable record costs one regeneration, never a silence.
      state.lastSuggestedTurn = Math.max(state.lastSuggestedTurn, stored.turn)
      return state.lastSuggestedTurn >= turn
    }

    /**
     * Persist one generated suggestion, or advance the cursor for a silent
     * no-suggestion.
     *
     * Separate from the settling callback so a WRITE failure reaches the same
     * reporting path as a generation failure: an `async` fulfillment handler's
     * rejection is NOT delivered to the sibling rejection handler, so inlining
     * this would let a failed write escape as an unhandled rejection.
     *
     * A superseding turn that started while the store was opening drops the
     * write — persisting then would resurrect a suggestion the user already
     * moved past.
     * @param suggested - the generated suggestion, or `undefined` when the
     *   model produced nothing usable.
     */
    const persist = async (suggested: SuggestPromptStorageRecord | undefined): Promise<void> => {
      if (suggested === undefined) {
        // A silent no-suggestion is normal (see generate.ts): no write, and the
        // cursor still advances so this turn is not retried.
        if (state.pending?.controller !== controller) return
        state.pending = undefined
        state.lastSuggestedTurn = turn
        return
      }
      const opened = await domain()
      if (state.pending?.controller !== controller) return
      await mutate(state, async () => {
        if (state.pending?.controller !== controller) return
        await writeSuggestion(opened, session.id, suggested)
        if (state.pending?.controller !== controller) await clearSuggestion(opened, session.id)
      })
      if (state.pending?.controller !== controller) return
      state.pending = undefined
      state.lastSuggestedTurn = turn
    }

    /**
     * Report one failed generation or write.
     * @param error - the rejection reason.
     */
    const reportFailure = (error: unknown): void => {
      if (state.pending?.controller === controller) state.pending = undefined
      // Superseded calls abort with the new controller; their failure is expected.
      if (controller.signal.aborted) return
      // The LLM layer wraps adapter rejections into Errors, so the non-Error
      // arm is defensive only.
      /* v8 ignore next 2 -- non-Error rejections are wrapped by the LLM layer */
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`suggest-prompt: suggestion generation failed: ${message}`)
    }

    // session/event is dispatched synchronously inside the committing append;
    // defer to a microtask so the turn's own commit unwinds first.
    void Promise.resolve().then(async () => {
      if (await alreadySuggested()) return
      // A superseding turn may have arrived while the store was read; its own
      // generation owns the slot now.
      if (state.pending?.controller !== controller) return
      // Retire the older turn's text before the model is called, so the store
      // answers `null` instead of a suggestion this turn has already replaced.
      await retirePrevious()
      if (state.pending?.controller !== controller) return
      // The transcript fold reflects every event up to and including this
      // turn/end, so reading it here yields the completed turn's messages.
      return await generateSuggestion(ctx, resolved, session, turn, transcriptStateOf(session), controller.signal)
    }).then(
      (suggested) => persist(suggested),
      (error: unknown) => { reportFailure(error) },
    ).catch((error: unknown) => { reportFailure(error) })
  }

  // The listener is deliberately not stored: Cordis disposes it with the
  // plugin fiber, and the plugin owns no path that unsubscribes early.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      const state = states.get(session)
      state?.pending?.controller.abort()
      if (state !== undefined) state.pending = undefined
    }
    if (event.type === 'turn/end' && event.data.reason.kind === 'completed') {
      handleTurnEnd(session, event.data.turn)
    }
  })

  // Abort every in-flight generation when the plugin unloads.
  ctx.effect(() => () => {
    disposed = true
    for (const state of tracked) {
      state.pending?.controller.abort()
      state.pending = undefined
    }
  })

  // The browser read endpoint. `connection.fetch.register` claims an exact
  // path on the shared `/api` gateway and returns its disposer, which
  // `ctx.effect` ties to the plugin. A malformed body is answered `null`
  // rather than thrown: the caller is the composer, which only ever wants a
  // value to render.
  //
  // Deliberately NOT `connection.rpc.handle`: that surface registers an HTTP
  // route through the *connection* service's own fiber, which never injects
  // `webServer`, so it throws there regardless of this plugin's own `inject`
  // list. See `SUGGEST_ROUTE_PATH`.
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: SUGGEST_ROUTE_PATH,
      methods: [SUGGEST_ROUTE_METHOD],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        const suggestion = await readForBrowserRequest(request)
        return Response.json({ suggestion })
      },
    }),
    'suggest-prompt: browser suggestion route',
  )

  // Explicit generation shares the automatic path's flight slot, transcript,
  // bounded dispatcher and durable domain; it deliberately bypasses its cursor.
  ctx.effect(() => ctx.connection.fetch.register({
    path: SUGGEST_GENERATE_ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => {
      const reply = (status: SuggestPromptGenerateStatus, code = 200, suggestion: SuggestPromptSuggestion | null = null): Response =>
        Response.json({ suggestion, status }, { status: code })
      let body: unknown
      try { body = await request.json() } catch { return reply('error', 400) }
      const id = sessionIdOf(body)
      if (id === undefined || id.trim() !== id || id.length > 512 || /[\u0000-\u001f]/u.test(id)) return reply('error', 400)
      const session = ctx.sessions.get(id)
      if (session === undefined) return reply('error', 404)
      const state = stateOf(session)
      const lifecycle = ctx.sessionProjections.stateOf(session, 'suggestPromptLifecycle')
      if (disposed || state.pending !== undefined || lifecycle?.running) return reply('busy', 409)
      const transcript = transcriptStateOf(session)
      const turn = transcript.lastCompletedTurn
      if (!lifecycle?.completed || lifecycle.turn !== turn || turn < 1
        || !transcript.entries.some(entry => entry.turn === turn && entry.text.trim().length > 0)) return reply('no-context')
      const controller = new AbortController()
      state.pending = { turn, controller }
      const ownsFlight = (): boolean => !disposed && !controller.signal.aborted && state.pending?.controller === controller
      try {
        const resolved = resolveSuggestPromptConfig(config)
        const opened = await domain()
        if (!ownsFlight()) return reply('busy', 409)
        await mutate(state, async () => {
          if (state.pending?.controller === controller) await clearSuggestion(opened, session.id)
        })
        if (!ownsFlight()) return reply('busy', 409)
        const result = await generateSuggestion(ctx, resolved, session, turn, transcript, controller.signal)
        if (!ownsFlight()) return reply('busy', 409)
        if (result === undefined) {
          state.lastSuggestedTurn = Math.max(state.lastSuggestedTurn, turn)
          return reply('empty')
        }
        await mutate(state, async () => {
          if (!ownsFlight()) return
          await writeSuggestion(opened, session.id, result)
          if (!ownsFlight()) await clearSuggestion(opened, session.id)
        })
        if (!ownsFlight()) return reply('busy', 409)
        state.lastSuggestedTurn = Math.max(state.lastSuggestedTurn, turn)
        return reply('generated', 200, readSuggestion(opened, session.id) ?? null)
      } catch {
        // No adapter error, credential, route or transcript is exposed to clients.
        return ownsFlight() ? reply('error', 502) : reply('busy', 409)
      } finally {
        if (state.pending?.controller === controller) state.pending = undefined
      }
    },
  }), 'suggest-prompt: manual generation route')

  // A separate host-only lifecycle fold handles restored sessions too, without
  // reading deprecated history or depending on private execution internals.
  ctx.sessionProjections.register<'suggestPromptLifecycle', SuggestPromptLifecycle>({
    key: 'suggestPromptLifecycle',
    stateSchema: zod.object({ running: zod.boolean(), turn: zod.number().int().nonnegative(), completed: zod.boolean() }),
    init: () => ({ running: false, turn: 0, completed: false }),
    apply: (state, event) => event.type === 'turn/start'
      ? { running: true, turn: event.data.turn, completed: false }
      : event.type === 'turn/end'
        ? { running: false, turn: event.data.turn, completed: event.data.reason.kind === 'completed' }
        : state,
    stateVersion: 1,
  })

  // Host-only transcript fold: the retained transcript that generation reads in
  // place of the prohibited synchronous session-history scans. It carries no
  // `wire`, so its state never leaves the host. Registered here because the
  // whole plugin body is scoped to the projection registry.
  ctx.sessionProjections.register<'suggestPromptTranscript', SuggestPromptTranscriptState>({
    key: 'suggestPromptTranscript',
    stateSchema: transcriptStateSchema,
    init: () => EMPTY_TRANSCRIPT_STATE,
    apply: applyTranscriptProjection,
    stateVersion: 1,
  })
}

/** Re-exported for the host invariant, which reads committed events. */
export type { SessionEvent, SuggestPromptSuggestion }