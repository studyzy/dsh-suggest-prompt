# 把配置页搬到「插件」页

本文件说明如何把 suggest-prompt 的设置卡片从 **设置 → 内置插件** 的标签页，搬到 **插件**
页 —— 让用户点开插件卡片就能配置，不再需要先找到设置区。

本文档由 dsh-lazy-tools 的对应改动整理而成，那份改动已在真实桌面应用（dsh 0.2.0-rc.2）
中验证通过。两份插件的起点完全相同（都注册 `settings.plugins.tab`），且**都是 profile
依赖**，所以踩过的坑这里都适用。

---

## 一、结论先行：要改两个槽位，不是一个

这是最容易做错的地方。直觉上「搬到插件页」＝把 `settings.plugins.tab` 换成
`plugins.item` 就完了。**不够。** 只改一半的结果是：插件页上会出现一张卡片，点进去
可能是空的。

原因是插件页对「官方插件」和「已安装的包」是**两套渲染路径**：

```js
// packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx
const mine     = listed.filter(pkg => pkg.installed || !pkg.optional)
const official = listed.filter(pkg => pkg.optional && !pkg.installed)

const officialCards = [
  ...official.map(packageCard),                              // 包卡片（Installed 分组）
  ...ledger.items.map(item => <ItemCard .../>),               // 配置卡片（Official 分组）
]
```

而 `@studyzy/dsh-suggest-prompt` 在 profile 里是这么声明的：

```json
"dependencies": { "@studyzy/dsh-suggest-prompt": "link:..." },
"dsh": { "profile": { "bundles": ["...", "@studyzy/dsh-suggest-prompt"] } }
```

既是 `bundles` 成员、又是 `dependencies` 成员 → `installed: true` → 插件页把它列进
**「已安装」分组的包卡片**。同时它又注册了 `plugins.item`，于是**「官方插件」分组里还有
一张配置卡片**。

结果：**同一个插件出现两张卡片，分属两个分组**。用户（包括我自己测的时候）会先点
「已安装」里那张 —— 而那张的配置区由另一个槽位控制：

```js
configured: ledger.bundles.has(openPkg.name)
// ...
{configured ? renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name }) : null}
```

**没注册 `plugins.bundle.config` 时 `configured` 恒为 `false`，配置区整个不渲染** ——
页面上只有描述、「包含的组件」列表和一个启用开关，看起来就像"这个插件没有配置项"。

> **参照物陷阱**：官方「子智能体」插件只有一个入口，因为它是**应用自带**的
> （`optional` 且未安装），根本不会生成包卡片。照抄它的写法会漏掉整个
> `plugins.bundle.config`。`@studyzy/dsh-suggest-prompt` 和 `dsh-lazy-tools` 都属于
> 「profile 依赖」这一类，**必须两个都注册**。

---

## 二、要改的地方

### 1. `src/browser/index.ts` —— 注册两个槽位

把现有的 `settings.plugins.tab` 注册替换掉（当前代码在第 87–96 行附近）：

```ts
// 一份 face，两处共用 —— 见下方「为什么必须共用」
const face = settings.inject()

const item = settingsCtx.slots.inject('plugins.item', () => settingsCtx.slots.register({
  name: 'plugins.item',
  id: SUGGEST_PROMPT_NS,      // 这里用 'suggest-prompt'，见下方说明
  order: 30,
  label: () => t('title'),    // 卡片标题（Official 分组里的那张卡）
  locale: NS,
  inject: () => face,
}, SettingsCard))

const bundle = settingsCtx.slots.inject('plugins.bundle.config', () => settingsCtx.slots.register({
  name: 'plugins.bundle.config',
  key: '@studyzy/dsh-suggest-prompt',   // 注意：包名，不是命名空间
  locale: NS,
  inject: () => face,
}, SettingsCard))
```

两点容易写错：

- **`plugins.bundle.config` 用 `key`，不是 `id`。** 它是 keyed 槽位，由包名寻址；
  写了 `id` 不会报错，但永远匹配不上，配置区仍然不渲染。
- **`key` 是 npm 包名**（`@studyzy/dsh-suggest-prompt`），**不是** `SUGGEST_PROMPT_NS`
  （`'suggest-prompt'`）。两者不同，混淆了同样静默失效。

