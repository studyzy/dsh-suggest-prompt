# dsh-suggest-prompt

Suggested next prompt for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): after every completed agent turn, a bounded auxiliary LLM call writes **one suggested next prompt** into the session log, and the web composer renders it as ghost text in the empty input — accepted with `Alt-/`.

Two packages live here:

| Package | Role |
|---|---|
| [`@deepseek-ai/dsh-suggest-prompt`](packages/suggest-prompt) | Host plugin: generates the suggestion on `turn/end` (completed) and publishes the `suggestPrompt` session projection. |
| [`@deepseek-ai/dsh-client-ui-suggest-prompt`](packages/ui-suggest-prompt) | Browser plugin: reads the projection and pushes the suggestion into the composer's ghost decoration (`InputActions.setGhost`); `Alt-/` fills the draft. |

## Features

- **Lightweight by default**: the suggestion model defaults to `deepseek-official` / `deepseek-v4-flash`; override the `provider`/`model` pair in the plugin config to route elsewhere.
- **Bounded**: byte/token/time bounds, transcript tail bounds, and a visible-character cap on the suggestion.
- **Safe**: transcripts are secret-redacted before framing; output is sanitized (control sequences, fences, quotes stripped, single line).
- **Re-arm without a call**: deleting back to an empty draft re-shows the persisted suggestion — no new model request.

## Install

Both packages are published to npm under `@deepseek-ai`. Install into a dsh deployment and mount the rows, e.g. in the `web` profile:

```yaml
- insert:
    - id: suggest-prompt
      name: '@deepseek-ai/dsh-suggest-prompt'
      config:
        maxInputBytes: 4096
        maxOutputTokens: 64
        timeoutMs: 60000
        maxRecentTurns: 10
        maxTranscriptChars: 12000
        maxSuggestionChars: 240
        provider: deepseek-official
        model: deepseek-v4-flash

    - id: ui-suggest-prompt
      name: '@deepseek-ai/dsh-client-ui-suggest-prompt'
```

Omit `provider`/`model` to inherit the session's latest logged request route instead.

## Development

```sh
pnpm install
pnpm build      # host tsc + client tsdown bundle
pnpm test       # vitest
pnpm typecheck
```

> **Install caveat**: this repo depends on the published `@deepseek-ai/*` packages (the DeepSeek Harness workspace). A small number of internal packages referenced by the published `dsh-*` releases are not yet on the npm registry (`@deepseek-ai/dsh-compact`, `@deepseek-ai/dsh-environment`), so `pnpm install` may fail until the harness registry is complete. The full test matrix runs inside the harness monorepo; this repo is the source-of-record copy for the two packages.

## License

MIT
