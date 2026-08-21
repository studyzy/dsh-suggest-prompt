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
import { applySuggestPromptProjection } from '@studyzy/dsh-suggest-prompt'
import { apply as installCompanion } from '../src/invariant.ts'
import {
  buildTranscript,
  generateSuggestion,
  resolveSuggestPromptConfig,
  suggestionLanguage,
  systemPrompt,
} from '../src/generate.ts'
import type { SuggestPromptProjection } from '../src/types.ts'
import type { SuggestPromptRequested, SuggestPromptSuggested } from '../src/domain.ts'

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

async function bench(config: Config = CONFIG): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  contexts.push(ctx)
  await ctx.plugin(suggestPromptPlugin, config)
  return ctx
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

function suggestedEvents(session: Session): SuggestPromptSuggested[] {
  return session.events
    .filter(event => event.type === 'suggest-prompt/suggested')
    .map(event => event.data)
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
    expect(buildTranscript(session, 3, 500)).toBeUndefined()
  })

  it('returns undefined without model-visible messages', () => {
    const session = Session.create(SessionId('no-messages'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(buildTranscript(session, 3, 500)).toBeUndefined()
  })

  it('keeps only the newest maxRecentTurns and reports source seqs and base seq', () => {
    const session = Session.create(SessionId('recent-turns'))
    appendTurn(session, 1, '旧问题', '旧回答')
    const secondUser = session.events.find(event => event.type === 'user/message')!.seq
    void secondUser
    appendTurn(session, 2, '新问题', '新回答')
    const transcript = buildTranscript(session, 1, 500)!
    expect(transcript.pairs.map(pair => pair.text)).toEqual(['新问题', '新回答'])
    expect(transcript.baseSeq).toBe(transcript.sourceMessageSeqs[transcript.sourceMessageSeqs.length - 1])
    expect(transcript.sourceMessageSeqs.every(seq => Number.isInteger(seq) && seq >= 0)).toBe(true)
  })

  it('trims the tail to the character budget but always keeps the newest pair', () => {
    const session = Session.create(SessionId('char-budget'))
    appendTurn(session, 1, '旧问题', '旧回答')
    appendTurn(session, 2, '新', '新')
    const transcript = buildTranscript(session, 3, 4)!
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
    const transcript = buildTranscript(session, 3, 500)!
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

    const transcript = buildTranscript(session, 1, 500)!
    // Only the real prompt survives; the injected context is dropped.
    expect(transcript.pairs.map(pair => pair.text)).toEqual(['出一道小学数学题给我', '好的，题目是……'])
    expect(transcript.sourceMessageSeqs).toHaveLength(2)
  })
})

describe('applySuggestPromptProjection', () => {
  it('returns the same reference for unrelated events', () => {
    const state: SuggestPromptProjection = { turn: 1, baseSeq: 2, text: 'x', truncated: false, requestSeq: 3, acceptKey: 'Tab' }
    const event = { type: 'turn/start', data: { turn: 1 } } as never
    expect(applySuggestPromptProjection(state, event)).toBe(state)
  })

  it('maps a suggested whole value, keeping route when present', () => {
    const event = {
      type: 'suggest-prompt/suggested',
      data: {
        version: 1, turn: 2, baseSeq: 5, text: '继续', truncated: true,
        route: { provider: 'main', model: 'main-model' }, requestSeq: 6, acceptKey: 'Tab',
      },
    } as never
    expect(applySuggestPromptProjection(null, event)).toEqual({
      turn: 2, baseSeq: 5, text: '继续', truncated: true,
      route: { provider: 'main', model: 'main-model' }, requestSeq: 6, acceptKey: 'Tab',
    })
  })

  it('maps a suggested whole value without a route', () => {
    const event = {
      type: 'suggest-prompt/suggested',
      data: { version: 1, turn: 2, baseSeq: 5, text: '继续', truncated: false, requestSeq: 6, acceptKey: 'Tab' },
    } as never
    expect(applySuggestPromptProjection(null, event)).toEqual({
      turn: 2, baseSeq: 5, text: '继续', truncated: false, requestSeq: 6, acceptKey: 'Tab',
    })
  })
})

