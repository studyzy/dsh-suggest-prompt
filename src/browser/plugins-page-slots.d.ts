/**
 * SlotMap merge for the two **Plugins page** seats this plugin registers into.
 *
 * `plugins.item` and `plugins.bundle.config` are declared at runtime by the
 * plugin-manager client bundle (its `main` registration's `children` table), not
 * by any published type package: the page is `dsh-client-ui-plugin-manager`'s,
 * and this plugin deliberately does not depend on it — a headless consumer of
 * this package must not be forced to install the browser UI stack, and the
 * client bundle may only `require` the shell's platform singletons anyway.
 *
 * Without this merge `ctx.slots.inject('plugins.item', …)` is a type error
 * ("not assignable to keyof SlotMap"), because `SlotMap` is only as wide as the
 * type-only packages this package happens to import. The declarations below
 * transcribe the page's own `children` table (verified against the shipped
 * `dsh-client-ui-plugin-manager/lib/client.js`), which is the same technique
 * the sibling bundle plugin `dsh-lazy-tools` uses for its slot surface.
 *
 * The merge is key-typed only: it proves the slot names, their kinds, and their
 * scopes, so a list/keyed mix-up (writing `id` where the page reads `key`)
 * fails at `register` rather than silently in the browser.
 */

export {}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The Plugins page's official-plugins card list. The page renders this
     * entry's component twice — `view: 'summary'` as the card's one-liner,
     * `view: 'page'` as the body of the plugin's own detail page.
     *
     * Scoped `root`: the list exists once per app, outside any session.
     */
    'plugins.item': {
      kind: 'list'
      scope: 'root'
    }
    /**
     * One bundle's configuration section on its **package** detail page.
     *
     * Keyed, and addressed by the bundle's *package* name: the page computes
     * `configured = ledger.bundles.has(pkg.name)` from the entries'
     * `options.key`, so a `key` of anything but the npm package name (or an
     * `id`, which a keyed slot does not read at all) registers without erroring
     * and then never matches — the section silently never renders.
     *
     * Scoped `root` for the same reason as {@link SlotMap['plugins.item']}.
     */
    'plugins.bundle.config': {
      kind: 'keyed'
      scope: 'root'
    }
  }
}