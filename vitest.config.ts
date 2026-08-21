import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Map the single package's outlets to their source when the tests import them
 * by name, so tests run against source without a prior build. More specific
 * outlets must be listed before the bare package name (Vite prefix-matches).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@studyzy/dsh-suggest-prompt/client': fileURLToPath(new URL('src/browser/index.ts', import.meta.url)),
      '@studyzy/dsh-suggest-prompt/types': fileURLToPath(new URL('src/types.ts', import.meta.url)),
      '@studyzy/dsh-suggest-prompt/invariant': fileURLToPath(new URL('src/invariant.ts', import.meta.url)),
      '@studyzy/dsh-suggest-prompt': fileURLToPath(new URL('src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    exclude: ['**/provider.e2e.ts'],
    // The published dsh-client-* packages ship CSS modules (e.g. primitives'
    // StateDot.module.css); jsdom cannot import them as raw Node files. Inline
    // the published client dependencies so Vitest's pipeline (CSS modules as
    // identity class maps) applies to their bundled output too.
    css: true,
    server: {
      deps: {
        inline: [/@deepseek-ai\/dsh-client-.*/],
      },
    },
  },
})
