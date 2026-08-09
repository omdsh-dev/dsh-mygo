/**
 * Type-only contract surface of `@deepseek-ai/dsh-mygo-api`: the plugin
 * manifest, environment, hooks, permissions, sources, and handle types
 * transcribed from the plugin-v1 spec (§2, §3, §4, §5, §15.1-2). This module
 * deliberately contains no runtime code and no import of `cordis`; the plugin
 * manager bridges these declarations into Cordis at mount time.
 * @module @deepseek-ai/dsh-mygo-api/src/types
 */

import type Schema from 'schemastery'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** A schemastery schema, the manifest config DSL every harness plugin shares. */
export type Schemastery = Schema

/** File-access mode vocabulary: `write` implies `read` on the same path. */
export type FileAccessMode = 'read' | 'write'

/** One file-access entry `[mode, path]` declared by a plugin or granted by a deployment. */
export type FileAccessEntry = readonly [mode: FileAccessMode, path: string]

/**
 * The upper-level plugin manifest. Plugin authors never import Cordis; the
 * manager validates and bridges this declaration at mount time. `isolationMode`
 * is intentionally absent from v1 (`'process'` is a future field with no
 * consumer).
 */
export interface PluginDefinition {
  /** Plugin id; the registry key and event-payload identity, matching `/^[a-z][a-z0-9-]*$/`. */
  readonly id: string
  /** Display and generation-identity version in semver shape (no semantic consumption in v1). */
  readonly version: string
  /**
   * Open classification vocabulary (`/^[a-z][a-z0-9-]*$/`, non-empty entries);
   * catalogs group by value and classify unseen values as `other`.
   */
  readonly kinds: string[]
  /** Cordis service ids this plugin consumes; an entry containing `@` is reserved (`capability-range-reserved`). */
  readonly requires: string[]
  /** Service ids this plugin provides; the manager holds the `provide` registrations. */
  readonly provides: string[]
  /** Declared event permissions and position (§5). */
  readonly permissions: PermissionsBlock
  /**
   * Custom event names this plugin may observe or emit. Entries are exact
   * names (emit mode, observe-only) or `namespace/*` prefix patterns that
   * declare an open extension-to-extension bus (for example `pi-ext/*`).
   * The manager adds declared events to the dispatch vocabulary at mount
   * and lazily materializes pattern members at first listener/emit; names
   * and namespaces that collide with the harness vocabulary are rejected.
   */
  readonly events?: readonly string[]
  /** File paths and modes the plugin may access; `write` implies `read` on the same path. */
  readonly fileAccess?: FileAccessEntry[]
  /** URL allowlist for `env.fetch`; absent denies all network access. */
  readonly networkAccess?: { readonly allow: string[] }
  /** Env-var names this plugin may read/write through `env.vars`; absent denies all variable access. */
  readonly varsAccess?: readonly string[]
  /** Model-call access: optional model allowlist for `env.llm`; absent denies all model calls. */
  readonly llmAccess?: { readonly models?: readonly string[] }
  /** Subprocess access: executable-name allowlist for `env.exec`; absent denies all subprocess calls. */
  readonly execAccess?: { readonly allow: readonly string[] }
  /** HTTP route access: path allowlist for `env.http.register`; absent denies all route registrations. */
  readonly httpAccess?: { readonly routes?: readonly string[] }
  /** Client-half declaration for UI plugins (browser bundle entry + host injections). */
  readonly client?: PluginClientDeclaration
  /** Declares that the plugin writes sessions through `sessionPersistence.create/append`; requires the `sessionWrite` grant. */
  readonly sessionWriteAccess?: boolean
  /** Declares that provided services are published into the host context; requires the `hostPublish` grant. */
  readonly hostPublishAccess?: boolean
  /** Declares that the plugin may dynamically install/uninstall other plugins through `env.plugins.install/uninstall`; requires the `dynamicInstall` grant. */
  readonly dynamicInstallAccess?: boolean
  /** Whether the plugin participates in capture/restore state handoff. */
  readonly stateful: boolean
  /** State-handoff quiescence policy for replace; the chain swap itself is always atomic. */
  readonly swapPolicy: 'immediate' | 'drain' | 'next-idle'
  /** Schemastery schema validating the resolved install/updateConfig config. */
  readonly config: Schemastery
  /** Lifecycle hooks (§4). */
  readonly hooks: PluginHooks
}

