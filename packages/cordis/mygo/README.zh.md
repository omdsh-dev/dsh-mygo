# @deepseek-ai/dsh-mygo

[English](README.md) | 中文

> **dsh-MYGO!!!!!** — Managed Yield Gen Orchestrator。致敬乐队 MyGO!!!!!（BanG Dream!）。每个迷路的插件都会在 boot 时找到回家的路。

无 Cordis 依赖的上层契约（`@deepseek-ai/dsh-mygo-api`）与运行时之间的受管插件桥：`ctx.pluginManager` 服务键类型、manager 部署 Config、§16 组 1/组 2 的 mount 期校验链、纯函数排序/冲突/plan 推导、容器化 dispatch 机器、生命周期引擎、PluginEnv 能力边界与 sqlite 持久化 + boot 恢复层。#12–#20 已落地（出厂集成细节见下）；提案 A/B 与阶段一原生能力总表沿用同一套错误词表。

首次接触的作者从[插件作者指南](../../../docs/plugin-author-guide.md)开始；部署面细节（grants、配额、sqlite 注册表）见本 README。

[生态兼容性矩阵](../../../docs/plugin-ecosystem-compat.md)记录现有 dsh-external Cordis 插件经 `fromCordisPlugin` 迁移的真实结果。

## 公开 API

