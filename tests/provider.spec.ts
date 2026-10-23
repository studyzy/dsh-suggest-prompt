/**
 * Host-half behavior of the suggest-prompt plugin.
 *
 * Durability moved: generation is pure (`generateSuggestion` returns the record
 * and writes nothing) and the plugin persists through its OWN storage domain
 * (`ctx.storageDomain.open(suggestPromptDomainSpec)`), never the session log.
 * The pre-1.2 build appended private `suggest-prompt/…` session events, which
 * `validateStoredEvents` refused on the next cold read (issue #4), so every
 * assertion that used to read a suggestion out of `session.snapshotEvents()` or
 * out of the retired `suggestPrompt` projection now reads the fake domain's
 * `.records` Map / `.puts` counter instead.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import LlmRuntime, { createAssistantMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as suggestPromptPlugin from '@studyzy/dsh-suggest-prompt'
import type { Config } from '@studyzy/dsh-suggest-prompt'
import { apply as installCompanion } from '../src/invariant.ts'
import {
  buildTranscript,
  generateSuggestion,
  resolveSuggestPromptConfig,
  suggestionLanguage,
  systemPrompt,
} from '../src/generate.ts'
import { SUGGEST_DOMAIN_NAME } from '../src/records.ts'
import { SUGGEST_GENERATE_ROUTE_PATH, SUGGEST_ROUTE_METHOD, SUGGEST_ROUTE_PATH } from '../src/rpc-contract.ts'
import type { SuggestPromptStorageRecord } from '../src/domain.ts'
import type { SuggestPromptSuggestion, SuggestPromptTranscriptState } from '../src/types.ts'
import { applyTranscriptProjection, EMPTY_TRANSCRIPT_STATE } from '../src/transcript.ts'
import { createFakeDomain, installFakeStorage } from './storage.ts'
import type { FakeStorageDomain } from './storage.ts'

const CONFIG = {
  maxInputBytes: 1000,
  maxOutputTokens: 32,
  timeoutMs: 1000,
  maxRecentTurns: 3,
  maxTranscriptChars: 500,
  maxSuggestionChars: 40,
} as const

/** Adapter that answers immediately with a fixed text and finish sequence. */
class ImmediateAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly text: string
  readonly tail: readonly StreamChunk[]
  constructor(text = '继续修复登录页', tail: readonly StreamChunk[] = [{ type: 'finish', reason: { kind: 'stop' } }]) {
    super()
    this.text = text
    this.tail = tail
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    options.signal?.throwIfAborted()
    yield { type: 'text-delta', index: 0, text: this.text }
    yield * this.tail
  }
}

/** Adapter that waits for release(), honoring the abort signal. */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly releases: Array<() => void> = []
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await new Promise<void>((resolve) => { this.releases.push(resolve) })
    options.signal?.throwIfAborted()
    yield { type: 'text-delta', index: 0, text: '建议二' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  release(): void { this.releases.shift()?.() }
}

/** Adapter that throws on first use. */
class ThrowingAdapter extends LlmAdapter {
  override async * stream(): AsyncIterable<StreamChunk> {
    throw new Error('boom')
  }
}

/** Adapter that rejects with a non-Error value on first use. */
class ThrowingStringAdapter extends LlmAdapter {
  override async * stream(): AsyncIterable<StreamChunk> {
    throw 'boom-string'
  }
}

let contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts = []
})

/** The browser RPC registry the host plugin registers its read channel on. */
interface RpcCall {
  readonly channel: string
  readonly endpoint: string
  readonly payload: unknown
}

/** Minimal `ctx.connection.fetch` stand-in: records routes, drives their fetch. */
class FetchRouteStandin {
  readonly routes = new Map<string, { methods: readonly string[]; fetch: (request: Request) => Promise<Response> }>()

  register(route: {
    path: string
    methods: readonly string[]
    requestBody: unknown
    fetch: (request: Request) => Promise<Response>
  }): () => void {
    this.routes.set(route.path, { methods: route.methods, fetch: route.fetch })
    return () => { this.routes.delete(route.path) }
  }

  /** Drive the registered route exactly as the `/api` gateway would. */
  async request(sessionId: unknown, path = SUGGEST_ROUTE_PATH): Promise<unknown> {
    const route = this.routes.get(path)
    if (route === undefined) throw new Error(`no host route registered for ${path}`)
    const response = await route.fetch(new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }))
    const body = await response.json() as { suggestion: unknown }
    return body.suggestion
  }
}

/** One mounted bench: the context, the fake store, and the RPC stand-in. */
interface Bench {
  readonly ctx: Context
  readonly domain: FakeStorageDomain
  readonly routes: FetchRouteStandin
}

/**
 * Mount the plugin the way a real profile composes it: LLM, sessions,
 * projections, the RPC registry, and the storage domain it declares.
 * @param config - deployment policy handed to the plugin.
 * @returns the context plus the fake store and RPC stand-in for assertions.
 */
async function bench(config: Config = CONFIG): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const routes = new FetchRouteStandin()
  ctx.provide('connection', { fetch: routes } as never)
  const domain = createFakeDomain()
  installFakeStorage(ctx, domain)
  contexts.push(ctx)
  await ctx.plugin(suggestPromptPlugin, config)
  await new Promise(r => setTimeout(r, 30))
  // Surface a mount failure instead of letting it read as "no suggestion".
  for (const entry of (ctx as unknown as { loader?: { entries(): Iterable<{ options?: { id?: string }; fiber?: { error?: unknown } }> } }).loader?.entries?.() ?? []) {
    if (String(entry.options?.id).includes('suggest') && entry.fiber?.error !== undefined) {
      throw new Error(`suggest-prompt did not activate: ${String(entry.fiber.error)}`)
    }
  }
  return { ctx, domain, routes }
}

function userMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistantMessage(text: string) {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'main', model: 'main-model' },
  })
}

