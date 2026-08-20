# dsh-suggest-prompt

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 开发的「建议提示词」插件：每个 agent 回合完成后，通过一次有界的辅助 LLM 调用，在会话日志中写入**一条建议的下一条提示词**；Web 端把它渲染成输入框内部的浅色幽灵占位文字，按 **Tab**（默认）即可采纳进草稿（与 Claude Code 一致）。

> 想快速上手？直接看 **[使用说明](USAGE.zh.md)**（面向终端用户的操作指南）。

本仓库是这两个包的**权威源码**（source of record），由两个包构成：

| 包 | 作用 |
|---|---|
| [`@studyzy/dsh-suggest-prompt`](packages/suggest-prompt) | 宿主插件：在 `turn/end`（reason=`completed`）时生成建议，发布 `suggestPrompt` 会话投影。 |
| [`@studyzy/dsh-client-ui-suggest-prompt`](packages/ui-suggest-prompt) | 浏览器插件：读取投影，把建议渲染为输入框内部的浅色幽灵占位文字（`inputActions.setDraft`），按配置的快捷键填入草稿。 |

## 特性

- **默认轻量**：不配置 `provider` / `model` 时继承主请求最近一次记录的路由，无需为建议单独选模型；需要时也可显式指定任意路由（例如本地 OpenAI 兼容网关）。
- **免思考、快速便宜**：建议生成默认携带 `reasoningEffort: off`（DeepSeek 序列化为 `thinking: disabled`），不消耗推理预算；模型不支持该参数时自动去掉并重试一次。
- **WebUI 设置卡片**：安装后在「设置 → 插件」中出现「建议提示词」卡片，可直接从已安装的 provider 目录选择建议生成使用的 provider / model（或跟随会话路由），保存后下一完成回合生效；也可手写 `~/.dsh/settings.yaml`。
- **只发最后一轮**：默认只把最后一轮的用户输入与 AI 最终回答发给建议模型（`maxRecentTurns` 默认为 `1`），中间的工具调用 / 推理过程一律不发送。
- **有界调用**：字节 / 令牌 / 超时上限、转录长度预算、建议可见字符上限，全部可配置。
- **安全**：转录在发送前脱敏（密钥形状被掩蔽）；输出净化（控制序列、围栏、引号剥离、单行化）并做语义过滤（元文本、评价套话、助手口吻等被当作「无建议」丢弃）。
- **无建议是常态**：模型回复为空或不合格时静默跳过，不报错、不写事件、不打扰。
- **免调用重显**：删回空草稿会重新显示已持久化的建议，不再发新的模型请求。
- **快捷键可配**：采纳快捷键通过 `acceptKey` 配置，默认 `Tab`。

## 安装

### 前置条件

- Node.js `^22.19` 或 `>=24`、pnpm。
- 一个基于 deepseek-harness 的 dsh 部署（web profile）。浏览器端需要 `conversation.input.overlay` 槽位与 `inputActions.setDraft`（deepseek-harness 的标准 web 输入机均已提供）。

### 通过 npm 安装（发布后）

> 注意：`@studyzy/dsh-suggest-prompt` 与 `@studyzy/dsh-client-ui-suggest-prompt` 的完整依赖链尚未全部发布到 npm（上游 `@deepseek-ai/dsh-compact`、`@deepseek-ai/dsh-environment` 等仍缺失）。等 registry 补齐后：

```sh
npm install @studyzy/dsh-suggest-prompt @studyzy/dsh-client-ui-suggest-prompt
```

然后在 profile 的 cordis.yml / 补丁层挂上两行（见下「配置」示例）。

### 从本仓库源码接入（当前方式）

把这两个包放进 harness 工作区（或通过 `file:` 依赖引用本仓库），并在 profile 补丁层插入两行。例如 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: suggest-prompt
  name: '@studyzy/dsh-suggest-prompt'
  config:
    maxInputBytes: 4096
    maxOutputTokens: 512
    timeoutMs: 60000
    maxRecentTurns: 1
    maxTranscriptChars: 12000
    maxSuggestionChars: 240
    provider: ccr
    model: ttswitch/deepseek-v4-flash-ioa
    acceptKey: Tab