/**
 * The capability surface the manager hands to a plugin. Registration methods
 * belong to `activate` only; calling them during `setup` throws
 * `setup-registration`.
 */
export interface PluginEnv {
  /** Rate-limited logger (1000 lines/minute in the manager); excess is dropped and reported via `warn`. */
  readonly logger: Logger
  /**
   * Register one listener for a managed event. The listener signature follows
   * the event's `@mode`: emit/parallel/serial listeners take the payload
   * without a `next` argument; waterfall listeners take `next` as their last
   * parameter. Listener options have no per-registration entry point — the
   * manifest `position` is the only option surface, and direct EventOptions
   * fail with `unsupported-event-option`.
   * @param event - managed event name declared in `PluginEvents`.
   * @param listener - dispatch listener whose parameter shape matches the event's mode.
   * @returns a disposer removing the listener.
   */
  on<E extends PluginEventName>(event: E, listener: PluginEventListener<E>): Disposable
  /**
   * Register one teardown disposer for the plugin generation. Raw Cordis
   * plugins call this through `ctx.effect`; the manager runs every collected
   * disposer when the generation is released (replace/uninstall/dispose).
   * @param disposer - synchronous teardown callback.
   * @param name - optional human-readable label for diagnostics.
   */
  effect(disposer: () => void, name?: string): void
  /**
   * Emit one plugin-declared custom event (an exact `events` entry or a
   * name matching a declared `namespace/*` pattern). The emit routes through
   * the dispatch machine so managed listeners and real host listeners fire;
   * emitting an event outside the plugin's declarations throws
   * `emit-denied` before any dispatch.
   * @param event - custom event name to emit.
   * @param payload - optional event payload.
   */
  emit(event: string, payload?: unknown): void
  /**
   * Register one prompt section through the manager-held contribution table;
   * the manager publishes it into the host systemPrompt service and disposes
   * it with the generation.
   * @param section - the section to register.
   * @returns a disposer removing the contribution.
   */
  registerPromptSection(section: PluginPromptSection): Disposable
  /**
   * Derive an agent-scoped env whose registrations are visible only to that agent.
   * @param agentId - session id of the target agent scope.
   * @returns an env scoped to the agent.
   */
  scope(agentId: SessionId): PluginEnv
  /**
   * Register one tool definition; registration belongs to `activate`.
   * @param definition - minimal structural tool definition bridged into the tools registry.
   * @returns a disposer removing the tool.
   */
  registerTool(definition: PluginToolDefinition): Disposable
  /**
   * Read one registered tool's current definition (manager-held table).
   * @param name - tool name.
   * @returns the live definition, or `undefined` when not registered.
   */
  getTool(name: string): PluginToolDefinition | undefined
  /**
   * List every currently registered tool definition.
   * @returns the live definitions in registration order.
   */
  listTools(): readonly PluginToolDefinition[]
  /**
   * Provide a service value; the manager holds the underlying Cordis provide.
   * @param capability - service id this plugin declares in `provides`.
   * @param value - service implementation value.
   * @returns a disposer removing the service.
   */
  provide(capability: string, value: unknown): Disposable
  /**
   * Resolve one capability the plugin declared in `requires`. An undeclared
   * capability returns `undefined` — that is service isolation, not an error,
   * and carries no error code.
   * @param capability - service id to resolve.
   * @returns the service value, or `undefined` when undeclared or unavailable.
   */
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T is the caller-chosen service type at each call site.
  get<T>(capability: string): T | undefined
  /**
   * The raw host context the plugin runs inside. Zero-intrusion plugins
   * resolve undeclared capabilities and host verbs through this object; the
   * facade forwards unknown `ctx.*` properties here.
   */
  readonly host: unknown
  /** Read-only view of the current managed plugin set (§15.2). */
  plugins(): readonly PluginHandleInfo[]
  /**
   * Install one dynamic plugin (inline/npm source) through the manager.
   * Requires the deployment `dynamicInstall` grant (declared via
   * `dynamicInstallAccess`); without it the call throws `install-denied`.
   * @param source - inline or npm plugin source.
   * @param options - initial config (validated against the manifest schema).
   * @returns the installed plugin handle.
   */
  install(source: PluginSource, options?: InstallOptions): Promise<PluginHandleInfo>
  /**
   * Uninstall a dynamically installed plugin by id.
   * @param id - plugin id to uninstall.
   */
  uninstall(id: string): Promise<void>
  /**
   * Hot-config update for this plugin, routed through the replace path.
   * @param patch - config patch validated against the manifest config schema.
   * @returns a promise settling after the update commits.
   */
  updateConfig(patch: unknown): Promise<void>
  /** File access surface (host passthrough; no grant gating). */
  readonly fs: PluginFs
  /**
   * Network fetch surface (host passthrough; no grant gating).
   * @param url - URL to fetch.
   * @param init - standard fetch options.
   * @returns the fetched response.
   */
  fetch(url: string, init?: RequestInit): Promise<Response>
  /**
   * Environment-variable surface backed by the host process environment.
   */
  readonly vars: PluginVars
  /**
   * Model-call surface backed by the host LLM seam; a call with no host seam
   * fails loudly.
   */
  readonly llm: PluginModel
  /**
   * Subprocess surface backed by the host subprocess seam; a call with no
   * host seam fails loudly.
   */
  readonly exec: PluginExec
  /**
   * HTTP route-registration surface; routes are staged and disposed with the
   * generation.
   */
  readonly http: PluginHttp
  /**
   * Skill-contribution surface: `registerSkill` stages a managed skill with
   * the generation and publishes it into the host skills registry when a
   * host seam is present. Registration belongs to `activate`.
   */
  readonly skills: PluginSkills
  /**
   * Slash-command surface: `register` stages a command with the generation
   * and publishes it into the host commands service when a host seam is
   * present. Registration belongs to `activate`.
   */
  readonly commands: PluginCommands
}

