# Plugin ecosystem compatibility matrix

English | [中文](plugin-ecosystem-compat.zh.md)

This matrix records how existing Cordis plugins from the `dsh-external` organization run under the v1 managed plugin surface. Each candidate was cloned at a pinned commit and exercised **zero-modification**: the plugin's own source is never edited, `fromCordisPlugin` wraps it with a caller-supplied §5 declaration, and the manager adopts the result in a REAL Loader composition. The runnable guard is [`ecosystem-compat.spec.ts`](../packages/cordis/mygo/tests/ecosystem-compat.spec.ts); fixture provenance (repositories and commits) lives in [`PROVENANCE.md`](../packages/cordis/mygo/tests/fixtures/dsh-external/PROVENANCE.md).

The matrix is deliberately not archived or finalized: it feeds the v1.1 direction decision. Every "needs wrapper" or "rejected" row states a root-cause class — a facade-coverage gap on our side (candidates for v1.1 review) or a plugin-boundary violation (correctly intercepted). The four contract differences behind these verdicts are explained in [why existing plugins are not zero-day](why-not-zero-day.md).

## Verdicts

| Plugin | Source repo (pinned commit) | Category | Verdict | Root-cause class |
|---|---|---|---|---|
| `chat-width` | `dsh-external/chat-width` `9ab48d6` | UI enhancement | **Direct-accept (host shell)**; function lives in the unhosted client half | Harness scope gap: the node half is an intentional no-op and the width engine ships in the `dshClient` browser half, which v1 does not host (client-half face; v1.1 candidate, not over-strict validation) |
| `working-activity` | `dsh-external/dsh-working-activity` `aa00794` | UI / status line | **Needs wrapper** | Harness facade gap: `fromCordisPlugin`'s restricted facade has no `ctx.inject` (narrate section); mount rejects with `staging-failed`. The timer cleanup is lifecycle-sovereignty territory, not a facade gap ([why-not-zero-day §1](why-not-zero-day.md#1-lifecycle-sovereignty)) |
| `session-chatlog` | `dsh-external/session-chatlog` `5c2a344` | Status summary / tools | **Direct-accept via the service-mapping bridge (Proposal B)** | Harness bridge shipped: `ctx.tools.register` (Proposal A), `ctx.systemPrompt.section` (manager-held prompt-section registration), and `ctx.sessionPersistence` (read-only projection; write calls physically fail) all map through the facade. The plugin's direct-`node:fs` tolerant-parse fallback stays on the direct-I/O boundary — the primary service path works, the fallback is unavailable under managed semantics |
| `dsh-tool-calculator` | `dsh-external/dsh-tool-calculator` `fa79a1f` | Tool | **Direct-accept via the tools.register bridge (Proposal A)** | Harness bridge shipped: the facade's `ctx.tools.register` maps `defineTool` output onto `PluginToolDefinition`, and the registry bridge publishes the tool through the manager. The plugin's `name` is also a scoped package name (`@deepseek-ai/dsh-tool-calculator`), which the §5 declaration normalizes to the kebab-case v1 id |
| `distill` | `dsh-external/distill` `75a7615` | Autonomy / skill distillation | **Rejected** | Correct interception: `agent/settled` is outside this snapshot's generated harness vocabulary (`event-not-mountable`); the plugin also reads/writes `SKILL.md` through direct `node:fs` (bypassing the `env.fs` grant boundary), forks subagents, and materializes skills — surfaces v1 deliberately does not admit |

Direct-accept: **3/5** — chat-width's host shell, calculator through the tools.register bridge (Proposal A), and session-chatlog through the service-mapping bridge (Proposal B). The remaining two are one wrapper (`working-activity`) and one rejection (`distill`).

## Real guard output

The spec's five cases are the matrix's evidence; the rejection lines below are the actual `PluginError` values observed while developing the guard:

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

## Root-cause review list (v1.1 candidates)

1. **`fromCordisPlugin` facade coverage** — `ctx.tools.register` (Proposal A) and `ctx.systemPrompt`/`ctx.sessionPersistence` (Proposal B) now map through declared surfaces; the only remaining gap is `ctx.inject` (`working-activity`'s narrate section), which needs declaration-derived injection rather than honoring the raw inject list. `ctx.effect` is deliberately not on this list: the #24 design memo evaluated a managed effect shape and kept the surface closed (`FIXME(sandbox-effect)`), because the only mount-side effect usage is timer cleanup that managed timer verbs already cover ([why-not-zero-day §1](why-not-zero-day.md#1-lifecycle-sovereignty)).
2. **Client-half hosting** — `chat-width` shows the largest UI class cannot deliver behavior through the node half. The `dshClient` / `dsh.plugin.json` `client` declaration (ecosystem-review conflict #4) needs an explicit v1.1 face or an explicit out-of-scope statement with a migration path.
3. **Vocabulary source alignment** — `agent/settled` exists in the ecosystem harness surface but not in this snapshot's generated event vocabulary. The manager correctly rejects it (`event-not-mountable`), but v1.1 should state how the generated vocabulary tracks harness event versions.
4. **Tool bridge and publication** — closed by Proposal A: the `defineTool` → `PluginToolDefinition` mapping ships on the facade, the registry bridge publishes one live indirection per managed tool (F1 `schemas()` order stable across replace, no `tools/change`, REAL-asserted), and the tool-cordis sandbox routes through the manager when composed (F2 tool route). Remaining: the §23.2 declaration/permission bridge for event-declaring raw plugins, and a non-generic tool card render (the mapping drops dsh-tools render functions).
5. **Direct-I/O plugins** — `distill` uses `node:fs` at module scope, which no grant can gate. Correctly out of scope today; v1.1 migration guidance must spell out the rewrite to `env.fs` and the "install = full trust today" default (ecosystem-review §五.5).
6. **Service mapping bridge (Proposal B)** — closed: `systemPrompt.section` is a manager-held prompt-section registration published into the host service (disposed with the generation), and `sessionPersistence` resolves as a read-only projection whose write methods physically fail (`create`/`append` reject with a named message — REAL-asserted). Remaining: session-chatlog's `node:fs` tolerant-parse fallback (direct-I/O boundary, documented in the row), and the sessionPersistence write surface, which reopens only when the first managed write consumer appears.
