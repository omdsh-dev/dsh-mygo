# 为什么现有 Cordis 插件不能 0day 成为受管插件

[English](why-not-zero-day.md) | 中文

一个在裸组合里能跑的现有 Cordis 插件，不会因为被挂载就自动变成受管插件。本页解释背后的四层契约差异，配[生态兼容性矩阵](plugin-ecosystem-compat.md)里的迁移案例，最后给出直收率最高的写作指引。[插件作者指南](plugin-author-guide.md)是实操教程；本页讲"为什么"。

## 签证 vs 轨距

有两样不同的东西会让插件跑不起来，只有一样关乎权限。**签证**是授权——谁可以进来：`grants`、通道 ceiling、溯源，以及 mount 期组 2 检查。缺签证会在挂载时以具名码拒绝（`grant-missing`、`ceiling-exceeded`、`provenance-rejected`）。**轨距**是运行时语义——拿到许可的插件是否真能跑：manager 的生命周期、声明-执行一致、推导排序、容器化运行时。签证完备的插件仍可能以 `staging-failed` 或 `event-not-mountable` 失败，因为它按另一种轨距造出来的。

迁移桥 `fromCordisPlugin` 转换的是调用约定——裸 `apply` 跑在受限 facade 上——而不是轨距。裸插件是按裸轨写的：注册顺序分发、隐式抛错即否决、经 `ctx.effect` 的任意 teardown、直接 Node 权限。受管轨是声明并强制的，推导监听器顺序，给每个能力上闸。因此 0day 兼容需要两样：签证（声明 + grants）**和**轨距契合（插件的写法能在受管面上表达）。

## 1. 生命周期主权

manager 持有插件的生命周期：generation 先 staging 再 go-live，注册是 manager 持有的声明式 effect，go-live 不运行插件代码，处置达到静默。裸插件用自己的 `ctx.effect` 管 teardown、用 `ctx.inject` 注入服务；facade 两者都没有，因为放出来就等于把生命周期交回插件。

**矩阵案例——`working-activity`。** 它唯一的清理是 `ctx.effect(() => () => clearInterval(tickTimer), 'working-activity tick timer')`（`tests/fixtures/dsh-external/working-activity/src/index.ts:209`）。在 facade 下挂载以 `staging-failed` 失败——先撞上 `ctx.inject`（narrate 注入），effect 缺口是同一道主权边界再往后一步。这是普通 Cordis 用法；受管面只是不提供任意 teardown。

**改造路径。** 把清理表达在声明面上：受管 timer 动词（`ctx.timeout` / `ctx.interval` 一族，tool-cordis 沙箱已经在转发）、`on` / `provide` / `registerTool` 返回的 disposer，或 `deactivate` / `dispose` hooks。清理确实无法声明的插件保持裸形态——非受管共存是声明过的永久边界，不是迁移窗口。守卫版 effect 的 reopen 条件记在 `FIXME(sandbox-effect)`（`packages/cordis/tool-cordis/src/guard.ts:752`）。

## 2. 声明-执行一致

裸轨上语义是隐式的：在 `emit` 监听器里抛错即否决分发、`waterfall` 监听器不调 `next()` 就返回即否决、bail 分支合法。受管轨上这些都必须声明，然后在分发边界强制执行（`next-missing`、`undeclared-veto`、`undeclared-branch`）；manager 无法强制执行的声明只是一句注释。

**矩阵邻接案例——抛错即否决的迁移绊线。** 宿主自己的 `agent/created` 写着「synchronous listener failure vetoes publication」——这是合法的裸轨否决。受管容器里抛错被吞掉，每个监听器每次启动以 `veto-suppressed` 上报一次，带 §23.2 第一步迁移提示，而挂载时没有任何东西失败——插件悄悄失去它可能一直依赖的否决能力。权限 note 把这列为冲突 C 族的迁移绊线（containerized-dispatch 威胁映射，PO:253/264）：裸监听器保留自己的语义，所以迁移审计是操作者的责任，不是运行时的。

**改造路径。** 跑否决审计：grep 裸插件的 `emit` 监听器里是否有故意抛错（`agent/created` 是目录中唯一把「抛错即否决」写成文档的事件）。要么保持裸形态，要么重构到 decision 事件的授予门控 `intercept` 上并声明它可能返回的分支（`returns: ['deny']`）；此后未声明的否决尝试是 `undeclared-veto`，声明过的则合法。

