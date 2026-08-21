# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## Project overview

`dsh-suggest-prompt` is a single bundle plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (a Cordis-based agent framework)(local source code: `../../deepseek-harness/`). After every completed agent turn, a bounded auxiliary LLM call writes **one suggested next prompt** into the session log; the web composer renders it as ghost placeholder text inside the input, adopted via a configurable shortcut (default `Tab`).

This repo is the **authoritative source of record** for one bundle package `@studyzy/dsh-suggest-prompt` (a single-package bundle that declares `dsh.bundle` and ships its own `cordis.patch.yml`, so `dsh plugin add <git-url>` installs it as one profile layer). It merges the former two-package workspace into two runtime halves under one package:

| Half | Outlet | Role |
|---|---|---|
| host / node | `.`, `./invariant`, `./types` | On `turn/end` (reason `completed`), builds a bounded transcript, calls `ctx.llm`, sanitizes the reply, appends a `suggest-prompt/suggested` session event, and publishes the `suggestPrompt` session projection. |
| browser | `./client` | Reads the `suggestPrompt` projection and renders it as ghost placeholder text in the composer (`conversation.input.overlay` slot), plus a WebUI settings card. |

## Commands

Requires Node `^22.19` or `>=24` and `pnpm`. Run everything from the repo root (single package, no workspace fan-out).

```sh
pnpm install       # uses pnpm.overrides mapping 3 unpublished @deepseek-ai packages to local empty stubs/
pnpm build         # tsc -p tsconfig.json && tsdown: host ESM (lib/{index,invariant}.js) + browser bundle (lib/client.js)
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest run
```

Run a single test file:

```sh
pnpm vitest run tests/sanitize.spec.ts
pnpm vitest run tests/ghost.client.spec.tsx
```

Note: `tests/provider.e2e.ts` is a manual end-to-end test and is **excluded** from the Vitest run via `vitest.config.ts`. The full test matrix runs inside the harness monorepo; this repo is the source-of-record copy.

## Architecture

### Install / build caveats (important)

- The root `package.json` `pnpm.overrides` maps three unpublished upstream packages (`@deepseek-ai/dsh-compact`, `@deepseek-ai/dsh-type-meta`, `@deepseek-ai/dsh-environment`) to empty local packages under `stubs/` so `pnpm install` succeeds offline. Do not delete them until the registry is complete.
- `dsh.bundle` in `package.json` (`patch: ./cordis.patch.yml`) makes the package a one-command bundle: `dsh plugin --profile web add <git-url>` installs it and `reconcilePlugins` auto-appends it to the profile's `bundles` list. The browser half is discovered via the `dsh.client` declaration (`exports["./client"]`), so `cordis.patch.yml` only inserts the host entry.
- The `vitest.config.ts` aliases the single package's outlets to their **source** (not `lib/`) and `inline`s `@deepseek-ai/dsh-client-*` deps so tests run against source without a prior build and so CSS modules resolve under jsdom.

### Host half (`src/`)

One file per responsibility:

- `index.ts` — the Cordis plugin `apply(ctx)`: wires the `turn/end` handler, dedup/abort state per session, the `suggestPrompt` projection fold (`applySuggestPromptProjection`), and the `dsh-settings` config section. The projection-key type merge is re-exported via `export type * from './types.ts'` at the package root.
- `types.ts` — single home of the `SuggestPromptSuggestion` / projection-key declarations shared by host and browser.
- `domain.ts` — `SuggestPromptRequested` / `SuggestPromptSuggested` event payload types.
- `generate.ts` — the bounded generation pipeline: config validation (`resolveSuggestPromptConfig`), transcript framing, route resolution (inherits main request route when `provider`/`model` unset), deadline-fused dispatch via `ctx.llm`, and reasoning disabled (`ReasoningEffortId('off')`, retried once without the field if rejected). Mirrors the `session-title-llm` call policy so the "model-visible ⟺ logged" invariant holds.
- `sanitize.ts` — pure functions: `redactSecrets` (masks AWS/OpenAI/GitHub/Slack/JWT/Stripe secret shapes), `sanitizeSuggestion` (strips control sequences/fences/quotes, collapses to one line), `cleanSuggestion`, `shouldFilterSuggestion` (semantic filter: meta-text, evaluative filler, assistant voice → "no suggestion"), `hasCJK` (reply-language selection).
- `invariant.ts` — package invariant (fail-loud stream checks).

### Browser half (`src/browser/`)

- `index.ts` — browser plugin `apply(ctx)`: registers `GhostSuggestion` into the `conversation.input.overlay` slot, and conditionally (via `ctx.inject(['settingsScope', 'locale'])`) mounts the `SettingsCard` into the `settings.plugin.item` slot. Re-exports `./types` so the `./client` outlet keeps exposing the `suggestPrompt` projection declaration.
- `GhostSuggestion.tsx` — the overlay bridge: reads `useProjection('suggestPrompt')`, shows ghost text only when the suggestion is for the latest completed turn, agent idle, and draft empty. In-package types via relative `../types.ts` (no package self-import).
- `accept-key.ts` — parses the `acceptKey` config (default `Tab`) into a keyboard-shortcut matcher; ignores input while focused outside the composer or during IME composition.
- `settings-controller.ts` — `SuggestPromptCardController` for the WebUI settings card; reads/writes `~/.dsh/settings.yaml` under the `suggest-prompt` namespace (`SUGGEST_PROMPT_NS`), staged saves take effect on the next completed turn.
- `settings-locales.ts` — `zh`/`en` locale dictionaries for the card.
- `SettingsCard.tsx` — the React settings card UI.

### Key invariants / behavioral rules

- **Last turn only**: by default only the last completed turn's user input + assistant final answer are sent (`maxRecentTurns` default `1`); intermediate tool calls/reasoning are never included.
- **Silent no-suggestion is normal**: empty or filtered model replies skip quietly — no event, no warning, projection stays `null`.
- **One in-flight generation per session**; the next completed turn aborts (supersedes) the previous one.
- **Pre-dispatch logging**: exact framed input + system prompt are recorded in `suggest-prompt/request` before dispatch (model-visible ⟺ logged invariant).
- **Re-arm without a call**: deleting back to an empty draft re-shows the persisted suggestion with no new model request.
