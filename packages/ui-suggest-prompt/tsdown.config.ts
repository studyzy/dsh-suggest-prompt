import type { UserConfig } from 'tsdown'

/** The plugin id stamped into the module-loader handoff and style tags. */
const ID = '@deepseek-ai/dsh-client-ui-suggest-prompt'

/**
 * Externals resolved from the harness's loader module table: the host Cordis
 * runtime and the peer UI/runtime faces. Every other import is bundled.
 */
const EXTERNALS: readonly string[] = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-conversation/client',
  '@deepseek-ai/dsh-client-ui-slots',
  'react',
]

/**
 * Browser plugin bundle for the DeepSeek Harness web client. Emits a
 * closure-factory artifact: the bundle calls window.__ModuleLoader__.load()
 * with the plugin id and resolves externals through the injected require.
 */
const client: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...EXTERNALS],
  noExternal: (id: string) => (EXTERNALS.includes(id) ? undefined : true),
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default client
