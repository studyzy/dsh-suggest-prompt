// @vitest-environment jsdom
/**
 * Suggest-prompt settings card controller: the staged route pair and its save.
 * The two behaviors under test:
 *
 * - save() verifies a write by reading the section back AFTER the host write
 *   settles, not by trusting the promise to reject — the host scope resolves
 *   even when the document refused the value (it folds or reloads instead).
 * - switching the staged provider drops a staged model that the new provider
 *   does not serve, so the next generation cannot fail as UNKNOWN_MODEL.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

// The published runtime bundle bootstraps through window.__ModuleLoader__, which
// jsdom does not provide; stub the one value import the controller uses so the
// store keeps its simple synchronous set/get contract.
vi.mock('@deepseek-ai/dsh-client-runtime/client', () => ({
  createSnapshotStore: <T>(init: T): SnapshotStore<T> => {
    let state = init
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => state,
      subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
      update: (mutator) => { mutator(state); for (const fn of listeners) fn() },
      set: (next) => { state = next; for (const fn of listeners) fn() },
    }
  },
}))

import { SuggestPromptCardController } from '../src/client/settings-controller.ts'

/** Minimal fake scope with a scriptable user layer and write behavior. */
function makeScope<T>(init: {
  status?: SettingsScopeSnapshot<T>['status']
  value?: T
  base?: unknown
  user?: unknown
  writable?: boolean
} = {}): SettingsScope<T> & {
  fail: { set: boolean; unset: boolean }
  /** Set the snapshot status, notifying subscribers (as a host commit would). */
  setStatus(status: SettingsScopeSnapshot<T>['status']): void
  /** Active subscribers (for asserting dispose removes them). */
  listeners: Set<() => void>
} {
  const state: SettingsScopeSnapshot<T> = {
    status: init.status ?? 'ready',
    value: init.value,
    base: init.base,
    user: init.user,
    revision: 1,
    writable: init.writable ?? true,
    mode: 'host',
  }
  const fail = { set: false, unset: false }
  const listeners = new Set<() => void>()
  const publish = (): void => { for (const fn of listeners) fn() }
  return {
    getSnapshot: () => state,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    fail,
    setStatus: (status) => { state.status = status; publish() },
    listeners,
    // Scriptable writes: apply to the section unless the test marked the write
    // to fail — mirroring the host scope that resolves (not rejects) on a
    // refused value after reloading.
    set: async (field, value) => {
      if (fail.set) { state.status = 'ready'; publish(); return }
      const section = state.value as Record<string, unknown> | undefined ?? {}
      section[field] = value
      state.value = section as T
      publish()
    },
    unset: async (field) => {
      if (fail.unset) { state.status = 'ready'; publish(); return }
      const section = state.value as Record<string, unknown> | undefined ?? {}
      delete section[field]
      state.value = section as T
      publish()
    },
  }
}

/** Build a controller over scriptable scopes and the raw suggest scope user layer. */
function buildController(over: {
  value?: { provider?: string; model?: string }
  base?: { provider?: string; model?: string }
  user?: { provider?: string; model?: string }
  providers?: Record<string, { models?: Array<{ id: string }> }>
  deepseekModels?: Array<{ id: string }>
  catalogStatus?: SettingsScopeSnapshot<{ providers?: Record<string, { models?: Array<{ id: string }> }> }>['status']
} = {}) {
  const scope = makeScope<{ provider?: string; model?: string }>({
    value: over.value,
    base: over.base,
    user: over.user,
  })
  const catalogScope = makeScope<{ providers?: Record<string, { models?: Array<{ id: string }> }> }>({
    status: over.catalogStatus,
    value: { providers: over.providers },
  })
  const deepSeekScope = makeScope<{ models?: Array<{ id: string }> }>({
    value: { models: over.deepseekModels },
  })
  return { controller: new SuggestPromptCardController(scope, catalogScope, deepSeekScope), scope, catalogScope, deepSeekScope }
}

/** Await the in-flight save and return the published card state. */
async function settledState(built: ReturnType<typeof buildController>) {
  await vi.waitFor(() => expect(built.controller.inject().hooks.suggestPromptCard.getSnapshot().saving).toBe(false))
  return built.controller.inject().hooks.suggestPromptCard.getSnapshot()
}