/** Env-var capability exposed through `PluginEnv.vars`; denial precedes any host access. */
export interface PluginVars {
  /**
   * Read one environment variable within the granted vars set.
   * @param name - variable name to read.
   * @returns the current value, or `undefined` when unset.
   */
  get(name: string): string | undefined
  /**
   * Set one environment variable within the granted vars set.
   * @param name - variable name to write.
   * @param value - value to set.
   */
  set(name: string, value: string): void
}

/** One model message in the managed request dialect. */
export interface PluginModelMessage {
  /** Message role label (user/assistant/system or provider-specific). */
  readonly role: string
  /** Message text content. */
  readonly content: string
}

/** Managed model-call request; the provider route is a host wiring concern. */
export interface PluginModelRequest {
  /** Model name the deployment's `llmAccess` allowlist checks against. */
  readonly model: string
  /** Ordered conversation messages. */
  readonly messages: readonly PluginModelMessage[]
  /** Sampling temperature, when the host route supports it. */
  readonly temperature?: number
  /** Completion token ceiling, when the host route supports it. */
  readonly maxTokens?: number
}

/** Managed model-call response (text completion). */
export interface PluginModelResponse {
  /** Assembled text content of the completion. */
  readonly content: string
  /** Model that produced the completion, when the host reports it. */
  readonly model?: string
  /** Token usage reported by the host route, when available. */
  readonly usage?: { readonly promptTokens?: number; readonly completionTokens?: number }
}

/** Model-call capability exposed through `PluginEnv.llm`; denial precedes the host call. */
export interface PluginModel {
  /**
   * Run one model completion through the managed surface.
   * @param request - model request to complete.
   * @returns the assembled text completion.
   */
  complete(request: PluginModelRequest): Promise<PluginModelResponse>
}

