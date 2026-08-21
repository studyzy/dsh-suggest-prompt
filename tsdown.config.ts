import type { UserConfig } from 'tsdown'

/**
 * Single-package bundle: the host plugin ESM entries plus the browser plugin
 * closure bundle for the DeepSeek Harness web client.
 *
 * - `tsc` emits declarations (and the host runtime JS) to `lib/types/`.
 * - The host pass bundles the runtime entries to `lib/{index,invariant}.js`;
 *   declared dependencies and peers stay external so the running harness
 *   resolves them from its own install.
 * - The client pass bundles the browser half from `src/browser/index.ts` to
 *   `lib/client.js`, a closure-factory artifact that calls
 *   `window.__ModuleLoader__.load()` with the plugin id and resolves externals
 *   through the injected require.
 */
const HOST_EXTERNALS: readonly string[] = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-timeout',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-invariants',
  'zod',
]

const CLIENT_ID = '@studyzy/dsh-suggest-prompt/client'
const CLIENT_EXTERNALS: readonly string[] = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-conversation/client',
  '@deepseek-ai/dsh-client-ui-settings-plugins/client',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
  'react',
  'react/jsx-runtime',
]

const host: UserConfig = {
  name: '@studyzy/dsh-suggest-prompt',
  entry: ['lib/types/{index,invariant}.js'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

const client: UserConfig = {
  name: CLIENT_ID,
  entry: { client: 'src/browser/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  // Substitutes the Node idiom `process.env.NODE_ENV` that inlined deps
  // (react/jsx-runtime guards) reference; the browser has no `process`.
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [host, client]
