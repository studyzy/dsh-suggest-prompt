/**
 * The two seams that replaced the session-log record: the durable suggestion
 * store, and the browser read endpoint over the plugin's `/api` route.
 *
 * These are the contracts issue #4 turned on: a suggestion must be persisted
 * somewhere that is NOT the session log, and it must still reach the composer.
 * The store tests cover the read/write/ownership rules; the endpoint tests cover
 * the browser-visible half, including the malformed and unknown-endpoint paths
 * that decide whether a broken call degrades to "no ghost text" or breaks the
 * composer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createAssistantMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { apply as applyPlugin, Config as PluginConfig, inject as PLUGIN_INJECT } from '../src/index.ts'
import {
  readSuggestion,
  toStoredRecord,
  toSuggestion,
  writeSuggestion,
  suggestPromptDomainSpec,
  SUGGEST_DOMAIN_NAME,
} from '../src/records.ts'
import { SUGGEST_ROUTE_METHOD, SUGGEST_ROUTE_PATH } from '../src/rpc-contract.ts'
import { createFakeDomain, installFakeStorage } from './storage.ts'
import type { FakeStorageDomain } from './storage.ts'

const SUGGESTION = {
  turn: 1,
  baseSeq: 4,
  text: 'run the focused suite',
  truncated: false,
  acceptKey: 'Tab',
} as const

const CONFIG = {
  maxInputBytes: 4096,
  maxOutputTokens: 512,
  timeoutMs: 60_000,
  maxRecentTurns: 1,
  maxTranscriptChars: 12_000,
  maxSuggestionChars: 240,
  acceptKey: 'Tab',
}

describe('the durable suggestion store', () => {
  it('declares one per-record domain that never fails the boot on bad data', () => {
    // The spec IS the durable contract: a rename or version bump silently
    // orphans every stored suggestion, and dropping `invalidRecords` would turn
    // one unreadable record into a failed startup.
    expect(SUGGEST_DOMAIN_NAME).toBe('suggest_prompt')
    expect(suggestPromptDomainSpec.name).toBe('suggest_prompt')
    expect(suggestPromptDomainSpec.version).toBe(1)
    expect(suggestPromptDomainSpec.invalidRecords).toBe('backup-and-skip')
    expect(Object.keys(suggestPromptDomainSpec.tables)).toEqual(['sessions'])
  })

  it('round-trips a suggestion through the store', async () => {
    const domain = createFakeDomain()
    await writeSuggestion(domain as never, SessionId('s1'), SUGGESTION)
    expect(readSuggestion(domain as never, SessionId('s1'))).toEqual(SUGGESTION)
  })

  it('returns undefined for a session with no stored suggestion', () => {
    const domain = createFakeDomain()
    expect(readSuggestion(domain as never, SessionId('absent'))).toBeUndefined()
  })

  it('replaces the whole record rather than merging (whole-value discipline)', async () => {
    const domain = createFakeDomain()
    await writeSuggestion(domain as never, SessionId('s1'), SUGGESTION)
    await writeSuggestion(domain as never, SessionId('s1'), {
      ...SUGGESTION, turn: 2, text: 'second', truncated: true,
    })
    expect(domain.records.size).toBe(1)
    expect(readSuggestion(domain as never, SessionId('s1'))).toMatchObject({ turn: 2, text: 'second', truncated: true })
  })

  it('keeps one record per session', async () => {
    const domain = createFakeDomain()
    await writeSuggestion(domain as never, SessionId('a'), SUGGESTION)
    await writeSuggestion(domain as never, SessionId('b'), { ...SUGGESTION, text: 'other' })
    expect(domain.records.size).toBe(2)
    expect(readSuggestion(domain as never, SessionId('a'))?.text).toBe('run the focused suite')
    expect(readSuggestion(domain as never, SessionId('b'))?.text).toBe('other')
  })

  it('refuses to serve a record written by another build', () => {
    // A record is owner-validated data: the harness leaves its shape to the
    // plugin, so a stale or hand-edited row must read as "no suggestion" rather
    // than reach the composer as a malformed value.
    expect(toSuggestion({ version: 2, turn: 1, text: 'x', baseSeq: 0, truncated: false, acceptKey: 'Tab' })).toBeUndefined()
    expect(toSuggestion({ version: 1, turn: 1, text: '', baseSeq: 0, truncated: false, acceptKey: 'Tab' })).toBeUndefined()
    expect(toSuggestion({ version: 1, turn: 'nope', text: 'x', baseSeq: 0, truncated: false, acceptKey: 'Tab' })).toBeUndefined()
    expect(toSuggestion(null)).toBeUndefined()
    expect(toSuggestion('nonsense')).toBeUndefined()
  })

  it('serves a current record unchanged', () => {
    expect(toSuggestion(toStoredRecord(SUGGESTION))).toEqual(SUGGESTION)
  })

  it('omits an absent route rather than storing a null one', () => {
    // `exactOptionalPropertyTypes` + a zod `.optional()` field: writing an
    // explicit `undefined` would be rejected by the durable boundary.
    expect(toStoredRecord(SUGGESTION)).not.toHaveProperty('route')
    const withRoute = { ...SUGGESTION, route: { provider: 'p', model: 'm' } }
    expect(toSuggestion(toStoredRecord(withRoute))?.route).toEqual({ provider: 'p', model: 'm' })
  })
})

/**
 * A one-shot LLM adapter that answers every auxiliary request with fixed text.
 *
 * `hold` gates the stream: when armed, the generator parks until `release()` is
 * called, which is what lets a test observe the store WHILE a suggestion is
 * being generated (the stale-flash window) instead of only after it lands.
 */
class FixedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private gate: Promise<void> | undefined
  private openGate: (() => void) | undefined
  constructor(private readonly reply: string) { super() }

  /** Park the next (and subsequent) streams until {@link release} is called. */
  hold(): void {
    this.gate = new Promise<void>((resolve) => { this.openGate = resolve })
  }

  /** Let a held stream finish. */
  release(): void {
    this.openGate?.()
    this.gate = undefined
    this.openGate = undefined
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.gate !== undefined) await this.gate
    yield { type: 'text-delta', index: 0, text: this.reply }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** One mounted plugin plus the capture of the channel it registered. */
interface Mounted {
  readonly ctx: Context
  readonly domain: FakeStorageDomain
  readonly adapter: FixedAdapter
  /** Invoke the registered RPC handler, exactly as the transport would. */
  call(sessionId: unknown): Promise<{ suggestion: unknown }>
}

let mounted: Mounted | undefined

/**
 * Mount the plugin against an in-memory store, capturing the RPC registration so
 * the browser endpoint can be driven without a real transport.
 * @param reply - auxiliary model reply text.
 * @param seed - optional record to pre-populate the store with.
 */
async function mount(reply = 'run the focused suite', seed?: Record<string, unknown>): Promise<Mounted> {
  const ctx = new Context()
  const domain = createFakeDomain()
  if (seed !== undefined) domain.records.set(String(seed.key), seed.value as never)
  installFakeStorage(ctx, domain)

  let handler: ((request: Request) => Promise<Response>) | undefined
  ctx.provide('connection', {
    fetch: {
      register(route: { path: string; methods: readonly string[]; fetch: typeof handler }) {
        expect([SUGGEST_ROUTE_PATH, `${SUGGEST_ROUTE_PATH}/generate`]).toContain(route.path)
        expect(route.methods).toEqual([SUGGEST_ROUTE_METHOD])
        if (route.path === SUGGEST_ROUTE_PATH) handler = route.fetch
        return () => undefined
      },
    },
  } as never)

  const adapter = new FixedAdapter(reply)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.llm.registerAdapter(['main'], adapter)
  // Mount through ctx.plugin so activation (including the scoped
  // `ctx.inject(['sessionProjections'], …)` body) is awaited before the test
  // appends anything. A bare `applyPlugin(ctx, config)` returns before that
  // scope resolves and the turn listener would not yet be wired.
  await ctx.plugin({
    name: 'suggest-prompt',
    inject: PLUGIN_INJECT,
    apply: applyPlugin,
    Config: PluginConfig,
  }, CONFIG)

  const result: Mounted = {
    ctx,
    domain,
    adapter,
    async call(sessionId) {
      if (handler === undefined) throw new Error('the plugin registered no browser route')
      const response = await handler(new Request(`http://localhost${SUGGEST_ROUTE_PATH}`, {
        method: SUGGEST_ROUTE_METHOD,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }))
      return await response.json() as never
    },
  }
  mounted = result
  return result
}

/**
 * Create a session that has completed one turn, so generation has a transcript
 * to build from.
 * @param ctx - mounted context.
 * @param id - session id, which is also the storage key.
 */
function completedTurn(ctx: Context, id: string): { session: ReturnType<Context['sessions']['create']> } {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'do a thing' }],
  }) as never, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'done a thing' }],
      source: { provider: 'main', model: 'main-model' },
    }),
  } as never, { surfaceOp: 'append' })
  // Route resolution inherits the logged request header; without it the
  // generator fails loud rather than guessing a route.
  session.append('request/header', {
    header: { config: { provider: 'main', model: 'main-model' } },
    reason: 'initial',
  })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { session }
}

/**
 * Complete one more turn on an existing session.
 *
 * The stale-suggestion tests need a genuine second completed turn on the SAME
 * session: retiring the previous record is keyed on the session, so a second
 * session would not exercise it.
 * @param session - the session to advance.
 * @param turn - the turn number to complete.
 */
function anotherTurn(
  session: ReturnType<Context['sessions']['create']>,
  turn: number,
): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: `do thing ${String(turn)}` }],
  }) as never, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: `done thing ${String(turn)}` }],
      source: { provider: 'main', model: 'main-model' },
    }),
  } as never, { surfaceOp: 'append' })
  session.append('request/header', {
    header: { config: { provider: 'main', model: 'main-model' } },
    reason: 'initial',
  })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Flush pending microtasks and the awaited store open. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

afterEach(async () => {
  await mounted?.ctx.fiber.dispose()
  mounted = undefined
  vi.restoreAllMocks()
})