- `PluginManager` / `PluginOperation` / `PluginOperationPlan` §15.3 的类型化服务面，同时以 `ctx.pluginManager` 键声明在 Cordis `Context` 上。#12 骨架交付契约；运行时服务注册随操作阶段（#13 plan、#15 生命周期）到来。
- `PluginManagerConfig` / `PluginManagerConfigSchema` / `resolvePluginManagerConfig(input)` §15.6 + §17 的部署 Config：注册表配额（256KB 代码 / 64MB 注册表 / 1000 个动态插件）、审计轮转（50MB × 5）、`stateRoot`（默认为 `dshHomePath('plugin-state')`）、`historyKeep`（2）、`maxRuntimeApiPermissionLevel`（默认 `claims` = 无额外封顶）、`swapTimeoutMs`，以及 §17 字段 `grants`（出厂为空）、`protectedFields`、`development` 与 `trustedScopes`。
- `PluginGrants` 按插件的部署授权：`intercept`、`claims`、`fileAccess`（`[mode, path]` 条目，`write` ⊇ `read`）与 `networkAccess.allow`。刻意没有 `position` 字段（决定 #5）；对 `outermost` + `intercept` 插件的审查顺序指引属于 README 职责，不落 schema。
- `validateMount(definition, options)` §16 组 1（manifest zod、harness tier 可达面、`@mode` 上限、返回类型属性与分支词表、capability-range 语法、事件选项）与组 2（grant 覆盖、通道 ceiling、来源接受、受保护字段、provenance）的 mount 期校验链。每次拒绝都是 `PluginError`，消息来自 dsh-mygo-api 模板，manifest 校验通过后 `pluginId` 填来源定义的 id（校验前的 manifest 失败无法归属）；成功返回非致命警告（目前只有 `development-mode` provenance 绕过，SEC:158）。
- `assertEventOptions(options, pluginId?)` `unsupported-event-option` 守卫：直传 `env.on` 的 EventOptions 一律拒绝，因为 manifest `position` 是唯一的 listener 选项入口。#12 骨架拥有该守卫与消息；`PluginEnv` 桥在能力阶段（#16）将其接入 `env.on`。
- `deriveOrders(input)` / `buildScopeGraph(input)` / `deriveScopeOrder(...)` / `scopeMembers(...)` 纯函数排序推导（#13，§9/§11）：reads/writes/appends 图的字典序最小线性扩展，按 scope 用 Kahn + 插件 id 最小堆计算。`orders` 每个 scope 键一个数组，外加 `'*'` 表示仅 unscoped 序；端位置 band 按 id 序固定在链两端；成环 scope 进 `cycles` 且不出现在 `orders`。`orderNeutral` 是 #6 的按插件标志：当且仅当插件声明 intercept（任意分支）或向 chain-ordered slot append 时为 false（PO:53）。
- `evaluateConflicts(input)` 纯函数五规则 + claims 判定（#13，§10-§12）：`write-conflict`、`intercept-branch-conflict`、`ordering-cycle`、`veto-position-conflict`、`claims-unmanaged-incumbent` 与 `shadow-undeclared`，只在插件 scope 集相交处求值，并按确定性顺序排序供预检。
- `planOperation(operation, state)` 纯函数 plan 预检（§15.3/PO:242）：accepted 计划携带 `displaced` 旁观者（相对序变化且与操作插件无共享声明槽位的插件）与位移它的边，另有动态安装被静态 incumbent shadow 的 `wouldShadow`（T2-4）；rejected 计划预演操作将抛的精确 §16.2 码。
- `DispatchMachine` / `managedListenerOptions` / `MANAGED_META` 链路所有权与容器化 dispatch 核心（#14，§13/§16 组 5/16.4）。`start()` 安装 `internal/listener` bail 处理器与每个受管事件两个真实注册——outermost band 走 `prepend: true`，derived+innermost 共用一个正常注册。env 桥把 `managedListenerOptions(meta)` 附到 `ctx.on`；bail 把 listener 转入按 scope 的 band 数组（`setOrders`，即 #13 派生序）并把条目绑到调用方 fiber。每个受管 listener 都在容器内运行：吞没 throw（`veto-suppressed`，每 listener 每 boot 一次）、执行返回纪律（`next-missing`/`undeclared-veto`/`undeclared-branch`）、计量不含 `await next()` 窗口的 own-time CPU（`quota-cpu-exceeded`，连续 5 次 → `onAutoDisable`，被跳的 intercept 以 `intercept-skipped` 上报），并拒绝直传 EventOptions（`unsupported-event-option`）。
- `LifecycleEngine` 操作核心（#15，§14/§15.3）：`install`/`uninstall`/`enable`/`disable`/`replace`/`updateConfig`、静态收养（T2-4）、回到缓存代、boot 恢复（T4）与 `dispose`。每个插件 id 同时只跑一个操作（`concurrent-operation`），遵守 T3 写序（创建类：runtime commit → persist → return，`persist-failed` 补偿；删除类：persist 先行），按 §14 七步协议换代。staging 对可丢弃集合跑 setup + activate，并逐代重校全部 tool output schema（`staging-failed`）；go-live 前失败保持旧代 live，`plugin/replace-failed` 恰好发一次。go-live 交换不可变的事件数组与 manager 持有的 provide/tool 表而不跑插件代码；受影响事件排空后释放旧代，回到缓存代 = 对当前同伴全量重查的全新 replace（`companion-conflict`）。`swapPolicy: 'drain'|'next-idle'` 的等待以 `swapTimeoutMs` 为界、按挂钟（`now()`）计量，超时抛 `swap-timeout`（details 带 `policy` + `waitedMs`）；#14 的 own-time CPU 计量是另一套时钟，既不暂停也不延长 swap 等待。`io` 与 `fetchImpl` 选项注入 env 边界要门控的主机文件/网络接缝（默认：Node `fs/promises` 与全局 fetch）；`persistence` 注入 #17 的 sqlite/快照/审计门面，缺省时引擎纯内存运行。
- `RegistryStore` / `InMemoryRegistryStore` 持久化接缝（§22.1 行：只写一次的 `gens` 加每插件一条小 `status` 行，带 `v: 1` 记录版号的不透明 TEXT）与内存实现，带 `fail(table)` 写失败注入、`snapshot()` 崩溃测试深拷贝与 `crashAfter(table)` 写后断电注入（T3 崩溃矩阵）。`usage()` 供 T6 注册表配额求值。
- `SqliteRegistryStore` / `openSqliteRegistryStore` / `RegistryRowError` 接缝的 sqlite 实现，跑在 storage-domain 之上（真实 sqlite 后端，每 profile 一个库文件）。值保持不透明 TEXT；不可解析的行抛 `RegistryRowError`，boot 恢复按 `damaged-record` quarantine。
- `pluginRegistryDomainSpec` / `sanitizeProfileName` / `fnv1a` 每 profile 的 domain 声明 `plugin_registry_<profile>`（§22.1）：`gens`/`status` 两表、版本 1、`recovery: 'reset'`，以及写死的 profile 消毒规则（小写、`_` 替换、`p_` 前缀、FNV-1a 冲突后缀）。
- `SnapshotStore` / `SnapshotMeta` 状态快照文件（§22.2）：`plugin-state/<profile>/<id>/<gen>.state.json`，temp-write + rename，status 行带 sha256/字节元数据，hash 校验读（不符 = 无快照 + warn），boot GC 清孤儿文件。
- `AuditLog` / `AuditClass` 部署审计流（T5）：`plugin-state/<profile>/audit.jsonl` 追加式 JSONL，0o600，按 `auditMaxBytes` × `auditKeepFiles` 轮转，容忍式读取（`since`/`byPlugin`/`tail`），§22.3 封闭类别集。
- `RegistryPersistence` 组合门面：打开 profile domain、快照库与审计流，并把 `domain/reset` 接入审计（`medium-reset`，T4-5）。门面在运行时里的组合接线属 #18 一部分。
- `PluginManagerService` / `PluginManagerServiceConfig` Loader 面的 `ctx.pluginManager` 服务（#18）：注入 `storage`/`storageDomain`，Config = §15.6/§17 表面 + `profile` + `cpuBudgetMs`。init 打开每 profile 持久化、构建带两条组合接线的 dispatch 机器（`onAutoDisable` 以 reason `cpu-quota` 跑引擎 disable 协议；dispatch 违规以 §22.3 类别入审计流）、跑恢复，并暴露完整 §15.3 操作面。inline 源码以进程内模块求值（导出 `PluginDefinition`）；npm 源以 `package-not-resolvable` 拒绝。宿主侧审计读方法（`auditSince`/`auditByPlugin`/`auditTail`，T5-4）闭环 SEC:153 的"独立服务可读"面；`PluginEnv` 永不看到它们。
- `createPluginFs` / `fileModeForPath` / `normalizeGatePath` / `pathPrefixCovers` / `realPathOf` / `PluginIo` / `nodePluginIo` 运行时 `env.fs` 边界（#16，SEC:149）：词法路径检查在任何 I/O 之前同步抛 `fs-denied`，随后解析最长现存祖先的符号链接，并把真实路径对照“真实化后的 grant 基路径”再查一次——`/project` grant 拒绝 `/etc/passwd`、`..` 逃逸与 symlink 逃逸，同时 honor 指向符号链接的 grant 根。`fileModeForPath` 编码 write⊃read 蕴含：同路径上 `write` grant 同时满足读与写请求，`read` grant 只满足读。
- `createNetworkFetch` / `networkUrlAllowed` 运行时 `env.fetch` 边界（SEC:150）：allowlist 与 mount 校验共用同一 scheme/host 边界前缀，被拒 URL 在调用主机 fetch 之前同步抛 `network-denied`。
- `claimEffect` / `PluginEffectQuota` §18 的注册 effect 配额：每插件 100 listener / 50 tool / 20 service，在注册调用点抛 `quota-effects-exceeded`，同一 generation staging 的 scope 层共享计数。
- `ToolRegistryLike` / `tools.register` 桥（提案 A）把每个 manager 持有的工具以活间接层（name/description/parameters/output/execute 都经当前代解析）恰好一次发布进真实 tools 注册表，replace 从不重注册——不发 `tools/change`、`schemas()` 位置稳定（F1 关闭）。`fromCordisPlugin` facade 的 `ctx.tools.register` 结构性映射裸 `defineTool` 输出到 `PluginToolDefinition`；组合了 manager 时 tool-cordis 沙箱经桥路由（F2 工具路由关闭）。staging 对照注册表全局层强制工具 claims/shadow：claims 指向裸持有槽位是 `claims-unmanaged-incumbent`，scoped 未声明 claims 的遮蔽是 `shadow-undeclared`，未限 scope 的重名是 `staging-failed`——后来者绝不静默赢。
- `PromptServiceLike` / `createSessionPersistenceProjection` / `SessionPersistenceProjection` / `registerPromptSection` 服务映射桥（提案 B）`env.registerPromptSection` staging 一个提示词 section（按 §18 贡献桶计配额、staging 校验有限 order），引擎经 `promptService` 接缝以活视图发布进宿主 systemPrompt 服务，并随 generation 处置（HMR-safety）。`env.get('sessionPersistence')` 在声明指名时经 `sessionPersistence` 接缝解析 manager 策展的只读投影（listSnapshots/list/locate/inspect/load/readFrom/prepare）；写方法（`create`/`append`）以抛错 stub 存在，调用物理失败而非静默返回 `undefined`（写面延后到第一个写消费者）。facade 把 `ctx.systemPrompt.section` 与 `ctx.sessionPersistence` 映射到这些面；裸 `inject` 继续不被 honoring（声明即承重）。
- `createRateLimitedLogger` SEC:71 日志门：每插件每分钟 1000 行；超出行丢弃，并在每个窗口向插件告警一次。
- `EVENT_VOCABULARY` / `PluginEventVocabularyEntry` 生成的 harness 词表：每个事件的事件名、dispatch mode、真实返回类型的顶层属性名，以及 decision-union 返回类型的判别标签。`src/event-vocabulary.ts` 由 `pnpm run gen-cordis-catalog` 从与 `docs/cordis-catalog/events.md`、`tool-cordis` API catalog 相同的 Typert AST 扫描产出，并由 `pnpm run verify-cordis-catalog` 保鲜——绝不可手改，本包内也不保留手写事件白名单。

