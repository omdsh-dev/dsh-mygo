# 插件生态兼容性矩阵

[English](plugin-ecosystem-compat.md) | 中文

本矩阵记录 `dsh-external` 组织现有 Cordis 插件在 v1 受管插件面下的运行结果。每个候选插件都在固定 commit 克隆，并做**零修改**验证：插件自身源码从不改动，`fromCordisPlugin` 用调用方提供的 §5 声明包装它，manager 在 REAL Loader 组合中收养结果。可重跑守卫是 [`ecosystem-compat.spec.ts`](../packages/cordis/mygo/tests/ecosystem-compat.spec.ts)；fixture 来源（仓库与 commit）见 [`PROVENANCE.md`](../packages/cordis/mygo/tests/fixtures/dsh-external/PROVENANCE.md)。

矩阵刻意不收尾、不定稿：它服务于 v1.1 方向决策。每个"适配"或"拒收"行都给出根因类别——我方 facade 覆盖缺口（v1.1 回议候选）或插件越界（正确拦截）。

这些判定背后的四层契约差异见[为什么现有插件不能 0day](why-not-zero-day.md)。

## 判定结果

| 插件 | 来源仓库（固定 commit） | 类别 | 判定 | 根因分类 |
|---|---|---|---|---|
| `chat-width` | `dsh-external/chat-width` `9ab48d6` | UI 增强 | **直收（宿主半身）**；功能在未托管的 client half | 我方 scope 缺口：node 半身是刻意空实现，宽度引擎在 `dshClient` 浏览器半身，v1 不托管（client half 面；v1.1 候选，非校验过严） |
| `working-activity` | `dsh-external/dsh-working-activity` `aa00794` | UI / 状态行 | **适配（需 wrapper）** | 我方 facade 缺口：`fromCordisPlugin` 受限 facade 没有 `ctx.inject`（narrate 注入）；挂载以 `staging-failed` 拒绝。定时器清理属生命周期主权域，不是 facade 缺口（[why-not-zero-day §1](why-not-zero-day.md#1-lifecycle-sovereignty)） |
| `session-chatlog` | `dsh-external/session-chatlog` `5c2a344` | 状态总结 / 工具 | **经服务映射桥直收（提案 B）** | 我方桥已落地：`ctx.tools.register`（提案 A）、`ctx.systemPrompt.section`（manager 持有的提示词 section 注册）、`ctx.sessionPersistence`（只读投影；写调用物理失败）都经 facade 映射。插件直接 `node:fs` 的容忍式回退解析仍在直接 I/O 边界上——主服务路径可用，回退在受管语义下不可用 |
| `dsh-tool-calculator` | `dsh-external/dsh-tool-calculator` `fa79a1f` | 工具 | **经 tools.register 桥直收（提案 A）** | 我方桥已落地：facade 的 `ctx.tools.register` 把 `defineTool` 输出映射到 `PluginToolDefinition`，注册表桥把工具经 manager 发布。插件的 `name` 还是带 scope 的包名（`@deepseek-ai/dsh-tool-calculator`），§5 声明把它规范为 kebab-case v1 id |
| `distill` | `dsh-external/distill` `75a7615` | 自治 / 技能蒸馏 | **拒收** | 正确拦截：`agent/settled` 不在本快照生成的 harness 词表（`event-not-mountable`）；插件还通过直接 `node:fs` 读写 `SKILL.md`（绕过 `env.fs` grant 边界）、fork subagent、落盘技能——这些面 v1 明确不收容 |

直收：**3/5**——chat-width 的宿主半身、calculator 经 tools.register 桥（提案 A）、session-chatlog 经服务映射桥（提案 B）。剩下两个是 1 个 wrapper（`working-activity`）与 1 个拒收（`distill`）。

## 真实守卫输出

spec 的五个用例是矩阵证据；下面拒收行是开发守卫时观测到的真实 `PluginError`：

```text
== chat-width == ADOPT_OK
== dsh-working-activity == code=staging-failed
message=staging failed at staging: TypeError: ctx.inject is not a function
details={"stage":"staging","cause":"TypeError: ctx.inject is not a function"}
== session-chatlog == ADOPT_OK (service-mapping bridge, Proposal B)
== write-probe == code=staging-failed
message=staging failed at staging: Error: sessionPersistence.create is not available to managed plugins in v1 (write surface deferred; Proposal B)
details={"stage":"staging","cause":"Error: sessionPersistence.create is not available to managed plugins in v1 (write surface deferred; Proposal B)"}
== dsh-tool-calculator == ADOPT_OK (tools.register bridge, Proposal A)
registry: ctx.tools.schemas() lists calculator; replace keeps the position with no tools/change (F1/F2 REAL guards)
== distill == code=event-not-mountable
message=event agent/settled is not mountable: outside harness tier harness
details={"event":"agent/settled","tier":"harness"}
```

## 根因回议清单（v1.1 候选）

1. **`fromCordisPlugin` facade 覆盖**——`ctx.tools.register`（提案 A）与 `ctx.systemPrompt`/`ctx.sessionPersistence`（提案 B）都已经声明面映射；唯一剩余缺口是 `ctx.inject`（`working-activity` 的 narrate 注入），它需要声明派生的注入而非 honoring 裸 inject 列表。`ctx.effect` 刻意不在清单里：#24 设计备忘录评估过受管 effect 形态后维持不开放（`FIXME(sandbox-effect)`），因为唯一挂载侧 effect 用法是受管 timer 动词已覆盖的定时器清理（[why-not-zero-day §1](why-not-zero-day.md#1-lifecycle-sovereignty)）。
2. **Client half 托管**——`chat-width` 说明最大 UI 类无法通过 node 半身交付行为。`dshClient` / `dsh.plugin.json` 的 `client` 声明（生态评审冲突点 #4）需要 v1.1 显式面，或显式 out-of-scope 声明加迁移路径。
3. **词表来源对齐**——`agent/settled` 存在于生态 harness 面，但不在本快照生成的事件词表。manager 正确拒绝（`event-not-mountable`），但 v1.1 应说明生成词表如何跟踪 harness 事件版本。
4. **工具桥与发布面**——提案 A 已关闭：`defineTool` → `PluginToolDefinition` 映射随 facade 落地，注册表桥为每个受管工具发布一条活间接层（F1 `schemas()` 序跨 replace 稳定、无 `tools/change`，REAL 断言），tool-cordis 沙箱在组合 manager 时经桥路由（F2 工具路由）。剩余：面向事件声明裸插件的 §23.2 声明/权限桥，以及非通用工具卡 render（映射丢弃 dsh-tools 的 render 函数）。
5. **直接 I/O 插件**——`distill` 在模块作用域用 `node:fs`，任何 grant 都门不住。今天正确排除；v1.1 迁移指引必须写明改写为 `env.fs` 以及"安装即全信任"默认（生态评审 §五.5）。
6. **服务映射桥（提案 B）**——已关闭：`systemPrompt.section` 是 manager 持有的提示词 section 注册（随 generation 处置），`sessionPersistence` 解析为只读投影，写方法物理失败（`create`/`append` 以具名消息拒绝——REAL 断言）。剩余：session-chatlog 的 `node:fs` 容忍式回退解析（直接 I/O 边界，已记入行），以及 sessionPersistence 写面——只在第一个受管写消费者出现时重开。
