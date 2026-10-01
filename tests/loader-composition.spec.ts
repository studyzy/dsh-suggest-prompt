import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import LlmRuntime, { createAssistantMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as suggestPromptPlugin from '@studyzy/dsh-suggest-prompt'
import { Config } from '@studyzy/dsh-suggest-prompt'

/**
 * Mirror the host's `volatileForm()` projection: walk a schema and report the
 * field paths whose node is marked volatile. `dsh >= 0.2.0` derives a plugin's
 * settings page from the schema, and an entry with no volatile field is omitted
 * from `settings.describe` entirely — which makes the WebUI card mount and then
 * render nothing.
 * @param schema - a schemastery node.
 * @returns volatile field paths (a wholly volatile node reports its own key).
 */
function volatileFieldPaths(schema: { meta?: { volatile?: boolean }; type?: string; dict?: Record<string, unknown> }): string[] {
  if (schema.meta?.volatile === true) return ['<node>']
  if (schema.type !== 'object') return []
  return Object.entries(schema.dict ?? {}).flatMap(([key, child]) => volatileFieldPaths(child as never)
    .map(path => (path === '<node>' ? key : `${key}.${path}`)))
}

describe('suggest-prompt settings schema', () => {
  it('marks the user-editable preferences volatile so the host describes the entry', () => {
    // Without this, the settings card is unreachable: the host omits an entry
    // with no volatile field from the describe answer the client reads.
    expect(volatileFieldPaths(Config as never).sort()).toEqual(['acceptKey', 'model', 'provider'])
  })

  it('keeps the deployment bounds out of the generated settings form', () => {
    // The numeric bounds are composition policy, not user preferences; they must
    // not become editable form fields.
    const paths = volatileFieldPaths(Config as never)
    for (const bound of ['maxInputBytes', 'maxOutputTokens', 'timeoutMs', 'maxRecentTurns', 'maxTranscriptChars', 'maxSuggestionChars']) {
      expect(paths).not.toContain(bound)
    }
  })
})

let root: string | undefined
let context: Context | undefined

class LoaderAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: 'Loader composed suggestion' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-suggest-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@studyzy/dsh-suggest-prompt'",
    '  config:',
    '    maxInputBytes: 1000',
    '    maxOutputTokens: 32',
    '    timeoutMs: 1000',
    '    maxRecentTurns: 3',
    '    maxTranscriptChars: 500',
    '    maxSuggestionChars: 40',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@studyzy/dsh-suggest-prompt', suggestPromptPlugin],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('suggest-prompt Loader composition', () => {
  it('loads the plugin with required deployment policy and generates on a completed turn', async () => {
    const ctx = await loadComposition()
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const adapter = new LoaderAdapter()
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('loader-suggest'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '组合测试' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '组合回答' }],
        source: { provider: 'main', model: 'main-model' },
      }),
    }, { surfaceOp: 'append' })
    session.append('request/header', {
      header: { config: { provider: 'main', model: 'main-model' } }, reason: 'initial',
    })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'main', model: 'main-model' })
    // `snapshotEvents()` is the sanctioned inspection reader for repository tests
    // (rc.2 removed the bare `events` accessor and prohibits new synchronous
    // history reads in production code).
    const suggested = session.snapshotEvents()
      .filter(event => event.type === 'suggest-prompt/suggested')
      .map(event => event.data)
    expect(suggested).toHaveLength(1)
    expect(suggested[0]).toMatchObject({ turn: 1, text: 'Loader composed suggestion' })
    expect(ctx.sessionProjections.snapshot(session).values.suggestPrompt).toMatchObject({
      turn: 1,
      text: 'Loader composed suggestion',
    })
  })
})