/** Append one completed turn with its route, messages, and end. */
function appendTurn(session: Session, turn: number, user: string, assistant: string): void {
  session.append('turn/start', { turn })
  session.append('user/message', userMessage(user), { surfaceOp: 'append' })
  session.append('assistant/message', { turn, step: 1, message: assistantMessage(assistant) }, { surfaceOp: 'append' })
  session.append('request/header', { header: { config: { provider: 'main', model: 'main-model' } }, reason: 'initial' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Every suggestion record the fake store holds, in insertion order. */
function storedRecords(domain: FakeStorageDomain): SuggestPromptStorageRecord[] {
  return [...domain.records.values()]
}

/** The stored suggestion for one session id, or undefined. */
function storedRecord(domain: FakeStorageDomain, sessionId: string): SuggestPromptStorageRecord | undefined {
  return domain.records.get(sessionId)
}

/** Seed the fake store with an already-durable suggestion (the reload case). */
function seedStored(domain: FakeStorageDomain, sessionId: string, record: SuggestPromptStorageRecord): void {
  domain.records.set(sessionId, record)
}

/**
 * Fold a session's committed events into the host-only transcript state.
 *
 * The plugin reads this projection state at generation time instead of scanning
 * the log (rc.2 prohibits new synchronous history reads in production code and
 * removed the bare `events` accessor), so these tests build their input the same
 * way the runtime does. `snapshotEvents()` is the sanctioned inspection reader
 * for repository tests.
 * @param session - session whose committed events are folded.
 * @returns the transcript fold state generation consumes.
 */
function foldTranscript(session: Session): SuggestPromptTranscriptState {
  return session.snapshotEvents().reduce(applyTranscriptProjection, EMPTY_TRANSCRIPT_STATE)
}

/**
 * The transcript one session's folded events produce.
 * @param session - source session.
 * @param maxRecentTurns - completed-turn tail to include.
 * @param maxTranscriptChars - character budget for the kept tail.
 * @returns the bounded transcript, or undefined when the window holds no text.
 */
function transcriptOf(session: Session, maxRecentTurns: number, maxTranscriptChars: number) {
  return buildTranscript(foldTranscript(session), maxRecentTurns, maxTranscriptChars)
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('resolveSuggestPromptConfig', () => {
  it('validates and deep-freezes a complete policy', () => {
    const resolved = resolveSuggestPromptConfig(CONFIG)
    expect(resolved.maxSuggestionChars).toBe(40)
    expect(Object.isFrozen(resolved)).toBe(true)
  })

  // `dsh >= 0.2.0` hands the plugin a live reference ({ get(), set() }) for every
  // `volatile()`-marked field, because those are the fields the settings form may
  // edit. Reading one as a plain value would silently produce "[object Object]"
  // (or fail validation), so the unwrap is load-bearing.
  it('unwraps volatile field references into plain values', () => {
    const resolved = resolveSuggestPromptConfig({
      ...CONFIG,
      provider: { get: () => 'acme', set: () => {} },
      model: { get: () => 'acme-1', set: () => {} },
      acceptKey: { get: () => 'Alt+Slash', set: () => {} },
    } as never)
    expect(resolved.provider).toBe('acme')
    expect(resolved.model).toBe('acme-1')
    expect(resolved.acceptKey).toBe('Alt+Slash')
  })

  it('treats an absent volatile reference as an absent override', () => {
    // A volatile field with no configured value resolves to undefined; it must
    // not become an explicit undefined key that survives into the policy.
    const resolved = resolveSuggestPromptConfig({
      ...CONFIG,
      provider: { get: () => undefined, set: () => {} },
    } as never)
    expect('provider' in resolved).toBe(false)
  })

  it('rejects a volatile reference whose live value is invalid', () => {
    expect(() => resolveSuggestPromptConfig({
      ...CONFIG,
      provider: { get: () => '', set: () => {} },
    } as never)).toThrow(/provider override must be a non-empty string/)
  })

  it('rejects a non-object, unknown keys, invalid bounds, and empty route overrides', () => {
    expect(() => resolveSuggestPromptConfig(null as never)).toThrow(/configuration is required/)
    expect(() => resolveSuggestPromptConfig({ ...CONFIG, bogus: 1 } as never)).toThrow(/unknown config key/)
    expect(() => resolveSuggestPromptConfig({ ...CONFIG, maxInputBytes: 0 })).toThrow(/maxInputBytes/)
    expect(() => resolveSuggestPromptConfig({ ...CONFIG, maxOutputTokens: 1.5 })).toThrow(/maxOutputTokens/)
    expect(() => resolveSuggestPromptConfig({ ...CONFIG, timeoutMs: MAX_TIMER_DELAY_MS + 1 })).toThrow(/timeoutMs/)
    expect(() => resolveSuggestPromptConfig({ ...CONFIG, maxRecentTurns: -1 })).toThrow(/maxRecentTurns/)
    expect(() => resolveSuggestPromptConfig({ ...CONFIG, maxTranscriptChars: 0 })).toThrow(/maxTranscriptChars/)
    expect(() => resolveSuggestPromptConfig({ ...CONFIG, maxSuggestionChars: 0 })).toThrow(/maxSuggestionChars/)
    expect(() => resolveSuggestPromptConfig({ ...CONFIG, provider: '' })).toThrow(/provider override/)
    expect(() => resolveSuggestPromptConfig({ ...CONFIG, provider: '', model: 'm' })).toThrow(/provider override/)
    expect(() => resolveSuggestPromptConfig({ ...CONFIG, model: '' })).toThrow(/model override/)
    expect(() => resolveSuggestPromptConfig({ ...CONFIG, provider: 3 as never })).toThrow(/provider override/)
    expect(() => resolveSuggestPromptConfig({ ...CONFIG, acceptKey: '' })).toThrow(/acceptKey/)
    expect(() => resolveSuggestPromptConfig({ ...CONFIG, acceptKey: 3 as never })).toThrow(/acceptKey/)
    expect(resolveSuggestPromptConfig(CONFIG).acceptKey).toBeUndefined()
    expect(resolveSuggestPromptConfig({ ...CONFIG, acceptKey: 'Alt+Slash' }).acceptKey).toBe('Alt+Slash')
  })

  it('accepts a partial route override: either member may stand alone', () => {
    const providerOnly = resolveSuggestPromptConfig({ ...CONFIG, provider: 'other' })
    expect(providerOnly.provider).toBe('other')
    expect(providerOnly.model).toBeUndefined()
    const modelOnly = resolveSuggestPromptConfig({ ...CONFIG, model: 'other-model' })
    expect(modelOnly.provider).toBeUndefined()
    expect(modelOnly.model).toBe('other-model')
  })
})

describe('systemPrompt', () => {
  it('bakes the character cap and the reply language into the instruction', () => {
    const prompt = systemPrompt(40, '简体中文')
    expect(prompt).toContain('At most 40 visible characters')
    expect(prompt).toContain('Language: 简体中文')
    expect(systemPrompt(40, 'English')).toContain('Language: English')
  })
})

describe('suggestionLanguage', () => {
  it('follows the last user message language, defaulting to English', () => {
    expect(suggestionLanguage([
      { role: 'user', text: '帮我写个函数' },
      { role: 'assistant', text: '好的' },
    ])).toBe('简体中文')
    expect(suggestionLanguage([
      { role: 'user', text: 'fix the bug' },
      { role: 'assistant', text: 'done' },
    ])).toBe('English')
    expect(suggestionLanguage([{ role: 'assistant', text: 'hello' }])).toBe('English')
  })
})

describe('buildTranscript', () => {
  it('returns undefined without a completed turn', () => {
    const session = Session.create(SessionId('no-turn'))
    session.append('turn/start', { turn: 1 })
    expect(transcriptOf(session, 3, 500)).toBeUndefined()
  })

  it('returns undefined without model-visible messages', () => {
    const session = Session.create(SessionId('no-messages'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(transcriptOf(session, 3, 500)).toBeUndefined()
  })

  it('keeps only the newest maxRecentTurns and reports source seqs and base seq', () => {
    const session = Session.create(SessionId('recent-turns'))
    appendTurn(session, 1, '旧问题', '旧回答')
    appendTurn(session, 2, '新问题', '新回答')
    const transcript = transcriptOf(session, 1, 500)!
    expect(transcript.pairs.map(pair => pair.text)).toEqual(['新问题', '新回答'])
    expect(transcript.baseSeq).toBe(transcript.sourceMessageSeqs[transcript.sourceMessageSeqs.length - 1])
    expect(transcript.sourceMessageSeqs.every(seq => Number.isInteger(seq) && seq >= 0)).toBe(true)
  })

  it('trims the tail to the character budget but always keeps the newest pair', () => {
    const session = Session.create(SessionId('char-budget'))
    appendTurn(session, 1, '旧问题', '旧回答')
    appendTurn(session, 2, '新', '新')
    const transcript = transcriptOf(session, 3, 4)!
    // Even a single pair exceeds the budget; the newest pair still survives.
    expect(transcript.pairs.map(pair => pair.text)).toEqual(['新'])
  })

  it('skips text-less messages and tolerates a missing turn/start boundary', () => {
    const session = Session.create(SessionId('no-text'))
    session.append('user/message', userMessage('有文本'), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [],
        source: { provider: 'main', model: 'main-model' },
      }),
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'reasoning', text: '思考过程' }],
        source: { provider: 'main', model: 'main-model' },
      }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const transcript = transcriptOf(session, 3, 500)!
    expect(transcript.pairs.map(pair => pair.text)).toEqual(['有文本'])
    expect(transcript.sourceMessageSeqs).toHaveLength(1)
  })

  it('excludes harness-injected user context, keeping only genuine user input', () => {
    // Harness writes workspace instructions, runtime snapshots, and the skill
    // catalog as user/message events (source.kind 'agent-instructions' /
    // 'plugin' / 'skill-catalog'). These can be huge; counting them would blow
    // maxInputBytes on a fresh session's first turn and suppress suggestions.
    const session = Session.create(SessionId('injected-context'))
    session.append('turn/start', { turn: 1 })
    // A huge injected context first (would dominate the transcript if kept).
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `<system-reminder>\n${'x'.repeat(20_000)}\n</system-reminder>` }],
      source: { kind: 'agent-instructions', form: 'instructions', baseline: true },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Current runtime context. ...' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' },
    }), { surfaceOp: 'append' })
    session.append('user/message', userMessage('出一道小学数学题给我'), { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, message: assistantMessage('好的，题目是……') }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const transcript = transcriptOf(session, 1, 500)!
    // Only the real prompt survives; the injected context is dropped.
    expect(transcript.pairs.map(pair => pair.text)).toEqual(['出一道小学数学题给我', '好的，题目是……'])
    expect(transcript.sourceMessageSeqs).toHaveLength(2)
  })
})