## 设计契约

Mount 期可达性按 tier 推导而非白名单：事件可受管当且仅当它出现在生成的 harness 词表（`@deepseek-ai/dsh-*` 声明）中；继承 tier（`internal/*`、hmr、loader、exit）不在词表里，因此报 `event-not-mountable`。声明的 `reads`/`writes`/`appends` 属性名与 intercept `returns` 分支都对照同一投影的事件真实返回类型解析，所以 `writes: ['modle']` 的拼写错误在 mount 期失败，而不是静默地什么都不排序。

mount 期覆盖规则刻意具体化：file-access grant 按模式蕴含（`write` ⊇ `read`）与路径边界前缀覆盖声明条目；network grant 按 scheme/host 边界前缀覆盖声明 URL（`https://example.dev` 覆盖 `https://example.dev/api`，但不覆盖 `https://example.dev.evil/`）。运行时的 `..`/symlink 规范化与 allowlist 执行落在 `env.fs`/`env.fetch` 边界（#16），执行的是授予集而非声明集：超出 grants 的请求在主机读/写或网络活动之前被拒，`state-rejected` 的 capture 按 16.4 告警并走 replace 步 3 失败路径。

所有消息与机读 details 都来自 `@deepseek-ai/dsh-mygo-api` 的 `PluginError` 模板；本包对 §16.2 各码不自行措辞。

