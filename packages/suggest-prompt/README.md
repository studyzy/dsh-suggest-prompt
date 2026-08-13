# @deepseek-ai/dsh-suggest-prompt

English | [中文](README.zh.md)

Host plugin that, after every completed agent turn, generates **one suggested next prompt** for the user through a bounded auxiliary `ctx.llm` call. The suggestion is appended to the session log as the `suggest-prompt/suggested` event, and the `suggestPrompt` session projection surfaces it to the web composer as ghost text (see `@deepseek-ai/dsh-client-ui-suggest-prompt`).

Generation is host-driven on `turn/end` with reason `completed`, deduplicated per session and turn, and superseded (aborted) when the next completed turn arrives. The plugin carries all of its own deployment policy: routes, byte/token/time bounds, transcript bounds, and the suggestion length cap.

## Configuration

| Field | Meaning |
|---|---|
| `maxInputBytes` | Maximum UTF-8 bytes in the final JSON-framed user prompt |
| `maxOutputTokens` | Auxiliary generation output-token cap |
| `timeoutMs` | End-to-end auxiliary request deadline in milliseconds |
| `maxRecentTurns` | Transcript tail keeps at most this many recent completed turns |
| `maxTranscriptChars` | Transcript tail character budget before JSON framing |
| `maxSuggestionChars` | Visible-character cap for the generated suggestion |
| `provider` / `model` | Optional explicit route pair; omit both to inherit the session's latest logged request header |

Omit both `provider` and `model` to inherit the exact route from the current logged main request, or set both to route suggestion generation independently.

## Security

- Transcripts are redacted before framing: AWS access keys, OpenAI-style `sk-` tokens, GitHub `ghp_`/`gho_`/`ghu_` tokens, Slack `xox-` tokens, JWTs, and Stripe keys are masked.
- Output is sanitized before it reaches the composer: ANSI/OSC/CSI/DCS sequences, C0/C1 control characters, bidirectional overrides, and lone surrogates are stripped; quotes and code fences are trimmed; the text is collapsed to one line and truncated to `maxSuggestionChars`.

## Model Experience

### Suggestion request

#### What the model sees

The suggestion model receives a fixed extraction instruction and a JSON array of the most recent user/assistant exchanges (redacted, bounded by `maxRecentTurns` and `maxTranscriptChars`). The exact framed input is recorded in the `suggest-prompt/request` event before dispatch.

#### Token effect

At most one auxiliary request per completed turn, bounded by `maxInputBytes` and `maxOutputTokens`. The main agent request gains zero tokens.

#### KV Cache effect

No main-request invalidation. The auxiliary request uses the configured or logged route and has provider-specific cache behavior.

## Known Limitations and Deferred Work

- Generation runs after every completed turn regardless of whether the composer already holds text; the ghost is only *displayed* while the draft is empty.
- A superseded (aborted) generation leaves no suggestion for the older turn; only the newest turn's suggestion is published.
- The projection persists the last suggestion, so reopening an old session shows its final suggestion without a new model call.