describe('suggestPromptDomainSpec', () => {
  it('is the plugin-owned durable store, one record per session', () => {
    // The domain is what replaced the session-log record: a plugin-owned name
    // with a per-record layout, so a write rewrites exactly one session's
    // document and an unreadable record is skipped instead of failing the boot.
    expect(SUGGEST_DOMAIN_NAME).toBe('suggest_prompt')
    // The channel must sit under `/api`: Connection's `assertFetchRoute`
    // rejects anything else, and only registered exact paths are dispatched.
    expect(suggestPromptPlugin.SUGGEST_ROUTE_PATH).toBe('/api/suggest-prompt')
    expect(suggestPromptPlugin.SUGGEST_ROUTE_METHOD).toBe('POST')
  })

  it('round-trips a suggestion through the wire projection', async () => {
    const { toStoredRecord, toSuggestion } = await import('../src/records.ts')
    const suggestion: SuggestPromptSuggestion = {
      turn: 2, baseSeq: 5, text: '继续', truncated: true,
      route: { provider: 'main', model: 'main-model' }, acceptKey: 'Tab',
    }
    const record = toStoredRecord(suggestion)
    expect(record).toEqual({ version: 1, ...suggestion })
    expect(toSuggestion(record)).toEqual(suggestion)
    // A restored record carries whatever JSON an earlier build wrote.
    expect(toSuggestion({ version: 1, turn: 'bad' })).toBeUndefined()
  })
})

