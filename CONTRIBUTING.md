# Contributing

Thanks for your interest in `dsh-suggest-prompt`. This document covers the
practical rules for changing the repo; the architecture itself lives in
[AGENTS.md](AGENTS.md).

## Prerequisites

- Node `^22.19` or `>=24` (see `.nvmrc`)
- `pnpm` (the exact version is pinned by `packageManager` in `package.json`)

## Setup

```sh
pnpm install       # maps three unpublished @deepseek-ai packages to local stubs/
pnpm typecheck
pnpm test
pnpm build
```

`pnpm install` uses `pnpm.overrides` to map three upstream packages that are not
on the npm registry to empty local packages under `stubs/`. That is expected,
not a workaround you should remove.

## The three gates

Every change must pass all three, and CI runs exactly these:

```sh
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest run (unit + client, jsdom)
pnpm build         # tsc -> lib/types, tsdown -> lib/{index,invariant,client}.js
```

Run a single test file while iterating:

```sh
pnpm vitest run tests/sanitize.spec.ts
pnpm vitest run tests/ghost.client.spec.tsx
```

## Version-coupled code (read before editing)

This plugin is built against a **specific** `dsh` release, and the harness
changes its internal contracts between releases. The seams that have already
broken once are documented in [AGENTS.md](AGENTS.md) under
"Version-critical contracts". Two of them are easy to get wrong:

- **The client module table is a fixed seed list.** A browser bundle may only
  `require` the platform singletons listed in the harness's `PLATFORM_MODULES`.
  Requiring anything else throws at load time. `CLIENT_EXTERNALS` in
  `tsdown.config.ts` mirrors that list.
- **The composer is a Lexical `contenteditable` host, not a `<textarea>`**, and
  its placeholder is a real sibling element rather than a `::placeholder`
  pseudo-element. Code that assumes a textarea (focus checks, CSS selectors)
  will silently do nothing.

When you adapt to a new harness release, update the affected `@deepseek-ai/*`
ranges, the `pnpm.overrides` pin, `AGENTS.md`, and the e2e assertions together.

## Tests

- Add a regression test for every bug fix. Two of this project's shipped bugs
  (duplicate ghost text, and `Tab` not accepting) were invisible to a test suite
  that only exercised the old `<textarea>` shape — so test the DOM shape the
  current harness actually renders.
- `tests/e2e/` drives a real `dsh web` with Playwright and requires
  `DEEPSEEK_API_KEY`. It is excluded from `pnpm test`; run it with
  `pnpm test:e2e`.
- Manual and browser end-to-end suites are excluded from the default lane via
  `vitest.config.ts`.

## Commits and pull requests

- Conventional-commit subjects (`fix:`, `feat:`, `docs:`, `test:`, `chore:`,
  `refactor:`) keep the history scannable.
- Keep a commit focused; unrelated cleanups belong in their own PR.
- Fill in the pull request template, including the **Breaking changes** section
  when you touch the bundle's public surface, the `suggest-prompt` config
  schema, or the `suggestPrompt` session projection.
- Note in the PR how you verified the change. "Ran `pnpm test`" is enough for a
  small fix; contract changes should say what you checked against the harness
  source.

## Reporting bugs

Use the issue templates. For a behavior difference after a `dsh` upgrade,
include the harness version — most reports of this kind are a contract drift
rather than a logic bug.