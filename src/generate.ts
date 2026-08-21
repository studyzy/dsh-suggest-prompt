/**
 * Bounded auxiliary suggestion generation: transcript framing, secret
 * redaction, route resolution, deadline-fused LLM dispatch, and output
 * sanitization. Mirrors the session-title-llm call policy (byte bound, output
 * cap, deadline, pre-dispatch request event) so the model-visible⟺logged
 * invariant holds for every suggestion request.
 * @module @studyzy/dsh-suggest-prompt/generate
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
  createUserMessage,
  deepFreeze,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { SuggestPromptRequested, SuggestPromptSuggested } from './domain.ts'
import { cleanSuggestion, hasCJK, redactSecrets, sanitizeSuggestion, shouldFilterSuggestion } from './sanitize.ts'
import type { Config } from './index.ts'

/** Capability-owned timeout reason code for auxiliary suggestion requests. */
export const SUGGEST_PROMPT_TIMEOUT_CODE = 'SUGGEST_PROMPT_TIMEOUT'

/**
 * Suggestion generation is an opportunistic, must-be-fast-and-cheap auxiliary
 * call: reasoning/thinking is disabled. `off` maps to `thinking: disabled` on
 * the DeepSeek adapter and to `reasoning_effort: off` on OpenAI-compatible
 * (pi-ai) routes, so the request never spends budget on a chain of thought.
 */
const SUGGEST_REASONING_EFFORT = ReasoningEffortId('off')

/**
 * Informational purpose tag for auxiliary suggestion calls. The published
 * `GenerateOptions['purpose']` union predates the suggest-prompt capability and
 * no provider tailors transport for it yet, so the literal widens through
 * `unknown` once; the runtime value stays `'suggest-prompt'` for providers that
 * learn it later.
 */
