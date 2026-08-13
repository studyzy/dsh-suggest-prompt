// @vitest-environment jsdom
/**
 * ui-suggest-prompt browser half on a real cordis Context with fake slots
 * faces: the plugin registers the ghost bridge dock entry at
 * conversation.input.dock with the suggest-prompt id, and the registration
 * drops when the plugin fiber unloads (HMR safety). The node half is
 * exercised over the same Context.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

describe('ui-suggest-prompt browser plugin', () => {
  it('registers the ghost bridge dock entry and drops it on unload', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root', children: { 'conversation.input.dock': { kind: 'list', scope: 'session' } },
    } as never, (() => null) as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('conversation.input.dock').map(entry => entry.options.id))
      .toEqual(['suggest-prompt'])
    expect(ctx.slots.entries('conversation.input.dock')[0]?.options).toMatchObject({
      id: 'suggest-prompt',
      order: 30,
    })
    await fiber.dispose()
    expect(ctx.slots.entries('conversation.input.dock')).toHaveLength(0)
  })
})

describe('ui-suggest-prompt node half', () => {
  // The invariant companion is mounted by the vitest-wide invariant host on
  // every Context this suite creates; its registration is covered there.
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
