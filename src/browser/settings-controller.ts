/**
 * The suggest-prompt settings card's staged form over the `suggest-prompt`
 * profile entry. Edits are staged until save; a save writes the staged route
 * pair back through the entry's config form (the host plugin re-resolves its
 * config from the entry, so the next completed turn uses the new model).
 *
 * The card's dropdowns read sibling entries (`llm-pi-ai`, `llm-deepseek`) from
 * the same config-form seam read-only: provider names are the `llm-pi-ai`
 * `providers` keys and the model list is the selected provider's `models[].id`.
 * A provider without an explicit model list falls back to a free-text model
 * field.
 * @module @studyzy/dsh-suggest-prompt/settings-controller
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

/**
 * Settings namespace of the suggest-prompt host plugin. In `dsh >= 0.2.0` a
 * plugin's settings namespace IS its profile entry id, so this is the id the
 * bundle patch mounts the host plugin under. Spelled here rather than imported:
 * a client package must not depend on a Host package, and the host plugin that
 * owns it spells the same value.
 */
export const SUGGEST_PROMPT_NS = 'suggest-prompt'

/** The suggest-prompt section's editable fields (route pair plus the accept shortcut). */
export type SuggestPromptEditField = 'provider' | 'model' | 'acceptKey'

/** Route fields the card edits — the suggest-prompt section's optional pair. */
export interface SuggestPromptSettings {
  /** Provider the auxiliary call routes through; absent follows the session route. */
  provider?: string
  /** Full catalog model id; absent follows the session route. */
  model?: string
  /** Composer shortcut that accepts a suggestion into the draft (default Tab). */
  acceptKey?: string
}

/** The `llm-pi-ai` section, narrowed to the route dropdown catalog. */
export interface PiAiProviderCatalog {
  providers?: Record<string, {
    /** Explicit model profiles; absent relies on the installed catalog defaults. */
    models?: Array<{ id: string }>
  }>
}

/** The built-in DeepSeek adapter's provider route (spelled here, not imported). */
const DEEPSEEK_PROVIDER = 'deepseek-official'

/** The `llm-deepseek` section, narrowed to its advisory model list. */
export interface DeepSeekCatalog {
  models?: Array<{ id: string }>
}

/** One dropdown option: the route value written to settings, and its label. */
export interface RouteOption {
  /** Provider route (or model id) persisted when selected. */
  value: string
  /** Human-readable option label. */
  label: string
}

/** One route field as the card's control renders it. */
export interface RouteFieldState {
  /** Draft text the control renders. */
  text: string
  /** Whether saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** Whether the draft is not a value this field accepts (blocks saving). */
  invalid: boolean
}

/** What the card renders. */
export interface SuggestPromptCardState {
  /** False while the namespace is not served to this client; the card renders nothing. */
  available: boolean
  /** Whether the host document accepts writes. */
  writable: boolean
  /** Whether the form holds edits that a save would write. */
  dirty: boolean
  /** Whether any staged draft is invalid, which blocks the save. */
  invalid: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged. */
  failed: boolean
  /** The provider field. */
  provider: RouteFieldState
  /** The model field. */
  model: RouteFieldState
  /** The accept-key shortcut field. */
  acceptKey: RouteFieldState
  /** Provider names from the pi-ai catalog plus the built-in DeepSeek route. */
  providerOptions: RouteOption[]
  /** Model ids of the effective provider, plus the current value when absent. */
  modelOptions: RouteOption[]
  /** Whether the effective provider lists explicit models (else a text field). */
  modelSelectable: boolean
}

/** The write actions the card's slot entry injects. */
export interface SuggestPromptCardActions {
  /** Stage draft text for one field. */
  edit(field: SuggestPromptEditField, text: string): void
  /** Stage a clear, so saving lets the field re-inherit the composition layer. */
  resetField(field: SuggestPromptEditField): void
  /** Write every staged edit, then re-seed from what the host accepted. */
  save(): void
  /** Drop every staged edit. */
  discard(): void
}

/** The registration-side face the card's slot entry injects. */
export interface SuggestPromptCardFace extends SuggestPromptCardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useSuggestPromptCard. */
    suggestPromptCard: SnapshotStore<SuggestPromptCardState>
  }
}

/** One staged edit. */
interface StagedEdit {
  text: string
  clear: boolean
}

/** Bridges the entry config forms onto the card's staged form. */
export class SuggestPromptCardController {
  private readonly staged = new Map<SuggestPromptEditField, StagedEdit>()
  private readonly store: SnapshotStore<SuggestPromptCardState>
  private readonly unsubscribers: Array<() => void>
  private saving = false
  private failed = false

