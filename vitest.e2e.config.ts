import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * E2E lane: spawns a REAL `dsh web` against an isolated $DSH_HOME and drives
 * the browser with Playwright. The default vitest lane (`vitest.config.ts`)
 * excludes `tests/e2e/**`; run this lane explicitly with `pnpm test:e2e`.
 *
 * The aliases mirror the unit config so any package-outlet imports resolve to
 * source, and the published client deps stay inlined so their CSS modules
 * load under jsdom-free E2E too.
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
    include: ['tests/e2e/**/*.e2e.ts'],
    testTimeout: 300_000,
    hookTimeout: 240_000,
    css: true,
    server: {
      deps: {
        inline: [/@deepseek-ai\/dsh-client-.*/],
      },
    },
  },
})