async function manual(routes: FetchRouteStandin, body: unknown): Promise<Response> {
  return routes.routes.get(SUGGEST_GENERATE_ROUTE_PATH)!.fetch(new Request(`http://localhost${SUGGEST_GENERATE_ROUTE_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
}

describe('manual suggestion generation', () => {
  it('generates durably after automatic silent-empty, and writes no session events', async () => {
    const { ctx, domain, routes } = await bench()
    const adapter = new ImmediateAdapter('')
    const release = ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('manual-retry'))
    appendTurn(session, 1, 'fix login', 'fixed')
    await settle()
    const before = session.snapshotEvents()
    expect((await manual(routes, { sessionId: session.id })).status).toBe(200)
    expect(adapter.requests).toHaveLength(2)
    release()
    ctx.llm.registerAdapter(['main'], new ImmediateAdapter('run the tests'))
    const response = await manual(routes, { sessionId: session.id })
    expect(await response.json()).toMatchObject({ status: 'generated', suggestion: { text: 'run the tests', turn: 1 } })
    expect(domain.records.get(session.id)?.text).toBe('run the tests')
    expect(session.snapshotEvents()).toEqual(before)
  })

  it('validates malformed, missing, unknown, empty and running sessions', async () => {
    const { ctx, routes } = await bench()
    for (const body of ['{', {}, { sessionId: 2 }, { sessionId: ' ' }]) {
      expect((await manual(routes, body)).status).toBe(400)
    }
    expect((await manual(routes, { sessionId: 'unknown' })).status).toBe(404)
    const session = ctx.sessions.create(SessionId('manual-empty'))
    expect(await (await manual(routes, { sessionId: session.id })).json()).toEqual({ suggestion: null, status: 'no-context' })
    session.append('turn/start', { turn: 1 })
    expect((await manual(routes, { sessionId: session.id })).status).toBe(409)
    session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
    expect(await (await manual(routes, { sessionId: session.id })).json()).toEqual({ suggestion: null, status: 'no-context' })
  })

  it('a newer automatic completion supersedes manual without losing its slot', async () => {
    const { ctx, routes, domain } = await bench()
    const release = ctx.llm.registerAdapter(['main'], new ImmediateAdapter(''))
    const session = ctx.sessions.create(SessionId('manual-auto-supersede'))
    appendTurn(session, 1, 'fix login', 'fixed')
    await settle()
    release()
    const adapter = new GatedAdapter()
    ctx.llm.registerAdapter(['main'], adapter)
    const pending = manual(routes, { sessionId: session.id })
    await settle()
    appendTurn(session, 2, 'test login', 'tested')
    await settle()
    expect(adapter.requests).toHaveLength(2)
    adapter.release()
    expect((await pending).status).toBe(409)
    expect((await manual(routes, { sessionId: session.id })).status).toBe(409)
    adapter.release()
    await settle()
    expect(domain.records.get(session.id)?.turn).toBe(2)
  })

  it('shares one flight with auto, rejects duplicate manual calls, and supersedes on start', async () => {
    const { ctx, routes, domain } = await bench()
    const adapter = new GatedAdapter()
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('manual-flight'))
    appendTurn(session, 1, 'fix login', 'fixed')
    await settle()
    expect((await manual(routes, { sessionId: session.id })).status).toBe(409)
    adapter.release()
    await settle()
    const pending = manual(routes, { sessionId: session.id })
    await settle()
    expect((await manual(routes, { sessionId: session.id })).status).toBe(409)
    session.append('turn/start', { turn: 2 })
    expect(adapter.requests[1]?.signal?.aborted).toBe(true)
    adapter.release()
    expect((await pending).status).toBe(409)
    expect(domain.records.has(session.id)).toBe(false)
  })

  it('removes an obsolete manual put that finishes after a new turn starts', async () => {
    const { ctx, routes, domain } = await bench()
    const release = ctx.llm.registerAdapter(['main'], new ImmediateAdapter(''))
    const session = ctx.sessions.create(SessionId('manual-slow-put'))
    appendTurn(session, 1, 'fix login', 'fixed')
    await settle()
    release()
    ctx.llm.registerAdapter(['main'], new ImmediateAdapter('run the tests'))
    const table = domain.table('sessions')
    const originalPut = table.put.bind(table)
    let releasePut!: () => void
    const gate = new Promise<void>(resolve => { releasePut = resolve })
    table.put = async (key, value) => { await gate; await originalPut(key, value) }
    const pending = manual(routes, { sessionId: session.id })
    await settle()
    session.append('turn/start', { turn: 2 })
    releasePut()
    expect((await pending).status).toBe(409)
    expect(domain.records.has(session.id)).toBe(false)
  })

  it('aborts manual generation on dispose and hides provider failure details', async () => {
    const { ctx, routes, domain } = await bench()
    const release = ctx.llm.registerAdapter(['main'], new ImmediateAdapter(''))
    const session = ctx.sessions.create(SessionId('manual-dispose'))
    appendTurn(session, 1, 'fix login', 'fixed')
    await settle()
    release()
    const releaseFailure = ctx.llm.registerAdapter(['main'], new ThrowingAdapter())
    const failure = await manual(routes, { sessionId: session.id })
    expect(failure.status).toBe(502)
    expect(await failure.json()).toEqual({ status: 'error', suggestion: null })
    releaseFailure()
    const adapter = new GatedAdapter()
    ctx.llm.registerAdapter(['main'], adapter)
    const pending = manual(routes, { sessionId: session.id })
    await settle()
    await ctx.fiber.dispose()
    expect(adapter.requests[0]?.signal?.aborted).toBe(true)
    adapter.release()
    expect((await pending).status).toBe(409)
    expect(domain.puts).toBe(0)
  })
})

describe('suggest-prompt plugin generation', () => {
  it('generates one suggestion per completed turn and stores it durably', async () => {
    const { ctx, domain } = await bench()
    const adapter = new ImmediateAdapter()
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('happy-path'))
    appendTurn(session, 1, '帮我写个函数', '好的，请看')

    await settle()

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'main', model: 'main-model', purpose: 'suggest-prompt', maxTokens: 32 })
    expect(adapter.requests[0]?.system).toBe(systemPrompt(40, '简体中文'))

    // Nothing at all enters the log: the durable channel is the plugin's own
    // storage domain, and a plugin-private session event is exactly what wedged
    // sessions on cold read (issue #4).
    expect(session.snapshotEvents().map(event => event.type as string)
      .filter(type => type.startsWith('suggest-prompt') || type.startsWith('plugin:'))).toEqual([])

    // One write, one record, keyed by session id and carrying the whole value.
    expect(domain.puts).toBe(1)
    expect([...domain.records.keys()]).toEqual(['happy-path'])
    expect(storedRecord(domain, 'happy-path')).toEqual({
      version: 1,
      turn: 1,
      baseSeq: expect.any(Number),
      text: '继续修复登录页',
      truncated: false,
      route: { provider: 'main', model: 'main-model' },
      acceptKey: 'Tab',
    })
  })

  it('serves the stored suggestion to the browser over the plugin route', async () => {
    const { ctx, routes } = await bench()
    ctx.llm.registerAdapter(['main'], new ImmediateAdapter())
    const session = ctx.sessions.create(SessionId('route-read'))
    appendTurn(session, 1, '问题', '回答')

    await settle()

    // Before the first suggestion the route answers null, never an error: the
    // caller is the composer, which only wants a value to render.
    expect(await routes.request('nothing-stored')).toBeNull()
    expect(await routes.request('route-read')).toEqual({
      turn: 1,
      baseSeq: expect.any(Number),
      text: '继续修复登录页',
      truncated: false,
      route: { provider: 'main', model: 'main-model' },
      acceptKey: 'Tab',
    })
    // A malformed body is answered with null rather than throwing.
    expect(await routes.request('not-an-object')).toBeNull()
    expect(await routes.request('')).toBeNull()
  })

  it('composes a partial route override with the session route', async () => {
    const { ctx } = await bench({ ...CONFIG, model: 'override-model' })
    const adapter = new ImmediateAdapter()
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('partial-route'))
    appendTurn(session, 1, '问题', '回答')

    await settle()

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'main', model: 'override-model' })
  })

  it('uses the explicit route pair when both members are configured', async () => {
    const { ctx } = await bench({ ...CONFIG, provider: 'other', model: 'other-model' })
    const adapter = new ImmediateAdapter()
    ctx.llm.registerAdapter(['main', 'other'], adapter)
    const session = ctx.sessions.create(SessionId('explicit-route'))
    appendTurn(session, 1, '问题', '回答')

    await settle()

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'other', model: 'other-model' })
  })

  it('carries the configured accept key on the stored record', async () => {
    const { ctx, domain } = await bench({ ...CONFIG, acceptKey: 'Alt+Slash' })
    const adapter = new ImmediateAdapter('继续修复登录页')
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('accept-key'))
    appendTurn(session, 1, '问题', '回答')

    await settle()
    expect(storedRecord(domain, 'accept-key')?.acceptKey).toBe('Alt+Slash')
  })

  it('defaults maxRecentTurns to 1, sending only the last completed turn', async () => {
    const { ctx } = await bench({
      maxInputBytes: 1000,
      maxOutputTokens: 32,
      timeoutMs: 1000,
      maxTranscriptChars: 500,
      maxSuggestionChars: 40,
    })
    const adapter = new ImmediateAdapter('继续修复登录页')
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('default-last-turn'))
    appendTurn(session, 1, '旧问题', '旧回答')
    appendTurn(session, 2, '新问题', '新回答')

    await settle()
    expect(adapter.requests).toHaveLength(1)
    const framed = adapter.requests[0]!.messages[0]!.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join(' ')
    expect(framed).toContain('新问题')
    expect(framed).not.toContain('旧问题')
  })

  it('prefers the configured provider/model pair over the logged route', async () => {
    const { ctx } = await bench({ ...CONFIG, provider: 'explicit', model: 'explicit-model' })
    const adapter = new ImmediateAdapter()
    ctx.llm.registerAdapter(['explicit'], adapter)
    const session = ctx.sessions.create(SessionId('explicit-route'))
    appendTurn(session, 1, '问题', '回答')

    await settle()
    expect(adapter.requests[0]).toMatchObject({ provider: 'explicit', model: 'explicit-model' })
  })

  it('constrains the suggestion language to match the last user prompt', async () => {
    const { ctx } = await bench()
    const adapter = new ImmediateAdapter('run the tests')
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('language-route'))
    appendTurn(session, 1, 'fix the bug', 'done')

    await settle()
    expect(adapter.requests[0]?.system).toContain('Language: English')
  })

  it('skips turns that do not complete', async () => {
    const { ctx, domain } = await bench()
    const adapter = new ImmediateAdapter()
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('no-complete'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', userMessage('问题'), { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, message: assistantMessage('回答') }, { surfaceOp: 'append' })
    session.append('request/header', { header: { config: { provider: 'main', model: 'main-model' } }, reason: 'initial' })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'E', message: 'x' } } })

    await settle()
    expect(adapter.requests).toHaveLength(0)
    expect(domain.puts).toBe(0)
  })

  it('never regenerates a turn whose suggestion is already durable (reload dedupe)', async () => {
    const { ctx, domain } = await bench()
    const adapter = new ImmediateAdapter()
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('reload-dedupe'))
    // The durable record the previous process left behind: a reload must adopt
    // it rather than paying for the same suggestion twice. It is seeded BEFORE
    // the first completed turn, which is when the plugin seeds its cursor.
    seedStored(domain, 'reload-dedupe', {
      version: 1, turn: 1, baseSeq: 4, text: '已有建议', truncated: false, acceptKey: 'Tab',
    })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', userMessage('问题'), { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, message: assistantMessage('回答') }, { surfaceOp: 'append' })
    session.append('request/header', { header: { config: { provider: 'main', model: 'main-model' } }, reason: 'initial' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await settle()
    await settle()
    expect(adapter.requests).toHaveLength(0)
    expect(domain.puts).toBe(0)
    // The pre-existing record is untouched, not overwritten with a fresh one.
    expect(storedRecord(domain, 'reload-dedupe')?.text).toBe('已有建议')
  })

  it('still generates when the stored record answers an older turn', async () => {
    // Only the turn the record answers is deduped: a newer completed turn is a
    // new question and must be answered.
    const { ctx, domain } = await bench()
    const adapter = new ImmediateAdapter()
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('stale-record'))
    seedStored(domain, 'stale-record', {
      version: 1, turn: 1, baseSeq: 4, text: '旧建议', truncated: false, acceptKey: 'Tab',
    })
    appendTurn(session, 1, '问题一', '回答一')
    appendTurn(session, 2, '问题二', '回答二')

    await settle()
    await settle()
    expect(adapter.requests).toHaveLength(1)
    expect(storedRecord(domain, 'stale-record')?.turn).toBe(2)
    expect(storedRecord(domain, 'stale-record')?.text).toBe('继续修复登录页')
  })

  it('aborts an in-flight generation when the next turn completes', async () => {
    const { ctx, domain } = await bench()
    const adapter = new GatedAdapter()
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('supersede'))
    appendTurn(session, 1, '问题一', '回答一')
    await settle()
    expect(adapter.requests).toHaveLength(1)
    appendTurn(session, 2, '问题二', '回答二')
    await settle()
    expect(adapter.requests).toHaveLength(2)

    adapter.release()
    await settle()
    adapter.release()
    await settle()

    // Exactly one durable suggestion: the superseded call's write is dropped
    // rather than resurrecting a suggestion the user already moved past.
    expect(domain.puts).toBe(1)
    const stored = storedRecords(domain)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.turn).toBe(2)
  })

  it('logs a warning and stores nothing when generation fails', async () => {
    const { ctx, domain } = await bench()
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.llm.registerAdapter(['main'], new ThrowingAdapter())
    const session = ctx.sessions.create(SessionId('failure'))
    appendTurn(session, 1, '问题', '回答')

    await settle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('suggest-prompt: suggestion generation failed'))
    expect(domain.puts).toBe(0)
    expect(domain.records.size).toBe(0)
  })

  it('logs a warning and stores nothing when the durable write fails', async () => {
    const { ctx, domain } = await bench()
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.llm.registerAdapter(['main'], new ImmediateAdapter())
    domain.failWrites = new Error('medium is read-only')
    const session = ctx.sessions.create(SessionId('write-failure'))
    appendTurn(session, 1, '问题', '回答')

    await settle()
    await settle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('medium is read-only'))
    // A failed write surfaces as the generation's failure rather than leaving
    // the caller believing the medium accepted state it never did.
    expect(domain.records.size).toBe(0)
  })

  it('fails loud without a logged route and without a config pair', async () => {
    const { ctx, domain } = await bench()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const adapter = new ImmediateAdapter()
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('no-route'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', userMessage('问题'), { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, message: assistantMessage('回答') }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await settle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no complete route is available'))
    expect(adapter.requests).toHaveLength(0)
    expect(domain.puts).toBe(0)
  })

  it('fails loud when the logged header carries an empty route', async () => {
    const { ctx } = await bench()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const session = ctx.sessions.create(SessionId('empty-route'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', userMessage('问题'), { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, message: assistantMessage('回答') }, { surfaceOp: 'append' })
    session.append('request/header', { header: { config: { provider: '', model: '' } }, reason: 'initial' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await settle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no complete route is available'))
  })

  it('drops a repeat turn/end for the same in-flight turn', async () => {
    const { ctx } = await bench()
    const adapter = new GatedAdapter()
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('same-turn-repeat'))
    appendTurn(session, 1, '问题', '回答')
    await settle()
    expect(adapter.requests).toHaveLength(1)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await settle()
    expect(adapter.requests).toHaveLength(1)
    adapter.release()
    await settle()
  })

  it('logs a string rejection without wrapping it', async () => {
    const { ctx } = await bench()
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.llm.registerAdapter(['main'], new ThrowingStringAdapter())
    const session = ctx.sessions.create(SessionId('string-failure'))
    appendTurn(session, 1, '问题', '回答')

    await settle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom-string'))
  })

  it('sanitizes the model output into the durable suggestion', async () => {
    const { ctx, domain } = await bench()
    const adapter = new ImmediateAdapter('\x1b[31m"建议文本"\x1b[0m')
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('sanitized'))
    appendTurn(session, 1, '问题', '回答')

    await settle()
    expect(storedRecord(domain, 'sanitized')?.text).toBe('建议文本')
  })

  it('silently drops a semantically rejectable suggestion', async () => {
    const { ctx, domain } = await bench()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const adapter = new ImmediateAdapter('no suggestion available')
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('filtered'))
    appendTurn(session, 1, '问题', '回答')

    await settle()
    expect(domain.puts).toBe(0)
    expect(domain.records.size).toBe(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('drops verbose output instead of truncating it into a cut-off suggestion', async () => {
    const { ctx, domain } = await bench()
    const adapter = new ImmediateAdapter('很长很长的建议文本'.repeat(10))
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('verbose'))
    appendTurn(session, 1, '问题', '回答')

    await settle()
    expect(domain.puts).toBe(0)
  })

  it('truncates over-cap output that still passes the semantic filter', async () => {
    const { ctx, domain } = await bench()
    const adapter = new ImmediateAdapter(`${'a'.repeat(20)} ${'b'.repeat(20)}`)
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('truncated'))
    appendTurn(session, 1, '问题', '回答')

    await settle()
    const stored = storedRecord(domain, 'truncated')!
    expect(stored.truncated).toBe(true)
    expect(Array.from(stored.text).length).toBe(40)
  })
})

describe('generateSuggestion direct boundary', () => {
  it('throws on a pre-aborted signal', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    contexts.push(ctx)
    const session = Session.create(SessionId('pre-aborted'))
    appendTurn(session, 1, '问题', '回答')
    const signal = new AbortController()
    signal.abort()
    await expect(generateSuggestion(
      ctx,
      resolveSuggestPromptConfig(CONFIG),
      session,
      1,
      foldTranscript(session),
      signal.signal,
    )).rejects.toThrow()
  })

  it('throws without a transcript', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    contexts.push(ctx)
    const session = Session.create(SessionId('no-transcript'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(generateSuggestion(
      ctx,
      resolveSuggestPromptConfig(CONFIG),
      session,
      1,
      foldTranscript(session),
      new AbortController().signal,
    )).rejects.toThrow(/no model-visible transcript/)
  })

  it('throws when the framed input exceeds maxInputBytes', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    contexts.push(ctx)
    const session = Session.create(SessionId('byte-bound'))
    appendTurn(session, 1, '问题', '回答')
    await expect(generateSuggestion(
      ctx,
      resolveSuggestPromptConfig({ ...CONFIG, maxInputBytes: 10 }),
      session,
      1,
      foldTranscript(session),
      new AbortController().signal,
    )).rejects.toThrow(/exceeding maxInputBytes/)
  })

  it('throws when the model requests a tool', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    contexts.push(ctx)
    const adapter = new ImmediateAdapter('', [{
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', index: 0, id: 't-1' as never, name: 'x', arguments: {} },
    }, { type: 'finish', reason: { kind: 'stop' } }] as unknown as StreamChunk[])
    ctx.llm.registerAdapter(['main'], adapter)
    const session = Session.create(SessionId('tool-call'))
    appendTurn(session, 1, '问题', '回答')
    await expect(generateSuggestion(
      ctx,
      resolveSuggestPromptConfig(CONFIG),
      session,
      1,
      foldTranscript(session),
      new AbortController().signal,
    )).rejects.toThrow(/must contain text only/)
  })

  it('throws on terminal finish reasons other than stop', async () => {
    const cases: Array<{ tail: readonly StreamChunk[]; message: string | RegExp }> = [
      { tail: [{ type: 'finish', reason: { kind: 'max-tokens' } }], message: /maxOutputTokens/ },
      { tail: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'E', message: 'boom' } } }], message: /boom/ },
      { tail: [{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'A', message: 'abort' } } }], message: /abort/ },
      { tail: [{ type: 'finish', reason: { kind: 'tool-calls' } }], message: /requested a tool/ },
    ]
    for (const { tail, message } of cases) {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      contexts.push(ctx)
      const adapter = new ImmediateAdapter('x', tail)
      ctx.llm.registerAdapter(['main'], adapter)
      const session = Session.create(SessionId('finish-case'))
      appendTurn(session, 1, '问题', '回答')
      await expect(generateSuggestion(
        ctx,
        resolveSuggestPromptConfig(CONFIG),
        session,
        1,
        foldTranscript(session),
        new AbortController().signal,
      )).rejects.toThrow(message)
    }
  })

  it('silently skips when sanitization leaves no text', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    contexts.push(ctx)
    const adapter = new ImmediateAdapter('\u001b[31m\u001b[0m')
    ctx.llm.registerAdapter(['main'], adapter)
    const session = Session.create(SessionId('empty-output'))
    appendTurn(session, 1, '问题', '回答')
    const result = await generateSuggestion(
      ctx,
      resolveSuggestPromptConfig(CONFIG),
      session,
      1,
      foldTranscript(session),
      new AbortController().signal,
    )
    expect(result).toBeUndefined()
    // Generation is pure with respect to durability: with no usable reply there
    // is nothing to hand back, and the session log is untouched either way.
    expect(session.snapshotEvents().map(event => event.type as string)
      .filter(type => type.startsWith('suggest-prompt'))).toEqual([])
  })

  it('returns the record instead of writing it, leaving persistence to the caller', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    contexts.push(ctx)
    const adapter = new ImmediateAdapter('run the tests')
    ctx.llm.registerAdapter(['main'], adapter)
    const session = Session.create(SessionId('pure-generation'))
    appendTurn(session, 1, '问题', '回答')
    const before = session.snapshotEvents().length
    const result = await generateSuggestion(
      ctx,
      resolveSuggestPromptConfig(CONFIG),
      session,
      1,
      foldTranscript(session),
      new AbortController().signal,
    )
    expect(result).toMatchObject({ version: 1, turn: 1, text: 'run the tests', acceptKey: 'Tab' })
    expect(session.snapshotEvents()).toHaveLength(before)
  })

  it('defaults the accept key to Tab when the config omits it', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    contexts.push(ctx)
    const adapter = new ImmediateAdapter('run the tests')
    ctx.llm.registerAdapter(['main'], adapter)
    const session = Session.create(SessionId('default-accept-key'))
    appendTurn(session, 1, '问题', '回答')
    const result = await generateSuggestion(
      ctx,
      resolveSuggestPromptConfig(CONFIG),
      session,
      1,
      foldTranscript(session),
      new AbortController().signal,
    )
    expect(result?.acceptKey).toBe('Tab')
  })

  it('defaults the transcript window to the last turn when maxRecentTurns is omitted', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    contexts.push(ctx)
    const adapter = new ImmediateAdapter('run the tests')
    ctx.llm.registerAdapter(['main'], adapter)
    const session = Session.create(SessionId('direct-default-turns'))
    appendTurn(session, 1, '旧问题', '旧回答')
    appendTurn(session, 2, '新问题', '新回答')
    const result = await generateSuggestion(
      ctx,
      resolveSuggestPromptConfig({
        maxInputBytes: 1000, maxOutputTokens: 32, timeoutMs: 1000,
        maxTranscriptChars: 500, maxSuggestionChars: 40,
      }),
      session,
      2,
      foldTranscript(session),
      new AbortController().signal,
    )
    expect(result).toBeDefined()
    const framed = adapter.requests[0]!.messages[0]!.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join(' ')
    expect(framed).toContain('新问题')
    expect(framed).not.toContain('旧问题')
  })
})

describe('suggest-prompt log prohibition invariant', () => {
  /** A context with the invariant registry and companion mounted over sessions. */
  async function invariantCtx(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(SessionStore)
    await ctx.plugin({ inject: ['invariants'], apply: installCompanion })
    contexts.push(ctx)
    return ctx
  }

  it('accepts ordinary session traffic', async () => {
    const ctx = await invariantCtx()
    const session = ctx.sessions.create(SessionId('inv-ordinary'))
    expect(() => {
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }).not.toThrow()
  })

  it('rejects the historical suggestion event type on commit', async () => {
    // This is the regression that made sessions unloadable: the suggestion must
    // live in the storage domain, never in the agent's conversation log.
    const ctx = await invariantCtx()
    const session = ctx.sessions.create(SessionId('inv-suggested'))
    expect(() => session.append('suggest-prompt/suggested' as never, {
      version: 1, turn: 1, baseSeq: 2, text: '建议', truncated: false, acceptKey: 'Tab',
    } as never)).toThrow(/must not write session-log events/)
  })

  it('rejects the plugin-record spelling as well', async () => {
    const ctx = await invariantCtx()
    const session = ctx.sessions.create(SessionId('inv-plugin-record'))
    expect(() => session.append('plugin:suggest-prompt/suggested' as never, {
      version: 1, turn: 1, baseSeq: 2, text: '建议', truncated: false, acceptKey: 'Tab',
    } as never)).toThrow(/must not write session-log events/)
  })

  it('ignores foreign plugin records', async () => {
    const ctx = await invariantCtx()
    const session = ctx.sessions.create(SessionId('inv-foreign'))
    expect(() => session.append('plugin:other/state', { anything: true } as never)).not.toThrow()
  })
})

describe('plugin mount composition', () => {
  it('declares the services the durable store and browser endpoint need', () => {
    // No `webServer`: this plugin registers through `connection.fetch`, which
    // touches only the connection service's own route table. The sibling
    // `rpc.handle` surface is the one that reads `webServer` — and it reads it
    // on the CONNECTION fiber, which never injects it, so that call throws
    // there no matter what this list says. See `SUGGEST_ROUTE_PATH`.
    expect(suggestPromptPlugin.inject)
      .toEqual(['llm', 'sessions', 'storageDomain', 'connection'])
    expect(suggestPromptPlugin.name).toBe('suggest-prompt')
  })

  it('registers its browser route through connection.fetch, not webServer', async () => {
    // The desktop regression. `connection.rpc.handle` registers its channel as
    // an HTTP route through `owner.webServer.register(...)`, where `owner` is
    // the CONNECTION service's own fiber — which injects `['credentials']` plus
    // its profile row's `[webRuntime]`, never `webServer`. That read therefore
    // throws `cannot get property "webServer" without inject` inside the
    // harness, regardless of this plugin's own `inject`, aborting the plugin
    // body and rolling back the session listener with it. The composer then
    // never fills and nothing is reported anywhere the user can see.
    //
    // `connection.fetch.register` writes only to the connection's own route
    // table, so it carries no such dependency.
    expect(suggestPromptPlugin.inject).toContain('connection')
    expect(suggestPromptPlugin.inject).not.toContain('webServer')

    const { ctx, routes } = await bench()
    const seen: string[] = []
    ctx.on('session/event', (_s, event) => { seen.push(event.type) })
    const session = ctx.sessions.create(SessionId('route-liveness'))
    appendTurn(session, 1, '问题', '回答')
    await settle()
    expect(seen).toContain('turn/end')
    expect([...routes.routes.keys()]).toContain(suggestPromptPlugin.SUGGEST_ROUTE_PATH)
  })

  it('registers only the host-only transcript projection, never a client-visible one', async () => {
    const { ctx } = await bench()
    const session = ctx.sessions.create(SessionId('projection-keys'))
    appendTurn(session, 1, '问题', '回答')
    await settle()
    // Client-visible values carry only units that declare a `wire`; the retired
    // `suggestPrompt` projection is gone, and the host-only fold never leaves
    // the host. `stateOf` is the host-side read face the plugin itself uses.
    const values = ctx.sessionProjections.snapshot(session).values as Record<string, unknown>
    expect('suggestPrompt' in values).toBe(false)
    expect('suggestPromptTranscript' in values).toBe(false)
    expect(ctx.sessionProjections.stateOf(session, 'suggestPromptTranscript'))
      .toMatchObject({ lastCompletedTurn: 1 })
  })

  it('unregisters the browser endpoint when the plugin unloads', async () => {
    const { routes } = await bench()
    expect(routes.routes.has(SUGGEST_ROUTE_PATH)).toBe(true)
    for (const each of [...contexts]) await each.fiber.dispose()
    expect(routes.routes.has(SUGGEST_ROUTE_PATH)).toBe(false)
  })

  it('mounts the generation capability without a configured route but never calls the LLM', async () => {
    // A deployment with no provider/model runs the same code path as a session
    // with no logged route: generation fails loud and nothing is stored.
    const { ctx, domain } = await bench({ ...CONFIG })
    const adapter = new ImmediateAdapter()
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('no-route-bench'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', userMessage('问题'), { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, message: assistantMessage('回答') }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await settle()
    expect(adapter.requests).toHaveLength(0)
    expect(domain.puts).toBe(0)
  })
})