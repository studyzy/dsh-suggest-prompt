/**
 * suggest-prompt invariant manual topology: the companion seeds validation
 * over sessions that already exist when it installs, so a pre-populated
 * session exercises both seed loops (existing events and existing sessions).
 * Manual topology suites are excluded from the vitest-wide invariant host
 * (see scripts/test-invariants.ts).
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { apply as installCompanion } from '../src/invariant.ts'

describe('suggest-prompt invariant companion', () => {
  it('seeds validation over pre-existing sessions and events on install', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('seed-session'))
    session.append('turn/start', { turn: 1 })
    session.append('suggest-prompt/suggested', {
      version: 1, turn: 1, baseSeq: 2, text: '建议', truncated: false, requestSeq: 1,
    })
    // Install after the session exists: the companion seeds from ctx.sessions.list().
    await ctx.plugin({ inject: ['invariants'], apply: installCompanion })
    expect(session.events.some(event => event.type === 'suggest-prompt/suggested')).toBe(true)
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
