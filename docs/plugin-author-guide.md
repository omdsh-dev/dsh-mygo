# Plugin author guide

English | [中文](plugin-author-guide.zh.md)

This guide is for someone writing their first managed plugin for the DeepSeek Harness. You do not need to know Cordis: you declare a manifest and hooks, and the manager (`@deepseek-ai/dsh-mygo`) mounts, orders, quarantines, and persists your plugin for you. The full API reference is generated from the JSDoc in [`mygo-api-reference`](mygo-api-reference.md) — nothing on this page is hand-copied from it.

## 1. What a managed plugin is

A plugin is a plain object: an `id`, a `version`, a `permissions` block that declares what it observes/transforms/intercepts, optional `requires` / `provides` capabilities, and `hooks` (`setup` / `activate` / `deactivate` / `captureState` / `restoreState` / `dispose`). You write it against `@deepseek-ai/dsh-mygo-api` only; the package never imports Cordis. Existing Cordis plugins do not become managed by magic: the four contract differences (lifecycle sovereignty, declared-and-enforced behavior, derived ordering, containerized runtime) and their migration paths are in [why existing plugins are not zero-day](why-not-zero-day.md).

## 2. A minimal plugin

The smallest useful plugin registers an observe listener on a harness event. This exact source is the guarded Example A (see section 7):

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

`permissions.observe` lists the events you listen to; `position` defaults to `derived` (topological order); `swapPolicy: 'immediate'` is the default swap shape. `config` is a schemastery schema — in a package you write `config: z.object({})` from `schemastery`; the inline form above is the same contract.

## 3. Declaring permissions

The `permissions` block has four axes:

| Axis | Meaning |
|---|---|
| `observe` | Listen without returning anything (emit/parallel/serial events). |
| `transform` | Replace part of a waterfall event's payload; must call `next()`. |
| `intercept` | Veto or branch a decision event; `returns` lists every branch you may return. |
| `claims` | Take over a slot (eviction for unscoped, shadowing for scoped); needs `grants.claims`. |

Every declared `transform` / `intercept` / `claims` needs a matching grants entry (section 4). This exact source is the guarded Example B — a delegating deny-only guard on tool pre-execution:

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

`returns` is not free text: the manager validates each branch against the event's decision union at mount time (`unknown-property`).

## 4. Grants configuration

Grants live in the `dsh-mygo` row of your profile's composition, not in the manifest. Without them, an `intercept` declaration fails mount with `grant-missing`:

```yaml
- id: dsh-mygo
  name: '@deepseek-ai/dsh-mygo'
  config:
    profile: default
    grants:
      guard-plugin:
        intercept: true
```

`fileAccess` and `networkAccess` grants follow the same shape; they are the only way a plugin gets filesystem or network capability.

## 5. Common error codes

| Code | When you see it |
|---|---|
| `manifest-invalid` | The manifest failed shape validation (bad id/version/config schema). |
| `event-not-mountable` | You declared an event outside the harness tier (e.g. `internal/*`). |
| `mode-ceiling-exceeded` | `transform`/`intercept` declared on an event whose `@mode` caps lower. |
| `unknown-property` | A `reads`/`writes`/`appends`/`returns` name is not on the event's real type. |
| `non-payload-name` | A well-formed but payload-external name (`service:*`) in a property list. |
| `grant-missing` | You declared `intercept`/`claims`/`fileAccess`/`networkAccess` without a grants entry. |
| `ceiling-exceeded` | The channel ceiling (e.g. model-written) is lower than your declaration. |
| `write-conflict` | Two plugins write the same property on intersecting scopes. |
| `intercept-branch-conflict` | Two interceptors where one may return a non-deny branch. |
| `ordering-cycle` | Your reads/writes edges form a cycle in one scope. |
| `veto-position-conflict` | Two `outermost` interceptors claim the same event. |
| `staging-failed` | `setup`/`activate` threw during staging; the current generation stays live. |
| `fs-denied` / `network-denied` | A runtime capability call outside your grants; thrown before any I/O. |
| `quota-effects-exceeded` | More than 100 listeners / 50 tools / 20 services registered. |

The complete table (36 codes) is in `@deepseek-ai/dsh-mygo-api`'s `PluginErrorCode` and the generated reference.

## 6. Running and testing it

In a package, export `definePlugin(definition)` and let a bundle row mount it through `toCordisPlugin` (see [`plugin-catalog`](plugin-catalog.md)). For a quick try, `ctx.pluginManager.install({ type: 'inline', code: <source> })` installs the inline form above. For unit tests, `createFakeEnv` gives you a recording `PluginEnv` without Cordis.

## 7. These examples are real

Examples A and B are exactly the sources guarded by REAL-composition tests: `packages/cordis/mygo/tests/author-guide.spec.ts` mounts Example A and asserts its listener fires on `tools/change`, and mounts Example B with and without the grants entry (the no-grants boot rejects with `grant-missing`). If the tutorial text drifts from a runnable state, the tests fail.
