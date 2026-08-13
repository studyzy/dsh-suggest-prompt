# @deepseek-ai/dsh-suggest-prompt

[English](README.md) | 中文

宿主插件：在每个完成的智能体回合之后，通过一次有界的辅助 `ctx.llm` 调用，为用户生成**一条建议的下一条提示词**。建议以 `suggest-prompt/suggested` 事件写入会话日志，`suggestPrompt` 会话投影将其推送到 Web 输入框显示为幽灵文本（见 `@deepseek-ai/dsh-client-ui-suggest-prompt`）。

生成由宿主在 `turn/end`（reason 为 `completed`）时驱动，按会话与回合去重，并在下一个完成回合到来时中止被取代的生成。插件自带全部部署策略：路由、字节/令牌/超时上限、转录范围与建议长度上限。

## 配置

| 字段 | 含义 |
|---|---|
| `maxInputBytes` | 最终框架化用户提示的最大 UTF-8 字节数 |
| `maxOutputTokens` | 辅助生成输出令牌上限 |
| `timeoutMs` | 辅助请求端到端截止时间（毫秒） |
| `maxRecentTurns` | 转录尾部保留的最近完成回合数 |
| `maxTranscriptChars` | 转录尾部框架化前的字符预算 |
| `maxSuggestionChars` | 生成建议的可见字符上限 |
| `provider` / `model` | 可选显式路由对；同时省略则继承会话日志中最近的主请求路由 |
| `acceptKey` | 将显示的建议采纳到草稿的输入框快捷键（`Tab`、`Alt+Slash`、`Ctrl+Enter` 等）；默认为 `Tab` |

同时省略 `provider` 与 `model` 时，会继承当前已记录主请求的确切路由；也可以同时设置二者，使建议生成使用独立路由。`acceptKey` 会随每条建议事件下发，由 Web 输入框的幽灵文本读取。

## 安全

- 转录在框架化前脱敏：AWS 访问密钥、OpenAI 风格 `sk-` 令牌、GitHub `ghp_`/`gho_`/`ghu_` 令牌、Slack `xox-` 令牌、JWT 与 Stripe 密钥均被掩蔽。
- 输出在到达输入框前净化：剥离 ANSI/OSC/CSI/DCS 序列、C0/C1 控制符、双向覆盖符与未配对代理项；去除引号与代码围栏；压缩为单行并截断到 `maxSuggestionChars`。
- 输出还会经过质量过滤：元文本（"no suggestion"、"stay silent"）、错误回显、评价性套话（"thanks"、"looks good"）、助手语气措辞（"Let me..."、"I'll..."）、多句或过长回复以及孤立的单词会被当作"无建议"丢弃，而不是显示。

## 模型体验

### 建议请求

#### 模型看到的内容

建议模型会收到一条指令：将其绑定为以用户自己的口吻预测下一条提示词，禁止生成内容或元文本，并给出具体的正例与反例；指令还会让回复语言与会话一致（最后一条用户消息含 CJK 文本时为 `简体中文`，否则为 `English`）。对话尾部以带标签的 `[User Message]` / `[Assistant Response]` 块呈现（已脱敏，受 `maxRecentTurns` 与 `maxTranscriptChars` 约束）；确切框架化输入与系统提示在派发前记录于 `suggest-prompt/request` 事件。

#### Token 影响

每个完成回合最多一次辅助请求，受 `maxInputBytes` 与 `maxOutputTokens` 约束。主 agent 请求不增加 token。

#### KV Cache 影响

不会使主请求的 KV Cache 失效。辅助请求使用已配置或已记录路由，其缓存行为由提供方决定。

## 已知限制与暂缓事项

- 每个完成回合都会生成，无论输入框是否已有文本；幽灵文本只在草稿为空时*显示*。
- 被取代（中止）的生成不会为较早回合留下建议；只发布最新回合的建议。
- 空回复或被过滤的回复意味着该回合"无建议"：不会写入 `suggest-prompt/suggested` 事件，投影保持 `null`，也不会记录警告。
- 投影保留最后一次建议，因此重新打开旧会话会显示其最终建议，且不会发起新的模型调用。