describe('the browser read endpoint', () => {
  it('serves the stored suggestion for a session', async () => {
    const m = await mount()
    await writeSuggestion(m.domain as never, SessionId('sess-1'), SUGGESTION)
    const result = await m.call('sess-1')
    expect(result.suggestion).toEqual(SUGGESTION)
  })

  it('answers null for a session with no suggestion', async () => {
    const m = await mount()
    expect(await m.call('nothing-here')).toEqual({ suggestion: null })
  })

  it('answers null for a malformed payload instead of throwing', async () => {
    // The caller is the composer: a bad payload must read as "no suggestion",
    // never as an error rendered where the user is typing.
    const m = await mount()
    for (const payload of [null, undefined, 'sess', 42, {}, { sessionId: '' }, { sessionId: 7 }]) {
      expect(await m.call(payload)).toEqual({ suggestion: null })
    }
  })

  it('never serves the superseded suggestion while the next one generates', async () => {
    // The reported bug: tip 1 is on screen, the user sends a second message,
    // and the composer shows tip 1 again for the whole generation before
    // swapping to tip 2 — the stale window is exactly the model's latency.
    const m = await mount('tip one')
    const { session } = completedTurn(m.ctx, 'stale')
    await flush()
    expect((await m.call('stale')).suggestion).toMatchObject({ turn: 1, text: 'tip one' })

    // Second turn completes with the model deliberately parked, so the test
    // observes the store at the exact moment the composer polls it.
    m.adapter.hold()
    anotherTurn(session, 2)
    await flush()
    expect(m.adapter.requests).toHaveLength(2)
    // This is the whole fix: the retired record answers "no suggestion yet"
    // instead of showing the one this turn has already replaced.
    expect(m.domain.deletes).toBe(1)
    expect((await m.call('stale')).suggestion).toBeNull()

    // And the new tip still arrives once generation completes.
    m.adapter.release()
    await flush()
    expect((await m.call('stale')).suggestion).toMatchObject({ turn: 2, text: 'tip one' })
  })

  it('serves the new suggestion once it is generated', async () => {
    const m = await mount('tip one')
    const { session } = completedTurn(m.ctx, 'swap')
    await flush()
    anotherTurn(session, 2)
    await flush()
    expect((await m.call('swap')).suggestion).toMatchObject({ turn: 2, text: 'tip one' })
  })

  it('does not retire a record when the turn is already answered', async () => {
    // Re-delivering the same turn must not clear a good record: `alreadySuggested`
    // short-circuits before the retire step, so a duplicate turn/end is a no-op.
    const m = await mount('only tip')
    const { session } = completedTurn(m.ctx, 'dupe')
    await flush()
    expect((await m.call('dupe')).suggestion).toMatchObject({ turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await flush()
    expect(m.domain.deletes).toBe(0)
    expect((await m.call('dupe')).suggestion).toMatchObject({ turn: 1, text: 'only tip' })
  })

  it('publishes the suggestion it just generated', async () => {
    const m = await mount('run the focused suite')
    completedTurn(m.ctx, 'live')
    await flush()
    expect(m.adapter.requests).toHaveLength(1)
    const result = await m.call('live')
    expect(result.suggestion).toMatchObject({ turn: 1, text: 'run the focused suite' })
  })
})

describe('generation writes to the store and never to the session log', () => {
  it('persists one record per completed turn', async () => {
    const m = await mount()
    const { session } = completedTurn(m.ctx, 'one-turn')
    await flush()
    expect(m.domain.puts).toBe(1)
    expect(readSuggestion(m.domain as never, SessionId('one-turn'))).toMatchObject({ turn: 1 })

    // The log-prohibition guarantee: ordinary traffic only, and no event of any
    // kind carries the suggestion.
    const types = session.snapshotEvents().map(event => (event as { type: string }).type)
    expect(types.some(type => type.startsWith('suggest-prompt') || type.startsWith('plugin:suggest-prompt'))).toBe(false)
  })

  it('skips a turn whose suggestion is already stored (reload dedupe)', async () => {
    const m = await mount()
    await writeSuggestion(m.domain as never, SessionId('already'), { ...SUGGESTION, turn: 1 })
    // Only the seeding write above counts; the turn itself must add none.
    const seeded = m.domain.puts
    completedTurn(m.ctx, 'already')
    await flush()
    expect(m.adapter.requests).toHaveLength(0)
    expect(m.domain.puts).toBe(seeded)
  })

  it('stores nothing when the model produces no usable suggestion', async () => {
    const m = await mount('   ')
    completedTurn(m.ctx, 'silent')
    await flush()
    expect(m.adapter.requests).toHaveLength(1)
    expect(m.domain.puts).toBe(0)
  })

  it('warns and stores nothing when the write fails', async () => {
    const m = await mount()
    const warn = vi.spyOn(m.ctx.logger, 'warn').mockImplementation(() => undefined)
    m.domain.failWrites = new Error('disk on fire')
    completedTurn(m.ctx, 'broken')
    await flush()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('suggestion generation failed'))
    expect(m.domain.records.size).toBe(0)
  })
})

/** Keep the type import honest without pulling the value into the program. */
export type { SessionIdType }
