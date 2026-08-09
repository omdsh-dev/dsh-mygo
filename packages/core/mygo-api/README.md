# @deepseek-ai/dsh-mygo-api

English | [中文](README.zh.md)

The Cordis-free upper-level plugin contract: `definePlugin`, the manifest and environment types, the `PluginError` vocabulary, and a fake-env test surface. Plugin authors import only this package; the plugin manager (`@deepseek-ai/dsh-mygo`) bridges these declarations into Cordis at mount time. First-time authors start with the [plugin author guide](../../../docs/plugin-author-guide.md); the generated [API reference](../../../docs/mygo-api-reference.md) is the JSDoc-derived source of truth for every export.

## Public API

- `definePlugin(definition)` Identity type carrier for a `PluginDefinition`. It performs no validation — mount-time validation belongs to the manager.
- `PluginDefinition` The v1 manifest: `id`, `version`, `kinds`, `requires`, `provides`, `permissions`, `fileAccess`, `networkAccess`, `stateful`, `swapPolicy`, `config` (a schemastery schema), and `hooks`. `kinds` is an open vocabulary (`/^[a-z][a-z0-9-]*$/`, non-empty); `isolationMode` is deliberately absent from v1.
- `PluginEnv` The capability surface: `logger`, `on`, `scope`, `registerTool`, `registerPromptSection`, `provide`, `get`, `plugins`, `updateConfig`, `fs`, and `fetch`. `get` returns `undefined` for an undeclared capability — service isolation is not an error. Registration methods belong to `activate`; calling them during `setup` throws `setup-registration`.
- `PluginFs`, `Disposable`, and the minimal `Logger` shape handed to plugins.
- `PluginEvents` / `PluginEventName` / `PluginEventListener` The empty base event map follows the repo declaration-merging convention: event-owning packages augment it. Listener signatures follow each event's `@mode`: waterfall listeners end with `next`, emit/parallel/serial listeners do not. Listener options have only the manifest `position` entry; direct EventOptions fail with `unsupported-event-option`.
- `PluginToolDefinition` The minimal structural tool type (name, description, input schema, output schema, execute, render intent). This package does not import the tools package; the manager bridges the structure into the tools registry and revalidates the output schema per generation.
- `PluginHooks` / `DeactivateReason` / `PreviousGeneration` The four executable boundaries: setup forbids registration; `previous` identifies the snapshot's generation (or is `null`); capture state must be JSON-serializable; oversized or unserializable state is rejected, never truncated.
- `PermissionsBlock` / `TransformDeclaration` / `InterceptDeclaration` The §5 declaration block, including `position` (`outermost` | `derived` | `innermost`) and `claims` (`service:<id>` | `tool:<name>`).
- `PluginSource` / `InstallOrigin` / `InstallOptions` The §15.1 dynamic install surface: `inline` code or an `npm` package reference (never fetched), origin `model` | `runtime-api`, and optional initial config.
- `PluginHandleInfo` The §15.2 read-only managed-plugin handle, exported from this package so `plugins()` is the same type on both sides of the bridge.
- `PluginError` / `PluginErrorCode` / `formatPluginError` The single error class and the closed 36-code table in six groups (§16.2). `message` is generated from the code template plus machine-readable `details` and names every "naming X" entity the spec attaches to the code; `pluginId` is required when ownership is known.
- `createFakeEnv` A recording `PluginEnv` for plugin unit tests: seed `requires`/`services`, set `phase` to exercise the setup guard, and drive listeners with `trigger`. `get` returns declared services and `undefined` for undeclared ones.
- `toCordisPlugin(definition)` The §23.1 self-adoption adapter: wraps a managed definition as a structural Cordis function plugin whose `apply` only calls `ctx.pluginManager.adopt`; the `pluginManager` inject makes a missing manager fail loud at mount. `fromCordisPlugin(raw, declaration)` is the migration bridge: the raw plugin's `apply` runs against a restricted facade (`on`/`get`/`provide`/`tools.register`/`systemPrompt.section`/`sessionPersistence`/`logger`) inside the managed `activate`; `tools.register` maps the structural `defineTool` output onto `PluginToolDefinition` (input = compiled `parameters`, output = `output.schema`, generic card render); `systemPrompt.section` maps onto the manager-held prompt-section table; `sessionPersistence` resolves the manager's read-only projection for declared `requires` (write methods physically fail); direct EventOptions reject with `unsupported-event-option` and undeclared `get` stays `undefined` (SEC:86). Both shapes are structural — this package still imports no Cordis.

## Design contract

The author-facing source never imports Cordis; the `./invariant` companion is the one exception, and it is repo machinery rather than part of the plugin surface. Every public type and code is transcribed from the plugin-v1 spec; the message templates are the first finalized wording of §16.2 and are shared by all later manager stages' error assertions.

The fake env implements the env semantics this package owns (undeclared `get` → `undefined`, setup-phase registration guard) and records every call for assertions. It performs no manifest validation and does not implement Cordis dispatch modes: `trigger` invokes registered listeners in registration order, forwarding `next`-style arguments verbatim.

## Known Limitations and Deferred Work

- **No mount-time validation here** — manifest, permission, grant, and ceiling checks belong to the dsh-mygo task; this package stays a type/error surface.
- **`fromCordisPlugin` does not honor the raw plugin's inject list or options surface** — the migration bridge is the managed fiber's guest by design; permissions must be declared by the caller per §5.
- **`PluginToolDefinition` is deliberately minimal** — its exact structural field shapes are this package's own realization of the six spec facets; the manager's bridge maps them into the tools registry vocabulary.
- **The fake `trigger` performs no mode-specific dispatch** — bail/waterfall composition is manager behavior, so tests needing it must invoke listener callbacks directly or wait for the manager implementation.
