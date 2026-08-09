# Why existing Cordis plugins are not zero-day managed plugins

English | [中文](why-not-zero-day.zh.md)

An existing Cordis plugin that worked in a raw composition does not become a managed plugin by being mounted. This page explains the four contract differences behind that, with the migration cases from the [ecosystem compatibility matrix](plugin-ecosystem-compat.md), and ends with the authoring guidance that gives the highest direct-accept rate. The [plugin author guide](plugin-author-guide.md) is the practical tutorial; this page is the "why".

## Visa vs track gauge

Two different things keep a plugin from running, and only one of them is about permission. **Visa** is authorization — who may enter: `grants`, channel ceilings, provenance, and the mount-time group-2 checks. A missing visa rejects at mount with a named code (`grant-missing`, `ceiling-exceeded`, `provenance-rejected`). **Track gauge** is runtime semantics — whether a plugin that *is* allowed can actually run: the manager's lifecycle, declared-and-enforced behavior, derived ordering, and containerized runtime. A plugin with a perfect visa can still fail with `staging-failed` or `event-not-mountable` because it was built for a different gauge.

The migration bridge `fromCordisPlugin` converts the calling convention — the raw `apply` runs against a restricted facade — but not the gauge. A raw plugin was written against the raw track: registration-order dispatch, implicit throw-as-veto, arbitrary teardown through `ctx.effect`, and direct Node access. The managed track is declared and enforced, derives listener order, and gates every capability. Zero-day compatibility therefore needs both: a visa (declaration plus grants) **and** a gauge fit (the plugin's patterns must be expressible on the managed surface).

## 1. Lifecycle sovereignty

The manager owns the plugin's lifecycle: a generation is staged before it goes live, registrations are declared effects the manager holds, go-live never runs plugin code, and disposal reaches quiescence. A raw plugin owns its own teardown through `ctx.effect` and may inject services through `ctx.inject`; neither exists on the facade, because both would hand the lifecycle back to the plugin.

**Matrix case — `working-activity`.** Its only cleanup is `ctx.effect(() => () => clearInterval(tickTimer), 'working-activity tick timer')` (`tests/fixtures/dsh-external/working-activity/src/index.ts:209`). Under the facade the mount fails at `staging-failed` — first on `ctx.inject` (the narrate section), and the effect gap is the same sovereignty boundary one step later. The plugin is ordinary Cordis usage; the managed surface simply does not offer arbitrary teardown.

**Migration path.** Express cleanup on declared surfaces: managed timer verbs (`ctx.timeout` / `ctx.interval` family, which the tool-cordis sandbox already forwards), disposers returned by `on` / `provide` / `registerTool`, or the `deactivate` / `dispose` hooks. A plugin whose cleanup genuinely cannot be declared keeps its raw form — unmanaged coexistence is a permanent, stated boundary, not a migration window. The guarded-effect reopen condition is recorded at `FIXME(sandbox-effect)` in `packages/cordis/tool-cordis/src/guard.ts:752`.

## 2. Declared-and-enforced behavior

On the raw track, semantics are implicit: throwing inside an `emit` listener vetoes the dispatch, a `waterfall` listener that returns without `next()` vetoes, and a bail branch is legal. On the managed track every one of those must be declared and is then enforced at the dispatch boundary (`next-missing`, `undeclared-veto`, `undeclared-branch`); a declaration the manager cannot enforce is a comment.

**Matrix-adjacent case — the throw-veto migration tripwire.** The host's own `agent/created` documents "synchronous listener failure vetoes publication"; that is a legitimate raw-track veto. Under the managed container the throw is swallowed once per listener per boot as `veto-suppressed` with the §23.2 step-1 migration hint, and nothing fails at mount — the plugin silently loses a veto it may have relied on. The permission note names this as the conflict-C family tripwire (containerized-dispatch threat mapping, PO:253/264): raw listeners keep their own semantics, so the migration audit is the operator's, not the runtime's.

**Migration path.** Run the veto audit: grep the raw plugin's `emit` listeners for intentional throws (`agent/created` is the catalog's one documented veto-by-throw). Either keep the plugin raw, or restructure onto a decision event's grant-gated `intercept` declaring the branches it may return (`returns: ['deny']`); an undeclared veto attempt is then `undeclared-veto`, and a declared one is legal.

