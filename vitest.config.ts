import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

/**
 * Map the workspace packages to their source when the tests import them by
 * name, so tests run against source without a prior build (the monorepo does
 * the same through tsconfig paths).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@studyzy/dsh-suggest-prompt/client': fileURLToPath(new URL('packages/suggest-prompt/src/client.ts', import.meta.url)),
      '@studyzy/dsh-suggest-prompt/types': fileURLToPath(new URL('packages/suggest-prompt/src/types.ts', import.meta.url)),
      '@studyzy/dsh-suggest-prompt/invariant': fileURLToPath(new URL('packages/suggest-prompt/src/invariant.ts', import.meta.url)),
      '@studyzy/dsh-suggest-prompt': fileURLToPath(new URL('packages/suggest-prompt/src/index.ts', import.meta.url)),
      '@studyzy/dsh-client-ui-suggest-prompt/client': fileURLToPath(new URL('packages/ui-suggest-prompt/src/client/index.ts', import.meta.url)),
      '@studyzy/dsh-client-ui-suggest-prompt/invariant': fileURLToPath(new URL('packages/ui-suggest-prompt/src/invariant.ts', import.meta.url)),
      '@studyzy/dsh-client-ui-suggest-prompt': fileURLToPath(new URL('packages/ui-suggest-prompt/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/tests/**/*.spec.ts', 'packages/*/tests/**/*.spec.tsx'],
    exclude: ['**/provider.e2e.ts'],
  },
})