**disposer 不用担心，但要知道为什么。** `slots.inject(...)` 返回的 disposer 已经挂在
**当前 fiber** 上（`settingsCtx` 内），fiber 卸载时会自动回收 —— 这也是你们测试里
`SlotRegistryStandin` 注释写的那句「The contribution's lifetime rides the registering
fiber (HMR reload unloads the plugin and drops its entries)」。现有的
`settings.plugins.tab` 注册同样没有单独处理 disposer。

所以照现有写法把两个 `slots.inject` 并列即可，不需要额外包 `effect`：

```ts
settingsCtx.slots.inject('plugins.item', () => settingsCtx.slots.register({ ... }, SettingsCard))
settingsCtx.slots.inject('plugins.bundle.config', () => settingsCtx.slots.register({ ... }, SettingsCard))
```

只有当你想显式控制回收顺序、或者要做可读性更强的分组时，才需要像
`settingsCtx.effect(() => () => { settings.dispose() }, ...)` 那样包一层。

### 2. `src/browser/index.ts` —— `dsh.client.inject` 不需要动

`package.json` 里的：

```json
"dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-ui-conversation"], "platform": "web" } }
```

**保持原样。** 这里列的是「必须先加载的客户端包」，用于加载顺序；它**不是**类型依赖声明，
也不需要在里面加 `dsh-client-ui-plugin-manager`。

我一开始给 dsh-lazy-tools 加了 `@deepseek-ai/dsh-client-ui-plugin-manager`，后来发现：
- 它是从官方 shell 插件照抄来的；
- 对该插件毫无作用（bundle 只 `require` primitives，从不 `require` plugin-manager）；
- 而且那个包在 profile 里**根本解析不到**（`MODULE_NOT_FOUND`）—— 官方插件能写是因为
  它们在**应用的** `node_modules` 里，而 `link:` 外部插件的解析基准是 profile。

宿主的扫描器只把它当数据读，不会因解析失败而报错，所以这个错误**不会显形**，但它也没有
任何收益。不要加。

### 3. `src/browser/SettingsCard.tsx` —— 必须处理 `view`，并改掉 `<li>`

这是 suggest-prompt 相比 dsh-lazy-tools **需要多做的**工作，因为这张卡目前是为标签页
手写的（自带 `<style>` + 手风琴 `<li>`），而不是复用共享表单。

**(a) 加 `view` 分支。** `plugins.item` 会用一个组件渲染两次：`view: 'summary'` 是卡片上
的那行说明，`view: 'page'` 是详情页里的表单。所以加起来是**三处**渲染（summary、page、
bundle.config），需要区分对待。

⭐ **但 suggest-prompt 不能像 dsh-lazy-tools 那样简单地早返回**，原因见下面的警告框。

> ⚠️ **这里和 dsh-lazy-tools 不一样，不要直接照抄它的写法。**
>
> dsh-lazy-tools 可以写得很简单：
>
> ```ts
> export function LazyToolsCard(props: LazyToolsCardProps): unknown {
>   const { t } = props
>   if (props.view === 'summary') return t('description')   // ← 在 hook 之前
>   const state = props.useLazyTools(snapshot => snapshot)
> ```
>
> 因为它**在这个组件里没有任何 hook**（表单模型是普通类，store 由注入进来）。
>
> 而 `SettingsCard` 目前是：
>
> ```tsx
> export function SettingsCard(props: SettingsCardProps) {
>   const { t } = props
>   const state = props.useSuggestPromptCard(snapshot => snapshot)   // hook 1
>   const [open, setOpen] = useState(false)                          // hook 2
> ```
>
> **两个 hook 都在顶层。** 如果照抄上面的写法，把 `if (props.view === 'summary')
> return ...` 插到第 361 行之前，就会出现：summary 渲染时 hook 数为 0、page 渲染时为 2。
> React 会在"Rendered fewer hooks than expected"上直接抛错或行为错乱 —— 而这只在真正
> 切到卡片列表时才触发，Node 端的浅测试未必覆盖得到。
>
> 正确做法是把 summary 拆成**独立组件**，或把现有实现整体搬进一个内层组件：
>
> ```tsx
> /** 卡片上的一行说明：不订阅 store，避免为了一行字建订阅。 */
> function Summary(props: { t: (k: SuggestPromptSettingsLocaleKey) => string }) {
>   return <>{props.t('description')}</>
> }
>
> export function SettingsCard(props: SettingsCardProps) {
>   if (props.view === 'summary') return <Summary t={props.t} />
>   return <CardBody {...props} />   // 原实现搬进来，两个 hook 在 CardBody 顶层
> }
> ```
>
> 这样两个分支各自 hook 数恒定，规则不被破坏。
> `plugins.bundle.config` 只请求 `view: 'page'`，所以只有 `plugins.item` 需要 summary。

