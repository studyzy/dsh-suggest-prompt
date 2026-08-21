/**
 * LOCAL browser e2e for dsh-suggest-prompt, running against the developer's
 * REAL ~/.dsh (no isolated home, no dsh install — the globally installed dsh
 * and an already-configured DeepSeek/ccr setup are assumed):
 *
 *   1.  `dsh plugin --profile web add <this repo>` links the current source
 *       into the local web profile (source-of-truth install);
 *   2.  `dsh web --port <free> --no-open` is spawned against the real home;
 *   3.  Playwright drives the WebUI: sets the suggestion model to
 *       DeepSeek Flash (ccr / hai/DeepSeek-V4-Flash) in the "建议提示词"
 *       settings card, sends a math question, and asserts a ghost next-prompt
 *       suggestion appears in the composer after the agent finishes.
 *
 * Unlike the CI lane (`suggest.e2e.ts`, isolated $DSH_HOME + onboarding), this
 * one reuses the local profile: no onboarding (already acknowledged), no
 * workspace pick (one is already connected), and it writes to the real
 * `~/.dsh/settings.yaml` (the suggestion model) — an intentional side effect
 * the developer opted into.
 *
 * Playwright runs HEADFUL on macOS (watch the browser drive the UI) and
 * headless on Linux. Not part of CI; run with `pnpm test:e2e:local`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  probeFreePort, resolvePnpmBinDir, runDSHPlugin, saveFailureShot, setSuggestionModel, waitForReadyLine,
} from './helpers.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

// The local DeepSeek Flash route (this machine's ccr gateway). The suggestion
// model is set to it through the UI each run.
const LOCAL_PROVIDER = 'ccr'
const LOCAL_FLASH_MODEL = 'hai/DeepSeek-V4-Flash'

describe.skipIf(homedir() === '' && !process.env.DSH_HOME)(
  'suggest-prompt browser e2e (local ~/.dsh)',
  () => {
    let child: ChildProcess
    let baseUrl: string
    let browser: Browser
    let page: Page
    const pageErrors: string[] = []

    beforeAll(async () => {
      // Install the CURRENT source into the local web profile as a `link:`
      // dependency. If an older `github:`-sourced version is already present,
      // pnpm keeps resolving that remote spec (and demands a prepare-script
      // allowlist), so remove it first — then re-add the local path as a link.
      const home = homedir()
      await runDSHPlugin('web', ['remove', '@studyzy/dsh-suggest-prompt'], home).catch(() => {
        // Not installed via dsh before (or already absent) is fine.
      })
      await runDSHPlugin('web', ['add', REPO_ROOT], home)

      // Spawn `dsh web` against the REAL home (no DSH_HOME override).
      const port = await probeFreePort()
      const spawnEnv = { ...process.env }
      const pnpmBin = resolvePnpmBinDir()
      if (pnpmBin !== '') spawnEnv.PATH = `${pnpmBin}:${spawnEnv.PATH ?? ''}`
      child = spawn('dsh', ['web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], {
        cwd: home,
        env: spawnEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      baseUrl = await waitForReadyLine(child)

      // Headful on macOS so the developer can watch the run; headless elsewhere.
      browser = await chromium.launch({ headless: process.platform !== 'darwin' })
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
      // Intentionally do NOT clean up the real profile: the source link and the
      // suggestion-model setting persist for the developer's daily use.
    })

    it('suggests a next prompt after the assistant answers a math question', async () => {
      onTestFailed(() => saveFailureShot(page, 'suggest-e2e-local'))

      // No onboarding: the local home has acknowledged the welcome/credential
      // steps, so the main frame appears directly. No workspace pick either:
      // the local profile already has one connected, so the composer is live.
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      const input = page.locator('textarea:enabled').first()
      await input.waitFor({ timeout: 20_000 })

      // Route the suggestion model to DeepSeek Flash (ccr / hai/DeepSeek-V4-Flash).
      await setSuggestionModel(page, LOCAL_PROVIDER, LOCAL_FLASH_MODEL)

      // Ask a math question; the local agent-default-model answers with real API.
      await input.fill('出一道小学数学题给我')
      await input.press('Enter')

      // The ghost suggestion renders only after the turn completes (agent idle)
      // and the suggestion generation returns.
      const ghost = page.locator('[data-suggest-prompt-ghost] .dsh-suggest-prompt-ghost')
      await ghost.waitFor({ timeout: 180_000 })
      const text = await ghost.textContent()
      expect(text?.trim().length).toBeGreaterThan(0)
      expect(pageErrors).toEqual([])
    }, 240_000)
  },
)
