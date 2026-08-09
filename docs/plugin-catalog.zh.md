# 受管插件目录

[English](plugin-catalog.md) | 中文

harness 的受管插件面：`definePlugin` 包经 bundle 行挂载进 manager 后得到什么、可观察的事件，以及可注入的 manager 服务。

## 事件

每个 `plugin/*` 事件（§15.5）都是 observe-only 的 `emit`，收录在 [events catalog](cordis-catalog/events.md) 与 manager 的 mount 期词表：`plugin/installed`、`plugin/activated`、`plugin/deactivated`、`plugin/replacing`、`plugin/replaced`、`plugin/replace-failed`、`plugin/enabled`、`plugin/disabled`、`plugin/uninstalled`。payload 共用 `PluginLifecycleEventPayload` 形状（id、name、version、generation，以及 spec 逐事件点名的可选 `reason`/`error`/`displaced`/`providesPath`）。

## 服务

`ctx.pluginManager` 是 §15.3 操作面（install/uninstall/enable/disable/replace/updateConfig/plugins/plan/adopt），由 `@deepseek-ai/dsh-mygo` 的 `PluginManagerService` 实现。服务按 profile 注册；`dsh-base` 的 `dsh-mygo` 行提供其 config（`profile` 来自 `DSH_PROFILE`、§15.6/§17 字段、`cpuBudgetMs`）。宿主侧审计读方法（`auditSince`/`auditByPlugin`/`auditTail`，T5-4）在服务类上；`PluginEnv` 永不暴露它们。

## 挂载 definePlugin 包

引用 `definePlugin` 包的 bundle 行保持普通 Loader 形状；包的 `toCordisPlugin` 导出（来自 `@deepseek-ai/dsh-mygo-api`）在 mount 期自我收养该条目（`origin: 'static'`，永不持久化）。适配器的 `pluginManager` inject 让 manager 缺席 fail loud。完整契约与剩余已知限制见 dsh-mygo-api 与 dsh-mygo 两份 README。