describe('suggest-prompt plugin generation', () => {
  it('generates one suggestion per completed turn and drives the projection', async () => {
    const ctx = await bench()
    const adapter = new ImmediateAdapter()
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('happy-path'))
    appendTurn(session, 1, '帮我写个函数', '好的，请看')

    await settle()

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'main', model: 'main-model', purpose: 'suggest-prompt', maxTokens: 32 })
    expect(adapter.requests[0]?.system).toBe(systemPrompt(40, '简体中文'))

    // The bare LlmAdapter declares no reasoning support, so the reasoning-off
    // attempt is refused before dispatch and the generation retries without the
    // override. Both attempts are logged pre-dispatch; the suggestion points at
    // the request that actually produced it (the retry).
    const requestEvents = session.events.filter(event => event.type === 'suggest-prompt/request')
    expect(requestEvents).toHaveLength(2)
    expect((requestEvents[0]?.data as SuggestPromptRequested | undefined)?.reasoningOff).toBe(true)
    expect((requestEvents[1]?.data as SuggestPromptRequested | undefined)?.reasoningOff).toBe(false)
    expect((requestEvents[0]?.data as { sourceMessageSeqs: number[] }).sourceMessageSeqs.length).toBe(2)

    const suggested = suggestedEvents(session)
    expect(suggested).toHaveLength(1)
    expect(suggested[0]).toMatchObject({
      turn: 1, text: '继续修复登录页', truncated: false,
      route: { provider: 'main', model: 'main-model' }, acceptKey: 'Tab',
    })
    expect(suggested[0]?.requestSeq).toBe(requestEvents[1]?.seq)

    const projection = ctx.sessionProjections.snapshot(session).values.suggestPrompt
    expect(projection).toMatchObject({ turn: 1, text: '继续修复登录页', acceptKey: 'Tab' })
  })

  it('composes a partial route override with the session route', async () => {
    const ctx = await bench({ ...CONFIG, model: 'override-model' })
    const adapter = new ImmediateAdapter()
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('partial-route'))
    appendTurn(session, 1, '问题', '回答')

    await settle()

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'main', model: 'override-model' })
  })

  it('uses the explicit route pair when both members are configured', async () => {
    const ctx = await bench({ ...CONFIG, provider: 'other', model: 'other-model' })
    const adapter = new ImmediateAdapter()
    ctx.llm.registerAdapter(['main', 'other'], adapter)
    const session = ctx.sessions.create(SessionId('explicit-route'))
    appendTurn(session, 1, '问题', '回答')

    await settle()

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'other', model: 'other-model' })
  })

  it('carries the configured accept key on the suggestion event and projection', async () => {
    const ctx = await bench({ ...CONFIG, acceptKey: 'Alt+Slash' })
    const adapter = new ImmediateAdapter('继续修复登录页')
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('accept-key'))
    appendTurn(session, 1, '问题', '回答')

    await settle()
    expect(suggestedEvents(session)[0]?.acceptKey).toBe('Alt+Slash')
    expect(ctx.sessionProjections.snapshot(session).values.suggestPrompt).toMatchObject({ acceptKey: 'Alt+Slash' })
  })

  it('defaults maxRecentTurns to 1, sending only the last completed turn', async () => {
    const ctx = await bench({
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
    const requestData = session.events.find(event => event.type === 'suggest-prompt/request')!.data as { messages: readonly Message[] }
    const framed = requestData.messages[0]?.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join(' ')
    expect(framed).toContain('新问题')
    expect(framed).not.toContain('旧问题')
  })

  it('prefers the configured provider/model pair over the logged route', async () => {
    const ctx = await bench({ ...CONFIG, provider: 'explicit', model: 'explicit-model' })
    const adapter = new ImmediateAdapter()
    ctx.llm.registerAdapter(['explicit'], adapter)
    const session = ctx.sessions.create(SessionId('explicit-route'))
    appendTurn(session, 1, '问题', '回答')

    await settle()
    expect(adapter.requests[0]).toMatchObject({ provider: 'explicit', model: 'explicit-model' })
  })

  it('constrains the suggestion language to match the last user prompt', async () => {
    const ctx = await bench()
    const adapter = new ImmediateAdapter('run the tests')
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('language-route'))
    appendTurn(session, 1, 'fix the bug', 'done')

    await settle()
    expect(adapter.requests[0]?.system).toContain('Language: English')
  })

  it('skips turns that do not complete', async () => {
    const ctx = await bench()
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
  })

  it('never regenerates a turn whose suggestion is already durable (reload dedupe)', async () => {
    const ctx = await bench()
    const adapter = new ImmediateAdapter()
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('reload-dedupe'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', userMessage('问题'), { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, message: assistantMessage('回答') }, { surfaceOp: 'append' })
    session.append('request/header', { header: { config: { provider: 'main', model: 'main-model' } }, reason: 'initial' })
    session.append('suggest-prompt/suggested', {
      version: 1, turn: 1, baseSeq: 4, text: '已有建议', truncated: false, requestSeq: 5, acceptKey: 'Tab',
    })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await settle()
    expect(adapter.requests).toHaveLength(0)
  })

  it('aborts an in-flight generation when the next turn completes', async () => {
    const ctx = await bench()
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

    const suggested = suggestedEvents(session)
    expect(suggested).toHaveLength(1)
    expect(suggested[0]?.turn).toBe(2)
  })

  it('logs a warning and emits no suggestion when generation fails', async () => {
    const ctx = await bench()
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.llm.registerAdapter(['main'], new ThrowingAdapter())
    const session = ctx.sessions.create(SessionId('failure'))
    appendTurn(session, 1, '问题', '回答')

    await settle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('suggest-prompt: suggestion generation failed'))
    expect(suggestedEvents(session)).toHaveLength(0)
  })

  it('fails loud without a logged route and without a config pair', async () => {
    const ctx = await bench()
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
  })

  it('fails loud when the logged header carries an empty route', async () => {
    const ctx = await bench()
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
    const ctx = await bench()
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
    const ctx = await bench()
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.llm.registerAdapter(['main'], new ThrowingStringAdapter())
    const session = ctx.sessions.create(SessionId('string-failure'))
    appendTurn(session, 1, '问题', '回答')

    await settle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom-string'))
  })

  it('sanitizes the model output into the durable suggestion', async () => {
    const ctx = await bench()
    const adapter = new ImmediateAdapter('\x1b[31m"建议文本"\x1b[0m')
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('sanitized'))
    appendTurn(session, 1, '问题', '回答')

    await settle()
    expect(suggestedEvents(session)[0]?.text).toBe('建议文本')
  })

  it('silently drops a semantically rejectable suggestion', async () => {
    const ctx = await bench()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const adapter = new ImmediateAdapter('no suggestion available')
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('filtered'))
    appendTurn(session, 1, '问题', '回答')

    await settle()
    expect(suggestedEvents(session)).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('drops verbose output instead of truncating it into a cut-off suggestion', async () => {
    const ctx = await bench()
    const adapter = new ImmediateAdapter('很长很长的建议文本'.repeat(10))
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('verbose'))
    appendTurn(session, 1, '问题', '回答')

    await settle()
    expect(suggestedEvents(session)).toHaveLength(0)
  })

  it('truncates over-cap output that still passes the semantic filter', async () => {
    const ctx = await bench()
    const adapter = new ImmediateAdapter(`${'a'.repeat(20)} ${'b'.repeat(20)}`)
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('truncated'))
    appendTurn(session, 1, '问题', '回答')

    await settle()
    const suggested = suggestedEvents(session)[0]!
    expect(suggested.truncated).toBe(true)
    expect(Array.from(suggested.text).length).toBe(40)
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
      new AbortController().signal,
    )
    expect(result).toBeUndefined()
    expect(session.events.some(event => event.type === 'suggest-prompt/suggested')).toBe(false)
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
      new AbortController().signal,
    )
    expect(result).toBeDefined()
    const requestData = session.events.find(event => event.type === 'suggest-prompt/request')!.data as { messages: readonly Message[] }
    const framed = requestData.messages[0]?.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join(' ')
    expect(framed).toContain('新问题')
    expect(framed).not.toContain('旧问题')
  })
})

