# 插件原生能力总表

[English](plugin-native-capability-catalog.md) | 中文

对裸 Cordis 插件能触达的每一个宿主原生能力做一次普查，逐项归入四分法定性，并立下 manager 对它们统一适用的透传规则。本页是原生能力争议的唯一裁决依据：规则落地后，任何关于原生面的争论都按本表与三问规则裁决，绝不再逐案新开个案桥。

## 枚举方法（证明无漏）

原生面恰好有三个来源，下表每一行都来自其中之一：(1) vendored Cordis ctx 面——`Context` 自有点（`vendor/cordis/src/context.ts:42`）加安装所有混合方法的三行 mixin 声明（`vendor/cordis/src/reflect.ts:219-222`），生成目录的继承层有简明汇总（`docs/cordis-catalog/services.md:2763-2770`）；(2) 生成 harness 目录——46 个 `ctx.<service>` 条目（`docs/cordis-catalog/services.md`）与 harness 事件词表（`docs/cordis-catalog/events.md`）；(3) tool-cordis 沙箱已转发的动词（`packages/cordis/tool-cordis/src/guard.ts:667`）。测试、构建产物、`ScopedLayers.effect` 注册表 API 与内部 `fiber.effect` 绑定按 #24 审计同法剔除；三行 mixin 是混合方法的唯一安装点，因此枚举按构造即完备。`ctx.baseUrl`（被动元数据，见下）与 `Context.is`（静态品牌测试，非插件面向能力）补全自有点清单。

## 定性四分法

1. **可透传·声明即接**——声明路径现成或可加，且无生命周期主权冲突。
2. **需声明式映射**——能力存在但需要策展形态（投影、manager 持有表或受限面）。
3. **主权绑定·不开放**——与生命周期主权冲突（manager 拥有 generation、注册、teardown 与插件集）。`ctx.effect` 在此行终审、不许翻案；`ctx.inject` 因同族理由同入此行。
4. **越界·永不**——绕过一切闸门的通道。

## A. Cordis ctx 面（100% 枚举）