  /**
   * @param form - the config form of the `suggest-prompt` entry.
   * @param catalogForm - the read-only form for the `llm-pi-ai` provider catalog.
   * @param deepSeekForm - the read-only form for the built-in DeepSeek adapter.
   */
  constructor(
    private readonly form: ConfigForm<SuggestPromptSettings>,
    private readonly catalogForm: ConfigForm<PiAiProviderCatalog>,
    private readonly deepSeekForm: ConfigForm<DeepSeekCatalog>,
  ) {
    this.store = createSnapshotStore(this.projection())
    // Keep the disposers: a config form outlives the card's fiber (it is owned
    // by ui-settings), so dropping them would leave the controller's publish
    // wired into every form after this plugin unloads.
    this.unsubscribers = [
      form.subscribe(() => { this.publish() }),
      catalogForm.subscribe(() => { this.publish() }),
      deepSeekForm.subscribe(() => { this.publish() }),
    ]
  }

  /**
   * Stop observing the bound forms. Call once when the owning fiber unloads.
   */
  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    this.unsubscribers.length = 0
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): SuggestPromptCardFace {
    return { hooks: { suggestPromptCard: this.store }, ...this.actions() }
  }

  /** The form actions bound to this controller. */
  actions(): SuggestPromptCardActions {
    return {
      edit: (field, text) => { this.stage(field, { text, clear: false }) },
      resetField: (field) => { this.stage(field, { text: this.baseValue(field), clear: true }) },
      save: () => { void this.save() },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.failed = false
        this.publish()
      },
    }
  }

  /** Publish the card state projection. */
  private projection(): SuggestPromptCardState {
    const snapshot = this.form.getSnapshot()
    const section = (snapshot.value ?? {}) as Partial<SuggestPromptSettings>
    const providerOptions = this.catalogProviderOptions()
    const effectiveProvider = this.effectiveProvider(section)
    const catalogModels = this.catalogModels(effectiveProvider)
    const model = this.field('model', section.model)
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.staged.size > 0,
      invalid: false,
      saving: this.saving,
      failed: this.failed,
      provider: this.field('provider', section.provider),
      model,
      acceptKey: this.field('acceptKey', section.acceptKey),
      providerOptions,
      // Keep the current value selectable even when the catalog dropped it.
      modelOptions: catalogModels.length > 0 && model.text !== '' && !catalogModels.some(o => o.value === model.text)
        ? [{ value: model.text, label: model.text }, ...catalogModels]
        : catalogModels,
      modelSelectable: catalogModels.length > 0,
    }
  }

  /** One control's draft state: staged text, override presence, and validity. */
  private field(field: SuggestPromptEditField, value: unknown): RouteFieldState {
    const staged = this.staged.get(field)
    if (staged === undefined) {
      return {
        text: typeof value === 'string' ? value : '',
        overridden: this.stored(field),
        invalid: false,
      }
    }
    return {
      text: staged.clear ? '' : staged.text,
      overridden: !staged.clear,
      invalid: false,
    }
  }

  /** The provider whose model list the card offers: the staged pick, else the entry value. */
  private effectiveProvider(section: Partial<SuggestPromptSettings>): string {
    const staged = this.staged.get('provider')
    if (staged !== undefined) return staged.clear ? '' : staged.text.trim()
    return typeof section.provider === 'string' ? section.provider : ''
  }

  /** Provider options: the pi-ai catalog routes plus the built-in DeepSeek route. */
  private catalogProviderOptions(): RouteOption[] {
    const options: RouteOption[] = []
    if (this.deepSeekForm.getSnapshot().status === 'ready') {
      options.push({ value: DEEPSEEK_PROVIDER, label: 'DeepSeek' })
    }
    // Only read the catalog once its namespace is ready: a form that is still
    // loading or unavailable carries no providers, and treating that as "no
    // providers installed" would make the dropdown (and the card's model
    // selectability) lie about what the deployment offers.
    const catalog = this.catalogForm.getSnapshot()
    if (catalog.status === 'ready' && catalog.value?.providers !== undefined) {
      for (const route of Object.keys(catalog.value.providers).sort()) {
        options.push({ value: route, label: route })
      }
    }
    return options
  }

  /** Explicit model options one provider lists; empty means the catalog defaults apply. */
  private catalogModels(provider: string): RouteOption[] {
    if (provider === '') return []
    const models = provider === DEEPSEEK_PROVIDER
      ? this.deepSeekForm.getSnapshot().value?.models
      : this.catalogForm.getSnapshot().status === 'ready'
        ? this.catalogForm.getSnapshot().value?.providers?.[provider]?.models
        : undefined
    return models === undefined ? [] : models.map(model => ({ value: model.id, label: model.id }))
  }

  /** The composition-layer value one field reverts to once cleared. */
  private baseValue(field: SuggestPromptEditField): string {
    const base = this.form.getSnapshot().base as Partial<SuggestPromptSettings> | undefined
    const value = base?.[field]
    return typeof value === 'string' ? value : ''
  }

  /** Whether the user document layer carries this field (marks it overridden). */
  private stored(field: SuggestPromptEditField): boolean {
    const user = this.form.getSnapshot().user as Record<string, unknown> | undefined
    return user !== undefined && Object.hasOwn(user, field)
  }

  private stage(field: SuggestPromptEditField, edit: StagedEdit): void {
    this.staged.set(field, edit)
    this.failed = false
    // Switching provider changes which model that provider has: a staged model
    // picked from the previous provider's catalog (or one it no longer lists)
    // would otherwise ride along to a route that does not know it and fail the
    // next generation as UNKNOWN_MODEL. Unstage it so the user re-chooses a
    // model for the new provider.
    if (field === 'provider') {
      const provider = edit.clear ? '' : edit.text.trim()
      const section = (this.form.getSnapshot().value ?? {}) as Partial<SuggestPromptSettings>
      // The effective model: the staged one, else the committed one.
      const stagedModel = this.staged.get('model')
      const model = stagedModel === undefined ? this.stringValue(section.model) : stagedModel.clear ? '' : stagedModel.text.trim()
      if (!this.modelServes(model, provider)) {
        // The previously chosen model does not exist on the new provider, so it
        // will fail the next generation as UNKNOWN_MODEL. Drop the staged model
        // rather than carry it into a route that has no such id. When nothing is
        // composed as the reset base, forget the stage entirely so the form does
        // not report a spurious unsaved-edit while having nothing to write.
        const base = this.baseValue('model')
        if (base !== '') this.staged.set('model', { text: base, clear: true })
        else this.staged.delete('model')
      }
    }
    this.publish()
  }

  /** Whether one model id the effective provider route would resolve to. */
  private modelServes(model: string, provider: string): boolean {
    // A blank model, or a provider without an explicit catalog (free-text
    // model), accepts any draft: there is nothing to contradict.
    if (model === '' || provider === '') return true
    const models = this.catalogModels(provider)
    return models.length === 0 || models.some(option => option.value === model)
  }

  /** Read one scalar as a string from a settings section, else ''. */
  private stringValue(value: unknown): string {
    return typeof value === 'string' ? value : ''
  }

  /**
   * Write every staged edit, then re-seed from what the host accepted.
   *
   * The write contract ({@link ConfigForm.set}/{@link ConfigForm.unset})
   * resolves even when the document rejected the value — it folds/reloads
   * instead of throwing — so the edit is verified by reading the section back
   * after each write, not by relying on the promise to reject. A transport
   * failure does reject, which is the `catch` below.
   */
  private async save(): Promise<void> {
    const writes = [...this.staged].flatMap(([field, edit]): Array<{
      field: SuggestPromptEditField
      run: () => Promise<boolean>
    }> => {
      if (edit.clear) {
        return this.stored(field) ? [{ field, run: () => this.form.unset(field) }] : []
      }
      const value = edit.text.trim()
      return value === '' ? [] : [{ field, run: () => this.form.set(field, value) }]
    })
    // An edit that resolves to no write (an empty draft, or a clear of a field
    // the user layer never carried) must not keep the form dirty forever: it
    // already produced its effect by staging nothing to write.
    for (const field of this.staged.keys()) {
      if (!writes.some(write => write.field === field)) this.staged.delete(field)
    }
    if (writes.length === 0 || this.saving) {
      if (writes.length === 0) this.publish()
      return
    }
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    for (const write of writes) {
      try {
        // The form resolves `false` for a refusal (and reloads Host state), so
        // the result — not just the absence of a throw — decides the outcome.
        if (!await write.run()) landed = false
      } catch {
        landed = false
      }
    }
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}

/** The snapshot type one bound config form carries (re-exported for tests). */
export type SuggestPromptFormSnapshot = ConfigFormSnapshot<SuggestPromptSettings>
