/**
 * Type-only contract surface of `@deepseek-ai/dsh-mygo`: the
 * `ctx.pluginManager` service key, manager Config, and the mount-time
 * validation options. This module deliberately contains no runtime code; the
 * validation chain itself lives in `mount.ts`.
 * @module @deepseek-ai/dsh-mygo/src/types
 */

import type {
  InstallOrigin,
  InstallOptions,
  PermissionsBlock,
  PluginDefinition,
  PluginErrorCode,
  PluginHandleInfo,
  PluginSource,
  RawCordisFunctionPlugin,
} from '@deepseek-ai/dsh-mygo-api'
import type { PluginEventVocabularyEntry } from './event-vocabulary.ts'

/** Manager deployment Config. */
export interface PluginManagerConfig {
  /** Max inline source code bytes per install, checked before staging. */
  readonly maxCodeBytes: number
  /** Max registry bytes per profile. */
  readonly maxRegistryBytes: number
  /** Max dynamic plugin rows per profile. */
  readonly maxDynamicPlugins: number
  /** Audit stream rotation size. */
  readonly auditMaxBytes: number
  /** Audit stream rotation file count. */
  readonly auditKeepFiles: number
  /** Root for state snapshots; defaults to `dshHomePath('plugin-state')`. */
  readonly stateRoot: string
  /** Generation history retained per plugin. */
  readonly historyKeep: number
  /** Bounded drain/next-idle wait for replace (HP:139). */
  readonly swapTimeoutMs: number
  /** `'<event>.<property>'` fields that `writes` may not touch (PO:219/SEC:152). */
  readonly protectedFields?: readonly string[]
}

/** One operation fed to `plan()` (§15.3). */
export type PluginOperation =
  | { readonly op: 'install'; readonly source: PluginSource; readonly config?: unknown }
  | { readonly op: 'uninstall'; readonly id: string }
  | { readonly op: 'replace'; readonly id: string; readonly source: PluginSource; readonly force?: boolean }
  | { readonly op: 'enable' | 'disable'; readonly id: string }

/** Plan preview for one operation against the current managed set (§15.3). */
export interface PluginOperationPlan {
  readonly accepted: boolean
  /** The code the operation would throw, when rejected. */
  readonly error?: { readonly code: PluginErrorCode; readonly message: string }
  /** Bystanders whose observable position changes, with the displacing edge. */
  readonly displaced: readonly {
    readonly id: string
    readonly edge: { readonly from: string; readonly to: string; readonly property: string }
  }[]
  /** Dynamic installs shadowed by a static entry report `true` (T2-4). */
  readonly wouldShadow?: boolean
}

/**
 * The full manager operation surface (§15.3). The #12 skeleton ships the
 * typed surface plus the mount-time validation chain; operation semantics
 * land with the schedule's later stages (#13 plan, #15 lifecycle engine).
 */
export interface PluginManager {
  /** Install one plugin; runtime commit → persist → return (T3 rule 1). */
  install(source: PluginSource, options?: InstallOptions): Promise<PluginHandleInfo>
  /** Uninstall one plugin; idempotent (T2-3), persist first (T3 rule 2). */
  uninstall(id: string): Promise<void>
  /** Enable a disabled plugin (create-class write order). */
  enable(id: string): Promise<void>
  /** Disable an enabled plugin (delete-class write order). */
  disable(id: string, reason?: string): Promise<void>
  /** Hot replacement seven-step protocol (HP:82-90). */
  replace(id: string, source: PluginSource, options?: { readonly force?: boolean; readonly config?: unknown }): Promise<PluginHandleInfo>
  /** Reuse the replace path with the same code (HP:98). */
  updateConfig(id: string, patch: unknown): Promise<void>
  /** Read-only view of the current managed set, including static/quarantined/shadowed. */
  plugins(): readonly PluginHandleInfo[]
  /**
   * Evaluate one operation without changing state (PO:242). Async since
   * install/replace sources resolve through the manager's resolver; source
   * resolution is pure-read with zero staging side effects (2026-08-08
   * ruling #4).
   */
  plan(operation: PluginOperation): Promise<PluginOperationPlan>
  /** Static-composition self-adoption; not persisted, `origin: 'static'` (#12). */
  adopt(definition: PluginDefinition, config: unknown): Promise<void>
  /**
   * Zero-intrusion static adoption of a raw Cordis plugin module: the
   * manifest is auto-derived from `name`/`inject`/`Config`/`apply` and the
   * generation runs through the host-shaped transparent facade.
   * @param raw - the raw cordis plugin module.
   * @param config - deployment config validated against the raw Config schema.
   * @param id - optional manager-side plugin id; defaults to the derived id.
   */
  adoptRaw(raw: RawCordisFunctionPlugin, config: unknown, id?: string): Promise<PluginHandleInfo>
  /**
   * Live-update a previously adopted raw plugin: re-derive the manifest from
   * the new module and run the HMR replace protocol (capture → stage → swap
   * → dispose) so in-progress sessions and the host process stay live.
   * @param raw - the new raw Cordis plugin module.
   * @param config - deployment config for the new generation.
   * @param id - the existing manager-side plugin id (required).
   * @returns the updated plugin handle.
   */
  updateRaw(raw: RawCordisFunctionPlugin, config: unknown, id: string): Promise<PluginHandleInfo>
  /**
   * Remove an uninstall tombstone so a previously uninstalled static/bundle
   * plugin can be adopted again.
   * @param id - plugin id whose tombstone should be cleared.
   */
  clearUninstallTombstone(id: string): Promise<void>
  /**
   * Pre-mount support check: derive the managed manifest from a raw plugin
   * and verify the host can satisfy its declared requires, without mutating
   * any state. Bridge callers use this to skip unsupported plugins at boot
   * instead of letting one broken row fail the whole plugin tree.
   * @param raw - the raw Cordis plugin module.
   * @param id - optional manager-side plugin id; defaults to the derived id.
   * @returns `{ ok: true }` or `{ ok: false, reason }`.
   */
  checkSupport(raw: RawCordisFunctionPlugin, id?: string): Promise<PluginSupportCheck>
}

