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
  /** File paths and modes the plugin may access; `write` implies `read` on the same path. */
  readonly fileAccess?: FileAccessEntry[]
  /** URL allowlist for `env.fetch`; absent denies all network access. */
  readonly networkAccess?: { readonly allow: string[] }
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
  /** Read-only view of the current managed plugin set (§15.2). */
  plugins(): readonly PluginHandleInfo[]
  /**
   * Hot-config update for this plugin, routed through the replace path.
   * @param patch - config patch validated against the manifest config schema.
   * @returns a promise settling after the update commits.
   */
  updateConfig(patch: unknown): Promise<void>
  /** File access gated by the deployment's `fileAccess` grants. */
  readonly fs: PluginFs
  /**
   * Network fetch gated by the deployment's `networkAccess` grants; denial
   * throws before any network activity.
   * @param url - URL to fetch.
   * @param init - standard fetch options.
   * @returns the fetched response.
   */
  fetch(url: string, init?: RequestInit): Promise<Response>
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
  readonly status: 'enabled' | 'disabled' | 'quarantined' | 'shadowed'
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
