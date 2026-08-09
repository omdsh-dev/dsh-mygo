# @deepseek-ai/dsh-mygo-api

[English](README.md) | 中文

无 Cordis 依赖的上层插件契约：`definePlugin`、manifest 与环境类型、`PluginError` 错误词表，以及 fake-env 测试面。插件作者只导入本包；插件管理器（`@deepseek-ai/dsh-mygo`）会在挂载时把这些声明桥接到 Cordis。首次接触的作者从[插件作者指南](../../../docs/plugin-author-guide.md)开始；生成的 [API 参考](../../../docs/mygo-api-reference.md) 是每个导出的 JSDoc 同源事实来源。

## 公开 API

- `definePlugin(definition)` `PluginDefinition` 的类型载体（恒等函数）。它不做任何校验——挂载期校验归管理器。
- `PluginDefinition` v1 manifest：`id`、`version`、`kinds`、`requires`、`provides`、`permissions`、`fileAccess`、`networkAccess`、`stateful`、`swapPolicy`、`config`（schemastery schema）与 `hooks`。`kinds` 是开放词表（`/^[a-z][a-z0-9-]*$/`，非空）；`isolationMode` 有意不进入 v1。
- `PluginEnv` 能力面：`logger`、`on`、`scope`、`registerTool`、`registerPromptSection`、`provide`、`get`、`plugins`、`updateConfig`、`fs` 与 `fetch`。`get` 对未声明能力返回 `undefined`——服务隔离不是错误。注册方法只属于 `activate`；在 `setup` 期调用会抛 `setup-registration`。
- `PluginFs`、`Disposable` 与交给插件的极简 `Logger` 结构型。
- `PluginEvents` / `PluginEventName` / `PluginEventListener` 空基事件映射遵循仓库 declaration-merging 惯例：事件属主包通过合并补充。listener 签名按事件的 `@mode` 分流：waterfall 事件末参为 `next`，emit/parallel/serial 事件没有；listener 选项只有 manifest 的 `position` 一个入口，直传 EventOptions 会以 `unsupported-event-option` 失败。
- `PluginToolDefinition` 极简结构型工具定义（name、description、input schema、output schema、execute、render intent）。本包不导入 tools 包；管理器负责把该结构映射进工具注册表，并在每代 staging 重校 output schema。
- `PluginHooks` / `DeactivateReason` / `PreviousGeneration` 四条可执行边界：setup 禁止注册；`previous` 标识产出快照的 generation（首次安装为 `null`）；capture 状态必须可 JSON 序列化；超限或不可序列化的状态一律拒绝、绝不截断。
- `PermissionsBlock` / `TransformDeclaration` / `InterceptDeclaration` §5 声明块，含 `position`（`outermost` | `derived` | `innermost`）与 `claims`（`service:<id>` | `tool:<name>`）。
- `PluginSource` / `InstallOrigin` / `InstallOptions` §15.1 动态安装面：`inline` 代码或 `npm` 包引用（永不取货）、来源 `model` | `runtime-api`，以及可选的初装配置。
- `PluginHandleInfo` §15.2 受管插件只读句柄，从本包导出，使 `plugins()` 在桥两侧是同一类型。
- `PluginError` / `PluginErrorCode` / `formatPluginError` 唯一错误类与六组共 36 码的封闭码表（§16.2）。`message` 由 code 模板 + 机读 `details` 生成，并命名该码在 spec 中挂接的全部 "naming X" 实体；`pluginId` 在归属已知时必填。
- `createFakeEnv` 用于插件单元测试的记录型 `PluginEnv`：用 `requires`/`services` 播种，用 `phase` 触发 setup 守卫，用 `trigger` 驱动 listener。`get` 对已声明服务返回值、对未声明服务返回 `undefined`。
- `toCordisPlugin(definition)` §23.1 自我收养适配器：把受管定义包成结构型 Cordis 函数插件，`apply` 只调 `ctx.pluginManager.adopt`；`pluginManager` inject 让 manager 缺席在 mount 期 fail loud。`fromCordisPlugin(raw, declaration)` 迁移桥：裸插件的 `apply` 在受管 `activate` 内跑受限 facade（`on`/`get`/`provide`/`tools.register`/`systemPrompt.section`/`sessionPersistence`/`logger`）；`tools.register` 把结构化 `defineTool` 输出映射到 `PluginToolDefinition`（input = 编译后的 `parameters`、output = `output.schema`、通用 card render）；`systemPrompt.section` 映射到 manager 持有的提示词 section 表；`sessionPersistence` 对声明过的 `requires` 解析 manager 的只读投影（写方法物理失败）；直传 EventOptions 以 `unsupported-event-option` 拒绝，未声明 `get` 保持 `undefined`（SEC:86）。两个形状都是结构型——本包仍不导入 Cordis。

## 设计契约

面向插件作者的源码从不导入 Cordis；`./invariant` 配套是唯一例外，且属于仓库机制而非插件面。每个公共类型与错误码都誊写自插件 v1 spec；消息模板是 §16.2 的首版定稿措辞，后续所有管理器阶段的报错断言共用。

fake env 忠实实现本包拥有的 env 语义（未声明 `get` → `undefined`、setup 期注册守卫），并记录每次调用供断言使用。它不做 manifest 校验，也不实现 Cordis 的 dispatch 模式：`trigger` 按注册顺序调用 listener，`next` 风格的参数原样转发。

## 已知限制与暂缓事项

- **本包不做挂载期校验** —— manifest、权限、grant 与 ceiling 检查归 dsh-mygo 任务；本包保持为类型/错误面。
- **`fromCordisPlugin` 不继承裸插件的 inject 列表与 options 表面** —— 迁移桥按设计是受管 fiber 的客人；permissions 必须由调用方按 §5 声明。
- **`PluginToolDefinition` 刻意极简** —— 其结构字段形状是本包对 spec 六要素的具体化；管理器桥将其映射进 tools 注册表词表。
- **fake `trigger` 不做模式专属 dispatch** —— bail/waterfall 组合是管理器行为；需要它的测试要么直接调用 listener 回调，要么等管理器实现。