const SUGGEST_PURPOSE = 'suggest-prompt' as unknown as Exclude<GenerateOptions['purpose'], undefined>

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
  'acceptKey',
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
  if (value.maxRecentTurns !== undefined) assertPositiveInteger('maxRecentTurns', value.maxRecentTurns)
  assertPositiveInteger('maxTranscriptChars', value.maxTranscriptChars)
  assertPositiveInteger('maxSuggestionChars', value.maxSuggestionChars)
  if (value.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`suggest-prompt: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  // provider and model are independent per-field overrides of the session route:
  // either may be set alone and the missing member falls back to the session's
  // latest logged route (see routeOf). Only a present override is validated.
  if (value.provider !== undefined
    && (typeof value.provider !== 'string' || value.provider.length === 0)) {
    throw new Error('suggest-prompt: provider override must be a non-empty string')
  }
  if (value.model !== undefined
    && (typeof value.model !== 'string' || value.model.length === 0)) {
    throw new Error('suggest-prompt: model override must be a non-empty string')
  }
  if (value.acceptKey !== undefined
    && (typeof value.acceptKey !== 'string' || value.acceptKey.trim().length === 0)) {
    throw new Error('suggest-prompt: acceptKey must be a non-empty shortcut string')
  }
  return deepFreeze(Object.assign({}, value))
}

/**
 * Stable instruction for the suggestion extraction call. The model is bound to
 * predicting the user's next prompt in the user's own voice, forbidden from
 * generating content or meta-text; `language` constrains the reply language to
 * match the conversation.
 * @param maxSuggestionChars - visible-character cap baked into the instruction.
 * @param language - reply language ("简体中文" for CJK conversations, else "English").
 */
export function systemPrompt(maxSuggestionChars: number, language: string): string {
  return [
    'You are a prompt suggestion generator. Your ONLY purpose is to predict the user\'s next prompt in a coding-assistant chat — never to generate content.',
    '',
    'Your job:',
    '1. Read the user\'s most recent message and the assistant\'s final answer.',
    '2. Predict what the USER would naturally type next — not what the assistant should do.',
    '',
    'CRITICAL CONSTRAINTS:',
    '- You are NOT a code generator, writer, or task executor.',
    '- You MUST respond with ONLY the suggestion text, on a single line.',
    '- NEVER generate, implement, code, or produce any content.',
    '- NEVER provide explanations, reasoning, or extra text.',
    '- NEVER use quotes, labels, Markdown, XML, or formatting.',
    '- Be specific when you can — name files, functions, or actions.',
    '- If the next step is not obvious, reply with nothing at all.',
    '',
    'THE TEST: would the user think "I was just about to type that"?',
    '',
    'EXAMPLES:',
    'User asked "fix the bug and run tests", bug is fixed -> "run the tests"',
    'After code written -> "try it out"',
    'Assistant offers options -> pick the one the user would choose',
    'Assistant asks to continue -> "yes" or "go ahead"',
    'Task complete, obvious follow-up -> "commit this" or "push it"',
    'After an error or misunderstanding -> reply with nothing',
    '',
    'NEVER SUGGEST:',
    '- Evaluative feedback ("looks good", "thanks")',
    '- Questions ("what about...?")',
    '- Assistant-voice phrasing ("Let me...", "I\'ll...", "Here\'s...")',
    '- New ideas the user did not ask about',
    '- Multiple sentences',
    '',
    'Reply with ONLY the suggestion, 3-12 words, no quotes or explanation. If the next step is not obvious, reply with nothing.',
    '',
    `Language: ${language}`,
    `At most ${maxSuggestionChars} visible characters.`,
  ].join('\n')
}

/** Pick the reply language to match the user's last prompt (CJK → 简体中文). */
export function suggestionLanguage(pairs: readonly TranscriptPair[]): string {
  for (const pair of [...pairs].reverse()) {
    if (pair.role !== 'user') continue
    return hasCJK(pair.text) ? '简体中文' : 'English'
  }
  return 'English'
}

/** Frame the kept pairs as labelled blocks so the model reads them as context. */
function frameTranscript(pairs: readonly TranscriptPair[]): string {
  const blocks: string[] = []
  for (const pair of pairs) {
    blocks.push(pair.role === 'user' ? `[User Message]\n${pair.text}` : `[Assistant Response]\n${pair.text}`)
  }
  return blocks.join('\n\n')
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
 * messages of the last `maxRecentTurns` completed turns (default 1 — only the
 * last completed turn's user input and assistant final answer), redacted,
 * tail-trimmed to `maxTranscriptChars`.
 * @param session - session whose log is the transcript source.
 * @param maxRecentTurns - completed-turn tail to include (1 keeps only the last turn).
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

/**
 * Resolve the effective route: an explicit override wins for a member, and a
 * missing member falls back to the session's latest logged request route.
 * @param session - session whose logged request header supplies the fallback.
 * @param config - validated suggestion policy.
 * @returns the complete route, or throws when neither a configured pair nor a
 * logged session route supplies every member.
 */
function routeOf(
  session: Session,
  config: ResolvedSuggestPromptConfig,
): { readonly provider: string; readonly model: string } {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  const route = session.requestHeader()?.config
  const provider = config.provider ?? route?.provider
  const model = config.model ?? route?.model
  if (provider !== undefined && model !== undefined && provider.length > 0 && model.length > 0) {
    return { provider, model }
  }
  throw new Error('suggest-prompt: no complete route is available; configure provider and model, or run a turn that logs a session route')
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
 * @returns the durable whole-value suggestion event payload, or `undefined`
 * when the model produced no usable suggestion (an empty or semantically
 * rejectable reply — the system prompt tells it to reply with nothing when the
 * next step is not obvious). Genuine failures throw.
 */
export async function generateSuggestion(
  ctx: Context,
  config: ResolvedSuggestPromptConfig,
  session: Session,
  turn: number,
  signal: AbortSignal,
): Promise<SuggestPromptSuggested | undefined> {
  signal.throwIfAborted()
  const transcript = buildTranscript(session, config.maxRecentTurns ?? 1, config.maxTranscriptChars)
  if (transcript === undefined) {
    throw new Error('suggest-prompt: session has no model-visible transcript to suggest from')
  }
  const route = routeOf(session, config)
  const language = suggestionLanguage(transcript.pairs)
  const system = systemPrompt(config.maxSuggestionChars, language)
  const framed = frameTranscript(transcript.pairs)
  const inputBytes = Buffer.byteLength(framed, 'utf8')
  if (inputBytes > config.maxInputBytes) {
    throw new Error(`suggest-prompt: input is ${inputBytes} bytes, exceeding maxInputBytes ${config.maxInputBytes}`)
  }
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: framed }],
    source: { kind: 'plugin', plugin: 'dsh-suggest-prompt' },
  })]
  using callDeadline = deadline(signal, config.timeoutMs, SUGGEST_PROMPT_TIMEOUT_CODE)
  const requestOptions = (reasoningOff: boolean): GenerateOptions => deepFreeze({
    provider: route.provider,
    model: route.model,
    messages,
    system,
    maxTokens: config.maxOutputTokens,
    sessionId: session.id,
    purpose: SUGGEST_PURPOSE,
    ...(reasoningOff ? { reasoningEffort: SUGGEST_REASONING_EFFORT } : {}),
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
  // The request is tried reasoning-off first (fast and cheap); a model whose
  // adapter rejects `off` (UNSUPPORTED_REASONING_EFFORT) retries without the
  // override so a suggestion still generates. Each attempt that could reach
  // the wire appends its own pre-dispatch request event, so the log
  // reconstructs exactly what the model saw and the suggestion points at the
  // request that produced it.
  const firstRequest = session.append('suggest-prompt/request', { ...requestEvent, reasoningOff: true })
  callDeadline.signal.throwIfAborted()
  const drain = async (options: GenerateOptions): Promise<ReturnType<BlockAssembler['blocks']>> => {
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream(options)) {
      callDeadline.signal.throwIfAborted()
      assembler.push(chunk)
    }
    callDeadline.signal.throwIfAborted()
    const terminalError = finishError(assembler.finish)
    if (terminalError !== undefined) throw terminalError
    return assembler.blocks()
  }
  let request = firstRequest
  let blocks: ReturnType<BlockAssembler['blocks']>
  try {
    blocks = await drain(requestOptions(true))
  } catch (error: unknown) {
    if ((error as { code?: unknown } | null)?.code !== 'UNSUPPORTED_REASONING_EFFORT') throw error
    // The retry is a distinct wire-visible request; log it before dispatching.
    request = session.append('suggest-prompt/request', { ...requestEvent, reasoningOff: false })
    blocks = await drain(requestOptions(false))
  }
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error('suggest-prompt: suggestion output must contain text only')
  }
  const text = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
  // Filter the cleaned-but-untruncated output so verbose replies are dropped,
  // not silently truncated into a cut-off suggestion.
  const cleaned = cleanSuggestion(text)
  if (cleaned.length === 0 || shouldFilterSuggestion(cleaned)) {
    // An empty or semantically rejectable reply is a normal "no suggestion"
    // (the prompt tells the model to stay silent when the next step is not
    // obvious), not a failure. The request event above still records the call.
    return undefined
  }
  const { text: suggestion, truncated } = sanitizeSuggestion(cleaned, config.maxSuggestionChars)
  const suggested: SuggestPromptSuggested = {
    version: 1,
    turn,
    baseSeq: transcript.baseSeq,
    text: suggestion,
    truncated,
    route,
    requestSeq: request.seq,
    acceptKey: config.acceptKey ?? 'Tab',
  }
  session.append('suggest-prompt/suggested', suggested)
  return suggested
}
