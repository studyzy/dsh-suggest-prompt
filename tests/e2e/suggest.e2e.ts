/**
 * Full browser e2e for dsh-suggest-prompt through the REAL dsh CLI chain:
 *
 *   1.  an isolated $DSH_HOME is created (never touches the user's ~/.dsh);
 *   2.  `dsh plugin --profile web add <this repo>` installs the bundle
 *       (reconcilePlugins appends it to the profile's bundles list);
 *   3.  `dsh web --port <free> --no-open` is spawned against that home;
 *   4.  Playwright drives the WebUI: walks the first-run onboarding to store
 *       the DeepSeek key, connects a workspace, sets the suggestion model to
 *       DeepSeek Flash in the "建议提示词" settings card, then sends a math
 *       question and asserts a ghost next-prompt suggestion appears in the
 *       composer after the agent finishes.
 *
 * The `DEEPSEEK_API_KEY` env var is used both to gate the suite
 * (`skipIf(!DEEPSEEK_API_KEY)`) and as the value typed into the onboarding
 * dialog — it is deliberately NOT forwarded to the spawned `dsh web`, so the
 * first-run credential step mounts and we exercise the real UI path.
 *
 * Run: `pnpm test:e2e` (requires a real DEEPSEEK_API_KEY; skipped otherwise).
 * Excluded from the default `pnpm test` via vitest.e2e.config.ts.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Directory on PATH whose `pnpm` dsh will resolve to. The vitest process is
 * itself launched by `pnpm run`, which rewrites PATH to pin THIS repo's
 * `packageManager` (pnpm@9) — and pnpm 9 rejects `pnpm add` to a workspace
 * root, so dsh's own `pnpm` would fail. Find a pnpm ≥10 (corepack cache on
 * macOS and Linux) and prepend its bin dir to the spawned env's PATH so dsh
 * installs cleanly. Returns '' to leave PATH alone when pnpm ≥10 is already
 * first.
 */
