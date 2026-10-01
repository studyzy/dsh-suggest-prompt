/**
 * suggest-prompt invariant behavior: the companion validates every event
 * committed through `session/event`, which covers both newly appended events
 * and the replay of an already-logged one.
 *
 * `dsh >= 0.2.0` prohibits new synchronous reads of session history, so the
 * companion no longer seeds by scanning `session.events` at install time; it
 * relies on committed delivery instead. These tests therefore exercise the
 * delivery tap (accepting a valid event, rejecting a malformed one) rather than
 * an install-time scan.
 * Manual topology suites are excluded from the vitest-wide invariant host
 * (see scripts/test-invariants.ts).
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { apply as installCompanion } from '../src/invariant.ts'

describe('suggest-prompt invariant companion', () => {
  it('accepts a well-formed suggestion committed after install', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(SessionStore)
    await ctx.plugin({ inject: ['invariants'], apply: installCompanion })
    const session = ctx.sessions.create(SessionId('valid-delivery'))
    session.append('turn/start', { turn: 1 })
    // A valid payload must pass the delivery tap without failing the invariant.
    expect(() => session.append('suggest-prompt/suggested', {
      version: 1, turn: 1, baseSeq: 2, text: '建议', truncated: false, requestSeq: 1, acceptKey: 'Tab',
    })).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('rejects a malformed event appended after install', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(SessionStore)
    await ctx.plugin({ inject: ['invariants'], apply: installCompanion })
    const session = ctx.sessions.create(SessionId('post-install'))
    expect(() => session.append('suggest-prompt/suggested', {
      version: 1, turn: 1, baseSeq: 'x', text: '', truncated: 'y', requestSeq: 1,
    } as never)).toThrow(/invalid suggestion payload/)
    await ctx.fiber.dispose()
  })
})