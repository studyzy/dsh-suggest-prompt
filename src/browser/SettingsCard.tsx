/**
 * The suggest-prompt route card inside the WebUI plugin settings section:
 * provider/model for the ghost suggestion generation, chosen from the installed
 * provider catalog and staged until save. The chrome replicates the harness's
 * plugin settings cards (PluginCard/ValueField) so this card reads identically
 * to the built-in ones.
 * @module @studyzy/dsh-client-ui-suggest-prompt/settings-card
 */

import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the 'settings.plugin.item' SlotMap merge (the keyed card slot).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// Type-only: pulls the 'suggest-prompt.settings' LocaleNamespaceMap merge.
import type {} from './settings-locales.ts'
import type { SuggestPromptCardFace, SuggestPromptCardState, RouteOption, SuggestPromptEditField } from './settings-controller.ts'
import type { SuggestPromptSettingsLocaleKey } from './settings-locales.ts'
import { encodeKey } from './accept-key.ts'

/** Props the renderer binds for the suggest-prompt card. */
export type SettingsCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'suggest-prompt.settings'>
  & InjectFace<SuggestPromptCardFace>

/** Style tag id owning this card's copy of the plugin-card chrome. */
const STYLE_TAG_ID = 'dsh-suggest-prompt-settings-style'

/** The plugin-card chrome, mirrored from the harness PluginCard/fields modules. */
const CARD_CSS = `
.dsh-sug-card {
  list-style: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3);
  transition: border-color .16s, background .16s;
}
.dsh-sug-card:hover { border-color: var(--dsw-alias-label-dimmed); }
.dsh-sug-card-open {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-label-dimmed);
}
.dsh-sug-header {
  width: 100%;
  appearance: none;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 12px;
}
.dsh-sug-header:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.dsh-sug-head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dsh-sug-name {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--dsw-alias-label-primary);
}
.dsh-sug-description {
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-sug-chevron {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  transition: transform .16s;
}
.dsh-sug-chevron-open { transform: rotate(180deg); }
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
  border-top: 1px solid var(--dsw-alias-border-l2);
  margin: 0 16px;
  padding-bottom: 8px;
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
 * Render the suggest-prompt route card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card, or nothing while the namespace is unavailable.
 */
export function SettingsCard(props: SettingsCardProps) {
  const { t } = props
  const state = props.useSuggestPromptCard(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  if (!state.available) return null
  const title = t('title')
  const blocked = !state.dirty || state.invalid || state.saving
  return (
    <>
      <style id={STYLE_TAG_ID}>{CARD_CSS}</style>
      <li className={open ? 'dsh-sug-card dsh-sug-card-open' : 'dsh-sug-card'}>
        <button
          type="button"
          className="dsh-sug-header"
          aria-expanded={open}
          aria-label={`${t(open ? 'collapse' : 'expand')}: ${title}`}
          onClick={() => { setOpen(!open) }}
        >
          <span className="dsh-sug-head-text">
            <span className="dsh-sug-name">{title}</span>
            <span className="dsh-sug-description">{t('description')}</span>
          </span>
          {state.dirty ? <span className="dsh-sug-pending">{t('unsaved')}</span> : null}
          <IconChevronDownOutline14
            className={open ? 'dsh-sug-chevron dsh-sug-chevron-open' : 'dsh-sug-chevron'}
          />
        </button>
        {open
          ? (
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
          )
          : null}
      </li>
    </>
  )
}