/** Managed subprocess request; the executable name is the grant-checked unit. */
export interface PluginExecRequest {
  /** Executable name (basename is grant-checked; the host resolves PATH or absolute paths). */
  readonly command: string
  /** Arguments passed to the executable. */
  readonly args?: readonly string[]
  /** Text written to the child's stdin (bounded host-side); omitted means no stdin. */
  readonly stdin?: string
  /** Working directory for the child process. */
  readonly cwd?: string
  /** Execution deadline in milliseconds; defaults host-side (bounded). */
  readonly timeoutMs?: number
  /** Cancellation signal that aborts the process tree. */
  readonly signal?: AbortSignal
}

/** Managed subprocess result. */
export interface PluginExecResult {
  /** Captured stdout text. */
  readonly stdout: string
  /** Captured stderr text. */
  readonly stderr: string
  /** Exit code; -1 when the process died from a signal. */
  readonly code: number
  /** Raw stdout bytes when the host seam captured them (encoding-aware consumers). */
  readonly stdoutBytes?: Uint8Array
  /** Raw stderr bytes when the host seam captured them (encoding-aware consumers). */
  readonly stderrBytes?: Uint8Array
}

/** Subprocess capability exposed through `PluginEnv.exec`; denial precedes any spawn. */
export interface PluginExec {
  /**
   * Run one command through the managed surface.
   * @param request - command request to execute.
   * @returns captured stdout/stderr and the exit code.
   */
  run(request: PluginExecRequest): Promise<PluginExecResult>
}

/** HTTP methods a managed route may claim; `*` matches any method. */
export type PluginHttpMethod =
  | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | '*'

/** One managed HTTP request delivered to a route handler. */
export interface PluginHttpRequest {
  /** HTTP method of the request. */
  readonly method: string
  /** Pathname (query string excluded). */
  readonly path: string
  /** Original request URL (query string preserved); omitted when the host seam cannot attribute one. */
  readonly url?: string
  /** Request headers. */
  readonly headers: Readonly<Record<string, string>>
  /** Request body text (bounded host-side). */
  readonly body: string
}

/** One managed HTTP response returned by a route handler. */
export interface PluginHttpResponse {
  /** HTTP status code. */
  readonly status: number
  /** Response body; objects are serialized as JSON, bytes are written verbatim. */
  readonly body?: string | Record<string, unknown> | Uint8Array
  /** Response headers. */
  readonly headers?: Readonly<Record<string, string>>
}

/** One managed HTTP route registration. */
export interface PluginHttpRouteSpec {
  /** HTTP method this route claims; `*` matches any method. */
  readonly method: PluginHttpMethod
  /** Absolute pathname without a trailing slash. */
  readonly path: string
  /** `exact` matches the pathname verbatim; `prefix` matches it and any subpath. */
  readonly kind?: 'exact' | 'prefix'
  /** Route handler owning the response. */
  readonly handler: (request: PluginHttpRequest) => PluginHttpResponse | Promise<PluginHttpResponse>
}

/** HTTP route-registration capability exposed through `PluginEnv.http`; denial precedes staging. */
export interface PluginHttp {
  /**
   * Register one route for the plugin generation.
   * @param spec - route to register (registration belongs to `activate`).
   * @returns a disposer removing the route.
   */
  register(spec: PluginHttpRouteSpec): Disposable
}

/** One managed skill contribution. */
export interface PluginSkillDefinition {
  /** Kebab-case skill identifier used by discovery consumers. */
  readonly name: string
  /** Short routing description. */
  readonly description: string
  /** Markdown instruction body loaded by the registry on demand. */
  readonly content: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
}

/** Skill-contribution capability exposed through `PluginEnv.skills`. */
export interface PluginSkills {
  /**
   * Register one managed skill for the plugin generation.
   * @param definition - skill to register (registration belongs to `activate`).
   * @returns a disposer removing the skill.
   */
  register(definition: PluginSkillDefinition): Disposable
}

/** One managed slash command. */
export interface PluginCommandDefinition {
  /** Command name without the leading slash. */
  readonly name: string
  /** Short routing description shown by command discovery. */
  readonly description: string
  /** Optional input hint rendered by the UI. */
  readonly input?: { readonly hint?: string }
  /** Command handler; returns a success or error result. */
  readonly handler: (input: PluginCommandInvocation) => PluginCommandResult | Promise<PluginCommandResult>
}