排序与 plan 判定是已验证安装集（`PlanState`）的纯函数：安装史、config 行序、import 解析序与任何时序都不进入判定。scope 集、slot 分类（`slotKinds`，未知 slot 默认为 `chain-ordered`）与 manager 之外的持有槽位（`heldOutsideManager`）是调用方从自身运行时快照提供的显式输入。

Dispatch 必须容器化，因为容器化是上限成立的前提（§7）：Cordis 的 `Events.emit` 无 try-catch，抛错的受管 listener 会否决 dispatcher 并饿死同伴。机器持有唯一真实注册，每次 dispatch 只走一个不可变数组快照（PO:244），dispose 无残留（PO:245）。

生命周期引擎把每个 generation 视为不可变的 `{manifest, code, resolvedConfig}` 快照，历史受 `historyKeep` 约束。所有运行时 effect 都经 dispatch 机器与 manager 持有的 provide/tool 表，因此 go-live 永不跑插件代码：status 指针写完后（replace 第 ⑤ 步后）崩溃，新代就是持久化的当前代，T4 boot 路径会重挂它；generation 行与指针之间崩溃留下孤儿，由 boot GC 回收。staging 跨 scope 原子——每个现存 scope 都建成后才交换任何数组；任一失败所有 scope 停在旧代。manager 持有的 `provide` 值原位替换，不变的能力不卸载 dependents；消失的 provide 先过依赖检查（`dependent-exists`）。工具名全局唯一：staging 断言拒绝重名，被换掉的工具名在 go-live 释放，因此热交换永不发 `tools/change`、不扰动 `schemas()` 序（HP:137）。

