/**
 * Bounded auxiliary suggestion generation: transcript framing, secret
 * redaction, route resolution, deadline-fused LLM dispatch, and output
 * sanitization. Mirrors the session-title-llm call policy (byte bound, output
 * cap, deadline, pre-dispatch request event) so the model-visible⟺logged
 * invariant holds for every suggestion request.
 * @module @deepseek-ai/dsh-suggest-prompt/generate
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
  createUserMessage,
  deepFreeze,
} from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { SuggestPromptRequested, SuggestPromptSuggested } from './domain.ts'
import { redactSecrets, sanitizeSuggestion } from './sanitize.ts'
import type { Config } from './index.ts'

/** Capability-owned timeout reason code for auxiliary suggestion requests. */
export const SUGGEST_PROMPT_TIMEOUT_CODE = 'SUGGEST_PROMPT_TIMEOUT'

/** Validated immutable suggestion policy. */
export interface ResolvedSuggestPromptConfig extends Config {}

/** Complete configuration key set for direct construction validation. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'maxInputBytes',
  'maxOutputTokens',
  'timeoutMs',
  'maxRecentTurns',
  'maxTranscriptChars',
  'maxSuggestionChars',
  'provider',
  'model',
])

/** Validate one positive integer limit. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`suggest-prompt: ${name} must be a positive integer`)
  }
}

/**
 * Validate and detach the required suggestion policy.
 * @param config - untrusted plugin configuration.
 * @returns immutable policy with optional route absence preserved.
 */