/** One managed slash-command invocation. */
export interface PluginCommandInvocation {
  /** Raw text after the command name. */
  readonly rawInput: string
  /** Owning agent, when the host commands service attributes one. */
  readonly agent?: { readonly id: string; readonly session: { readonly id: string } }
  /** Owning session id, when the host commands service attributes one. */
  readonly sessionId?: SessionId
  /** Cancellation signal for the invocation. */
  readonly signal?: AbortSignal
}

/** One managed slash-command result. */
export interface PluginCommandResult {
  readonly kind: 'success' | 'error'
  readonly text: string
}

/** Slash-command capability exposed through `PluginEnv.commands`. */
export interface PluginCommands {
  /**
   * Register one command for the plugin generation.
   * @param definition - command to register (registration belongs to `activate`).
   * @returns a disposer removing the command.
   */
  register(definition: PluginCommandDefinition): Disposable
}

/** Client-half declaration carried by the managed manifest (bundle wrapper face). */
export interface PluginClientDeclaration {
  /** Browser bundle entry relative to the package root, e.g. `./lib/client.js`. */
  readonly main: string
  /** Host client-runtime packages the client half injects. */
  readonly inject?: readonly string[]
}

/** File capability exposed through `PluginEnv.fs`; denial precedes any real I/O. */
export interface PluginFs {
  /**
   * Read a file within the granted file-access set.
   * @param path - path to read.
   * @returns the file content.
   */
  read(path: string): Promise<Uint8Array>
  /**
   * Write a file within the granted write set (`write` implies `read` on the same path).
   * @param path - path to write.
   * @param data - content to write.
   * @returns a promise settling after the write.
   */
  write(path: string, data: Uint8Array | string): Promise<void>
  /**
   * Append bytes within the granted write set (audit-log style writers).
   * @param path - path to append to.
   * @param data - content to append.
   */
  append(path: string, data: Uint8Array | string): Promise<void>
  /**
   * List one directory within the granted file-access set.
   * @param path - directory path to list.
   * @returns directory entries in host order; symlinks are surfaced as
   * `symlink` and are never followed by `read`.
   */
  readdir(path: string): Promise<readonly PluginDirEntry[]>
  /**
   * Metadata within the granted file-access set (lstat semantics: symlinks
   * are reported, not followed).
   * @param path - path to stat.
   * @returns kind, byte size, and last-modified epoch milliseconds.
   */
  stat(path: string): Promise<PluginFileStat>
}

/** One directory entry returned by `PluginFs.readdir`. */
export interface PluginDirEntry {
  /** Entry name within the listed directory. */
  readonly name: string
  /** Entry kind; `symlink` entries are never followed by the gated fs. */
  readonly kind: 'file' | 'directory' | 'symlink' | 'other'
}

/** Metadata returned by `PluginFs.stat` (lstat semantics). */
export interface PluginFileStat {
  /** Entry kind; `symlink` entries are reported without following. */
  readonly kind: 'file' | 'directory' | 'symlink' | 'other'
  /** Size in bytes. */
  readonly size: number
  /** Last-modified epoch milliseconds. */
  readonly mtimeMs: number
}

/** Disposer shape returned by every registration method; structurally compatible with Cordis. */
export type Disposable = () => void

/**
 * Minimal logger surface handed to plugins; structurally compatible with the
 * Cordis logger facade the manager bridges in.
 */
export interface Logger {
  /** Record an error-severity line. */
  error(format: unknown, ...params: unknown[]): void
  /** Record an info-severity line. */
  info(format: unknown, ...params: unknown[]): void
  /** Record a warn-severity line. */
  warn(format: unknown, ...params: unknown[]): void
  /** Record a debug-severity line. */
  debug(format: unknown, ...params: unknown[]): void
}

/**
 * Event-name map for managed events. The empty base interface is the repo
 * declaration-merging convention: event-owning packages augment it, and the
 * generated catalog derives the harness tier that decides mountability.
 */
export interface PluginEvents {}