| 能力 | 证据（vendor/目录行号） | 用法证据 | 定性 | 依据 | 三问 |
|---|---|---|---|---|---|
| `ctx.on` | `reflect.ts:222`、`events.ts:288` | working-activity fixture `index.ts:195-199` | 可透传·声明即接（已落地） | `env.on` + 权限词表；dispatch 机器持有真实注册 | permissions.observe/transform/intercept / 机器 disposer / §18 监听器桶 |
| `ctx.once` | `reflect.ts:222`、`events.ts:312` | 无在产用法 | 需声明式映射（无消费者） | 一次性监听需策展自动处置；队列触发条件 = 首个消费者 | 仅触发条件 |
| `ctx.emit` / `parallel` / `serial` / `bail` / `waterfall`（发出侧） | `reflect.ts:222`、`events.ts:194-234` | 宿主服务发出 harness 事件（`tools/src/index.ts:740`、`system-prompt/src/index.ts:324`） | 主权绑定·不开放 | 发出权属宿主词表；沙箱不转发 emit（`guard.ts:667`）；插件发出事件需新声明面 | — |
| `ctx.get` | `reflect.ts:219` | session-chatlog fixture（服务读取） | 可透传·声明即接（已落地） | `env.get` + `requires`（SEC:86） | requires / 无（无状态读取）/ 豁免（非注册） |
| `ctx.set` | `reflect.ts:219` | 沙箱拒绝（`sandbox-context.spec.ts:33`） | 主权绑定·不开放 | 服务仓写权归 manager；沙箱只读 | — |
| `ctx.provide` | `reflect.ts:219` | 宿主 provider（`tool-cordis/tests/helpers.ts` PROVIDER_CODE） | 可透传·声明即接（已落地） | `env.provide` + `provides` + 依赖检查 | provides / manager 持有 provide 表 / §18 服务桶 |
| `ctx.accessor` / `ctx.mixin` | `reflect.ts:219` | 沙箱拒绝（`sandbox-context.spec.ts:34`） | 主权绑定·不开放 | 反射层内幕 | — |
| `ctx.effect` | `reflect.ts:220`、`fiber.ts:420` | working-activity fixture `index.ts:209` | 主权绑定·不开放（终审，不许翻案） | 生命周期主权；`FIXME(sandbox-effect)` `guard.ts:814`；reopen 需 #24 三重条件 | — |
| `ctx.runtime` | `reflect.ts:220` | 仅内部 | 主权绑定·不开放 | fiber 运行期内幕 | — |
| `ctx.inject` | `reflect.ts:221`、`registry.ts:300` | working-activity fixture `index.ts:114` | 主权绑定·不开放（与 effect 同族） | 动态依赖订阅是 fiber 效应所有的生命周期机制；静态 `requires` 已覆盖解析；working-activity 的 narrate 用途可被提案 B 的 `systemPrompt.section` 覆盖 | 替代面提案在队列 |
| `ctx.plugin` | `reflect.ts:221`、`registry.ts:316` | 宿主挂载（`repository-plugin/src/index.ts:98`、`tool-cordis/src/mount.ts:32`） | 主权绑定·不开放 | 插件集归 manager；沙箱拒绝（`sandbox-context.spec.ts:32`） | — |
| `ctx.extend` / `isolate` / `intercept` | `context.ts:99/121/140` | 宿主内部（`core/scope/src/index.ts:60`） | 主权绑定·不开放 | 上下文图变更是框架主权；沙箱拒绝（`sandbox-context.spec.ts:29-31`） | — |
| `ctx.root` / `fiber` / `registry` / `reflect` / `events` | `context.ts:95`、构造 | 沙箱拒绝（`sandbox-context.spec.ts:25-28`） | 主权绑定·不开放 | 环境句柄是框架内幕 | — |
| `ctx.scope` | 继承层（`services.md:2767`） | 沙箱拒绝（`sandbox-context.spec.ts:24`） | 主权绑定·不开放（原生）；受管 `env.scope(agentId)` 已落地 | 原生 scope 变更上下文图；受管 scope 是已声明派生面 | — |
| `ctx.baseUrl` | `context.ts:96` | 被动属性 | 非能力——仅元数据 | URL/模块说明符解析基址；无动作面 | — |
| `ctx.logger` | `context.ts` 构造 | 全仓插件 | 可透传·声明即接（已落地） | `env.logger` + SEC:71 限流 | — / — / 豁免（限流，SEC:71） |
| `ctx.timeout` / `interval` / `setTimeout` / `setInterval` / `throttle` / `debounce` | `vendor/timer/src/index.ts:4,15` | 无在产用法；沙箱已转发（`guard.ts:667`） | 需声明式映射 | 定时器须随 generation 处置（manager 持有）；沙箱先例是 fiber 效应 | facade 动词面（可加）/ manager 持有定时器表随 generation / §18 无桶——落地提案内论证豁免 |
| `ctx.loader` / `ctx.hmr` | 继承层（`services.md:2769-2770`） | 无 | 主权绑定·不开放 | 配置树与 HMR 主权 | — |

## B. harness 服务面（46 个目录服务）

透传规则适用于每个目录服务：解析型服务（`ctx.get`）需要 `requires` 条目加 manager 策展形态；贡献型服务（工具、提示词 section）在 `activate` 期注册、manager 持有贡献。三个已落地、一个矩阵消费者、其余未触发。

