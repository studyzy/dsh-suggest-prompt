/** Package-owned durable suggest-prompt invariants. @module @studyzy/dsh-suggest-prompt/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@studyzy/dsh-suggest-prompt'

/** Cordis companion plugin name. */
export const name = 'suggest-prompt-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** One integer payload field (turn/baseSeq/requestSeq/maxTokens are counts). */
function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** One non-empty route pair. */
function isRoute(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record['provider'] === 'string' && record['provider'].length > 0
    && typeof record['model'] === 'string' && record['model'].length > 0
}

/** Validate one suggest-prompt event payload before it reaches the durable log. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'suggest-prompt/request' && event.type !== 'suggest-prompt/suggested') return
  const data = event.data as unknown as Record<string, unknown>
  if (data.version !== 1) {
    fail(`suggest-prompt/${event.type.slice('suggest-prompt/'.length)} carries unsupported version ${JSON.stringify(data.version)}`)
    return
  }
  if (event.type === 'suggest-prompt/request') {
    if (!isInteger(data.turn)
      || !Array.isArray(data.sourceMessageSeqs) || !data.sourceMessageSeqs.every(isInteger)
      || !isRoute(data.route)
      || typeof data.system !== 'string' || data.system.length === 0
      || !Array.isArray(data.messages) || data.messages.length === 0
      || !isInteger(data.maxTokens)
      // Optional so events logged before `reasoningOff` existed stay valid;
      // when present it must be the boolean the write side records.
      || (data.reasoningOff !== undefined && typeof data.reasoningOff !== 'boolean')) {
      fail('suggest-prompt/request carries an invalid request payload')
    }
    return
  }
  if (!isInteger(data.turn) || !isInteger(data.baseSeq)
    || typeof data.text !== 'string' || data.text.length === 0
    || typeof data.truncated !== 'boolean'
    || !isInteger(data.requestSeq)) {
    fail('suggest-prompt/suggested carries an invalid suggestion payload')
  }
}

/** Install validation for loaded and newly appended suggest-prompt state. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const seed = (session: Session): void => {
    for (const event of session.events) validateEvent(event, fail)
  }
  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [, event] = args as [Session, SessionEvent]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the suggest-prompt invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
