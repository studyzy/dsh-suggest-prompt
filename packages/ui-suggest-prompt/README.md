# @deepseek-ai/dsh-client-ui-suggest-prompt

English | [中文](README.zh.md)

Browser half of the suggest-prompt surface: a `conversation.input.dock` bridge entry that reads the `suggestPrompt` session projection and pushes the current suggestion into the composer's ghost decoration via `inputActions.setGhost`. The composer renders the ghost as the textarea placeholder while the draft is empty.

Accept the suggestion by pressing **Alt-/** while the composer textarea holds focus; the text is placed into the draft (editable) rather than sent.

## Behavior

- Shows the ghost only when the suggestion answers the session's latest completed turn, the agent is idle, and the draft is empty.
- Typing clears the ghost; deleting back to an empty draft re-arms it from the persisted projection without a new model call.
- The entry renders nothing; all effects ride the input machine's ghost state.

## Model Experience

None, as this plugin consumes the host-computed `suggestPrompt` projection and renders it as composer ghost text; nothing here reaches a model request.

#### KV Cache effect

None; the package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The Alt-/ shortcut only fires while focus sits in a textarea; some keyboard layouts may route Alt-/ elsewhere.
