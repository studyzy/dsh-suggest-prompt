import type { UserConfig } from 'tsdown'

/**
 * Host plugin bundle for the dsh runtime. The monorepo build emits this
 * package's runtime entries through its workspace-wide tsdown pass; this
 * standalone repo owns that step itself. Entries mirror the monorepo layout:
 * `tsc` emits to `lib/types/`, and this pass bundles the runtime entries to
 * `lib/{index,invariant}.js`. Declared dependencies and peers stay external by
 * default so the running harness resolves them from its own install.
 */
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

export default host