/** Result of a pre-mount support check. */
export type PluginSupportCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** Inputs the mount-time validation chain needs beyond the manifest. */
export interface MountValidationOptions {
  /** Source the plugin comes from. */
  readonly source: PluginSource | { readonly type: 'static' }
  /** Channel identity. */
  readonly origin: 'static' | InstallOrigin
  /** Deployment-protected `'<event>.<property>'` fields. */
  readonly protectedFields?: readonly string[]
  /** Harness event vocabulary; defaults to the generated `EVENT_VOCABULARY`. */
  readonly vocabulary?: readonly PluginEventVocabularyEntry[]
}

/** Outcome of a successful mount-time validation pass. */
export interface MountValidationResult {
  /** Non-fatal warnings the caller must surface (16.4), e.g. `development-mode`. */
  readonly warnings: readonly string[]
}

/**
 * Slot classification for append ordering (§9, #4): host-sorted slots carry
 * their own contribution order key (`systemPrompt.section({order})`), so
 * appends are order-neutral; chain-ordered slots assemble in derived order
 * (`PostToolDecision.additionalContexts`), so appends are position-observable.
 * Unknown slots default to `chain-ordered` (conservative).
 */
export type SlotKind = 'host-sorted' | 'chain-ordered'

/**
 * One validated plugin declaration in the installed set (#13 input). The
 * manager's derivation is a pure function of this set: no install history,
 * config line order, import resolution order, or timing enters the verdict.
 */
export interface PluginDeclarationInput {
  /** Plugin id; the ordering tie-break and registry identity. */
  readonly id: string
  /** Validated §5 declaration block (observe/transform/intercept/position/claims). */
  readonly permissions: PermissionsBlock
  /** Service ids this plugin consumes; the dependent graph for uninstall/replace. */
  readonly requires: readonly string[]
  /** Service ids this plugin provides; the claims/shadowing surface (§12). */
  readonly provides: readonly string[]
  /** Scope keys this plugin is registered on; empty/absent = unscoped (every scope). */
  readonly scopes?: readonly string[]
  /** Enabled plugins participate in derived dispatch order; default `true`. */
  readonly enabled?: boolean
  /** Static compositions win over dynamic installs of the same id (T2-4); default `runtime-api`. */
  readonly origin?: 'static' | InstallOrigin
}

/** Pure derivation and plan input: the installed set plus deployment facts. */
export interface PlanState {
  /** Validated declaration set, unique plugin ids. */
  readonly plugins: readonly PluginDeclarationInput[]
  /** `'event.property'` slot classification; unknown slots default to `chain-ordered`. */
  readonly slotKinds?: ReadonlyMap<string, SlotKind>
  /**
   * Slots held by raw (unmanaged) Cordis registrations, snapshot supplied by
   * the caller; claims on these fail `claims-unmanaged-incumbent`.
   */
  readonly heldOutsideManager?: readonly string[]
}