/** Name of every managed event contributed via {@link PluginEvents} merging. */
export type PluginEventName = keyof PluginEvents

/**
 * Listener parameter shape for one managed event, derived from the event's
 * declared signature. Waterfall events therefore end with `next` while
 * emit/parallel/serial events do not — the `@mode` split is structural.
 */
export type PluginEventListener<E extends PluginEventName> =
  PluginEvents[E] extends (...args: infer Args) => unknown ? (...args: Args) => void : never

/** Dispatch argument tuple for one managed event (the declared parameters, `this` excluded). */
export type PluginEventArgs<E extends PluginEventName> =
  PluginEvents[E] extends (...args: infer Args) => unknown ? Args : never

/**
 * Minimal structural tool definition owned by this package: name, description,
 * input/output schemas, execute, and a render intent. The manager bridges it
 * into the tools registry and revalidates the output schema per generation;
 * this package deliberately does not import the tools package.
 */
export interface PluginToolDefinition {
  /** Tool name shown to the model. */
  readonly name: string
  /** Tool description shown to the model. */
  readonly description: string
  /** Input JSON Schema object for the model-facing arguments. */
  readonly input: Record<string, unknown>
  /** Output JSON Schema node for the canonical result value. */
  readonly output: Record<string, unknown>
  /**
   * Run one accepted call and return its canonical value.
   * @param args - parsed model arguments.
   * @param exec - execution context carrying cancellation and call identity.
   * @returns the canonical output value.
   */
  execute(args: unknown, exec: PluginToolExecutionContext): Promise<unknown>
  /** UI render intent; omitted falls back to the generic presentation. */
  readonly renderIntent?: PluginToolRenderIntent
}

/** Structural prompt section contributed through the manager (Proposal B). */
export interface PluginPromptSection {
  /** Unique section name; duplicate registration throws in the host service. */
  readonly name: string
  /** Ascending render order; must be finite. */
  readonly order: number
  /** Static text, or a provider evaluated at each assembly. */
  readonly text: string | ((context: unknown) => string)
}

/** Execution context passed to a plugin tool's `execute`. */
export interface PluginToolExecutionContext {
  /** Cancellation signal for the current call. */
  readonly signal: AbortSignal
  /** Owning agent session id, when the host tool bridge can attribute one. */
  readonly sessionId?: SessionId
  /** Owning agent view, when the host tool bridge carries it (durable session facts). */
  readonly agent?: PluginToolAgentContext
}

/** Durable session facts visible to a managed tool call. */
export interface PluginToolSessionContext {
  /** Session id. */
  readonly id: string
  /** Durable header facts (cwd, origin, delegation depth). */
  readonly header?: { readonly cwd?: string; readonly origin?: string; readonly delegationDepth?: number }
  /** Read-only event log view (surface ordering; never for direct writes). */
  readonly events?: readonly unknown[]
}

/** Agent view handed to managed tool calls by the host bridge. */
export interface PluginToolAgentContext {
  /** Session id of the owning agent. */
  readonly sessionId: string
  /** The owning session's durable view. */
  readonly session: PluginToolSessionContext
}

/** Tool render intent: a `card`-tagged value the manager maps into the tools presentation vocabulary. */
export interface PluginToolRenderIntent {
  /** Presentation-card discriminant consumed by UI bridges. */
  readonly card: string
}

/** Lifecycle hooks declared by a plugin (§4). */
export interface PluginHooks {
  /**
   * Staging-time preparation. Registration methods are unavailable here —
   * calling `on`/`registerTool`/`provide` during setup throws
   * `setup-registration` — and every other side effect must be rollbackable
   * with the discarded staging set.
   * @param env - capability surface for the staged generation.
   * @param config - resolved config validated against the manifest schema.
   * @returns a promise settling when setup completes.
   */
  setup?(env: PluginEnv, config: unknown): Promise<void>
  /**
   * Go-live hook; all registrations belong here.
   * @param env - capability surface for the live generation.
   * @returns nothing, or a promise settling when activation completes.
   */
  activate(env: PluginEnv): Promise<void> | void
  /**
   * Graceful drain before the generation is released.
   * @param reason - why the generation is being deactivated.
   * @returns nothing, or a promise settling when deactivation completes.
   */
  deactivate?(reason: DeactivateReason): Promise<void> | void
  /**
   * Capture state for handoff; required when `stateful` is true. The result
   * must be JSON-serializable and at most 10MB — rejection, never truncation.
   * @returns the plugin state to restore in the next generation.
   */
  captureState?(): unknown
  /**
   * Apply captured state from the previous generation or a persisted snapshot.
   * @param state - previously captured state.
   * @param previous - identity of the generation that produced the snapshot, or `null` on first install.
   * @returns nothing, or a promise settling when restore completes.
   */
  restoreState?(state: unknown, previous: PreviousGeneration | null): Promise<void> | void
  /** Release resources not owned by registrations. */
  dispose?(): Promise<void> | void
}