**(b) 根元素不能用 `<li>`。** 两个新槽位的 DOM 上下文和前一个完全不同：

| 槽位 | 渲染位置 | 合适的外层 |
|---|---|---|
| `settings.plugins.tab` | 标签页面板（自己有 `<ul>` 列表语义） | `<li>`（现状） |
| `plugins.item` `view:'summary'` | 卡片副标题，包在 **`<p>`** 里 | 纯文本或 inline 元素 |
| `plugins.item` `view:'page'` | 详情页 `<section data-plugin-config>` | `<div>` |
| `plugins.bundle.config` | 包详情页 `<section data-plugin-config>` | `<div>` |

`<li>` 放进 `<p>` 里是**非法嵌套** —— `<p>` 的内容模型只允许 phrasing content，而 `<li>`
是 flow content。React 用 `createElement` 建 DOM（不走 HTML 解析器），所以不会像服务端
HTML 那样被自动拆开，但控制台会报 validateDOMNesting 警告，且 `<li>` 在 `<p>` 里的
盒模型/列表样式都不成立，视觉上会错位。

所以：
- summary 分支返回**纯文本**（或 `<span>` 这类 inline 元素）；
- page 分支把根元素从 `<li>` 改成 `<div>`；
- 手风琴那一层壳（`dsh-sug-header` 的展开/收起按钮）在新的页面上下文里**是多余的** ——
  详情页本身就是「展开」状态。建议直接渲染表单主体，去掉展开按钮和 `open` state。

**(c) 排版量级不同。** 标签页面板宽度有限、卡片之间并列；详情页是整页宽度、单个表单。
现有的 `.dsh-sug-*` 内联样式可以继续用，但建议检查一遍间距，必要时给详情页加一个
class 变体。

### 4. 别忘了 `SettingsForm` 式的保存语义

suggest-prompt 自带「丢弃 / 保存」按钮，语义上和共享 `SettingsForm` 一致，保留即可。
**但要注意**：两个槽位渲染的是同一个组件、共用同一个 controller face，所以

- 在一处改了草稿，切到另一处（或另一个入口）应当能看到同一个草稿；
- 保存是**一次** revision-fenced 写入。

---

## 三、为什么两个槽位必须共用同一个 face

这一条是我写测试时才想清楚的，也是**最容易埋雷**的地方。

```ts
const face = settings.inject()   // ← 一次
// 两个注册都用 () => face
```

如果图省事写成 `inject: () => settings.inject()`（每次调用新建），**不会报错，但**：

- 两个 controller 各自持有一份草稿表；
- 在 A 页面改的东西，B 页面看不见；
- 在 B 页面点保存，写入的是 B 那份空草稿 —— **用户以为保存了，其实什么都没写**。

这类 bug 在浏览器里表现得很隐蔽（"我明明改了"），所以**务必写测试**。

另外注意断言要比较 `inject()` 的**返回值**，而不是函数本身：

```ts
// ❌ 永远失败：每个 () => face 都是新闭包
expect(item.inject).toBe(bundle.inject)

// ✅ 断言真正的不变量
expect(item.inject()).toBe(bundle.inject())
```

我自己就先写错成了前者，测试当场失败；这反而说明这个断言如果写不对就毫无意义。

---

## 四、建议补的测试

`tests/browser-plugin.client.spec.tsx` 里应当能照现有 stub 结构加。注意现有的
`SlotRegistryStandin` **只对已声明的槽位执行 inject 回调**（`if (started ||
!this._declarations.has(key)) return`），所以测试里必须先像现有的 `root` 注册那样把两个
新槽位声明出来，否则断言会拿到空数组、误以为"没注册"：

