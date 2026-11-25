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
 *
 * `zod` is the opposite case and the same trap: it is not a harness runtime
 * package, but its TYPES cross the harness boundary, so it must resolve to the
 * harness's own copy rather than to whatever patch release this repo happens to
 * pin.
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

/**
 * The harness packages whose `ZodType` this plugin's schemas are typed against:
 * `domainTable()` in `src/records.ts` and `stateSchema` in `src/index.ts`.
 * Read from the local dev install, which is why both again have to agree with
 * this package's own pin.
 */
const zodConsumers = [
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-session-projection',
]

/** The version spec a manifest asks for `zod`, whichever field carries it. */
const zodSpec = (m: Manifest): string => ({ ...m.peerDependencies, ...m.dependencies }).zod ?? ''

/** The manifest of an installed harness package. */
const installedManifest = (name: string): Manifest =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../node_modules/${name}/package.json`, import.meta.url)), 'utf8'),
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

  // `domainTable()` and `sessionProjections.register()` accept the harness's
  // `ZodType`, imported from the harness's own zod. Two copies are nominally
  // different types, so a pin that differs from the harness's installs a second
  // one and `tsc` fails at every schema boundary with "ZodType<…, zod@A> is not
  // assignable to ZodType<…, zod@B>" (dependabot #21: 4.6.6 → 4.6.7). Both
  // sides are exact pins, so equality — not range satisfaction — is the rule;
  // if the harness ever declares a range, this fails and the pin has to be
  // reconsidered by hand rather than guessed.
  it('pins zod to the copy the harness itself resolves', () => {
    const own = zodSpec(manifest)
    expect(own, 'zod must be an exact pin').toMatch(/^\d+\.\d+\.\d+$/)
    for (const name of zodConsumers) {
      const harness = zodSpec(installedManifest(name))
      expect(harness, `${name} must declare zod`).not.toBe('')
      expect(own, `zod must match ${name}'s pin (${harness})`).toBe(harness)
    }
  })
})