/** Why a plugin generation is being deactivated; `shutdown` is a clean process exit. */
export type DeactivateReason = 'replace' | 'uninstall' | 'disable' | 'shutdown'

/** Identity of the generation that produced a state snapshot. */
export interface PreviousGeneration {
  /** Generation sequence number. */
  readonly generation: number
  /** Manifest version of that generation. */
  readonly version: string
}

/** Declared event permission block (§5). */
export interface PermissionsBlock {
  /** Event names this plugin observes (harness tier). */
  readonly observe: string[]
  /** Transform declarations on waterfall events (grant-gated). */
  readonly transform: TransformDeclaration[]
  /** Intercept declarations (grant-gated). */
  readonly intercept: InterceptDeclaration[]
  /** Listener position; default is `derived`. */
  readonly position: 'outermost' | 'derived' | 'innermost'
  /** Claimed contributions: `'service:<id>'` or `'tool:<name>'`. */
  readonly claims: string[]
}

/** One transform declaration on a waterfall event. */
export interface TransformDeclaration {
  /** Event name being transformed. */
  readonly event: string
  /** Top-level payload property names this transform reads (depth 1). */
  readonly reads?: string[]
  /** Top-level payload property names this transform replaces. */
  readonly writes?: string[]
  /** Collection-slot property names this transform appends to. */
  readonly appends?: string[]
}

/** One intercept declaration on a serial or waterfall event. */
export interface InterceptDeclaration {
  /** Event name being intercepted. */
  readonly event: string
  /** Allowed return branches, drawn from the event's decision-union discriminant vocabulary. */
  readonly returns: string[]
}

/** Dynamic install source discriminant union; npm entries reference resolvable packages, never fetched. */
export type PluginSource =
  | { readonly type: 'inline'; readonly code: string }
  | { readonly type: 'npm'; readonly package: string }

/** Channel identity used for ceiling evaluation: `cordis_mount` always passes `model`. */
export type InstallOrigin = 'model' | 'runtime-api'

/** Options for a dynamic plugin install. */
export interface InstallOptions {
  /** Channel origin; defaults to `runtime-api` and selects the permission ceiling. */
  readonly origin?: InstallOrigin
  /** Initial config validated against the manifest config schema. */
  readonly config?: unknown
}

/** Read-only handle for one managed plugin (§15.2). */
export interface PluginHandleInfo {
  /** Plugin id. */
  readonly id: string
  /** Manifest version. */
  readonly version: string
  /** Generation sequence number. */
  readonly generation: number
  /** Install origin; `static` = bundle/Loader composition adopted by the adapter. */
  readonly origin: 'static' | InstallOrigin
  /** Lifecycle status of the plugin. */
  readonly status: 'enabled' | 'disabled' | 'quarantined' | 'shadowed' | 'uninstalled'
  /** Recovery reason when `status` is not `enabled`. */
  readonly reason?: string
  /** Declared kinds. */
  readonly kinds: readonly string[]
  /** Declared requires. */
  readonly requires: readonly string[]
  /** Declared provides. */
  readonly provides: readonly string[]
  /** Per-plugin order-neutrality flag for install-set-pure ordering. */
  readonly orderNeutral: boolean
  /** Source the plugin came from. */
  readonly source: PluginSource | { readonly type: 'static' }
}
