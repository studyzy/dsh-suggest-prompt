# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because this plugin is built against a specific `dsh` release and the harness
changes internal contracts between releases, each entry names the harness
version it targets.

## [Unreleased]

### Fixed

- **The ghost suggestion no longer paints over the composer's attachments row.**
  It was pinned with a fixed `top: calc(10px + 4px)` / `left: 16px` offset, which
  describes only a composer whose editor sits at the card's top edge — the
  numbers the pre-`0.2.0` layout used. The card has since become a flex column
  that stacks the accessory slot and the attachments row above the editor, so
  attaching an image pushed the editor down while the ghost stayed put and drew
  the suggestion on top of the user's image chips. The ghost now measures the
  draft editor's text origin at runtime (`src/browser/ghost-geometry.ts`) and
  re-measures through a `ResizeObserver` plus `window.resize`, so attachments,
  the font-size preference and the hero/docked layout all carry it along with
  the caret. Verified on `dsh 0.2.2-rc.1`; the stylesheet offset survives only as
  a fallback for trees with no layout to measure (jsdom, a detached node).

## [1.2.3] - 2026-10-28

### Fixed

- **Installing the plugin no longer disables the web profile's own plugins.**
  1.2.1 declared `@deepseek-ai/dsh-client-connection` and
  `@deepseek-ai/dsh-storage-domain` as direct dependencies so the storage-domain
  import could resolve inside an installed profile. That was the wrong vehicle:
  the copies landed in the profile's `node_modules`, shadowed the host's own
  rows, and any dsh runtime bump (e.g. 0.2.1-rc.2 over 0.2.0-rc.2) then disabled
  the rows as exact-version incompatible — cascading into the whole web profile
  failing to activate. Harness-internal `@deepseek-ai/dsh-*` packages are
  host-resolved (the loader resolves the plugin's bare imports against the host
  install, exactly as 1.1.0 already relied on for `dsh-llm`/`dsh-session`), so
  they belong in `peerDependencies`/`devDependencies` only. The entries stay in
  `devDependencies` for local builds; they no longer ship.

- **The harness runtime packages are declared as peers, and a test keeps them
  that way.** Dropping `@deepseek-ai/dsh-client-connection` and
  `@deepseek-ai/dsh-storage-domain` from `dependencies` left them undeclared:
  they were missing from `peerDependencies`, where the other fifteen harness
  packages are.
  `tests/package-manifest.spec.ts` now enforces both halves: no
  `@deepseek-ai/dsh*` entry in `dependencies`, and a version *range* (never an
  exact pin) for each harness package the plugin imports while the host runs it.
- **A failed on-demand generation no longer discards a working suggestion.** The
  explicit route retired the stored record the way automatic generation does,
  so a transient model timeout or 429 answered `502` *and* destroyed a tip that
  still answered the turn the user was asking about. It now retires only when
  nothing answers that turn.
- **A `running` toggle no longer cancels an in-flight on-demand request.** The
  toolbar control's reset effect was keyed on `running` as well as the session,
  so a turn starting and finishing mid-request orphaned the fetch, left the
  button stuck disabled, let a second click issue a duplicate call, and revoked
  an acceptance already shown in the composer. Only a session switch resets it
  now.

### Added

- **Touch acceptance and on-demand generation in the composer toolbar.** A
  localized, accessible button in the `conversation.input.right` slot either
  adopts the stored suggestion into the draft (never submitting it) or asks the
  host for a fresh one through `POST /api/suggest-prompt/generate`. The route
  reuses the automatic path's bounded, redacted dispatcher and plugin-owned
  storage, and answers `generated` / `empty` / `busy` / `no-context` / `error`;
  provider and adapter failures are never surfaced to the browser. Manual and
  automatic generation share one per-session in-flight slot, durable mutations
  are serialized so an older asynchronous put cannot win last, and a
  `suggestPromptLifecycle` projection supplies idle/completed context without
  reading deprecated session history. Nothing is written to the session log.

## [1.2.0] - 2026-10-12

