# Plugin native capability catalog

English | [中文](plugin-native-capability-catalog.zh.md)

One audit of every host-native capability a raw Cordis plugin can touch, each classified into one of four verdicts, with the passthrough rule the manager applies to all of them. This page is the single authority for native-capability disputes: after it lands, every future argument about a native surface is decided against this table and the three-question rule, never by a new one-off bridge.

## Enumeration method (proof of no omission)

The native surface has exactly three sources, and every row below comes from one of them: (1) the vendored Cordis ctx surface — `Context`'s own members (`vendor/cordis/src/context.ts:42`) plus the three mixin declarations that install every mixed-in method (`vendor/cordis/src/reflect.ts:219-222`), summarized tersely in the generated catalog's inherited tier (`docs/cordis-catalog/services.md:2763-2770`); (2) the generated harness catalog — 46 `ctx.<service>` entries (`docs/cordis-catalog/services.md`) and the harness event vocabulary (`docs/cordis-catalog/events.md`); (3) the tool-cordis sandbox's forwarded verbs (`packages/cordis/tool-cordis/src/guard.ts:667`). Tests, built output, the `ScopedLayers.effect` registry API, and internal `fiber.effect` bindings are excluded by the same method as the #24 audit; the three mixin lines are the only installation point for mixed-in methods, so the enumeration is exhaustive by construction. `ctx.baseUrl` (passive metadata, row below) and `Context.is` (static brand test, not a plugin-facing capability) complete the own-member inventory.

## Verdicts

1. **Passthrough, declared** — a declaration path exists or is addable and no lifecycle-sovereignty conflict exists.
2. **Needs declarative mapping** — the capability exists but needs a curated form (projection, manager-held table, or bounded surface).
3. **Sovereignty-bound, closed** — conflicts with lifecycle sovereignty (manager owns generation, registration, teardown, and the plugin set). `ctx.effect` is final here and must not be reopened; `ctx.inject` joins it for the same family of reasons.
4. **Out of bounds, never** — a channel that bypasses every gate.

## A. Cordis ctx surface (100% enumerated)

| Capability | Evidence (vendor/catalog lines) | Usage evidence | Verdict | Basis | Three questions |
|---|---|---|---|---|---|
| `ctx.on` | `reflect.ts:222`, `events.ts:288` | working-activity fixture `index.ts:195-199` | Passthrough, declared (shipped) | `env.on` + permission vocabulary; dispatch machine owns real registrations | permissions.observe/transform/intercept / machine disposer / §18 listener bucket |
| `ctx.once` | `reflect.ts:222`, `events.ts:312` | none in production | Needs declarative mapping (no consumer) | one-shot listener needs curated auto-disposal; queue trigger = first consumer | trigger only |
| `ctx.emit` / `parallel` / `serial` / `bail` / `waterfall` (emitting side) | `reflect.ts:222`, `events.ts:194-234` | host services emit harness events (`tools/src/index.ts:740`, `system-prompt/src/index.ts:324`) | Sovereignty-bound, closed | emission authority belongs to the host vocabulary; the sandbox forwards no emit (`guard.ts:667`); plugin-originated events need a new declared surface | — |
| `ctx.get` | `reflect.ts:219` | session-chatlog fixture (service reads) | Passthrough, declared (shipped) | `env.get` + `requires` (SEC:86) | requires / none (stateless read) / exempt (not a registration) |
| `ctx.set` | `reflect.ts:219` | sandbox denial (`sandbox-context.spec.ts:33`) | Sovereignty-bound, closed | service-store writes belong to the manager; sandbox is read-only | — |
| `ctx.provide` | `reflect.ts:219` | host providers (`tool-cordis/tests/helpers.ts` PROVIDER_CODE) | Passthrough, declared (shipped) | `env.provide` + `provides` + dependent check | provides / manager-held provide table / §18 service bucket |
| `ctx.accessor` / `ctx.mixin` | `reflect.ts:219` | sandbox denial (`sandbox-context.spec.ts:34`) | Sovereignty-bound, closed | reflection internals | — |
| `ctx.effect` | `reflect.ts:220`, `fiber.ts:420` | working-activity fixture `index.ts:209` | Sovereignty-bound, closed (final — do not reopen) | lifecycle sovereignty; `FIXME(sandbox-effect)` `guard.ts:814`; reopen requires the #24 triple condition | — |
| `ctx.runtime` | `reflect.ts:220` | internal only | Sovereignty-bound, closed | fiber runtime internals | — |
| `ctx.inject` | `reflect.ts:221`, `registry.ts:300` | working-activity fixture `index.ts:114` | Sovereignty-bound, closed (same family as effect) | dynamic dependency subscription is a fiber-effect-owned lifecycle mechanism; static `requires` already covers resolution; working-activity's narrate use is coverable by Proposal B's `systemPrompt.section` | replacement-surface proposal in the queue |
| `ctx.plugin` | `reflect.ts:221`, `registry.ts:316` | host mounting (`repository-plugin/src/index.ts:98`, `tool-cordis/src/mount.ts:32`) | Sovereignty-bound, closed | the plugin set is the manager's authority; sandbox denies (`sandbox-context.spec.ts:32`) | — |
| `ctx.extend` / `isolate` / `intercept` | `context.ts:99/121/140` | host internals (`core/scope/src/index.ts:60`) | Sovereignty-bound, closed | context-graph mutation is framework authority; sandbox denies (`sandbox-context.spec.ts:29-31`) | — |
| `ctx.root` / `fiber` / `registry` / `reflect` / `events` | `context.ts:95`, constructor | sandbox denial (`sandbox-context.spec.ts:25-28`) | Sovereignty-bound, closed | ambient handles are framework internals | — |
| `ctx.scope` | inherited tier (`services.md:2767`) | sandbox denial (`sandbox-context.spec.ts:24`) | Sovereignty-bound, closed (native); managed `env.scope(agentId)` is shipped | native scope mutates the context graph; managed scope is the declared derived surface | — |
| `ctx.baseUrl` | `context.ts:96` | passive property | Not a capability — metadata only | URL/module specifier resolution base; no action surface | — |
| `ctx.logger` | `context.ts` constructor | all in-repo plugins | Passthrough, declared (shipped) | `env.logger` + SEC:71 rate limit | — / — / exempt (rate-limited, SEC:71) |
| `ctx.timeout` / `interval` / `setTimeout` / `setInterval` / `throttle` / `debounce` | `vendor/timer/src/index.ts:4,15` | none in production; sandbox forwards (`guard.ts:667`) | Needs declarative mapping | timers must be disposed with the generation (manager-held); sandbox precedent is fiber-effect-owned | facade verb surface (addable) / manager-held timer table per generation / no §18 bucket — exemption argued in the landing proposal |
| `ctx.loader` / `ctx.hmr` | inherited tier (`services.md:2769-2770`) | none | Sovereignty-bound, closed | config-tree and HMR authority | — |