function resolvePnpmBinDir(): string {
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
function probeFreePort(): Promise<number> {
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
function waitForReadyLine(child: ChildProcess): Promise<string> {
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

/** Walk the first-run onboarding to store the DeepSeek credential through the UI. */
async function configureKeyThroughOnboarding(page: Page, apiKey: string): Promise<void> {
  const welcome = page.getByRole('dialog', { name: '内测声明' })
  await welcome.waitFor({ timeout: 30_000 })
  await welcome.getByRole('button', { name: '继续' }).click()
  await welcome.waitFor({ state: 'detached', timeout: 15_000 })

  const credentialStep = page.getByRole('dialog', { name: '添加一个 API Key 开始使用' })
  await credentialStep.waitFor({ timeout: 15_000 })
  const keyInput = credentialStep.getByLabel('API 密钥', { exact: true })
  await keyInput.waitFor({ timeout: 10_000 })
  await keyInput.fill(apiKey)
  await credentialStep.getByRole('button', { name: '保存并继续' }).click()
  await credentialStep.waitFor({ state: 'detached', timeout: 15_000 })
}

/**
 * Connect a fresh workspace through the in-browser browse directory picker so
 * the composer textarea unlocks from its inert workspace-trigger state. A cold
 * world with no listed workspace opens the picker directly (see
 * WorkspacePickFlow.addIsTheOnlyEntry in dsh-ui-workspace).
 */
async function connectWorkspace(page: Page, root: string, name = 'workspace'): Promise<void> {
  mkdirSync(join(root, name), { recursive: true })
  // A cold world with no listed workspace opens the in-browser browse
  // directory picker directly (see WorkspacePickFlow.addIsTheOnlyEntry in
  // dsh-ui-workspace), so the picker dialog appears right after the click.
  await page.getByRole('button', { name: '选择工作区' }).click()
  const dialog = page.getByRole('dialog', { name: '选择工作区目录' })
  await dialog.waitFor({ timeout: 15_000 })
  await dialog.getByRole('button', { name: '编辑路径' }).click()
  const pathInput = dialog.getByRole('textbox', { name: '编辑路径' })
  await pathInput.fill(join(root, name))
  await pathInput.press('Enter')
  await dialog.getByRole('button', { name: '打开', exact: true }).click()
  // The pick connects the workspace: the inert trigger textarea becomes a live
  // composer (placeholder changes to the default "描述你想要构建的内容").
  await page.locator('textarea:enabled[placeholder="描述你想要构建的内容"]')
    .waitFor({ timeout: 15_000 })
}

/** Open Settings → Plugins, expand the suggestion card, set provider/model, save. */
async function setSuggestionModel(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置' })
  await settings.waitFor({ timeout: 10_000 })
  await settings.getByRole('button', { name: '插件' }).click()

  const card = settings.getByRole('button', { name: '展开: 建议提示词' })
  await card.waitFor({ timeout: 10_000 })
  await card.click()

  const provider = settings.locator('#suggest-prompt-settings-provider')
  await provider.waitFor({ timeout: 10_000 })
  await provider.selectOption('deepseek-official')

  const model = settings.locator('#suggest-prompt-settings-model')
  await model.waitFor({ timeout: 10_000 })
  await model.selectOption('deepseek-v4-flash')

  await settings.getByRole('button', { name: '保存', exact: true }).click()
  await settings.getByRole('dialog', { name: '设置' }).waitFor({ state: 'detached', timeout: 15_000 })
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('suggest-prompt browser e2e (real dsh CLI)', () => {
  let child: ChildProcess
  let home: string
  let baseUrl: string
  let browser: Browser
  let page: Page
  const pageErrors: string[] = []

  beforeAll(async () => {
    // Isolated world: never touches the real ~/.dsh.
    home = mkdtempSync(join(tmpdir(), 'dsh-suggest-e2e-'))
    // dsh manages a profile's plugins with `pnpm` resolved from PATH. The
    // vitest process is launched by `pnpm run`, which pins PATH to this repo's
    // package-manager (pnpm@9) — and pnpm 9 rejects adding to a workspace
    // root. Prepend a pnpm ≥10 bin dir so dsh's pnpm installs cleanly.
    const spawnEnv = { ...process.env, DSH_HOME: home }
    const pnpmBin = resolvePnpmBinDir()
    if (pnpmBin !== '') spawnEnv.PATH = `${pnpmBin}:${spawnEnv.PATH ?? ''}`
    // Install the bundle into a fresh profile via the real dsh CLI.
    const install = spawn('dsh', ['plugin', '--profile', 'web', 'add', REPO_ROOT], {
      cwd: home,
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const installOut: string[] = []
    install.stdout?.on('data', chunk => installOut.push(chunk.toString()))
    install.stderr?.on('data', chunk => installOut.push(chunk.toString()))
    const code = await new Promise<number | null>(resolve => install.on('exit', resolve))
    if (code !== 0) {
      throw new Error(`dsh plugin add failed (exit ${code}):\n${installOut.join('')}`)
    }

    const port = await probeFreePort()
    // Deliberately drop the key so the first-run credential step mounts and
    // the test types it through the UI (the step the user asked to exercise).
    delete spawnEnv.DEEPSEEK_API_KEY
    child = spawn('dsh', [
      'web',
      // The shipped `directory-picker` row is `-auto` → native OS chooser,
      // which a Playwright page cannot drive. Pin the in-browser browse
      // picker (mirrors harness apps/web/tests/pin-browse-picker.overlay.yml).
      // `--patch` must lead the web-app flags: the launcher consumes it only
      // before the first positional/unknown option (enablePositionalOptions).
      '--patch', fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      '--no-open', '--host', '127.0.0.1', '--port', String(port),
    ], {
      cwd: home,
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    baseUrl = await waitForReadyLine(child)

    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
    page.on('pageerror', error => pageErrors.push(String(error)))
    await page.goto(baseUrl, { waitUntil: 'load' })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    if (child !== undefined && child.exitCode === null) {
      const gone = new Promise<void>(resolve => child.once('exit', () => resolve()))
      child.kill('SIGTERM')
      await Promise.race([gone, new Promise(resolve => setTimeout(resolve, 10_000).unref())])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
  })

  it('suggests a next prompt after the assistant answers a math question', async () => {
    onTestFailed(() => saveFailureShot(page, 'suggest-e2e'))
    const apiKey = process.env.DEEPSEEK_API_KEY as string

    // First-run onboarding: store the DeepSeek key through the UI.
    await configureKeyThroughOnboarding(page, apiKey)

    // Connect a workspace so the composer unlocks (the inert textarea is a
    // workspace trigger until a real workspace is picked).
    await connectWorkspace(page, home)
    const input = page.locator('textarea:enabled[placeholder="描述你想要构建的内容"]')
    await input.waitFor({ timeout: 15_000 })

    // Route the suggestion model to DeepSeek Flash (deepseek-v4-flash).
    await setSuggestionModel(page)

    // Ask a math question. The base layer's default agent model is already
    // deepseek-official/deepseek-v4-flash, so the agent answers with real API.
    await input.fill('出一道小学数学题给我')
    await input.press('Enter')

    // The ghost suggestion renders only after the turn completes (agent idle)
    // and the suggestion generation returns. `[data-suggest-prompt-ghost]` is
    // the suggestion's surface marker; assert its text is non-empty.
    const ghost = page.locator('[data-suggest-prompt-ghost] .dsh-suggest-prompt-ghost')
    await ghost.waitFor({ timeout: 180_000 })
    const text = await ghost.textContent()
    expect(text?.trim().length).toBeGreaterThan(0)
    expect(pageErrors).toEqual([])
  }, 240_000)
})

/** Failure evidence goes to the gitignored .artifacts/. */
async function saveFailureShot(page: Page, name: string): Promise<void> {
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