describe('SuggestPromptCardController.save', () => {
  it('clears staged edits when every write lands', async () => {
    const built = buildController({ value: {} })
    built.controller.actions().edit('provider', 'acme')
    built.controller.actions().edit('model', 'acme-1')
    built.controller.actions().save()
    const state = await settledState(built)
    expect(state.dirty).toBe(false)
    expect(state.failed).toBe(false)
    expect(state.provider.text).toBe('acme')
    expect(state.model.text).toBe('acme-1')
  })

  it('reports failed and keeps staged edits when the host refuses a write', async () => {
    const built = buildController({ value: {} })
    built.scope.fail.set = true
    built.controller.actions().edit('provider', 'acme')
    built.controller.actions().save()
    const state = await settledState(built)
    // The write did not land, so the edit must stay staged and the failure be shown.
    expect(state.failed).toBe(true)
    expect(state.dirty).toBe(true)
    expect(state.provider.text).toBe('acme')
  })

  it('reports failed when an unset did not land', async () => {
    const built = buildController({ user: { provider: 'acme' }, value: { provider: 'acme' } })
    built.controller.actions().resetField('provider')
    built.scope.fail.unset = true
    built.controller.actions().save()
    const state = await settledState(built)
    expect(state.failed).toBe(true)
    expect(state.dirty).toBe(true)
  })

  it('drops an empty staged draft without writing anything', async () => {
    const built = buildController({ value: {} })
    built.controller.actions().edit('provider', '   ')
    built.controller.actions().save()
    const state = await settledState(built)
    // Nothing was written, and nothing stays staged: an empty draft is a no-op edit.
    expect(state.dirty).toBe(false)
  })
})

describe('SuggestPromptCardController provider switch', () => {
  it('drops a staged model the new provider does not serve', () => {
    const built = buildController({
      value: {},
      providers: {
        acme: { models: [{ id: 'acme-1' }] },
        globex: { models: [{ id: 'globex-1' }] },
      },
    })
    built.controller.actions().edit('provider', 'acme')
    built.controller.actions().edit('model', 'acme-1')
    // Switch provider: the previously staged model belongs to the old provider.
    built.controller.actions().edit('provider', 'globex')
    const state = built.controller.inject().hooks.suggestPromptCard.getSnapshot()
    expect(state.provider.text).toBe('globex')
    expect(state.model.text).toBe('')
  })

  it('keeps a staged model when the new provider still serves it', () => {
    const built = buildController({
      value: {},
      providers: {
        acme: { models: [{ id: 'shared-1' }] },
        globex: { models: [{ id: 'shared-1' }, { id: 'globex-1' }] },
      },
    })
    built.controller.actions().edit('provider', 'acme')
    built.controller.actions().edit('model', 'shared-1')
    built.controller.actions().edit('provider', 'globex')
    const state = built.controller.inject().hooks.suggestPromptCard.getSnapshot()
    expect(state.model.text).toBe('shared-1')
  })

  it('keeps a staged model when the new provider has no explicit catalog', () => {
    const built = buildController({
      value: {},
      providers: { acme: { models: [{ id: 'acme-1' }] } },
    })
    built.controller.actions().edit('provider', 'acme')
    built.controller.actions().edit('model', 'acme-1')
    // globex has no explicit model list: free-text, so any draft is acceptable.
    built.controller.actions().edit('provider', 'globex')
    const state = built.controller.inject().hooks.suggestPromptCard.getSnapshot()
    expect(state.model.text).toBe('acme-1')
  })
})

describe('SuggestPromptCardController dispose', () => {
  it('detaches every scope observer', () => {
    const built = buildController({ value: {}, providers: {} })
    expect(built.scope.listeners.size).toBe(1)
    expect(built.catalogScope.listeners.size).toBe(1)
    expect(built.deepSeekScope.listeners.size).toBe(1)

    built.controller.dispose()

    expect(built.scope.listeners.size).toBe(0)
    expect(built.catalogScope.listeners.size).toBe(0)
    expect(built.deepSeekScope.listeners.size).toBe(0)
  })
})

describe('SuggestPromptCardController catalog readiness', () => {
  it('offers no catalog providers while the pi-ai namespace is not ready', () => {
    const built = buildController({
      value: {},
      providers: { acme: { models: [{ id: 'acme-1' }] } },
      catalogStatus: 'loading',
    })
    const state = built.controller.inject().hooks.suggestPromptCard.getSnapshot()
    expect(state.providerOptions.map(option => option.value)).not.toContain('acme')
  })

  it('exposes catalog providers once the namespace becomes ready', () => {
    const built = buildController({
      value: {},
      providers: { acme: { models: [{ id: 'acme-1' }] } },
      catalogStatus: 'loading',
    })
    expect(built.controller.inject().hooks.suggestPromptCard.getSnapshot().providerOptions.map(option => option.value))
      .not.toContain('acme')

    // The host commit brings the namespace up; the scope subscription republishes.
    built.catalogScope.setStatus('ready')
    const state = built.controller.inject().hooks.suggestPromptCard.getSnapshot()
    expect(state.providerOptions.map(option => option.value)).toContain('acme')
  })

  it('treats a provider whose catalog is still loading as free-text', () => {
    const built = buildController({
      value: {},
      providers: { acme: { models: [{ id: 'acme-1' }] } },
      catalogStatus: 'loading',
    })
    // With no explicit model list visible yet, the card renders a text field.
    expect(built.controller.inject().hooks.suggestPromptCard.getSnapshot().modelSelectable).toBe(false)
  })
})
