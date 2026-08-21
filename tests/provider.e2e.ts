import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as suggestPromptPlugin from '@studyzy/dsh-suggest-prompt'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('suggest-prompt with real DeepSeek API', () => {
  it('generates a non-empty suggestion from a real DeepSeek call', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, { thinking: 'disabled' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(suggestPromptPlugin, {
      maxInputBytes: 4096,
      maxOutputTokens: 64,
      timeoutMs: 60000,
      maxRecentTurns: 10,
      maxTranscriptChars: 12000,
      maxSuggestionChars: 240,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    const session = ctx.sessions.create(SessionId('real-api-suggest'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '帮我写一个防抖函数' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '防抖函数如下，它会在最后一次调用后等待 delay 毫秒再执行。' }],
        source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await new Promise(resolve => setTimeout(resolve, 0))
    const suggested = session.events
      .filter(event => event.type === 'suggest-prompt/suggested')
      .map(event => event.data)
    expect(suggested).toHaveLength(1)
    expect((suggested[0] as { text: string }).text.length).toBeGreaterThan(0)
  })
})