## 3. Ordering semantics

On the raw track, listener order is registration order — import-completion order inside a group, config line order at best. On the managed track, order is derived: `reads` / `writes` / `appends` edges per scope, topologically sorted with a lexicographic tie-break, and a plan that names every bystander whose position moves. Unmanaged listeners keep raw semantics and sit outside the managed chain; `outermost` means outermost among managed plugins.

**Matrix case.** Every matrix plugin ships without declarations, so none of their listeners can enter the derived order as-is. `working-activity`'s three `ctx.on` calls (`session/event`, `agent/status`, `session/disposed`) need matching `observe` entries to be placed at all; a plugin that "worked because it registered first" has no such guarantee under the derived order, and a rename that moves a plugin in the tie-break is a byte-level output change on chain-ordered slots.

**Migration path.** Declare `reads` / `writes` / `appends` and `position` truthfully; accept the derived order and the plan-disclosed bystander displacement; never rely on registration order. Head-of-chain behavior uses `position: 'outermost'`, with `intercept` (and thus a grant) when the plugin may short-circuit.

## 4. Containerized runtime

On the raw track, plugin code has full Node: `require('fs')`, `require('http')`, every service, the process heap. On the managed track, filesystem and network go through `env.fs` / `env.fetch` and their grants, CPU / effect / logger quotas bound the blast radius, and violations land in the audit stream.

**Matrix case — `distill`.** The plugin imports `mkdir` / `readFile` / `writeFile` from `node:fs/promises` at module scope (`tests/fixtures/dsh-external/distill/src/index.ts:25-28`) and resolves skill paths from `homedir()`. No `fileAccess` grant can gate a module-scope import, so the plugin is correctly rejected — first by `event-not-mountable` (`agent/settled` is outside this snapshot's vocabulary), and by the boundary itself even if that were fixed.

**Migration path.** Move every I/O to `env.fs` / `env.fetch` behind `fileAccess` / `networkAccess` grants; declare the services it needs (`subagents`, `skill`) as `requires`; expect CPU budgets and audit visibility. A direct-I/O plugin is out of v1 scope until rewritten — that is correct interception, not over-strict validation.

## Writing for the highest direct-accept rate

1. **Write only the declared surface.** `definePlugin` manifest plus hooks; never import Cordis, never touch `ctx.effect` / `ctx.inject`.
2. **Stay inside the harness vocabulary.** Listen only to events in the generated catalog; declare `observe` / `transform` / `intercept` with real property names and real `returns` branches.
3. **Clean up through managed surfaces.** Managed timer verbs, disposers returned by registrations, or `deactivate` / `dispose`; no bare `setInterval` + effect pairing.
4. **Never rely on implicit semantics.** No throw-as-veto, no registration-order dependence, no import-completion order.
5. **Do all I/O through `env.fs` / `env.fetch`** with grants declared; no module-scope `node:fs`, no direct sockets.
6. **Migrate in layers.** Raw plugin → `fromCordisPlugin` (facade) → declared manifest; verify at each layer (mount, staging, dispatch, audit). A visa gap is config; a gauge gap is a rewrite.

The matrix verdicts follow from these four differences: `chat-width`'s host shell is direct-acceptable, `dsh-tool-calculator` became direct-acceptable when the tools.register bridge (Proposal A) shipped, `session-chatlog` followed through the service-mapping bridge (Proposal B), the one remaining wrapper case (`working-activity`) fails on lifecycle and ordering surfaces, and `distill` fails on vocabulary and runtime boundaries. None of them was rejected for wanting a visa; all of them were built for a different gauge.

Related: [plugin author guide](plugin-author-guide.md), [ecosystem compatibility matrix](plugin-ecosystem-compat.md), the [permission and ordering](../.agents/notes/implemented/architecture/2026-08-05-plugin-permission-levels-and-transform-ordering.md) and [security](../.agents/notes/implemented/architecture/2026-08-05-plugin-security-and-threat-model.md) Agent Notes, and the [containerized-dispatch](../.agents/notes/implemented/architecture/2026-08-08-plugin-manager-containerized-dispatch.md) Agent Note.