## B. Harness service surface (46 catalog services)

The passthrough rule applies to every catalog service: resolving services (`ctx.get`) needs a `requires` entry plus a manager-curated form; contributing services (tools, prompt sections) register during `activate` and the manager holds the contribution. Three services are shipped, one is a matrix consumer, and the rest are un-triggered.

| Service (catalog line) | Verdict | Basis / trigger |
|---|---|---|
| `ctx.tools` (`services.md:2445`) | Passthrough, declared (Proposal A) | `env.registerTool`; registry bridge + staging claims/shadow (`lifecycle.ts:162,479,510`) |
| `ctx.systemPrompt` (`services.md:2195`) | Needs declarative mapping (Proposal B) | `registerPromptSection` manager-held, published via `promptService` seam (`lifecycle.ts:174,511`) |
| `ctx.sessionPersistence` (`services.md:1185`) | Needs declarative mapping (Proposal B) | read-only projection; write stubs physically fail (`lifecycle.ts:213,324,976`) |
| remaining 43 services | Needs declarative mapping (un-triggered) | named one per row in the B.1 appendix below |
| harness events (the listener side) | Passthrough, declared (shipped) | `env.on` + generated vocabulary; events outside the snapshot (`agent/settled`) are a vocabulary-alignment item, not a capability row |

### B.1 Named appendix — the 43 un-triggered services

Every service below is covered by the Section B rule and has no managed consumer yet: needs declarative mapping, trigger = the first managed consumer, proposal drafted per the rule. No per-service evidence is required — the rule is uniform, the list is named.

