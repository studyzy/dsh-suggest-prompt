/**
 * The install-time dependency declaration, which decides which copies of the
 * harness runtime packages a profile ends up with.
 *
 * The harness resolves its own packages out of the profile's module tree, so a
 * copy this package installs next to itself can end up above the runtime's copy
 * once the profile hoists. The harness then evaluates that older copy's
 * exact-version `dsh` peers, refuses them, and disables the profile rows they
 * back; with `@deepseek-ai/dsh-client-connection` the row that mounts the WebUI
 * routes never activated and every page answered 404. Both packages below are
 * imported by this plugin while the host runs them, so they belong in
 * `peerDependencies` and stay in `devDependencies` for the local build.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** The manifest fields this file constrains. */
interface Manifest {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as Manifest

/** Runtime packages this plugin imports while the host is running them. */
const hostProvided = [
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-storage-domain',
]

describe('package manifest', () => {
  it('installs no harness runtime package alongside the plugin', () => {
    const installed = Object.keys(manifest.dependencies ?? {})
      .filter(name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    expect(installed).toEqual([])
  })

  it('asks the host for each runtime package it imports, by range', () => {
    for (const name of hostProvided) {
      const range = manifest.peerDependencies?.[name] ?? ''
      expect(range, `${name} must be declared as a peer`).not.toBe('')
      // An exact version here is the defect this guards: it pins the copy the
      // harness evaluates to the release this repo happens to build against, so
      // the next harness release disables the row instead of running it.
      expect(range, `${name} must be a range, not an exact pin`).not.toMatch(/^\d+\.\d+\.\d+/)
    }
  })
})