## 3. 排序语义

裸轨上监听器顺序就是注册顺序——组内 import 完成顺序，最好也不过是配置文件行序。受管轨上顺序是推导的：按 scope 对 `reads` / `writes` / `appends` 边做拓扑排序，字典序并列裁决，plan 指名每个位置被挪动的旁观者。未受管监听器保留裸语义，坐在受管链之外；`outermost` 是"受管插件之中最外层"。

**矩阵案例。** 每个矩阵插件都没有声明，所以它们的监听器原样无法进入推导序。`working-activity` 的三个 `ctx.on`（`session/event`、`agent/status`、`session/disposed`）需要匹配的 `observe` 条目才能被安置；"因为先注册所以能跑"的插件在推导序下没有这个保证，而让插件在并列裁决中挪位的改名，在 chain 序槽位上就是字节级输出变化。

**改造路径。** 如实声明 `reads` / `writes` / `appends` 与 `position`；接受推导序和 plan 披露的旁观者挪位；永远不要依赖注册顺序。链首行为用 `position: 'outermost'`，会短路时配 `intercept`（因此需要 grant）。

## 4. 容器化运行时

裸轨上插件代码有完整 Node：`require('fs')`、`require('http')`、每个服务、进程堆。受管轨上文件与网络走 `env.fs` / `env.fetch` 及对应 grants，CPU / effect / logger 配额限制爆炸半径，违规进审计流。

**矩阵案例——`distill`。** 插件在模块作用域从 `node:fs/promises` import `mkdir` / `readFile` / `writeFile`（`tests/fixtures/dsh-external/distill/src/index.ts:25-28`），并用 `homedir()` 解析技能路径。模块作用域的 import 没有任何 `fileAccess` grant 能拦住，所以它被正确拒绝——先以 `event-not-mountable`（`agent/settled` 不在本快照词表），即使修好这一点，边界本身也会拒绝它。

**改造路径。** 把每个 I/O 挪到 `env.fs` / `env.fetch` 与 `fileAccess` / `networkAccess` grants 之后；把需要的服务（`subagents`、`skill`）声明进 `requires`；接受 CPU 预算与审计可见性。直接 I/O 插件在改写之前不在 v1 范围内——这是正确拦截，不是校验过严。

## 怎样写直收率最高

1. **只写声明面。** `definePlugin` manifest 加 hooks；绝不 import Cordis，绝不碰 `ctx.effect` / `ctx.inject`。
2. **只待在 harness 词表内。** 只监听生成目录里的事件；用真实属性名与真实 `returns` 分支声明 `observe` / `transform` / `intercept`。
3. **用受管面清理。** 受管 timer 动词、注册返回的 disposer、或 `deactivate` / `dispose`；不要裸 `setInterval` + effect 配对。
4. **绝不依赖隐式语义。** 不用抛错即否决，不依赖注册顺序，不依赖 import 完成顺序。
5. **I/O 只走 `env.fs` / `env.fetch`**，并声明 grants；不要模块作用域 `node:fs`，不要直连 socket。
6. **分层迁移。** 裸插件 → `fromCordisPlugin`（facade）→ 声明式 manifest；每层验证一次（mount、staging、dispatch、audit）。签证缺口是配置；轨距缺口是重写。

矩阵判定正来自这四层差异：`chat-width` 的宿主壳可直收；`dsh-tool-calculator` 在 tools.register 桥（提案 A）落地后转为直收；`session-chatlog` 经服务映射桥（提案 B）跟进直收；唯一剩余适配案例（`working-activity`）卡在生命周期与排序面；`distill` 卡在词表与运行时边界。没有一个是缺签证被拒——它们全都是按另一种轨距造的。

相关：[插件作者指南](plugin-author-guide.md)、[生态兼容性矩阵](plugin-ecosystem-compat.md)、[权限与排序](../.agents/notes/implemented/architecture/2026-08-05-plugin-permission-levels-and-transform-ordering.md)与[安全](../.agents/notes/implemented/architecture/2026-08-05-plugin-security-and-threat-model.md) Agent Note，以及[容器化分发](../.agents/notes/implemented/architecture/2026-08-08-plugin-manager-containerized-dispatch.md) Agent Note。