/** Derived dispatch order per scope (§9/§11). */
export interface DerivationResult {
  /**
   * Complete per-scope chain order. `'*'` is the unscoped-only order, used
   * for scopes without scoped plugins; each scoped key holds the combined
   * unscoped + scoped order for that scope. Cyclic scopes are absent.
   */
  readonly orders: ReadonlyMap<string, readonly string[]>
  /** Per-plugin order-neutrality flag (#6, PO:53). */
  readonly orderNeutral: ReadonlyMap<string, boolean>
  /** Derived-edge cycles per scope (§10 rule 3). */
  readonly cycles: readonly { readonly scope: string; readonly cycle: readonly string[] }[]
}

/** One relationship conflict or claims verdict from the five rules + §12. */
export interface ConflictIssue {
  /** The §16.2 code the operation would throw. */
  readonly code: PluginErrorCode
  /** Machine-readable naming entities for the code. */
  readonly details: Record<string, unknown>
}

/**
 * Pure plan input: the operation with its validated candidate declaration.
 * The §15.3 `PluginOperation` carries `source`; the service method resolves
 * source → declaration (non-pure evaluation) before calling this function.
 */
export type PlanOperationInput =
  | { readonly op: 'install'; readonly plugin: PluginDeclarationInput }
  | { readonly op: 'uninstall'; readonly id: string }
  | { readonly op: 'replace'; readonly id: string; readonly plugin: PluginDeclarationInput; readonly force?: boolean }
  | { readonly op: 'enable' | 'disable'; readonly id: string }

/** Base payload of every `plugin/*` event (§15.5). */
export interface PluginLifecycleEventPayload {
  /** Plugin id. */
  readonly id: string
  /** Plugin id, also serving as the display name. */
  readonly name: string
  /** Manifest version of the generation involved. */
  readonly version: string
  /** Generation sequence number involved. */
  readonly generation: number
  /** §16.3 reason when the event accompanies a non-enabled status. */
  readonly reason?: string
  /** Failure code/message on `plugin/replace-failed`. */
  readonly error?: { readonly code: string; readonly message: string }
  /** Bystander displacement on installed/replaced/uninstalled (§15.3 plan). */
  readonly displaced?: readonly {
    readonly id: string
    readonly edge: { readonly from: string; readonly to: string; readonly property: string }
  }[]
  /** Which provides-diff path a replace ran (HP:137 names the three paths). */
  readonly providesPath?: 'unchanged' | 'dropped' | 'added'
}

/**
 * The `ctx.pluginManager` service key (§15). The manager package bridges the
 * upper plugin contract into Cordis; plugin authors never see this key.
 */
declare module 'cordis' {
  interface Context {
    /**
     * Managed-plugin service surface (§15.3): install/uninstall/enable/
     * disable/replace/updateConfig, the read-only plugins() view, the async
     * plan() preview, and static self-adoption through adopt().
     * @dshScopeScan unsupported - one process-global manager per profile.
     */
    pluginManager: PluginManager
  }
  interface Events {
    /**
     * A dynamic plugin was installed and activated (§15.5). Observe-only.
     * @param payload - id, name, version, generation, displaced bystanders.
     * @mode emit
     */
    'plugin/installed'(payload: PluginLifecycleEventPayload): void
    /**
     * A plugin generation went live (install, replace, enable, recovery).
     * @param payload - id, name, version, generation.
     * @mode emit
     */
    'plugin/activated'(payload: PluginLifecycleEventPayload): void
    /**
     * A plugin generation was released (replace step ⑥, uninstall, dispose).
     * @param payload - id, name, version, generation.
     * @mode emit
     */
    'plugin/deactivated'(payload: PluginLifecycleEventPayload): void
    /**
     * A replace protocol started; observe-only (decision #2).
     * @param payload - id, name, version, generation.
     * @mode emit
     */
    'plugin/replacing'(payload: PluginLifecycleEventPayload): void
    /**
     * A replace committed; carries the provides-diff path and displacement.
     * @param payload - id, name, version, generation, providesPath, displaced.
     * @mode emit
     */
    'plugin/replaced'(payload: PluginLifecycleEventPayload): void
    /**
     * A replace failed before go-live; the current generation stays live.
     * @param payload - id, name, version, generation, error.
     * @mode emit
     */
    'plugin/replace-failed'(payload: PluginLifecycleEventPayload): void
    /**
     * A plugin was enabled.
     * @param payload - id, name, version, generation.
     * @mode emit
     */
    'plugin/enabled'(payload: PluginLifecycleEventPayload): void
    /**
     * A plugin was disabled; reason when non-empty.
     * @param payload - id, name, version, generation, reason.
     * @mode emit
     */
    'plugin/disabled'(payload: PluginLifecycleEventPayload): void
    /**
     * A plugin was uninstalled; carries displaced bystanders.
     * @param payload - id, name, version, generation, displaced.
     * @mode emit
     */
    'plugin/uninstalled'(payload: PluginLifecycleEventPayload): void
  }
}