#17 持久化层让注册表按 profile 持久化。写序遵守 T3：创建类操作（install/enable/replace）先 runtime commit，写 generation 行，再翻 status 指针（`persist-failed` 补偿）；删除类操作（uninstall/disable）persist 先行。两次写之间的断电要么留下 boot GC 可收的孤儿 generation，要么新指针已持久——boot 恢复会重挂它。boot 恢复（T4）逐行对照当前环境全量重校验，并报告 restored / shadowed / quarantined（validation-failed、damaged-record、package-not-resolvable）/ gc 行；介质级损坏按类销毁并单次重开（`medium-reset`，入审计）。disabled 行完整恢复：manifest 不挂载地重挂，`plugins()` 显示声明且依赖边成立；`enable` 在恢复代上挂载并恢复状态快照。状态快照先于 status 指针写入（T3 规则 4），跨 boot 带 hash 校验恢复。配额在 install 期求值（代码 ≤ `maxCodeBytes`、注册表字节投影 ≤ `maxRegistryBytes`、行数 ≤ `maxDynamicPlugins`）。

#18 出厂集成交付让 manager 成真的 bundle 行：`dsh-base` 增 storage / storage-sqlite / storage-domain / dsh-mygo 四行，domain 默认路由翻到 sqlite（`plugin-state/registry.db`），launcher 导出 `DSH_PROFILE` 供每 profile 注册表 unit 使用。`dsh-web-app` 重述 storage-domain 行：`backend: sqlite` + 显式 `routes` 把 `workspace` 与 `session_projcache` 指到 json，静态具名 domain 保持 json 形状而注册表走 sqlite。引用 `definePlugin` 包的 bundle 行挂载 `toCordisPlugin(definition)`（来自 `@deepseek-ai/dsh-mygo-api`），其 `pluginManager` inject 让条目自我收养为受管静态插件——REAL-composition 套件端到端验证整条链。

PO:243 的零 core 修改性质由组合门禁守护：`verify-runtime-closure`（101 包闭环）与 `verify-cordis-config`；manager 唯一 core 依赖是未修改的 `@deepseek-ai/dsh-mygo-api`。

## 已知限制与暂缓事项

