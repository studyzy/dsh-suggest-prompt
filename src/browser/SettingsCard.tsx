/**
 * The suggest-prompt configuration card on the WebUI Plugins page: provider and
 * model for the ghost suggestion generation, chosen from the installed provider
 * catalog and staged until save. The chrome replicates the harness's plugin
 * settings cards (PluginCard/ValueFields) so this card reads identically to the
 * built-in ones.
 *
 * The page renders the same component through **three** surfaces:
 *
 * - `plugins.item` with `view: 'summary'` — the one-liner on the official-
 *   plugins card, rendered inside the card head's `<p>`;
 * - `plugins.item` with `view: 'page'` — the form on that card's detail page;
 * - `plugins.bundle.config` with `view: 'page'` — the form on the installed
 *   package's detail page.
 *
 * Only the detail pages are "open": the accordion this card used to be (an
 * `<li>` with a header button, because it lived in a tab panel's list) is gone,
 * and the entry point's summary is a separate, hook-free component.
 * @module @studyzy/dsh-suggest-prompt/settings-card
 */

import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the LocaleNamespaceMap / SlotMap merges this card's props
// depend on (the dictionary it renders, and the ctx.slots service merge).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the 'suggest-prompt.settings' LocaleNamespaceMap merge.
import type {} from './settings-locales.ts'
import type { SuggestPromptCardFace, SuggestPromptCardState, RouteOption, SuggestPromptEditField } from './settings-controller.ts'
import type { SuggestPromptSettingsLocaleKey } from './settings-locales.ts'
import { encodeKey } from './accept-key.ts'

/**
 * The view the Plugins page asks one configuration entry for.
 *
 * The page renders a `plugins.item` entry twice — `summary` is the card's
 * one-liner in the list and in the detail header, `page` is the body of the
 * plugin's own page — and a `plugins.bundle.config` entry once, with `page`.
 * The keyed package page passes no `form`; the official-plugin page passes the
 * Host-owned form, which this card ignores (its own `configForms` face is the
 * same namespace and is what keeps the staged-edit model testable).
 */
export interface PluginConfigViewProps {
  /** `summary` renders the one-liner alone; `page` renders the configuration form. */
  readonly view?: 'summary' | 'page' | undefined
}

/** Props the renderer binds for the suggest-prompt card. */
export type SettingsCardProps =
  PluginConfigViewProps
  // Both seats are root-scoped list/keyed slots with no owner props, so the
  // standard-kit share is empty here. Named via `settings.plugins.tab` — the
  // root-scoped, owner-less entry the settings domain base still publishes —
  // rather than via one of the two seats: `PropsRuntime` is invariant in its
  // key, so a type naming a single seat could not describe both.
  & PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'suggest-prompt.settings'>
  & InjectFace<SuggestPromptCardFace>

/** Style tag id owning this card's copy of the plugin-card chrome. */
const STYLE_TAG_ID = 'dsh-suggest-prompt-settings-style'

/** The plugin-card chrome, mirrored from the harness PluginCard/fields modules. */
const CARD_CSS = `
.dsh-sug-card {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3);
}
.dsh-sug-pending {
  flex: none;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  font-weight: 500;
  white-space: nowrap;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
.dsh-sug-body {
  padding: 0 16px 8px;
}
.dsh-sug-readonly {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-sug-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}
.dsh-sug-field + .dsh-sug-field { border-top: 1px solid var(--dsw-alias-border-l2); }
.dsh-sug-head { display: flex; align-items: center; gap: 8px; }
.dsh-sug-label {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsh-sug-badges { display: inline-flex; align-items: center; gap: 8px; }
.dsh-sug-badge {
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
  font-weight: 500;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
.dsh-sug-reset {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsh-sug-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.dsh-sug-reset:disabled { cursor: default; }
.dsh-sug-input {
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsh-sug-input:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-sug-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.dsh-sug-select { padding-right: 28px; }
.dsh-sug-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-sug-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 0 4px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dsh-sug-failed {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-error);
}
.dsh-sug-discard,
.dsh-sug-save {
  appearance: none;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 5px 14px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
}
.dsh-sug-discard {
  border-color: var(--dsw-alias-border-l2);
  background: none;
  color: var(--dsw-alias-label-secondary);
}
.dsh-sug-discard:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-dimmed);
}
.dsh-sug-save {
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-3);
}
.dsh-sug-discard:disabled,
.dsh-sug-save:disabled { opacity: 0.4; cursor: default; }
.dsh-sug-discard:focus-visible,
.dsh-sug-save:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
`

