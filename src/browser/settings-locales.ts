/**
 * Locale copy for the suggest-prompt settings card.
 * @module @studyzy/dsh-client-ui-suggest-prompt/settings-locales
 */

/** Locale keys the settings card renders. */
export type SuggestPromptSettingsLocaleKey =
  | 'title'
  | 'description'
  | 'provider'
  | 'providerHint'
  | 'model'
  | 'modelHint'
  | 'acceptKey'
  | 'acceptKeyHint'
  | 'pressKeys'
  | 'followRoute'
  | 'overridden'
  | 'reset'
  | 'readOnly'
  | 'expand'
  | 'collapse'
  | 'save'
  | 'saving'
  | 'discard'
  | 'unsaved'
  | 'saveFailed'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'suggest-prompt.settings': SuggestPromptSettingsLocaleKey
  }
}

/** English copy for the card. */
export const en: Record<SuggestPromptSettingsLocaleKey, string> = {
  title: 'Suggested next prompt',
  description: 'Model that generates the ghost suggestion after each turn',
  provider: 'Provider',
  providerHint: 'Registered pi-ai provider; choose "follow session route" to use the session model.',
  model: 'Model',
  modelHint: 'A model of the selected provider; choose "follow session route" to use the session model.',
  acceptKey: 'Accept shortcut',
  acceptKeyHint: 'Press the key (or key combo) you want; focus the field first.',
  pressKeys: 'Press keys…',
  followRoute: 'Follow session route',
  overridden: 'overridden',
  reset: 'Reset',
  readOnly: 'Settings are read-only in this deployment.',
  expand: 'Expand',
  collapse: 'Collapse',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'Save failed; the host rejected the values.',
}

/** Simplified Chinese copy for the card. */
export const zh: Record<SuggestPromptSettingsLocaleKey, string> = {
  title: '建议提示词',
  description: '每轮结束后生成幽灵建议所使用的模型',
  provider: 'Provider',
  providerHint: '已注册的 pi-ai provider；选择"跟随会话路由"则使用会话模型。',
  model: 'Model',
  modelHint: '所选 provider 的模型；选择"跟随会话路由"则使用会话模型。',
  acceptKey: '接受快捷键',
  acceptKeyHint: '先点击该输入框获得焦点，然后按下你想用的按键（或组合键）。',
  pressKeys: '请按键…',
  followRoute: '跟随会话路由',
  overridden: '已覆盖',
  reset: '重置',
  readOnly: '当前部署下设置为只读。',
  expand: '展开',
  collapse: '收起',
  save: '保存',
  saving: '保存中…',
  discard: '放弃',
  unsaved: '未保存',
  saveFailed: '保存失败：宿主拒绝了该值。',
}
