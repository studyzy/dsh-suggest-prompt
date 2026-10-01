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
  '@deepseek-ai/dsh-timeout',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-util-values',
  '@deepseek-ai/dsh-invariants',
  'zod',
]

const CLIENT_ID = '@studyzy/dsh-suggest-prompt/client'
/**
 * Client-bundle externals. In `dsh >= 0.2.0` a fetch bundle may only require the
 * shell's platform-singleton seed words; requiring anything else misses the
 * frozen module table and throws at load. The seed table is `PLATFORM_MODULES`
 * in the harness's `dsh-client-web` package: `react`, `react/jsx-runtime`,
 * `react-dom`, `react-dom/client`, cordis, `dsh-client-store`,
 * `dsh-client-ui-slots`, `dsh-client-ui-primitives`, `dsh-client-ui-dockkit`.
 *
 * The `dsh-client-*` packages this plugin consumes for TYPES only
 * (ui-conversation, ui-settings, ui-renderer, locale) are deliberately absent:
 * they are type-only imports erased at build, and listing them would emit a
 * require that the module table cannot answer.
 */
const CLIENT_EXTERNALS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
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
  // Declared dependencies and peers stay external so the running harness
  // resolves them from its own install (one instance of each service).
  external: [...HOST_EXTERNALS],
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
