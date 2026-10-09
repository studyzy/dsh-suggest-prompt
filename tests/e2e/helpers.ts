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
import type { Locator, Page } from 'playwright'

/**
 * The composer's editable surface, once a workspace has unlocked it.
 *
 * `dsh >= 0.2.0` replaced the `<textarea>` with a Lexical `contenteditable`
 * host, so the old `textarea:enabled[placeholder=…]` selector matches nothing.
 * `[data-input-scroll]` is the editor layer's own marker and survives the inner
 * element changing again; `[contenteditable="true"]` narrows it to the live
 * (non-inert) state, which is what the workspace pick unlocks.
 * @param page - the page to query.
 * @returns a locator for the unlocked composer editor.
 */
export function composerEditor(page: Page): Locator {
  return page.locator('[data-input-scroll] [contenteditable="true"]')
}

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
 * Open the Plugins page, open the suggestion card's detail pane, set the
 * provider/model, save, and go back to the list.
 *
 * `dsh >= 0.2.0` first seated this card as a `role="tab"` under
 * Settings → 内置插件 (`settings.plugins.tab`); the plugin now contributes to
 * the **Plugins page** instead, through two slots it renders from two different
 * entry points:
 *
 *   - `plugins.item`  → the card's own seat in the 官方 group, as
 *     `<li data-plugin-item="suggest-prompt">`; its detail page
 *     (`<div data-plugin-item-detail="suggest-prompt">`) holds the form inside
 *     `<section data-plugin-config>`.
 *   - `plugins.bundle.config` → keyed by the **package name**, so it renders
 *     inside the 已安装 package card's page
 *     (`<div data-plugin-detail="@studyzy/dsh-suggest-prompt">`) as a sibling
 *     `<section data-plugin-config>` above 包含的组件 — and only there.
 *
 * This helper drives the 官方 (`plugins.item`) route: its id is the plugin's own
 * namespace (`suggest-prompt`), which is stable across profiles, whereas the
 * 已安装 route needs both the exact package name and a non-empty
 * `plugins.bundle.config` ledger (`configured: ledger.bundles.has(pkg.name)`) —
 * a registration bug there renders no section at all and the helper would hang
 * on a missing field rather than on a missing click target. The 已安装 route is
 * worth a separate assertion (it is the one the docs' checklist calls out), but
 * it is the more fragile of the two to route a whole suite through.
 *
 * The form itself is untouched by the move: the field ids
 * (`#suggest-prompt-settings-provider` / `-model`) and the 保存 button are the
 * same as before. What is gone is the accordion — the detail page IS the
 * expanded state, so there is no "展开: 建议提示词" disclosure header to click.
 *
 * Entrance: the 插件 panel is a sidebar entry, not a settings section — a
 * `<button aria-label="插件">` inside the sidebar's `<nav aria-label="全局面板">`
 * (panel id `plugins`). It is targetable by role+name, and it must be selected
 * before any card exists in the DOM.
 */
export async function setSuggestionModel(page: Page, provider: string, model: string): Promise<void> {
  // The sidebar's panel row: `aria-label` is the panel label ("插件"/"Plugins").
  // Scoped to the panel nav so a future "插件" label elsewhere cannot steal the
  // click. Selecting the panel unmounts/remounts the page (the plugin resets to
  // the list view whenever the active panel changes away), so this click is the
  // whole entrance — no settings dialog is involved any more.
  const panel = page.getByRole('navigation', { name: '全局面板' })
  const panelButton = panel.getByRole('button', { name: '插件', exact: true })
  await panelButton.waitFor({ timeout: 15_000 })
  await panelButton.click()

  // The 官方 group's card for this plugin. Clicking it opens the item detail
  // (`data-plugin-item-detail`), whose config section holds the full form.
  // `CardHead` opens on the title button, so click the card title rather than
  // the `<li>`: the row itself has no click handler.
  const itemCard = page.locator('li[data-plugin-item="suggest-prompt"]')
  await itemCard.waitFor({ timeout: 15_000 })
  await itemCard.getByRole('button', { name: '建议提示词' }).click()

  // Wait for the detail page itself, then for the section that owns the form:
  // both are rendered by the plugin-manager page, not by the card, so waiting
  // on them distinguishes "the page did not open" from "the form did not mount".
  await page.locator('div[data-plugin-item-detail="suggest-prompt"]').waitFor({ timeout: 15_000 })
  const config = page.locator('section[data-plugin-config]')
  await config.waitFor({ timeout: 15_000 })

  const providerSelect = config.locator('#suggest-prompt-settings-provider')
  await providerSelect.waitFor({ timeout: 10_000 })
  await providerSelect.selectOption(provider)

  // The model control is a <select> only when the provider's catalog lists
  // explicit models; a provider without one (notably `deepseek-official` in a
  // cold isolated $DSH_HOME) degrades to a free-text input. Type into whichever
  // shape rendered instead of assuming the dropdown.
  const modelControl = config.locator('#suggest-prompt-settings-model')
  await modelControl.waitFor({ timeout: 10_000 })
  if (await modelControl.evaluate(el => el.tagName.toLowerCase()) === 'select') {
    await modelControl.selectOption(model)
  } else {
    await modelControl.fill(model)
  }

  // The card's own footer, not a shared `SettingsForm`: its button copy is this
  // plugin's dictionary (`save` → 保存), scoped to the config section so the
  // page's own actions (启用/卸载/…) cannot match.
  await config.getByRole('button', { name: '保存', exact: true }).click()

  // Saving does not leave the page. The composer is unreachable while a detail
  // page is open, so click the crumb back to the list — its accessible name is
  // the plugin-manager dictionary's `backToList` ("返回插件列表"), rendered as a
  // `<button aria-label="返回插件列表">` at the top of every detail page.
  await page.getByRole('button', { name: '返回插件列表' }).click()
  await page.locator('div[data-plugin-item-detail="suggest-prompt"]')
    .waitFor({ state: 'detached', timeout: 15_000 })

  // The Plugins page is a global main panel: while a panel entry is selected it
  // owns the central area, the session Sidebar is not rendered, and no crumb
  // returns to the Conversation — the composer stays gone even in the list
  // view. Panel selection is transient state that a reload resets (dsh
  // 0.2.0-rc.2, "global main panels" note), and the stored key, workspace, and
  // just-saved suggestion model all live in the profile, so reload is the
  // platform-agnostic way back to the composer.
  await page.reload({ waitUntil: 'load' })

  // The preview notice is confirmed per browser process (its ack lives in the
  // host-only `ui-settings-general` namespace, so a page reload shows it again)
  // while the credential step does not — the key was stored through the
  // onboarding before the panel detour. Dismiss the notice idempotently: a
  // loopback browser that persisted the ack never mounts the dialog.
  const notice = page.getByRole('dialog', { name: '预览版说明' })
  if (await notice.count() > 0) {
    await notice.getByRole('button', { name: '继续' }).click()
    await notice.waitFor({ state: 'detached', timeout: 15_000 })
  }

  await composerEditor(page).waitFor({ timeout: 15_000 })
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
