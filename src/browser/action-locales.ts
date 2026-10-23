/** Touch and keyboard-accessible composer actions. */
export const ACTIONS_NS = 'suggest-prompt.actions'
export type SuggestionActionKey = 'accept' | 'acceptHint' | 'generate' | 'generateHint' | 'generating' | 'empty' | 'busy' | 'noContext' | 'error'
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'suggest-prompt.actions': SuggestionActionKey
  }
}
export const actionEn: Record<SuggestionActionKey, string> = {
  accept: 'Accept',
  acceptHint: 'Fill the draft with this suggestion without sending',
  generate: 'Suggest',
  generateHint: 'Generate a suggestion from the latest completed turn (uses the configured model)',
  generating: 'Generating…',
  empty: 'No usable suggestion this time. You can try again.',
  busy: 'A suggestion or agent turn is already running. Please wait.',
  noContext: 'Complete a conversation turn first, then generate a suggestion.',
  error: 'Could not generate a suggestion. Check the connection and model settings, then retry.',
}
export const actionZh: Record<SuggestionActionKey, string> = {
  accept: '采纳',
  acceptHint: '将建议填入草稿，不自动发送',
  generate: '生成建议',
  generateHint: '根据最近一轮已完成对话生成建议（调用已配置的模型）',
  generating: '生成中…',
  empty: '这次没有生成可用建议，可以重试。',
  busy: '正在生成建议或执行对话，请稍候。',
  noContext: '请先完成一轮对话，再生成提示词建议。',
  error: '生成失败，请检查连接和模型设置后重试。',
}