| 服务（目录行号） | 定性 | 依据 / 触发条件 |
|---|---|---|
| `ctx.tools`（`services.md:2445`） | 可透传·声明即接（提案 A） | `env.registerTool`；注册表桥 + staging claims/shadow（`lifecycle.ts:162,479,510`） |
| `ctx.systemPrompt`（`services.md:2195`） | 需声明式映射（提案 B） | `registerPromptSection` manager 持有，经 `promptService` 接缝发布（`lifecycle.ts:174,511`） |
| `ctx.sessionPersistence`（`services.md:1185`） | 需声明式映射（提案 B） | 只读投影；写 stub 物理失败（`lifecycle.ts:213,324,976`） |
| 其余 43 个服务 | 需声明式映射（未触发） | 每个点名一行，见 B.1 附录 |
| harness 事件（监听侧） | 可透传·声明即接（已落地） | `env.on` + 生成词表；快照外事件（`agent/settled`）是词表对齐项，不是能力行 |

### B.1 点名附录——43 个未触发服务

以下每个服务都适用 B 节规则且尚无受管消费者：需声明式映射，触发条件 = 首个受管消费者，届时按规则起草提案。无需逐项证据——规则统一，名单必须点名。

| 服务 | 目录行号 | 定性 |
|---|---|---|
| `ctx.agentLoop` | `services.md:12` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.agents` | `services.md:49` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.approval` | `services.md:221` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.bash` | `services.md:267` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.bashEnv` | `services.md:307` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.clientModuleHost` | `services.md:338` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.codeRuntime` | `services.md:382` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.commands` | `services.md:403` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.compact` | `services.md:456` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.credentials` | `services.md:521` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.directoryPicker` | `services.md:567` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.fs` | `services.md:581` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.goals` | `services.md:683` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.httpServer` | `services.md:770` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.invariants` | `services.md:820` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.llm` | `services.md:838` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.permission` | `services.md:964` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.planMode` | `services.md:1016` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.pty` | `services.md:1052` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.sandbox` | `services.md:1134` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.sandboxPolicy` | `services.md:1157` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.sessionProjectionCache` | `services.md:1306` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.sessionProjections` | `services.md:1354` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.sessionQuery` | `services.md:1462` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.sessionReferences` | `services.md:1589` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.sessions` | `services.md:1619` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.sessionTitle` | `services.md:1753` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.settings` | `services.md:1800` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.skills` | `services.md:1885` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.spillStore` | `services.md:1943` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.storage` | `services.md:1966` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.storageDomain` | `services.md:1990` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.subagents` | `services.md:2043` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.subprocess` | `services.md:2170` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.tasks` | `services.md:2251` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.telemetry` | `services.md:2346` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.tokenMeter` | `services.md:2369` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.toolResultPrune` | `services.md:2405` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.typert` | `services.md:2528` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.userInteraction` | `services.md:2589` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.web` | `services.md:2615` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.workflows` | `services.md:2673` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |
| `ctx.workspace` | `services.md:2691` | 需声明式映射（未触发）——B 节规则；触发条件 = 首个受管消费者 |

## C. 越界通道

| 通道 | 证据 | 定性 | 依据 |
|---|---|---|---|
| 模块作用域 `node:fs` / `http` / `child_process` | distill fixture `index.ts:24-28` | 越界·永不 | 模块作用域 import 无 grant 可门控；正确拦截，矩阵行维持 |
| 经服务返回值逃逸的 `Context` | `guard.ts` `denyContext` | 越界·永不 | 任何服务返回 context 时沙箱响亮失败（`sandbox-context.spec.ts:42-90`） |

## 透传总规则

**声明路径，双形态。** 可透传能力必须回答其一：(a) 解析型——`requires` 条目，经 `env.get` 解析、由 manifest 门控；(b) 贡献型——`activate` 期注册调用本身即声明，经 staging 校验与配额门控（`registerTool`、`registerPromptSection`、`on`）。没有声明路径的能力不透传，自动降级为"需声明式映射"。

**处置归谁。** 每个贡献注册都归 manager 持有并随 generation 释放：dispatch 机器持有监听器 disposer，工具注册表桥与提示词 section 表持有各自 disposer，uninstall / replace 丢弃 / 补偿 / 引擎 dispose 都同步发布状态（`lifecycle.ts:510-511,1202-1203`）。无状态解析（`get` 投影）无需处置；有状态订阅（定时器、动态 inject）必须 manager 持有，否则保持关闭。

**配额挂哪。** 注册进 §18 三桶：监听器 / 工具 / 服务；提示词 section 共享工具（贡献）桶。纯解析（`get`）与 `env.logger` 豁免，因为不是注册（SEC:71 已限流 logger）。新面（定时器）在落地提案中论证桶或豁免。

**降级规则。** 三问答不出者从"可透传"降级为"需声明式映射"；主权冲突或闸门绕过者绝不桥接——分别归"不开放"或"越界"。

## 实例验证（任务 1.3）

| 案例 | 声明路径 | 处置 | 配额 | 结论 |
|---|---|---|---|---|
| A：`ctx.tools.register` | 注册即声明（`activate`），staging 校验（`lifecycle.ts:162`） | 工具注册表 disposer 随 uninstall/replace/补偿/dispose 同步（`lifecycle.ts:510,1202`） | §18 工具桶（50） | 满足规则；"注册即声明"是规则的贡献型形态，此处记为规则澄清而非个案追认 |
| B：`ctx.systemPrompt.section` | 注册即声明（`lifecycle.ts:174`） | 提示词 section disposer 随 uninstall/replace/补偿/dispose 同步（`lifecycle.ts:511,1203`） | §18 贡献桶（工具） | 满足规则 |
| B：`ctx.sessionPersistence` | `requires: ['sessionPersistence']`（SEC:86） | 无需——只读投影，无状态 | 豁免（解析，非注册） | 满足规则 |

`ctx.inject` 定性主权绑定·不开放（A 节）——working-activity 的 narrate 用途进队列的声明式替代提案；`distill` 的直接 I/O 维持"越界·永不"（矩阵行不变）。

## 缺口提案队列（任务 1.4）

每项是一份标准三件套提案，等待裁决流程；本阶段不实现任何一项。

| 提案标题 | 消费者 | 定性引用 |
|---|---|---|
| 受管 timer 动词（`timeout`/`interval`/`setTimeout`/`setInterval`/`throttle`/`debounce`） | working-activity 定时器清理（fixture `index.ts:203,209`） | A `ctx.timer` 行——需声明式映射 |
| 声明式提示词 section 贡献（manifest 字段替代 `ctx.inject` narrate） | working-activity narrate（fixture `index.ts:114`） | A `ctx.inject` 行——主权绑定·不开放；替代面 |
| 受管一次性监听（`ctx.once`） | 暂无（触发条件） | A `ctx.once` 行——需声明式映射 |
| sessionPersistence 写面（`create`/`append`） | 暂无（首个受管写消费者） | B `ctx.sessionPersistence` 行——写面延后，响亮 stub 已落地 |
| 快照外事件词表对齐（`agent/settled`） | distill（拒收案例） | B harness 事件行——词表对齐项，非能力透传 |
| catalog C 节 ↔ B.1 附录交叉提示（文档） | catalog 读者 | 非阻塞，随词表对齐项一并处理——在 C 节与 B.1 附录之间加交叉引用，区分目录服务 `ctx.fs` / `ctx.subprocess` 与越界裸 `node:fs` / `child_process` |

未触发：其余 43 个目录服务与事件总线发出侧没有受管消费者；它们不是缺口，消费者出现前不占队列。

相关：[插件作者指南](plugin-author-guide.md)、[生态兼容性矩阵](plugin-ecosystem-compat.md)、[为什么现有插件不能 0day](why-not-zero-day.md)，以及[权限与排序](../.agents/notes/implemented/architecture/2026-08-05-plugin-permission-levels-and-transform-ordering.md)与[安全](../.agents/notes/implemented/architecture/2026-08-05-plugin-security-and-threat-model.md) Agent Note。