- id: ui-suggest-prompt
  name: '@studyzy/dsh-client-ui-suggest-prompt'
```

`provider` / `model` 可分别设置：设置的一方覆盖主请求路由的对应字段，省略的一方自动继承主请求最近一次记录的路由；两者都省略则完全跟随主请求路由。

## 配置

| 字段 | 含义 | 默认 |
|---|---|---|
| `maxInputBytes` | 最终框架化用户提示的最大 UTF-8 字节数 | 必填 |
| `maxOutputTokens` | 建议生成输出令牌上限 | 必填 |
| `timeoutMs` | 辅助请求端到端截止时间（毫秒） | 必填 |
| `maxRecentTurns` | 转录尾部保留的最近完成回合数 | `1`（只取最后一轮的用户输入 + AI 最终回答） |
| `maxTranscriptChars` | 转录字符预算 | 必填 |
| `maxSuggestionChars` | 建议的可见字符上限 | 必填 |
| `provider` / `model` | 各自独立覆盖主请求路由的对应字段；省略的字段自动继承主请求路由。可在 WebUI「建议提示词」设置卡片中编辑，或写入 `~/.dsh/settings.yaml` | 继承 |
| `acceptKey` | 采纳建议的输入框快捷键 | `Tab`（可写 `Alt+Slash`、`Ctrl+Enter` 等） |

> **`maxOutputTokens` 提示**：建议生成默认关闭思考（`reasoningEffort: off`），推理不消耗输出预算；但对无法关闭思考的模型（如部分 pi-ai 路由）会降级重试，此时思考仍会消耗预算——`maxOutputTokens` 偏小时，流会在输出建议文本之前就以 `max-tokens` 结束。这类模型请留足预算（例如 `512`）。

### 在 WebUI 设置中配置建议模型

挂载 `ui-suggest-prompt` 后，「设置 → 插件」会出现「建议提示词」卡片：

- **Provider / Model**：从已安装的 provider 目录（内置 `DeepSeek` 与 pi-ai 各 provider）中选择建议生成使用的路由；选择「跟随会话路由」则不覆盖，继承主请求路由。
- 编辑是暂存式的（带「未保存」标记与「放弃 / 保存」按钮），保存会写入 `~/.dsh/settings.yaml` 的 `suggest-prompt` 小节；**保存后下一个完成回合生效**，无需重启。
- 下拉只会列出目录中显式声明的模型；某 provider 未声明模型列表时，模型字段退化为自由文本输入。
- 依赖 `dsh-settings` 的设置能力：没有挂载设置服务的组装（如 headless）不显示此卡片，仍可用 `cordis.yml` / 补丁层配置。

## 工作方式

- 宿主在 `turn/end`（reason=`completed`）时触发生成；按会话 + 回合去重，下一个完成回合会中止上一个在途生成。
- 建议写入会话日志的 `suggest-prompt/suggested` 事件，`suggestPrompt` 投影把它暴露给 Web 端。
- 幽灵文字只在满足以下条件时显示：建议对应**最新**完成回合、agent 空闲、草稿为空；键入即隐藏，删回空草稿重新显示。
- 按 `acceptKey`（默认 Tab）把建议填入草稿（可编辑后再发送）；焦点不在输入框或处于 IME 组合输入时不触发，Tab 也只在显示幽灵文字时才被拦截（否则保持默认焦点行为）。

## 模型体验

- **系统提示词**：把模型限定为「以用户口吻预测下一条提示词」，禁止生成内容或元文本，给出具体正反例；回复语言跟随会话（最后一条用户消息含 CJK → `简体中文`，否则 `English`）。
- **模型看到的输入**：默认只有最后一轮的 `[User Message]` / `[Assistant Response]` 带标签块（已脱敏、受 `maxTranscriptChars` 约束）。
- **请求前记录**：确切的框架化输入与系统提示在派发前写入 `suggest-prompt/request` 事件，满足「模型可见 ⟺ 日志可重建」。
- **免思考**：辅助请求默认携带 `reasoningEffort: off`（DeepSeek 序列化为 `thinking: disabled`），追求快速与低成本；模型不支持时自动去掉该字段重试一次（拒绝发生在任何网络 I/O 之前，几乎无额外开销）。
- **成本**：每个完成回合至多一次辅助请求，受 `maxInputBytes` / `maxOutputTokens` 约束；主 agent 请求不增加任何 token。

## 安全

- **转录脱敏**：AWS `AKIA…`、OpenAI `sk-…`、GitHub `ghp_`/`gho_`/`ghu_`、Slack `xox-…`、JWT、Stripe `rk_…` 等密钥形状在发送前被掩蔽为占位标签。
- **输出净化**：ANSI/OSC/CSI/DCS 序列、C0/C1 控制符、双向覆盖符、孤立代理项被剥离；引号与代码围栏被去除；压缩为单行并截断到 `maxSuggestionChars`。
- **语义过滤**：元文本（"no suggestion"、"stay silent"）、错误回显、评价套话（"thanks"、"looks good"、谢谢、不错）、助手口吻（"Let me…"、"I'll…"、我来、我帮你）、多句 / 过长回复、孤立单词会被当作「无建议」丢弃，而不是显示。

## 已知限制

- 每个完成回合都会生成（与输入框是否已有内容无关），幽灵文字只在草稿为空时显示。
- 被中止（取代）的生成不会为较早回合留下建议。
- 空回复或被过滤的回复 = 该回合无建议：不写 `suggest-prompt/suggested` 事件，投影保持 `null`，也不记录警告。
- 投影保留最后一条建议：重新打开旧会话会显示其最终建议，且不发起新的模型调用。
- 建议模型的路由与预算由部署配置决定；无法关闭思考的模型（如部分 pi-ai 路由）会回退为模型默认的推理行为，想获得最快的建议体验，建议选支持关闭思考的路由（如内置 DeepSeek）。

## 开发

```sh
pnpm install
pnpm build      # host tsc + client tsdown bundle
pnpm test       # vitest
pnpm typecheck
```

> **安装说明**：本仓库依赖已发布的 `@deepseek-ai/*` 包（deepseek-harness 工作区）。上游少数内部包（`@deepseek-ai/dsh-compact`、`@deepseek-ai/dsh-type-meta`、`@deepseek-ai/dsh-environment`）尚未出现在 npm registry，本仓库通过根 `package.json` 的 `pnpm.overrides` 把它们映射到本地 `stubs/` 空包，因此 `pnpm install` 可直接成功；等 registry 补齐后可移除 overrides 与 `stubs/`。完整测试矩阵在 harness monorepo 内运行；本仓库是两个包的权威源码副本。

## 许可

MIT

---

# dsh-suggest-prompt

Suggested-next-prompt plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). After every completed agent turn, a bounded auxiliary LLM call writes **one suggested next prompt** into the session log; the web side renders it as ghost placeholder text inside the composer — press **Tab** (default) to adopt it into the draft (the Claude Code behavior).

This repository is the authoritative source of record for the two packages:

| Package | Role |
|---|---|
| [`@studyzy/dsh-suggest-prompt`](packages/suggest-prompt) | Host plugin: generates the suggestion on `turn/end` (reason `completed`) and publishes the `suggestPrompt` session projection. |
| [`@studyzy/dsh-client-ui-suggest-prompt`](packages/ui-suggest-prompt) | Browser plugin: reads the projection, renders the suggestion as ghost placeholder text inside the composer (`inputActions.setDraft`), and fills the draft on the configured shortcut. |

## Features

- **Lightweight by default**: without `provider` / `model` the suggestion inherits the route of the most recently logged main request — no model to pick just for suggestions; set them explicitly to route anywhere (for example a local OpenAI-compatible gateway).
- **No thinking, fast and cheap**: the auxiliary call carries `reasoningEffort: off` by default (DeepSeek serializes it as `thinking: disabled`) so no budget is spent on a chain of thought; models that reject `off` retry once without the field.
- **WebUI settings card**: after mounting, a "建议提示词" card appears under Settings → Plugins; pick the suggestion provider/model from the installed provider catalog (built-in DeepSeek + pi-ai routes) or keep "follow session route"; staged saves take effect on the next completed turn, and `~/.dsh/settings.yaml` works too.
- **Last turn only**: by default only the last completed turn's user input and assistant final answer are sent to the suggestion model (`maxRecentTurns` defaults to `1`); intermediate tool calls / reasoning are never included.
- **Bounded**: byte / token / timeout caps, a transcript budget, and a visible-character cap on the suggestion — all configurable.
- **Safe**: transcripts are secret-redacted before framing; output is sanitized (control sequences, fences, quotes stripped, single line) and semantically filtered (meta-text, evaluative filler, assistant-voice phrasing are dropped as "no suggestion").
- **Silent no-suggestion**: an empty or rejectable model reply is skipped quietly — no error, no event, no noise.
- **Re-arm without a call**: deleting back to an empty draft re-shows the persisted suggestion with no new model request.
- **Configurable shortcut**: the adopt shortcut is set via `acceptKey`, default `Tab`.

## Install

### Prerequisites

- Node.js `^22.19` or `>=24`, pnpm.
- A dsh deployment built from the DeepSeek Harness (web profile). The browser side needs the `conversation.input.overlay` slot and `inputActions.setDraft` — both standard in the deepseek-harness web input machine.

### From npm (once published)

> Note: the full dependency chain of `@studyzy/dsh-suggest-prompt` and `@studyzy/dsh-client-ui-suggest-prompt` is not fully on the npm registry yet (upstream `@deepseek-ai/dsh-compact`, `@deepseek-ai/dsh-environment`, etc. are still missing). Once the registry is complete:

```sh
npm install @studyzy/dsh-suggest-prompt @studyzy/dsh-client-ui-suggest-prompt
```

Then mount the two rows in your profile's cordis.yml / patch layer (see the config example below).

### From this repository's source (current)

Put the two packages into the harness workspace (or reference this repo via a `file:` dependency), and insert the two rows in your profile patch layer. For example `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: suggest-prompt
  name: '@studyzy/dsh-suggest-prompt'
  config:
    maxInputBytes: 4096
    maxOutputTokens: 512
    timeoutMs: 60000
    maxRecentTurns: 1
    maxTranscriptChars: 12000
    maxSuggestionChars: 240
    provider: ccr
    model: ttswitch/deepseek-v4-flash-ioa
    acceptKey: Tab

- id: ui-suggest-prompt
  name: '@studyzy/dsh-client-ui-suggest-prompt'
```

`provider` / `model` can be set independently: a set member overrides the matching member of the main request route, an omitted member inherits the most recently logged main request route, and omitting both follows the main request route entirely.

## Configuration

| Field | Meaning | Default |
|---|---|---|
| `maxInputBytes` | Maximum UTF-8 bytes in the final framed user prompt | required |
| `maxOutputTokens` | Suggestion output-token cap | required |
| `timeoutMs` | End-to-end auxiliary request deadline (ms) | required |
| `maxRecentTurns` | Transcript tail keeps at most this many recent completed turns | `1` (only the last turn's user input + assistant final answer) |
| `maxTranscriptChars` | Transcript character budget | required |
| `maxSuggestionChars` | Visible-character cap for the suggestion | required |
| `provider` / `model` | Each independently overrides the matching member of the main request route; omitted members inherit the main route. Editable from the WebUI "建议提示词" settings card, or via `~/.dsh/settings.yaml` | inherited |
| `acceptKey` | Composer shortcut that adopts a displayed suggestion | `Tab` (`Alt+Slash`, `Ctrl+Enter`, ...) |

> **On `maxOutputTokens`**: suggestion generation disables thinking by default (`reasoningEffort: off`), so reasoning does not consume the output budget; but a model that cannot turn thinking off (some pi-ai routes) falls back to a retry where thinking still spends budget — a small `maxOutputTokens` then ends the stream with `max-tokens` before any suggestion text is produced. Leave a generous budget (e.g. `512`) for such models.

### Configure the suggestion model in the WebUI

Once `ui-suggest-prompt` is mounted, a "建议提示词" card appears under Settings → Plugins:

- **Provider / Model**: pick the route the auxiliary call uses from the installed provider catalog (built-in DeepSeek + pi-ai routes); choosing "Follow session route" keeps the main request route.
- Edits are staged (with an "Unsaved" marker and Discard / Save buttons); saving writes the `suggest-prompt` section of `~/.dsh/settings.yaml`, and **takes effect on the next completed turn** — no restart needed.
- The dropdowns list only explicitly declared models; a provider without a declared model list degrades the model field to free-text input.
- This rides the `dsh-settings` capability: assemblies without a settings service (e.g. headless) do not show the card and keep using `cordis.yml` / the patch layer.

## How it works

- The host triggers generation on `turn/end` (reason `completed`), deduplicated per session and turn; the next completed turn aborts the in-flight generation.
- The suggestion is appended to the session log as the `suggest-prompt/suggested` event, and the `suggestPrompt` projection exposes it to the web side.
- The ghost text shows only when the suggestion answers the **latest** completed turn, the agent is idle, and the draft is empty; typing hides it, deleting back to an empty draft re-shows it.
- Pressing `acceptKey` (default Tab) fills the draft (editable, not sent). It is ignored while focus is outside the composer or during IME composition; Tab is intercepted only while ghost text is displayed (otherwise it keeps its default focus behavior).

## Model Experience

- **System prompt**: binds the model to predicting the user's next prompt in the user's own voice, forbids generating content or meta-text, and gives concrete examples and anti-examples; the reply language follows the conversation (`简体中文` when the last user message contains CJK, otherwise `English`).
- **What the model sees**: by default only the last turn, framed as labelled `[User Message]` / `[Assistant Response]` blocks (redacted, bounded by `maxTranscriptChars`).
- **Pre-dispatch logging**: the exact framed input and system prompt are recorded in the `suggest-prompt/request` event before dispatch, satisfying the model-visible ⟺ logged invariant.
- **No thinking**: the auxiliary request carries `reasoningEffort: off` by default (DeepSeek serializes it as `thinking: disabled`) for speed and low cost; a model that rejects `off` retries once without the field (the rejection happens before any network I/O, so the retry is nearly free).
- **Cost**: at most one auxiliary request per completed turn, bounded by `maxInputBytes` / `maxOutputTokens`; the main agent request gains zero tokens.

## Security

- **Transcript redaction**: AWS `AKIA…`, OpenAI `sk-…`, GitHub `ghp_`/`gho_`/`ghu_`, Slack `xox-…`, JWTs, and Stripe `rk_…` secret shapes are masked before the transcript reaches the model.
- **Output sanitization**: ANSI/OSC/CSI/DCS sequences, C0/C1 control characters, bidirectional overrides, and lone surrogates are stripped; quotes and code fences are removed; text is collapsed to one line and truncated to `maxSuggestionChars`.
- **Semantic filtering**: meta-text ("no suggestion", "stay silent"), error echo, evaluative filler ("thanks", "looks good"), assistant-voice phrasing ("Let me…", "I'll…"), multi-sentence or over-long replies, and stray single words are dropped as "no suggestion" instead of shown.

## Known Limitations

- Generation runs after every completed turn regardless of whether the composer already holds text; the ghost text is only *displayed* while the draft is empty.
- A superseded (aborted) generation leaves no suggestion for the older turn.
- An empty or filtered reply means "no suggestion" for that turn: no `suggest-prompt/suggested` event is written, the projection stays `null`, and no warning is logged.
- The projection persists the last suggestion, so reopening an old session shows its final suggestion without a new model call.
- The suggestion route and budget are deployment configuration; a model that cannot turn thinking off (some pi-ai routes) falls back to its default reasoning behavior — for the fastest suggestions, pick a route that supports `off` (such as the built-in DeepSeek).

## Development

```sh
pnpm install
pnpm build      # host tsc + client tsdown bundle
pnpm test       # vitest
pnpm typecheck
```

> **Install caveat**: this repo depends on the published `@deepseek-ai/*` packages (the DeepSeek Harness workspace). A small number of internal packages referenced by the published `dsh-*` releases are not yet on the npm registry (`@deepseek-ai/dsh-compact`, `@deepseek-ai/dsh-type-meta`, `@deepseek-ai/dsh-environment`); the root `package.json` `pnpm.overrides` map them to the local empty `stubs/` packages, so `pnpm install` succeeds out of the box — remove the overrides and `stubs/` once the registry is complete. The full test matrix runs inside the harness monorepo; this repo is the source-of-record copy for the two packages.

## License

MIT