describe('suggest-prompt durable invariant', () => {
  /** A context with the invariant registry and companion mounted over sessions. */
  async function invariantCtx(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(SessionStore)
    await ctx.plugin({ inject: ['invariants'], apply: installCompanion })
    contexts.push(ctx)
    return ctx
  }

  it('rejects an unsupported event version', async () => {
    const ctx = await invariantCtx()
    const session = ctx.sessions.create(SessionId('inv-version'))
    expect(() => session.append('suggest-prompt/request', { version: 2 } as never))
      .toThrow(/unsupported version/)
  })

  it('rejects a request with an invalid payload', async () => {
    const ctx = await invariantCtx()
    const session = ctx.sessions.create(SessionId('inv-request'))
    expect(() => session.append('suggest-prompt/request', {
      version: 1, turn: 'bad', sourceMessageSeqs: [], route: null,
      system: '', messages: [], maxTokens: 'x',
    } as never)).toThrow(/invalid request payload/)
  })

  it('rejects a request whose route is not an object', async () => {
    const ctx = await invariantCtx()
    const session = ctx.sessions.create(SessionId('inv-route'))
    expect(() => session.append('suggest-prompt/request', {
      version: 1, turn: 1, sourceMessageSeqs: [], route: 'bad',
      system: 'x', messages: [{ id: 'm' as never }], maxTokens: 1,
    } as never)).toThrow(/invalid request payload/)
  })

  it('rejects a suggested event with an invalid payload', async () => {
    const ctx = await invariantCtx()
    const session = ctx.sessions.create(SessionId('inv-suggested'))
    expect(() => session.append('suggest-prompt/suggested', {
      version: 1, turn: 1, baseSeq: 'x', text: '', truncated: 'y', requestSeq: 1,
    } as never)).toThrow(/invalid suggestion payload/)
  })
})