Targets `dsh 0.2.1-alpha.1+` for generation; everything else (settings card,
client bundle) still works on `dsh 0.2.0-rc.2`. The move below only changes which
slots the client card registers into, not the harness contract.

### Fixed

- **Suggestions no longer make the session log unreadable ([#4]).** The plugin
  used to append private `suggest-prompt/request` / `suggest-prompt/suggested`
  events through `Session.append`. Those types are outside the harness's closed
  `KNOWN_SESSION_EVENT_TYPES` and rc.2 offers no way to mark an appended event
  `ignorable`, so `validateStoredEvents` refused the whole log on the next cold
  read — every session that completed one suggestion became unloadable. Now the
  plugin writes nothing but a single ignorable plugin record
  (`plugin:suggest-prompt/suggested`, via `appendPluginRecord`, `dsh >= 0.2.1`):
  unknown readers retain and skip it, it never joins the model-visible surface,
  and the projection folds still consume it through `session/event`. On a
  harness without that API (0.2.0-rc.2) the plugin stays fully dormant — one
  warning at mount, no LLM call, no log write — because an auxiliary call whose
  only delivery channel wedges the session is worse than no suggestion. The
  pre-dispatch request logging (`suggest-prompt/request`) is gone; the
  `requestSeq` field left the suggestion payload and the `suggestPrompt`
  projection (stateVersion bumped to 2, stale cached rows are discarded).
  Sessions already wedged by the old build keep their three non-ignorable rows
  and still need a hand edit (marking them `ignorable: true` restores them).

[#4]: https://github.com/studyzy/dsh-suggest-prompt/issues/4

### Changed

- **The settings card moved from the Settings page to the Plugins page.** It is no
  longer a `settings.plugins.tab` entry. The same `SettingsCard` component is now
  registered twice and appears at **two entry points of the Plugins page**: a
  `plugins.item` card (`id: 'suggest-prompt'`) in the official-plugin group, and a
  `plugins.bundle.config` entry keyed by the package name
  (`@studyzy/dsh-suggest-prompt`) on the detail page of the installed
  `@studyzy/dsh-suggest-prompt` package card, above its "Components" (包含的组件)
  list. Both registrations are required: a profile bundle that is both a `bundles`
  member and a `dependencies` member is also rendered as an installed package
  card, and without the keyed registration that card's config section does not
  render at all. The keyed slot is addressed by **package name**, not by `id` or
  the settings namespace — the wrong key fails silently.
- The two surfaces share **one** controller face (built once, not per
  registration), so a draft edited at one entry point is visible at the other and
  Save is a single write. A face built per surface would leave each entry point
  with its own draft table and silently write the wrong one.
- `SettingsCard` now discriminates on `view`: `plugins.item` renders it as
  `summary` (the card's one-line description, from the `description` locale key,
  in a dedicated hook-free component) and as `page`, while
  `plugins.bundle.config` only asks for `page`. The root element is no longer an
  `<li>`, which is invalid inside the `<p>` that hosts the summary.
- Docs (`README.md`, `USAGE.zh.md`, [AGENTS.md](AGENTS.md)) now name the two
  Plugins-page entry points as the configuration path.

### Fixed

- Two entry points of the Plugins page no longer render two independent copies of
  the form: they share one draft table and one save path.

### Known issues

- The screenshots (`assets/suggest-prompt.png`, `assets/config.png`) still show
  the pre-move Settings → Built-in plugins flow; the `config.png` screenshot in
  particular is out of date for the Plugins page and still needs a refresh.

## [1.1.0] - 2026-10-01

Adapted to `dsh 0.2.0-rc.2`. This is a **breaking** release for anyone running an
older harness: the plugin now requires `dsh >= 0.2.0-rc.2` and will not load on
`0.1.x`.

### Added

- **Host-only `suggestPromptTranscript` projection.** The transcript fed to the
  auxiliary model call is now maintained incrementally as projection state
  instead of being rebuilt by scanning session history. `dsh >= 0.2.0` deprecates
  synchronous reads of arbitrary Session event history (`Session.events`,
  `eventAt`, `snapshotEvents`, `ownEvents`) for new production callers, so the
  plugin reconstructs what it needs from committed events. This also bounds
  memory: the fold retains roughly the last four turns, not the whole
  conversation.
- Regression tests for the fold, for the `contenteditable` composer, and for the
  native-placeholder rule.
- `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, and a Dependabot config.

### Changed

- **Requires `dsh >= 0.2.0-rc.2`** (up from `0.1.1-rc.1`). This release reworks
  several internal contracts the plugin sits on:
  - `@deepseek-ai/dsh-client-runtime` no longer exists. `createSnapshotStore` /
    `SnapshotStore` moved to `@deepseek-ai/dsh-client-store`.
  - The browser module table is now a fixed seed list (`react`,
    `react/jsx-runtime`, `react-dom`, `react-dom/client`, cordis,
    `dsh-client-store`, `dsh-client-ui-slots`, `dsh-client-ui-primitives`,
    `dsh-client-ui-dockkit`). A bundle requiring anything else throws at load.
  - The host settings wiring (`installSettingsSection`, `settingsNamespace`) was
    removed; a plugin's `Config` schema is now the settings page, keyed by its
    profile entry id.
  - The client settings card moved from `settings.plugin.item` +
    `ctx.settingsScope` to `settings.plugins.tab` + `ctx.configForms`.
  - Session projections take `init(header, inheritedEventCount)`, `wire` fields
    are `readonly`, and `stateVersion` must be a non-negative integer.
  - `deepFreeze` moved from `@deepseek-ai/dsh-llm` to
    `@deepseek-ai/dsh-util-values`.
  - The message-source union lost its catch-all `plugin` kind; each producer
    declares its own, so this plugin declares `kind: 'suggest-prompt'`.
- The package invariant validates committed delivery only. Its install-time scan
  of pre-existing sessions used the now-deprecated synchronous history reader.
- Dropped the now-unused `@deepseek-ai/dsh-settings` and
  `@deepseek-ai/dsh-client-ui-settings-plugins` dependencies.
- Requires `@deepseek-ai/schemastery >= 3.18.3` (was `^3.18.1`), the first
  release exposing `volatile()`, which the settings form requires.
- The e2e suites target the rc.2 composer (`contenteditable` + `[data-input-scroll]`)
  and the Built-in plugins settings tab, and additionally assert the two fixes
  below.
- Docs (`README.md`, `USAGE.zh.md`) and [AGENTS.md](AGENTS.md) now name the
  `dsh >= 0.2.0-rc.2` requirement and document the version-critical seams.

### Fixed

- **The settings card never rendered.** The host derives a plugin's settings page
  from its `Config` schema but only surfaces fields marked `volatile()`. With no
  volatile field the entry is omitted from `settings.describe` entirely, so the
  card mounted and then rendered nothing, with no error anywhere. The three
  user-editable preferences are now volatile. A volatile field arrives as a live
  reference (`{ get(), set() }`) rather than a value, so
  `resolveSuggestPromptConfig` unwraps every field at the config boundary.
- **Duplicate ghost text.** The composer's native placeholder is a real element
  (`[data-composer-placeholder]`) in `dsh >= 0.2.0`, not a `textarea::placeholder`
  pseudo-element. The old rule never matched, so the built-in placeholder and the
  suggestion painted on top of each other and neither was readable. The
  placeholder node is now hidden (via `visibility`, so the composer height does
  not shift) only inside a composer that carries a visible suggestion.
- **`Tab` did not accept the suggestion.** The accept handler required
  `document.activeElement instanceof HTMLTextAreaElement`, which is never true
  for the `contenteditable` composer that `dsh >= 0.2.0` renders, so the
  shortcut silently did nothing. Focus detection now accepts both composer
  shapes.

## [1.0.1] - 2026-08-21

### Changed

- Chinese package description.

### Fixed

- Adapt projection registration to the `dsh 0.1.1` contract (the persistable
  state schema became `stateSchema`, and the browser-visible view moved into the
  required `wire` sub-object).

[1.1.0]: https://github.com/studyzy/dsh-suggest-prompt/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/studyzy/dsh-suggest-prompt/compare/v1.0.0...v1.0.1