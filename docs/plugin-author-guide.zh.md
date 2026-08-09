# 插件作者指南

[English](plugin-author-guide.md) | 中文

本指南面向第一次给 DeepSeek Harness 写受管插件的作者。你不需要懂 Cordis：你声明 manifest 与 hooks，manager（`@deepseek-ai/dsh-mygo`）负责挂载、排序、quarantine 与持久化。完整 API 参考由 [`mygo-api-reference`](mygo-api-reference.md) 从 JSDoc 生成——本页没有任何手抄内容。

## 1. 受管插件是什么

插件是一个普通对象：`id`、`version`、声明 observe/transform/intercept 的 `permissions` 块、可选的 `requires`/`provides` 能力，以及 `hooks`（`setup`/`activate`/`deactivate`/`captureState`/`restoreState`/`dispose`）。你只面向 `@deepseek-ai/dsh-mygo-api` 写代码；该包永不导入 Cordis。

现有 Cordis 插件不会因为被挂载就自动变成受管插件：四层契约差异（生命周期主权、声明-执行一致、推导排序、容器化运行时）与对应迁移路径见[为什么现有插件不能 0day](why-not-zero-day.md)。

## 2. 最小插件

最小可用的插件在 harness 事件上注册 observe listener。以下源码就是受 REAL 测试守护的示例 A（见第 7 节）：

```js
module.exports = {
  id: 'hello-plugin',
  version: '1.0.0',
  kinds: ['example'],
  requires: [],
  provides: [],
  permissions: { observe: ['tools/change'], transform: [], intercept: [], position: 'derived', claims: [] },
  stateful: false,
  swapPolicy: 'immediate',
  config: () => ({}),
  hooks: {
    activate(env) {
      env.on('tools/change', () => {
        ;(globalThis.__authorHello ??= { count: 0 }).count += 1
      })
    },
  },
}
```

`permissions.observe` 列出你要监听的事件；`position` 默认 `derived`（拓扑序）；`swapPolicy: 'immediate'` 是默认换代形状。`config` 是 schemastery schema——在包里写 `config: z.object({})`（来自 `schemastery`）；上面的 inline 形式是同一契约。

## 3. 声明权限

`permissions` 块有四个轴：

| 轴 | 含义 |
|---|---|
| `observe` | 只监听、不返回值（emit/parallel/serial 事件）。 |
| `transform` | 替换 waterfall 事件 payload 的一部分；必须调 `next()`。 |
| `intercept` | 否决或分支 decision 事件；`returns` 列出你所有可能返回的分支。 |
| `claims` | 接管槽位（unscoped 为 eviction，scoped 为 shadowing）；需要 `grants.claims`。 |

每个声明的 `transform`/`intercept`/`claims` 都需要匹配的 grants 条目（第 4 节）。以下源码就是受 REAL 测试守护的示例 B——工具预执行上的委派型 deny-only 守卫：

```js
module.exports = {
  id: 'guard-plugin',
  version: '1.0.0',
  kinds: ['example'],
  requires: [],
  provides: [],
  permissions: {
    observe: [],
    transform: [],
    intercept: [{ event: 'tools/pre-execute', returns: ['deny'] }],
    position: 'derived',
    claims: [],
  },
  stateful: false,
  swapPolicy: 'immediate',
  config: () => ({}),
  hooks: {
    activate(env) {
      env.on('tools/pre-execute', (_payload, next) => {
        ;(globalThis.__authorGuard ??= { count: 0 }).count += 1
        // Delegating guard: call next() to allow; return { kind: 'deny' } to veto.
        return next()
      })
    },
  },
}
```

`returns` 不是自由文本：manager 在 mount 期对照事件的 decision union 校验每个分支（`unknown-property`）。

## 4. grants 配置

grants 放在 profile 组合的 `dsh-mygo` 行里，不在 manifest 中。没有它，`intercept` 声明会在 mount 期以 `grant-missing` 失败：

```yaml
- id: dsh-mygo
  name: '@deepseek-ai/dsh-mygo'
  config:
    profile: default
    grants:
      guard-plugin:
        intercept: true
```

`fileAccess` 与 `networkAccess` grants 同形；它们是插件获得文件/网络能力的唯一途径。

## 5. 常见错误码速查

| 码 | 何时出现 |
|---|---|
| `manifest-invalid` | manifest 形状校验失败（id/version/config schema 错误）。 |
| `event-not-mountable` | 声明了 harness tier 之外的事件（如 `internal/*`）。 |
| `mode-ceiling-exceeded` | 在 `@mode` 上限更低的事件上声明 `transform`/`intercept`。 |
| `unknown-property` | `reads`/`writes`/`appends`/`returns` 名字不在事件真实类型上。 |
| `non-payload-name` | 属性列表里出现良构但 payload 外的名字（`service:*`）。 |
| `grant-missing` | 声明了 `intercept`/`claims`/`fileAccess`/`networkAccess` 却没有 grants 条目。 |
| `ceiling-exceeded` | 通道 ceiling（如模型通道）低于你的声明。 |
| `write-conflict` | 两插件在相交 scope 写同一属性。 |
| `intercept-branch-conflict` | 两个 interceptor 中有一方可能返回非 deny 分支。 |
| `ordering-cycle` | 你的 reads/writes 边在某 scope 成环。 |
| `veto-position-conflict` | 两个 `outermost` interceptor 争同一事件。 |
| `staging-failed` | `setup`/`activate` 在 staging 期抛错；当前代保持 live。 |
| `fs-denied` / `network-denied` | 运行时能力调用越出 grants；在任何 I/O 之前抛出。 |
| `quota-effects-exceeded` | 注册超过 100 listener / 50 tool / 20 service。 |

完整码表（36 码）在 `@deepseek-ai/dsh-mygo-api` 的 `PluginErrorCode` 与生成的参考文档里。

## 6. 运行与测试

在包里导出 `definePlugin(definition)`，让 bundle 行经 `toCordisPlugin` 挂载（见 [`plugin-catalog`](plugin-catalog.md)）。想快速尝试时，`ctx.pluginManager.install({ type: 'inline', code: <源码> })` 安装上面的 inline 形式。单元测试用 `createFakeEnv` 获得记录型 `PluginEnv`，不需要 Cordis。

## 7. 这些示例是真的

示例 A 与 B 正是受 REAL-composition 测试守护的源码：`packages/cordis/mygo/tests/author-guide.spec.ts` 挂载示例 A 并断言其 listener 在 `tools/change` 上触发，挂载示例 B 分别带/不带 grants 条目（无 grants 的 boot 以 `grant-missing` 拒绝）。教程文字一旦漂移到不可运行状态，测试就会失败。
