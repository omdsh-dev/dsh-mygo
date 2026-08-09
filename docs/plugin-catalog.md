# Managed plugin catalog

English | [中文](plugin-catalog.zh.md)

The harness's managed-plugin surface: what a `definePlugin` package gets once a bundle row mounts it through the manager, the events it can observe, and the manager service it may be injected with.

## Events

Every `plugin/*` event (§15.5) is an observe-only `emit` in the [events catalog](cordis-catalog/events.md) and the manager's mount-time vocabulary: `plugin/installed`, `plugin/activated`, `plugin/deactivated`, `plugin/replacing`, `plugin/replaced`, `plugin/replace-failed`, `plugin/enabled`, `plugin/disabled`, and `plugin/uninstalled`. Payloads share the `PluginLifecycleEventPayload` shape (id, name, version, generation, and the optional `reason` / `error` / `displaced` / `providesPath` extras the spec names per event).

## Service

`ctx.pluginManager` is the §15.3 operation surface (install/uninstall/enable/ disable/replace/updateConfig/plugins/plan/adopt), implemented by `@deepseek-ai/dsh-mygo`'s `PluginManagerService`. The service is registered per profile; the `dsh-mygo` row in `dsh-base` supplies its config (`profile` from `DSH_PROFILE`, the §15.6/§17 fields, `cpuBudgetMs`). Host-side audit readers (`auditSince`/`auditByPlugin`/`auditTail`, T5-4) live on the service class; `PluginEnv` never exposes them.

## Mounting a definePlugin package

A bundle row naming a `definePlugin` package keeps its ordinary Loader shape; the package's `toCordisPlugin` export (from `@deepseek-ai/dsh-mygo-api`) self-adopts the entry at mount (`origin: 'static'`, never persisted). The adapter's `pluginManager` inject makes a missing manager fail loud. See the dsh-mygo-api and dsh-mygo READMEs for the full contract and the remaining known limitations.
