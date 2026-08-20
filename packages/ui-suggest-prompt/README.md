# @studyzy/dsh-client-ui-suggest-prompt

English | [中文](README.zh.md)

Browser half of the suggest-prompt surface: a `conversation.input.overlay` bridge entry that reads the `suggestPrompt` session projection and renders the current suggestion as light placeholder text INSIDE the composer textarea (the classic ghost-text UX, like Claude Code). It is `pointer-events: none`, so it never blocks typing or the caret. Pressing the configured shortcut (default **Tab**) while the composer textarea holds focus places the suggestion into the draft via `inputActions.setDraft`; the draft stays editable rather than being sent.

Accept the suggestion by pressing the configured shortcut (default **Tab**, like Claude Code) while the composer textarea holds focus — the ghost text becomes the user's real input. The shortcut comes from the host plugin's `acceptKey` config on each suggestion — for example `Tab`, `Alt+Slash`, or `Ctrl+Enter`.

## Behavior

- Shows the ghost text only when the suggestion answers the session's latest completed turn, the agent is idle, and the draft is empty.
- The accept shortcut fires only while focus sits in a textarea; an IME composition keydown never triggers it, and Tab is intercepted only when ghost text is displayed (otherwise it keeps its default focus behavior).
- Typing hides the ghost text; deleting back to an empty draft re-shows it from the persisted projection without a new model call.
- Pressing the accept shortcut fills the draft with the ghost text; nothing is sent automatically.

## Model Experience

None, as this plugin consumes the host-computed `suggestPrompt` projection and renders it as composer ghost text; nothing here reaches a model request.

#### KV Cache effect

None; the package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The accept shortcut only fires while focus sits in a textarea; some keyboard layouts may route a configured key elsewhere.
- The shortcut is not configurable from the browser side alone — it is set through the host plugin's `acceptKey` config and travels on each suggestion event.
