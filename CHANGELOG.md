# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because this plugin is built against a specific `dsh` release and the harness
changes internal contracts between releases, each entry names the harness
version it targets.

## [Unreleased]

Targets `dsh 0.2.0-rc.2` (unchanged): the move below only changes which slots the
client card registers into, not the harness contract.

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