| Service | Catalog line | Verdict |
|---|---|---|
| `ctx.agentLoop` | `services.md:12` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.agents` | `services.md:49` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.approval` | `services.md:221` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.bash` | `services.md:267` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.bashEnv` | `services.md:307` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.clientModuleHost` | `services.md:338` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.codeRuntime` | `services.md:382` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.commands` | `services.md:403` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.compact` | `services.md:456` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.credentials` | `services.md:521` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.directoryPicker` | `services.md:567` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.fs` | `services.md:581` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.goals` | `services.md:683` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.httpServer` | `services.md:770` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.invariants` | `services.md:820` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.llm` | `services.md:838` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.permission` | `services.md:964` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.planMode` | `services.md:1016` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.pty` | `services.md:1052` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.sandbox` | `services.md:1134` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.sandboxPolicy` | `services.md:1157` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.sessionProjectionCache` | `services.md:1306` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.sessionProjections` | `services.md:1354` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.sessionQuery` | `services.md:1462` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.sessionReferences` | `services.md:1589` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.sessions` | `services.md:1619` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.sessionTitle` | `services.md:1753` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.settings` | `services.md:1800` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.skills` | `services.md:1885` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.spillStore` | `services.md:1943` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.storage` | `services.md:1966` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.storageDomain` | `services.md:1990` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.subagents` | `services.md:2043` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.subprocess` | `services.md:2170` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.tasks` | `services.md:2251` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.telemetry` | `services.md:2346` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.tokenMeter` | `services.md:2369` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.toolResultPrune` | `services.md:2405` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.typert` | `services.md:2528` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.userInteraction` | `services.md:2589` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.web` | `services.md:2615` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.workflows` | `services.md:2673` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |
| `ctx.workspace` | `services.md:2691` | Needs declarative mapping (un-triggered) — Section B rule; trigger = first managed consumer |

## C. Out-of-bounds channels

| Channel | Evidence | Verdict | Basis |
|---|---|---|---|
| module-scope `node:fs` / `http` / `child_process` | distill fixture `index.ts:24-28` | Out of bounds, never | no grant can gate a module-scope import; correct interception, matrix row keeps it |
| a `Context` escaped through a service return value | `guard.ts` `denyContext` | Out of bounds, never | the sandbox fails loud when any service returns a context (`sandbox-context.spec.ts:42-90`) |

## Passthrough rule

**Declaration path, two forms.** A passthrough capability must answer one of two: (a) resolving capability — a `requires` entry, resolved by `env.get` and gated by the manifest; (b) contributing capability — the registration call itself during `activate` is the declaration, validated at staging and quota-gated (`registerTool`, `registerPromptSection`, `on`). A capability with no declaration path is not passed through; it degrades to "needs declarative mapping".

**Disposal ownership.** Every contributed registration is manager-held and released with the generation: the dispatch machine holds listener disposers, the tool registry bridge and prompt-section table hold their disposers, and uninstall / replace-drop / compensation / engine dispose all sync the published state (`lifecycle.ts:510-511,1202-1203`). Stateless resolutions (`get` projections) need no disposal; stateful subscriptions (timers, dynamic inject) must be manager-held or they stay closed.

**Quota bucket.** Registrations land in the §18 buckets: listeners / tools / services; prompt sections share the tools (contribution) bucket. Pure resolutions (`get`) and `env.logger` are exempt because they are not registrations (SEC:71 bounds the logger). New surfaces (timers) argue a bucket or an exemption in their landing proposal.

**Degradation.** A capability that cannot answer all three questions degrades from "passthrough" to "needs declarative mapping". A sovereignty conflict or a gate bypass is never bridged: it is closed or out of bounds, respectively.

## Instance verification (Task 1.3)

| Case | Declaration path | Disposal | Quota | Result |
|---|---|---|---|---|
| A: `ctx.tools.register` | registration-as-declaration (`activate`), staging-validated (`lifecycle.ts:162`) | tool registry disposers synced on uninstall/replace/compensate/dispose (`lifecycle.ts:510,1202`) | §18 tools bucket (50) | Satisfies the rule; "registration-as-declaration" is the rule's contribution form, recorded here as rule clarification, not case-specific |
| B: `ctx.systemPrompt.section` | registration-as-declaration (`lifecycle.ts:174`) | prompt-section disposers synced on uninstall/replace/compensate/dispose (`lifecycle.ts:511,1203`) | §18 contribution bucket (tools) | Satisfies the rule |
| B: `ctx.sessionPersistence` | `requires: ['sessionPersistence']` (SEC:86) | none needed — read-only projection, stateless | exempt (resolution, not registration) | Satisfies the rule |

`ctx.inject` is classified sovereignty-bound, closed (Section A) — the working-activity narrate use is the queue's declaration-based replacement proposal, and `distill` stays "out of bounds, never" for its direct I/O (matrix row unchanged).

## Gap proposal queue (Task 1.4)

Each item is a standard triplet proposal awaiting the ruling flow; nothing here is implemented in this phase.

| Proposal title | Consumer | Classification reference |
|---|---|---|
| Managed timer verbs (`timeout`/`interval`/`setTimeout`/`setInterval`/`throttle`/`debounce`) | working-activity timer cleanup (`fixture index.ts:203,209`) | A `ctx.timer` row — needs declarative mapping |
| Declared prompt-section contributions (manifest field replacing `ctx.inject` narration) | working-activity narrate (`fixture index.ts:114`) | A `ctx.inject` row — sovereignty-bound, closed; replacement surface |
| Managed one-shot listener (`ctx.once`) | none yet (trigger) | A `ctx.once` row — needs declarative mapping |
| sessionPersistence write surface (`create`/`append`) | none yet (first managed write consumer) | B `ctx.sessionPersistence` row — write side deferred, loud stubs shipped |
| Vocabulary alignment for events outside the snapshot (`agent/settled`) | distill (rejected case) | B harness-events row — vocabulary-alignment item, not a capability passthrough |
| Catalog C ↔ B.1 cross-hint (documentation) | catalog readers | non-blocking, handled with the vocabulary-alignment item — add a cross-reference between Section C and the B.1 appendix distinguishing catalog services `ctx.fs` / `ctx.subprocess` from the out-of-bounds raw `node:fs` / `child_process` |

Un-triggered: the remaining 43 catalog services and the emission side of the event bus have no managed consumer; they are not gaps and do not occupy the queue until a consumer appears.

Related: [plugin author guide](plugin-author-guide.md), [ecosystem compatibility matrix](plugin-ecosystem-compat.md), [why existing plugins are not zero-day](why-not-zero-day.md), and the [permission and ordering](../.agents/notes/implemented/architecture/2026-08-05-plugin-permission-levels-and-transform-ordering.md) / [security](../.agents/notes/implemented/architecture/2026-08-05-plugin-security-and-threat-model.md) Agent Notes.