- **`env.on` 没有 options 参数** —— 直传 EventOptions 在 PluginEnv 接缝结构上不可能；任何经 bail 走私的选项由 dispatch 机器以 `unsupported-event-option` 拒绝。
- **serial intercept 必须声明空 `returns` 列表** —— serial 事件没有 decision-union 标签（veto 走 `isBailed` 三分支），因此任何 `returns` 条目都会以 `unknown-property` 失败；获授权的 `intercept: []` 声明才是受支持形状。
- **无 scope 的 npm 包没有受信任路径** —— §15.1 source 联合没有 attestation 字段，因此不带 scope 的 npm 包一律 `provenance-rejected`，除非 `development: true` 以警告绕过。
- **进程内内存配额仍是文档化软限额** —— §18 的 50MB heap 行需要 isolate/worker 边界才能硬执行（SEC:70 hedge）；v1 无此边界，限额只记录不强制。
- **tool claims 与 tool shadowing 在 plan 期预览、在 staging 强制执行** —— 纯模块只见 manifest 声明，plan 预览保持声明只读；引擎（凭 tools.register 桥的注册表知识）在 staging 对工具名强制 `shadow-undeclared` / `claims-unmanaged-incumbent` / `staging-failed`。
- **v1 提示词 section 全局发布** —— scoped `registerPromptSection` 调用会记录 scope，但 manager 向宿主服务发布的是按名归键的 section；按 scope 的提示词 section 是后续集成点。
- **sessionPersistence 写面延后** —— 投影的 `create`/`append` 以具名消息拒绝（REAL 断言）；写面只在第一个需要写会话的受管插件出现时重开，届时再定消费者与权限归属。
- **相交 scope 的两个同 slot claimer 以 `claims-conflict` 拒绝** —— 2026-08-08 回写为 PO 笔记的 claims 成对句补码；tool-claim 成对针对受管 incumbent 由引擎在 staging 强制，针对裸 incumbent 走 `claims-unmanaged-incumbent`。
- **未知 id 的 enable/disable/replace 预演 `plugin-not-found`** —— 2026-08-08 回写新增 caller-bug 码（`<subject>-not-found` 族）；uninstall 仍是文档化的幂等例外。
- **向已存在动态 id 安装预演 `concurrent-operation`** —— 同 id 操作重叠拒绝（HP:150）；静态 incumbent 则接受并带 `wouldShadow: true`。
- **slot 分类在目录上报之前是输入** —— PO:236 的 host-sorted vs chain-ordered 目录上报是后续集成点（#19）；纯函数按给定的 `slotKinds` 消费。
- **机器只 dispatch 派生序中的插件** —— 参与序是 #13 派生的契约；生命周期引擎在每次拓扑提交后刷新序，因此生命周期操作后不会有 live 插件被静默留在序外。
- **scope 键在机器接缝是字符串** —— `scopeKeyOf` 把 dispatch 接收者映射到序使用的字符串键；运行时 `ScopeKey` ↔ 字符串映射是 env 桥的职责（#16）。
- **#14 的 per-plugin CPU 预算全局共享一个值** —— §18 的 per-plugin Config 接线随生命周期/env 阶段到来；机器现阶段只收一个 `cpuBudgetMs`。
- **quarantined 行每次 boot 重校验但仍保持 quarantine** —— 标 `quarantined` 的行会对照当前环境重查；校验通过后仍以 status-only 行可见（空声明），直到操作者 replace 或重装。spec T4-3 的重试措辞在此按保守解释（见 #17 Agent Note）。
- **跨进程操作在重启时收敛** —— sqlite WAL 保证写安全，但第二个进程的 install/uninstall 对运行中的进程不可见；uninstall 与 replace 竞态可在重启时复活插件（`cross-process-resurrected`，T3 Known Limitation）。
- **profile 删除是操作者动作** —— 销毁 domain unit 与删除 `plugin-state/<profile>/` 在组合层（#18）接线，不在引擎内部。
- **`plan()` 已改异步** —— 2026-08-08 裁决 #4：install/replace 的 source 在 plan 内经 manager resolver 解析，纯读、零 staging 副作用（不建 fiber、不跑 hooks、不触碰注册表）；uninstall/enable/disable 的候选声明来自受管记录。临时的 `staging-failed`（stage `plan`）行为已移除。
- **`tool-cordis` 的 cordis_mount/unmount 生命周期路由保持延后** —— 该工具维持 examples-only；挂载裸插件的工具注册在组合 manager 时经桥路由（F2 工具路由关闭），但面向事件声明裸插件的完整 §23.2 声明/权限桥本阶段未接线。
- **inline 源码求值是进程内的** —— 模型所写 inline 代码由服务 resolver 经 `new Function` 执行；上游沙箱化是宿主工具（tool-cordis）的职责，符合决定 #11 的 reference-not-fetch 立场。
- **tools.register 桥关闭 F1/F2** —— 受管工具经每名一条活间接层发布进真实注册表；`schemas()` 序跨 replace 稳定且不发 `tools/change`（REAL-composition 断言），桥接裸插件（含 tool-cordis 沙箱）的工具注册走 manager。剩余 §23.2 面向事件声明插件的权限桥是独立延后项。
- **`ctx.pluginManager` 尚未进入生成的 services catalog（F3 半面）** —— `plugin/*` 事件已收录且词表包含它们；services catalog 漏掉该键是 typert workspace analyzer 的导出解析缝隙。归属：typert generator。触发条件：需要该服务条目的 catalog 消费者，或 analyzer 修复。
- **host-sorted 与 chain-ordered 槽位上报仍是输入面（F4）** —— `slotKinds` 由调用方提供；两类槽位的 catalog 上报延后。归属：PO:236 catalog 上报项。触发条件：槽位分类的 catalog 消费者。
- **REAL 冷模块缓存转录快照未录制（F5）** —— 纯函数输入置换确定性已测；可运行 example 转录（置换 cordis.yml + 冷模块缓存）延后。归属：快照 example 套件。触发条件：example harness 消费者。
- **指向符号链接的 grant 根按其目标解析** —— 真实路径门把配置基路径是符号链接的 grant 解析到目标后放行；grant 只经目标生效，绝不穿过逃逸链接。
- **热交换缓存按事件键控** —— 旧代只在受影响事件有在飞 dispatch 时保留；之后回来 = 对当前同伴集的全新 replace。