export function resolveSuggestPromptConfig(config: Config): ResolvedSuggestPromptConfig {
  const candidate: unknown = config
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('suggest-prompt: configuration is required')
  }
  const value = candidate as Config
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`suggest-prompt: unknown config key "${key}"`)
  }
  assertPositiveInteger('maxInputBytes', value.maxInputBytes)
  assertPositiveInteger('maxOutputTokens', value.maxOutputTokens)
  assertPositiveInteger('timeoutMs', value.timeoutMs)
  assertPositiveInteger('maxRecentTurns', value.maxRecentTurns)
  assertPositiveInteger('maxTranscriptChars', value.maxTranscriptChars)
  assertPositiveInteger('maxSuggestionChars', value.maxSuggestionChars)
  if (value.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`suggest-prompt: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  const hasProvider = value.provider !== undefined
  const hasModel = value.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('suggest-prompt: provider and model must be supplied together')
  }
  if (hasProvider
    && (typeof value.provider !== 'string' || value.provider.length === 0
      || typeof value.model !== 'string' || value.model.length === 0)) {
    throw new Error('suggest-prompt: provider and model overrides must be non-empty strings')
  }
  return deepFreeze(Object.assign({}, value))
}

/** Stable instruction for the suggestion extraction call. */
export function systemPrompt(maxSuggestionChars: number): string {
  return [
    'You are the "suggested prompt" generator for a coding-assistant chat.',
    'Given the most recent conversation transcript, write ONE short prompt the user would most likely type next to continue the work.',
    'Output only the prompt text on a single line, in plain natural language, with no quotes, labels, Markdown, XML, or terminal control codes.',
    'Use the language of the conversation.',
    `At most ${maxSuggestionChars} visible characters.`,
  ].join('\n')
}

/** One redacted user/assistant exchange line ready for framing. */
export interface TranscriptPair {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** The bounded transcript handed to the model, plus its log attribution. */
export interface Transcript {
  readonly pairs: readonly TranscriptPair[]
  readonly sourceMessageSeqs: readonly number[]
  readonly baseSeq: number
}

/** Render a message's text blocks; non-text blocks contribute nothing. */
function renderMessageText(message: Message): string {
  let out = ''
  for (const block of message.content) {
    if (block.type === 'text') out += block.text
  }
  return out
}

/** Keep the newest pairs while the budget lasts; always keep the newest one. */
function keepTail(pairs: readonly TranscriptPair[], budget: number): number {
  let remaining = budget
  let kept = 0
  for (const pair of [...pairs].reverse()) {
    const cost = pair.role.length + pair.text.length + 2
    if (cost > remaining && kept > 0) break
    kept += 1
    remaining -= cost
  }
  return Math.max(1, kept)
}

/**
 * Build the model-visible transcript from the session log: user/assistant
 * messages of the last `maxRecentTurns` completed turns, redacted, tail-trimmed
 * to `maxTranscriptChars`.
 * @param session - session whose log is the transcript source.
 * @param maxRecentTurns - completed-turn tail to include.
 * @param maxTranscriptChars - character budget for the kept tail.
 * @returns the bounded transcript, or `undefined` when no completed turn has messages.
 */
export function buildTranscript(
  session: Session,
  maxRecentTurns: number,
  maxTranscriptChars: number,
): Transcript | undefined {
  const events = session.events
  let lastTurn = 0
  const turnStarts: Array<{ readonly turn: number; readonly seq: number }> = []
  for (const event of events) {
    if (event.type === 'turn/start') turnStarts.push({ turn: event.data.turn, seq: event.seq })
    else if (event.type === 'turn/end') lastTurn = event.data.turn
  }
  if (lastTurn === 0) return undefined
  const cutoffTurn = Math.max(1, lastTurn - Math.max(1, maxRecentTurns) + 1)
  const cutoffSeq = turnStarts.find(entry => entry.turn === cutoffTurn)?.seq ?? 0
  const pairs: TranscriptPair[] = []
  const sourceMessageSeqs: number[] = []
  let baseSeq = 0
  for (const event of events) {
    if (event.seq < cutoffSeq) continue
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const message = deriveEventMessage(event)
    if (message === null) continue
    const text = renderMessageText(message).trim()
    if (text.length === 0) continue
    pairs.push({ role: message.role === 'user' ? 'user' : 'assistant', text: redactSecrets(text) })
    sourceMessageSeqs.push(event.seq)
    baseSeq = event.seq
  }
  if (pairs.length === 0) return undefined
  const keptCount = keepTail(pairs, Math.max(1, maxTranscriptChars))
  const kept = pairs.slice(pairs.length - keptCount)
  const keptSeqs = sourceMessageSeqs.slice(sourceMessageSeqs.length - keptCount)
  return {
    pairs: kept,
    sourceMessageSeqs: keptSeqs,
    // keptSeqs is a tail slice, so the newest message seq is the baseSeq.
    baseSeq,
  }
}

/** Resolve the explicit route pair or the session's latest logged request header. */
function routeOf(
  session: Session,
  config: ResolvedSuggestPromptConfig,
): { readonly provider: string; readonly model: string } {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  const route = session.requestHeader()?.config
  if (route !== undefined && route.provider.length > 0 && route.model.length > 0) {
    return { provider: route.provider, model: route.model }
  }
  throw new Error('suggest-prompt: no logged request route is available; configure provider and model together')
}

/** Translate terminal finish reasons into an auxiliary-call failure. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error('suggest-prompt: suggestion output reached maxOutputTokens')
    case 'tool-calls':
      return new Error('suggest-prompt: suggestion model unexpectedly requested a tool')
    /* v8 ignore next 2 -- FinishReason is a closed five-member union; this default cannot be reached */
    default:
      return new Error(`suggest-prompt: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/**
 * Generate one suggestion for a completed turn through the shared auxiliary
 * LLM call.
 * @param ctx - context exposing the registered LLM service.
 * @param config - validated suggestion policy.
 * @param session - owning session log.
 * @param turn - completed turn whose completion this suggestion answers.
 * @param signal - cancellation forwarded to the auxiliary call.
 * @returns the durable whole-value suggestion event payload.
 */
export async function generateSuggestion(
  ctx: Context,
  config: ResolvedSuggestPromptConfig,
  session: Session,
  turn: number,
  signal: AbortSignal,
): Promise<SuggestPromptSuggested> {
  signal.throwIfAborted()
  const transcript = buildTranscript(session, config.maxRecentTurns, config.maxTranscriptChars)
  if (transcript === undefined) {
    throw new Error('suggest-prompt: session has no model-visible transcript to suggest from')
  }
  const route = routeOf(session, config)
  const framed = `Write one suggested next prompt from this JSON conversation:\n${JSON.stringify(transcript.pairs)}`
  const inputBytes = Buffer.byteLength(framed, 'utf8')
  if (inputBytes > config.maxInputBytes) {
    throw new Error(`suggest-prompt: input is ${inputBytes} bytes, exceeding maxInputBytes ${config.maxInputBytes}`)
  }
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: framed }],
    source: { kind: 'plugin', plugin: 'dsh-suggest-prompt' },
  })]
  const system = systemPrompt(config.maxSuggestionChars)
  using callDeadline = deadline(signal, config.timeoutMs, SUGGEST_PROMPT_TIMEOUT_CODE)
  const options: GenerateOptions = deepFreeze({
    provider: route.provider,
    model: route.model,
    messages,
    system,
    maxTokens: config.maxOutputTokens,
    sessionId: session.id,
    purpose: 'suggest-prompt',
    signal: callDeadline.signal,
  })
  const requestEvent: SuggestPromptRequested = {
    version: 1,
    turn,
    sourceMessageSeqs: [...transcript.sourceMessageSeqs],
    route,
    system,
    messages,
    maxTokens: config.maxOutputTokens,
  }
  const request = session.append('suggest-prompt/request', requestEvent)
  callDeadline.signal.throwIfAborted()
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  callDeadline.signal.throwIfAborted()
  const terminalError = finishError(assembler.finish)
  if (terminalError !== undefined) throw terminalError
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error('suggest-prompt: suggestion output must contain text only')
  }
  const text = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
  const { text: suggestion, truncated } = sanitizeSuggestion(text, config.maxSuggestionChars)
  if (suggestion.length === 0) throw new Error('suggest-prompt: suggestion model produced no text')
  const suggested: SuggestPromptSuggested = {
    version: 1,
    turn,
    baseSeq: transcript.baseSeq,
    text: suggestion,
    truncated,
    route,
    requestSeq: request.seq,
  }
  session.append('suggest-prompt/suggested', suggested)
  return suggested
}