/** One route field row mirroring the harness ValueField, with a select control. */
function RouteField(props: {
  t: (key: SuggestPromptSettingsLocaleKey) => string
  id: string
  label: string
  hint: string
  state: SuggestPromptCardState
  field: SuggestPromptEditField
  options: RouteOption[]
  selectable: boolean
  onEdit: (text: string) => void
  onReset: () => void
}) {
  const { t, id, label, hint, state, field, options, selectable, onEdit, onReset } = props
  const value = state[field]
  const disabled = !state.writable
  const className = `dsh-sug-input${selectable ? ' dsh-sug-select' : ''}`
  return (
    <div className="dsh-sug-field">
      <div className="dsh-sug-head">
        <label className="dsh-sug-label" htmlFor={id}>{label}</label>
        {value.overridden
          ? (
            <span className="dsh-sug-badges">
              <span className="dsh-sug-badge">{t('overridden')}</span>
              <button type="button" className="dsh-sug-reset" disabled={disabled} onClick={onReset}>
                {t('reset')}
              </button>
            </span>
          )
          : null}
      </div>
      {selectable
        ? (
          <select
            id={id}
            className={className}
            value={value.text}
            disabled={disabled}
            onChange={(event) => { onEdit(event.target.value) }}
          >
            <option value="">{t('followRoute')}</option>
            {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        )
        : (
          <input
            id={id}
            className={className}
            type="text"
            value={value.text}
            disabled={disabled}
            onChange={(event) => { onEdit(event.target.value) }}
          />
        )}
      <p className="dsh-sug-hint">{hint}</p>
    </div>
  )
}

/**
 * A shortcut recorder field: focusing it arms capture, and the next key press
 * (a main key with any held modifiers, e.g. `Alt`+`Slash`) commits the combo
 * as its canonical spec (`Alt+Slash`). Pressing only modifiers keeps the
 * recording live; blurring without a main key cancels back to the stored value.
 */
function KeyRecorderField(props: {
  t: (key: SuggestPromptSettingsLocaleKey) => string
  id: string
  label: string
  hint: string
  state: SuggestPromptCardState
  onEdit: (text: string) => void
  onReset: () => void
}) {
  const { t, id, label, hint, state, onEdit, onReset } = props
  const value = state.acceptKey
  const disabled = !state.writable
  // '' while armed-and-idle defers to the stored value for display.
  const [armed, setArmed] = useState(false)
  const [pending, setPending] = useState('')
  return (
    <div className="dsh-sug-field">
      <div className="dsh-sug-head">
        <label className="dsh-sug-label" htmlFor={id}>{label}</label>
        {value.overridden
          ? (
            <span className="dsh-sug-badges">
              <span className="dsh-sug-badge">{t('overridden')}</span>
              <button type="button" className="dsh-sug-reset" disabled={disabled} onClick={onReset}>
                {t('reset')}
              </button>
            </span>
          )
          : null}
      </div>
      <input
        id={id}
        className="dsh-sug-input"
        type="text"
        value={armed ? pending : value.text}
        readOnly
        placeholder={armed ? t('pressKeys') : undefined}
        disabled={disabled}
        onFocus={() => { setPending(''); setArmed(true) }}
        onBlur={() => { setArmed(false); setPending('') }}
        onKeyDown={(event) => {
          event.preventDefault()
          const spec = encodeKey(event.code, { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey })
          if (spec === undefined) {
            // A pure modifier key: show the held modifiers so far and keep recording.
            setPending(modifierSpec(event.altKey, event.ctrlKey, event.metaKey, event.shiftKey))
            return
          }
          onEdit(spec)
          setArmed(false)
          setPending('')
        }}
      />
      <p className="dsh-sug-hint">{hint}</p>
    </div>
  )
}

/** The canonical modifier-prefix string (`Alt+Ctrl`, empty when none held). */
function modifierSpec(alt: boolean, ctrl: boolean, meta: boolean, shift: boolean): string {
  const parts: string[] = []
  if (alt) parts.push('Alt')
  if (ctrl) parts.push('Ctrl')
  if (meta) parts.push('Meta')
  if (shift) parts.push('Shift')
  return parts.join('+')
}

/**
 * The card's one-line description, as `plugins.item` renders it in its summary
 * view — inside the card head's `<p>`, so this returns inline content only.
 *
 * Deliberately a component of its own, and deliberately hook-free: it answers a
 * render the form never sees, so subscribing to the card's store here would
 * build a subscription just to print one static sentence — and, more
 * importantly, it keeps the branch out of {@link CardBody}, whose two hooks
 * must run on every one of its renders. An early return ahead of them would
 * change the hook count between the summary and page renders of the *same*
 * component, which React reports as "Rendered fewer hooks than expected".
 * @param props - the locale copy bound for this entry's namespace.
 * @returns the description line.
 */
export function SettingsCardSummary(props: { t: (key: SuggestPromptSettingsLocaleKey) => string }) {
  return <>{props.t('description')}</>
}

/**
 * Render the suggest-prompt configuration entry.
 *
 * Branches on the view the Plugins page asked for, then delegates: the two
 * branches are separate components, so each has a constant hook count of its
 * own regardless of how the page renders them, or in what order.
 * @param props - locale copy, the requested view, the card snapshot, and its form actions.
 * @returns the summary line, or the configuration form.
 */
export function SettingsCard(props: SettingsCardProps) {
  const { t } = props
  if (props.view === 'summary') return <SettingsCardSummary t={t} />
  return <CardBody {...props} t={t} />
}

/**
 * The configuration form: the route pair and the accept shortcut, staged until
 * save. This is the body that both the plugin's own page (`plugins.item` with
 * `view: 'page'`) and the installed package's page (`plugins.bundle.config`)
 * render, and both entry points inject the same face, so a draft staged here is
 * the draft the other page shows.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the form, or nothing while the namespace is unavailable.
 */
function CardBody(props: SettingsCardProps & { t: (key: SuggestPromptSettingsLocaleKey) => string }) {
  const { t } = props
  const state = props.useSuggestPromptCard(snapshot => snapshot)
  if (!state.available) return null
  const blocked = !state.dirty || state.invalid || state.saving
  return (
    <>
      <style id={STYLE_TAG_ID}>{CARD_CSS}</style>
      <div className="dsh-sug-card">
        <div className="dsh-sug-body">
          {!state.writable ? <p className="dsh-sug-readonly">{t('readOnly')}</p> : null}
          <RouteField
            t={t}
            id="suggest-prompt-settings-provider"
            label={t('provider')}
            hint={t('providerHint')}
            state={state}
            field="provider"
            options={state.providerOptions}
            selectable={state.providerOptions.length > 0}
            onEdit={(text) => {
              if (text === '') props.resetField('provider')
              else props.edit('provider', text)
            }}
            onReset={() => { props.resetField('provider') }}
          />
          <RouteField
            t={t}
            id="suggest-prompt-settings-model"
            label={t('model')}
            hint={t('modelHint')}
            state={state}
            field="model"
            options={state.modelOptions}
            selectable={state.modelSelectable}
            onEdit={(text) => {
              if (text === '') props.resetField('model')
              else props.edit('model', text)
            }}
            onReset={() => { props.resetField('model') }}
          />
          <KeyRecorderField
            t={t}
            id="suggest-prompt-settings-accept-key"
            label={t('acceptKey')}
            hint={t('acceptKeyHint')}
            state={state}
            onEdit={(text) => { props.edit('acceptKey', text) }}
            onReset={() => { props.resetField('acceptKey') }}
          />
          <div className="dsh-sug-footer">
            {state.dirty ? <span className="dsh-sug-pending">{t('unsaved')}</span> : null}
            {state.failed ? <p className="dsh-sug-failed">{t('saveFailed')}</p> : null}
            <button
              type="button"
              className="dsh-sug-discard"
              disabled={!state.dirty || state.saving}
              onClick={props.discard}
            >
              {t('discard')}
            </button>
            <button
              type="button"
              className="dsh-sug-save"
              disabled={blocked}
              onClick={props.save}
            >
              {t(state.saving ? 'saving' : 'save')}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