```ts
ctx.slots.register({
  name: 'root',
  children: {
    'conversation.input.overlay': { kind: 'list', scope: 'session' },
    'plugins.item': { kind: 'list', scope: 'root' },
    'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
  },
}, (() => null) as never)
```

然后：

1. **两个槽位都注册了**：断言 `entries('plugins.item')` 与
   `entries('plugins.bundle.config')` 各有一条。
2. **key 用包名**：断言 bundle 那条的 `options.key === '@studyzy/dsh-suggest-prompt'`，
   且 `options.id` 为 `undefined`（keyed 槽位用 key 寻址）。
3. **共用同一个 face**：`expect(item.inject()).toBe(bundle.inject())`，理由见上。
4. **summary 分支不渲染表单**：直接调用组件传 `view: 'summary'`，断言返回值**不含**
   表单控件（不是 `<input>`/`<select>`/`<button>` 那套）。如果按第三节的写法抽出了
   `Summary`，也可以直接测 `Summary` 返回的文案是否等于 `t('description')` ——
   比断言 `SettingsCard` 的元素树更稳。
5. **卸载后两个都消失**：`await fiber.dispose()` 后两个 `entries()` 都为空 ——
   照现有 ghost overlay 那条测试的写法。注意 `slots.inject` 的 disposer 本来就挂在
   fiber 上（见第二节），这条测试是防止你漏接了其中一个。

如果你有类似 `scripts/verify-client-bundle.mjs` 的产物校验脚本，也把这几条加进去 ——
这类错误在构建期完全看不出来，只有真跑一下 bundle 才能发现。

---

## 五、验证清单

改完后按顺序过一遍：

```bash
pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run build
```

然后**重启 DSH**（客户端 bundle 是启动时读取的，改完必须重启），在「插件」页确认：

- [ ] **官方插件** 分组里出现 suggest-prompt 卡片，点进去是**完整表单**；
- [ ] **已安装** 分组里那张 `@studyzy/dsh-suggest-prompt` 包卡片，点进去后
      「包含的组件」**上方**出现**同一个表单**；
- [ ] 在一处改了 provider/model/快捷键，切到另一处，草稿还在；
- [ ] 保存后配置生效（保存写入的是 profile patch 的 `config`，全局层）；
- [ ] 把插件行禁用后，两个入口都不再出现。

可以用 DOM 属性快速定位这两张卡：

```js
// 配置卡片（Official 分组）
[...document.querySelectorAll('[data-plugin-item]')].map(e => e.dataset.pluginItem)
// 包卡片（Installed 分组）
[...document.querySelectorAll('[data-plugin-package]')].map(e => e.dataset.pluginPackage)
```

---

## 六、附：dsh-lazy-tools 的对应改动

供对照参考，那份改动的实际形态：

- `src/client/index.ts`：`registerPage()` 里注册 `plugins.item`（`id: 'lazy-tools'`,
  `order: 40`）与 `plugins.bundle.config`（`key: '@deepseek-ai/dsh-lazy-tools'`），
  两者共用同一个 `const face = controller.inject()`；
- `src/client/page.ts`：`LazyToolsCard` 加 `view` 判别，summary 分支直接
  `return t('description')`；
- `src/client/contracts.ts`：补 `SlotRegistrationOptions.key`；
- `tests/settings-page.spec.ts`、`tests/client-bundle.spec.ts`、
  `scripts/verify-client-bundle.mjs`：按上面第四节的方式加断言。

其中「两个 surface 共用同一 face」这条断言，是接 DSH **真实**的 `SlotRegistry` 服务
跑出来确认的 —— 最终 `configLedgerSource` 的投影为：

```
LEDGER bundles: ["@deepseek-ai/dsh-lazy-tools"]   ← configured 由 false 变 true
LEDGER items  : [{"id":"lazy-tools","label":"懒加载工具"}]
```

如果只是想快速确认自己改对了，把这个投影打出来是最直接的证据：`bundles` 里出现你的
包名，就说明配置区会渲染。