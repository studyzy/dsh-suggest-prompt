/**
 * Shared plumbing for the browser e2e lanes (both the CI isolated one and the
 * local `~/.dsh` one): pnpm≥10 resolution, free-port probing, the `dsh web`
 * ready-line wait, the suggestion-model settings helper, and failure evidence.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'

/**
 * Directory on PATH whose `pnpm` dsh will resolve to. The vitest process is
 * itself launched by `pnpm run`, which rewrites PATH to pin the repo's
 * `packageManager` (pnpm@9) — and pnpm 9 rejects `pnpm add` to a workspace
 * root, so dsh's own `pnpm` would fail. Find a pnpm ≥10 (corepack cache on
 * macOS and Linux) and prepend its bin dir to the spawned env's PATH so dsh
 * installs cleanly. Returns '' to leave PATH alone when pnpm ≥10 is already
 * first.
 */
export function resolvePnpmBinDir(): string {
  // If the current PATH's pnpm is already ≥10, nothing to do.
  const probe = spawnSync('pnpm', ['--version'], { encoding: 'utf8' })
  const current = (probe.stdout ?? '').trim()
  if (probe.status === 0 && /^10\.|^1[1-9]\./.test(current)) return ''
  // Otherwise search the corepack cache for the newest 10.x and prepend it.
  const roots = [
    join(homedir(), '.local/share/pnpm/.tools/pnpm'), // Linux / GitHub Actions
    join(homedir(), 'Library/pnpm/.tools/pnpm'),      // macOS
  ]
  let best = ''
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const version of readdirSync(root)) {
      if (!/^10\./.test(version)) continue
      const bin = join(root, version, 'bin')
      if (existsSync(bin)) best = bin
    }
  }
  // Fall back to npm's global install (e.g. `npm install -g pnpm@10`).
  if (best === '') {
    const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' })
    const npmGlobalNodeModules = (npmRoot.stdout ?? '').trim()
    if (npmGlobalNodeModules !== '') {
      const npmGlobalPnpmBin = join(npmGlobalNodeModules, 'pnpm', 'bin')
      if (existsSync(npmGlobalPnpmBin)) best = npmGlobalPnpmBin
    }
  }
  return best
}

/** OS-assigned free port, released before use (the spawned `dsh web` needs a concrete --port). */
export function probeFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close(() => { reject(new Error('port probe returned no address')) })
        return
      }
      probe.close(() => { resolvePort(address.port) })
    })
  })
}

/** Resolve once `dsh web` prints its listening line (`dsh web: http://...`). */
export function waitForReadyLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => {
      reject(new Error(`dsh web not ready in 90s; output:\n${out}`))
    }, 90_000)
    const onData = (chunk: Buffer): void => {
      out += chunk.toString()
      const match = /dsh web: (http:\/\/[^\s]+)/.exec(out)
      if (match !== null) {
        clearTimeout(timer)
        resolve(match[1] ?? '')
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
  })
}

/**
 * Run `dsh plugin --profile <name> <args...>`, prepending a pnpm ≥10 bin to
 * PATH so the profile's own pnpm (resolved from PATH) does not trip pnpm 9's
 * ERR_PNPM_ADDING_TO_ROOT. Throws with the captured output on non-zero exit.
 */
export function runDSHPlugin(profile: string, args: readonly string[], cwd: string): Promise<void> {
  const spawnEnv = { ...process.env }
  const pnpmBin = resolvePnpmBinDir()
  if (pnpmBin !== '') spawnEnv.PATH = `${pnpmBin}:${spawnEnv.PATH ?? ''}`
  return new Promise((resolve, reject) => {
    const child = spawn('dsh', ['plugin', '--profile', profile, ...args], {
      cwd,
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out: string[] = []
    child.stdout?.on('data', chunk => out.push(chunk.toString()))
    child.stderr?.on('data', chunk => out.push(chunk.toString()))
    child.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`dsh plugin ${args.join(' ')} failed (exit ${code}):\n${out.join('')}`))
    })
  })
}

/**
 * Open Settings → Plugins, expand the suggestion card, set provider/model,
 * save. The card is keyed by stable select ids
 * (`#suggest-prompt-settings-provider` / `-model`).
 */
export async function setSuggestionModel(page: Page, provider: string, model: string): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置' })
  await settings.waitFor({ timeout: 10_000 })
  await settings.getByRole('button', { name: '插件' }).click()

  const card = settings.getByRole('button', { name: '展开: 建议提示词' })
  await card.waitFor({ timeout: 10_000 })
  await card.click()

  const providerSelect = settings.locator('#suggest-prompt-settings-provider')
  await providerSelect.waitFor({ timeout: 10_000 })
  await providerSelect.selectOption(provider)

  const modelSelect = settings.locator('#suggest-prompt-settings-model')
  await modelSelect.waitFor({ timeout: 10_000 })
  await modelSelect.selectOption(model)

  await settings.getByRole('button', { name: '保存', exact: true }).click()
  // Saving does not close the settings dialog; click its header close button
  // (the "x" in the top-right corner) so the composer is reachable again.
  await settings.getByRole('button', { name: '关闭' }).click()
  await settings.waitFor({ state: 'detached', timeout: 15_000 })
}

/** Failure evidence goes to the gitignored .artifacts/. */
export async function saveFailureShot(page: Page, name: string): Promise<void> {
  const { mkdirSync } = await import('node:fs')
  const { fileURLToPath: f2p } = await import('node:url')
  const dir = f2p(new URL('../../.artifacts', import.meta.url))
  mkdirSync(dir, { recursive: true })
  try {
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true })
    const info = await page.evaluate(() => {
      const describe = (el: Element): string => {
        const role = el.getAttribute('role')
        const aria = el.getAttribute('aria-label')
        const text = (el.textContent ?? '').trim().slice(0, 80)
        return `[${role ?? el.tagName.toLowerCase()} aria-label=${aria ?? ''}] "${text}"`
      }
      const dialogs = [...document.querySelectorAll('[role="dialog"],[role="menu"]')].map(describe)
      const buttons = [...document.querySelectorAll('button[aria-haspopup]')].map(describe)
      const textareas = [...document.querySelectorAll('textarea')].map(describe)
      return { dialogs, buttons, textareas }
    })
    await import('node:fs/promises').then(fs =>
      fs.writeFile(`${dir}/${name}.json`, JSON.stringify(info, null, 2)))
  } catch {
    // Best-effort evidence: a dead page at failure time must not mask the real assertion error.
  }
}
