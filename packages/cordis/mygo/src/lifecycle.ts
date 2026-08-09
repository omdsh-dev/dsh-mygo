/**
 * Lifecycle engine (#15, §12-§14/§16 group 4): the generation registry,
 * staging sets with cross-scope atomicity, the seven-step replace protocol,
 * manager-held provides and the tool indirection table, swapPolicy bounded
 * waits, and T3 persistence ordering through the {@link RegistryStore} seam.
 * T4 boot recovery revalidates every persisted row and mounts or quarantines
 * it. All errors are `PluginError` from the shared template vocabulary.
 * @module @deepseek-ai/dsh-mygo/src/lifecycle
 */

import { PluginError, formatPluginError } from '@deepseek-ai/dsh-mygo-api'
import type {
  InstallOptions,
  InstallOrigin,
  Logger,
  PluginDefinition,
  PluginEnv,
  PluginErrorCode,
  PluginHandleInfo,
  PluginSource,
  PluginToolExecutionContext,
  PluginToolDefinition,
  PluginPromptSection,
} from '@deepseek-ai/dsh-mygo-api'
import type { Context, Events } from 'cordis'
import {
  claimEffect,
  createPluginFs,
  createNetworkFetch,
  createRateLimitedLogger,
  nodePluginIo,
  type PluginEffectQuota,
  type PluginIo,
} from './capabilities.ts'
import { evaluateConflicts } from './conflicts.ts'
import type { DispatchMachine } from './dispatch.ts'
import { EVENT_VOCABULARY } from './event-vocabulary.ts'
import type { PluginEventVocabularyEntry } from './event-vocabulary.ts'
import { deriveOrders } from './order.ts'
import { validateMount } from './mount.ts'
import { planOperation } from './plan.ts'
import type { RegistryPersistence } from './persistence.ts'
import type { SnapshotMeta } from './snapshots.ts'
import type {
  PlanState,
  PluginDeclarationInput,
  PluginManagerConfig,
  PluginOperation,
  PluginOperationPlan,
} from './types.ts'
import type { PluginLifecycleEventPayload } from './types.ts'
import type { GenerationRecord, RegistryStore, StatusRecord } from './store.ts'

/** One staged registration of a generation layer. */
type StagedRegistration =
  | {
    readonly kind: 'listener'
    readonly pluginId: string
    readonly scope?: string
    readonly event: string
    readonly mode: 'observe' | 'transform' | 'intercept'
    readonly position: 'outermost' | 'derived' | 'innermost'
    readonly returns?: readonly string[]
    readonly listener: (...args: unknown[]) => unknown
  }
  | {
    readonly kind: 'tool'
    readonly pluginId: string
    readonly scope?: string
    readonly definition: PluginToolDefinition
  }
  | {
    readonly kind: 'prompt-section'
    readonly pluginId: string
    readonly scope?: string
    readonly section: PluginPromptSection
  }
  | {
    readonly kind: 'provide'
    readonly pluginId: string
    readonly scope?: string
    readonly capability: string
    readonly value: unknown
  }

/** Shared staging phase: registrations belong to activate only (§4-1). */
interface PhaseHolder {
  phase: 'setup' | 'activate'
}

/** The registration half of the plugin env, owned by the engine (#15). */
class StagingEnv implements PluginEnv {
  readonly logger: Logger
  readonly fs: PluginEnv['fs']
  readonly scopedTo: string | undefined
  private readonly owner: LifecycleEngine
  private readonly pluginId: string
  private readonly manifest: PluginDefinition
  private readonly registrations: StagedRegistration[]
  private readonly scopeLayer: string | undefined
  private readonly phase: PhaseHolder
  private readonly quotas: PluginEffectQuota
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>

  constructor(
    owner: LifecycleEngine,
    pluginId: string,
    manifest: PluginDefinition,
    registrations: StagedRegistration[],
    scopeLayer: string | undefined,
    phase: PhaseHolder,
    logger: Logger,
    fs: PluginEnv['fs'],
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
    quotas: PluginEffectQuota,
  ) {
    this.owner = owner
    this.pluginId = pluginId
    this.manifest = manifest
    this.registrations = registrations
    this.scopeLayer = scopeLayer
    this.phase = phase
    this.quotas = quotas
    this.fetchImpl = fetchImpl
    this.logger = logger
    this.fs = fs
  }

  on(event: string, listener: (...args: unknown[]) => unknown): () => void {
    this.assertRegistrable('on')
    claimEffect(this.quotas, 'listener', this.pluginId)
    const declaration = this.manifest.permissions.intercept.find(entry => entry.event === event)
    const transform = this.manifest.permissions.transform.find(entry => entry.event === event)
    this.registrations.push({
      kind: 'listener',
      pluginId: this.pluginId,
      event,
      mode: declaration !== undefined ? 'intercept' : transform !== undefined ? 'transform' : 'observe',
      position: this.manifest.permissions.position,
      ...(declaration === undefined ? {} : { returns: declaration.returns }),
      ...(this.scopeLayer === undefined ? {} : { scope: this.scopeLayer }),
      listener,
    })
    return () => {}
  }

  scope(agentId: string): PluginEnv {
    return new StagingEnv(
      this.owner,
      this.pluginId,
      this.manifest,
      this.registrations,
      agentId,
      this.phase,
      this.logger,
      this.fs,
      this.fetchImpl,
      this.quotas,
    )
  }

  registerTool(definition: PluginToolDefinition): () => void {
    this.assertRegistrable('registerTool')
    claimEffect(this.quotas, 'tool', this.pluginId)
    this.registrations.push({
      kind: 'tool',
      pluginId: this.pluginId,
      definition,
      ...(this.scopeLayer === undefined ? {} : { scope: this.scopeLayer }),
    })
    return () => {}
  }

  registerPromptSection(section: PluginPromptSection): () => void {
    this.assertRegistrable('registerPromptSection')
    if (typeof section.name !== 'string' || section.name.length === 0
      || !Number.isFinite(section.order)
      || (typeof section.text !== 'string' && typeof section.text !== 'function')) {
      throw fail('staging-failed', {
        stage: 'prompt-section',
        cause: 'section must declare a name, finite order, and string-or-function text',
      }, this.pluginId)
    }
    // §18 contribution bucket: prompt sections count against the tool quota.
    claimEffect(this.quotas, 'tool', this.pluginId)
    this.registrations.push({
      kind: 'prompt-section',
      pluginId: this.pluginId,
      section,
      ...(this.scopeLayer === undefined ? {} : { scope: this.scopeLayer }),
    })
    return () => {}
  }

  provide(capability: string, value: unknown): () => void {
    this.assertRegistrable('provide')
    claimEffect(this.quotas, 'service', this.pluginId)
    this.registrations.push({
      kind: 'provide',
      pluginId: this.pluginId,
      capability,
      value,
      ...(this.scopeLayer === undefined ? {} : { scope: this.scopeLayer }),
    })
    return () => {}
  }

  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T is the caller-chosen service type at each call site.
  get<T>(capability: string): T | undefined {
    if (!this.manifest.requires.includes(capability)) return undefined
    const provided = this.owner.provideValue(capability)
    if (provided !== undefined) return provided as T
    if (capability === 'sessionPersistence') return this.owner.sessionPersistenceProjection() as T | undefined
    return undefined
  }

  plugins(): readonly PluginHandleInfo[] {
    return this.owner.plugins()
  }

  updateConfig(patch: unknown): Promise<void> {
    return this.owner.updateConfig(this.pluginId, patch)
  }

  fetch(url: string, init?: RequestInit): Promise<Response> {
    return this.fetchImpl(url, init)
  }

  private assertRegistrable(method: string): void {
    if (this.phase.phase !== 'setup') return
    throw fail('setup-registration', { method }, this.pluginId)
  }
}

/** One generation of a managed plugin, immutable after staging. */
interface EngineGeneration {
  readonly number: number
  readonly manifest: PluginDefinition
  readonly code: string
  readonly source: PluginSource | { readonly type: 'static' }
  readonly resolvedConfig: unknown
  readonly registrations: readonly StagedRegistration[]
  /** Disposers removing this generation's registrations from the machine. */
  readonly disposers: (() => void)[]
  /** Hot-swap retention: events with in-flight dispatches at swap time. */
  remainingEvents: Set<string>
  /** Provided capabilities and their current values (manager-held). */
  readonly provides: Map<string, unknown>
  /** Tool definitions held through the indirection table. */
  readonly tools: Map<string, PluginToolDefinition>
  /** Prompt sections held through the prompt-service publication table. */
  readonly promptSections: Map<string, PluginPromptSection>
  /** Whether this generation's registrations are live on the machine. */
  readonly mounted: boolean
}

/** A managed plugin record. */
interface ManagedRecord {
  readonly id: string
  readonly origin: 'static' | InstallOrigin
  readonly source: PluginSource | { readonly type: 'static' }
  status: 'enabled' | 'disabled' | 'quarantined' | 'shadowed'
  reason?: string
  generations: EngineGeneration[]
  state: unknown
  snapshot?: SnapshotMeta
}

/** Recovery outcome for one persisted row (§22.4). */
export interface RecoveryRow {
  readonly id: string
  readonly status: 'restored' | 'shadowed' | 'quarantined' | 'gc'
  readonly reason?: string
  readonly errorCode?: PluginErrorCode
}

/** Boot recovery summary (§22.4). */
export interface LifecycleRecoveryReport {
  readonly restored: number
  readonly shadowed: number
  readonly quarantined: number
  readonly gc: { readonly orphanGenerations: number; readonly historyTrimmed: number }
  readonly rows: readonly RecoveryRow[]
}

/** Structural host tools-registry seam the registry bridge publishes through. */
export interface ToolRegistryLike {
  /** Register one registry-shaped definition; returns its disposer. */
  register(definition: unknown): () => void
  /** The global-layer definition of one tool name, or `undefined` when free. */
  get(name: string): unknown
}

/** Structural host systemPrompt service seam (Proposal B). */
export interface PromptServiceLike {
  /** Register one prompt section; returns its disposer. */
  section(section: unknown): () => void
}

/** Read-only session-persistence projection (Proposal B, ruling question ②). */
export interface SessionPersistenceProjection {
  listSnapshots(signal?: AbortSignal): Promise<unknown>
  list(signal?: AbortSignal): Promise<unknown>
  locate(meta: unknown): unknown
  inspect(id: unknown, signal?: AbortSignal): Promise<unknown>
  load(id: unknown): Promise<unknown>
  readFrom(id: unknown, fromSeq: number, signal?: AbortSignal): Promise<unknown>
  prepare(id: unknown, signal?: AbortSignal): Promise<unknown>
  /** Loud write denial: the write surface is deferred (Proposal B). */
  create(meta: unknown): Promise<never>
  /** Loud write denial: the write surface is deferred (Proposal B). */
  append(id: unknown, events: readonly unknown[]): Promise<never>
}

/**
 * Build the read-only sessionPersistence projection a managed plugin may
 * resolve (Proposal B). Read methods forward to the host service; the write
 * methods (`create`/`append`) are present as throwing stubs so a call
 * PHYSICALLY FAILS instead of silently returning `undefined` — the write
 * surface is deferred to the first write consumer.
 * @param service - the host sessionPersistence service.
 * @returns the projection object.
 */
export function createSessionPersistenceProjection(service: unknown): SessionPersistenceProjection {
  const host = service as Partial<SessionPersistenceProjection>
  const denied = (method: string): () => Promise<never> => () => {
    return Promise.reject(new Error(
      `sessionPersistence.${method} is not available to managed plugins in v1 (write surface deferred; Proposal B)`,
    ))
  }
  function forward<A extends unknown[], R>(method: ((...args: A) => R) | undefined, fallback: (...args: A) => R): ((...args: A) => R) {
    return method === undefined ? fallback : (...args: A) => method(...args)
  }
  return {
    listSnapshots: forward(host.listSnapshots, () => Promise.resolve([])),
    list: forward(host.list, () => Promise.resolve([])),
    locate: forward(host.locate, () => undefined),
    inspect: forward(host.inspect, () => Promise.reject(new Error('sessionPersistence.inspect is unavailable'))),
    load: forward(host.load, () => Promise.reject(new Error('sessionPersistence.load is unavailable'))),
    readFrom: forward(host.readFrom, () => Promise.resolve([])),
    prepare: forward(host.prepare, () => Promise.resolve(undefined)),
    create: denied('create'),
    append: denied('append'),
  }
}

/** Options for the lifecycle engine. */
export interface LifecycleEngineOptions {
  /** Cordis context the engine emits `plugin/*` events through. */
  readonly ctx: Context
  /** Dispatch machine whose arrays the engine swaps on topology change. */
  readonly dispatch: DispatchMachine
  /** Persistence seam; the sqlite implementation arrives in #17. */
  readonly store: RegistryStore
  /** Resolved manager Config (#12). */
  readonly config: PluginManagerConfig
  /** Resolve an inline/npm source to a definition (evaluation is the caller's host power). */
  readonly resolveSource: (source: PluginSource) => Promise<PluginDefinition>
  /** Generation history retained per plugin; defaults to Config `historyKeep`. */
  readonly historyKeep?: number
  /** Bounded drain/next-idle wait; defaults to Config `swapTimeoutMs`. */
  readonly swapTimeoutMs?: number
  /** Agent-turn busy check for `swapPolicy: 'next-idle'`. */
  readonly isTurnBusy?: () => boolean | Promise<boolean>
  /** Static composition ids (T2-4: static wins over dynamic rows). */
  readonly staticIds?: readonly string[]
  /** Slot classification for order neutrality (same input as #13). */
  readonly slotKinds?: ReadonlyMap<string, 'host-sorted' | 'chain-ordered'>
  /** Harness event vocabulary for mount validation (defaults to the generated one). */
  readonly eventVocabulary?: readonly PluginEventVocabularyEntry[]
  /** Logger for recovery and warnings. */
  readonly logger?: Logger
  /** Host I/O seam for the `env.fs` boundary; defaults to Node's `fs/promises`. */
  readonly io?: PluginIo
  /** Host fetch for the `env.fetch` boundary; defaults to the global fetch. */
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
  /**
   * Host tools-registry seam for the registry bridge (Proposal A). Defaults
   * to the composed `tools` service via `ctx.get('tools')`; absent = tools
   * stay manager-internal and the bridge is inert.
   */
  readonly toolRegistry?: ToolRegistryLike
  /** Host systemPrompt seam for prompt-section publication (Proposal B). */
  readonly promptService?: PromptServiceLike
  /** Host sessionPersistence seam for the read-only projection (Proposal B). */
  readonly sessionPersistence?: unknown
  /** Sqlite/snapshot/audit persistence facade (#17); absent = in-memory engine. */
  readonly persistence?: RegistryPersistence
  /** Clock for provenance timestamps and bounded waits. */
  readonly now?: () => number
  /** Failure-injection seam: called right after a replace's status persist
   * succeeds, before step 6/7 — throwing here simulates a process crash with
   * the step-5 durable state already on disk. */
  readonly crashAfterPersist?: () => void
}

/**
 * The lifecycle engine: install/uninstall/replace/enable/disable/updateConfig
 * over the generation registry, with T3 persistence ordering and T4 boot
 * recovery. One operation per plugin id runs at a time
 * (`concurrent-operation` otherwise).
 */
export class LifecycleEngine {
  private readonly ctx: Context
  private readonly dispatch: DispatchMachine
  private readonly store: RegistryStore
  private readonly config: PluginManagerConfig
  private readonly resolveSource: (source: PluginSource) => Promise<PluginDefinition>
  private readonly historyKeep: number
  private readonly swapTimeoutMs: number
  private readonly isTurnBusy: () => boolean | Promise<boolean>
  private readonly staticIds: ReadonlySet<string>
  private readonly slotKinds: ReadonlyMap<string, 'host-sorted' | 'chain-ordered'>
  private readonly eventVocabulary: readonly PluginEventVocabularyEntry[]
  /** Engine-owned logger for warnings and violation surfaces; defaults to a no-op. */
  readonly logger: Logger
  private readonly io: PluginIo
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
  private readonly toolRegistry: ToolRegistryLike | undefined
  private readonly promptService: PromptServiceLike | undefined
  private readonly sessionPersistence: unknown
  private readonly persistence: RegistryPersistence | undefined
  private readonly now: () => number
  private readonly crashAfterPersist: () => void

  private readonly records = new Map<string, ManagedRecord>()
  private readonly locks = new Map<string, string>()
  private readonly provideTable = new Map<string, { readonly pluginId: string; value: unknown }>()
  private readonly toolIndirections = new Map<string, { readonly pluginId: string; definition: PluginToolDefinition }>()
  private readonly toolRegistryDisposers = new Map<string, () => void>()
  private readonly promptSectionTable = new Map<string, { readonly pluginId: string; section: PluginPromptSection }>()
  private readonly promptSectionDisposers = new Map<string, () => void>()
  private readonly idleDisposers = new Map<string, () => void>()
  private readonly neutral = new Map<string, boolean>()
  private readonly logLimiters = new Map<string, Logger>()
  private nextGeneration = 1

  /**
   * Create the engine over a dispatch machine and registry store.
   * @param options - context, machine, store, Config, source resolver, and policy knobs.
   */
  constructor(options: LifecycleEngineOptions) {
    this.ctx = options.ctx
    this.dispatch = options.dispatch
    this.store = options.store
    this.config = options.config
    this.resolveSource = options.resolveSource
    this.historyKeep = options.historyKeep ?? options.config.historyKeep
    this.swapTimeoutMs = options.swapTimeoutMs ?? options.config.swapTimeoutMs
    this.isTurnBusy = options.isTurnBusy ?? (() => false)
    this.staticIds = new Set(options.staticIds ?? [])
    this.slotKinds = options.slotKinds ?? new Map()
    this.eventVocabulary = options.eventVocabulary ?? EVENT_VOCABULARY
    this.logger = options.logger ?? { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }
    this.io = options.io ?? nodePluginIo
    this.fetchImpl = options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init))
    this.toolRegistry = options.toolRegistry ?? (this.ctx.get('tools') as ToolRegistryLike | undefined)
    this.promptService = options.promptService ?? (this.ctx.get('systemPrompt') as PromptServiceLike | undefined)
    this.sessionPersistence = options.sessionPersistence ?? this.ctx.get('sessionPersistence')
    this.persistence = options.persistence
    this.now = options.now ?? (() => Date.now())
    this.crashAfterPersist = options.crashAfterPersist ?? (() => {})
  }

  /**
   * Install one plugin: runtime commit → persist → return (T3 rule 1).
   * @param source - inline code or an npm package reference (never fetched).
   * @param options - origin and initial config for the install.
   * @returns the managed handle of the installed plugin.
   */
  async install(source: PluginSource, options: InstallOptions = {}): Promise<PluginHandleInfo> {
    const origin = options.origin ?? 'runtime-api'
    const definition = await this.resolveSource(source)
    return this.withLock(definition.id, 'install', async () => {
      this.validate(definition, origin, source)
      await this.assertRegistryQuota(source, definition.id)
      const existing = this.records.get(definition.id)
      if (existing !== undefined) {
        if (existing.origin === 'static') return this.installShadowed(definition, source)
        throw fail('concurrent-operation', { id: definition.id, operation: 'install' }, definition.id)
      }
      this.assertNoConflicts(definition.id, definition, 'install')
      const generation = await this.stageNew(definition, source, options.config, null, undefined)
      this.assertToolNamesAvailable(generation, definition.id)
      this.assertToolRegistryConflicts(generation, definition.id)
      const previousOrders = this.deriveOrderMap()
      await this.commitGeneration(definition.id, origin, source, generation, 'enabled', previousOrders, null)
      await this.auditMount(definition.id, definition.version, generation.number, origin)
      this.emit('plugin/installed', this.eventPayload(definition.id, definition, generation.number))
      this.emit('plugin/activated', this.eventPayload(definition.id, definition, generation.number))
      return this.handleOf(this.record(definition.id))
    })
  }

  /**
   * Adopt a static composition entry (#12/#18 adapter surface; decision #12).
   * Static entries are the deployment's authority: they win over any dynamic
   * row of the same id (T2-4, runtime marking) and are never persisted.
   * @param definition - validated static plugin manifest.
   * @param config - resolved deployment config.
   * @returns the static plugin handle.
   */
  async adoptStatic(definition: PluginDefinition, config: unknown): Promise<PluginHandleInfo> {
    this.validate(definition, 'static', { type: 'static' })
    const existing = this.records.get(definition.id)
    if (existing !== undefined && existing.origin !== 'static') {
      existing.status = 'shadowed'
      existing.reason = 'shadowed'
      this.refreshOrders()
    }
    const generation = await this.stageNew(definition, { type: 'static' }, config, null, undefined)
    this.assertToolNamesAvailable(generation, definition.id)
    this.assertToolRegistryConflicts(generation, definition.id)
    this.applyRegistrations(generation)
    this.replaceTables(definition.id, existing?.generations.at(-1) ?? null, generation)
    this.syncToolPublishState()
    this.syncPromptSectionState()
    if (existing !== undefined) {
      for (const old of existing.generations) {
        this.disposeGeneration(old)
        this.emit('plugin/deactivated', this.eventPayload(existing.id, old.manifest, old.number))
      }
    }
    this.records.set(definition.id, {
      id: definition.id,
      origin: 'static',
      source: { type: 'static' },
      status: 'enabled',
      generations: [generation],
      state: undefined,
    })
    this.refreshOrders()
    this.emit('plugin/installed', this.eventPayload(definition.id, definition, generation.number))
    this.emit('plugin/activated', this.eventPayload(definition.id, definition, generation.number))
    return this.handleOf(this.record(definition.id))
  }

  /**
   * Uninstall: idempotent for unknown ids; persist first (T3 rule 2).
   * @param id - plugin id to remove.
   */
  async uninstall(id: string): Promise<void> {
    return this.withLock(id, 'uninstall', async () => {
      const record = this.records.get(id)
      if (record === undefined) return
      const dependents = this.dependentsOf(id)
      if (dependents.length > 0) throw fail('dependent-exists', { dependents }, id)
      const plan = planOperation({ op: 'uninstall', id }, this.planState())
      const displaced = plan.displaced
      try {
        await this.store.deletePlugin(id)
      } catch (error) {
        throw fail('persist-failed', { operation: 'uninstall', table: 'status' }, id, error)
      }
      try {
        await this.persistence?.snapshots.deleteAll(id)
      } catch {
        // Snapshot cleanup is best-effort: orphan files are boot-GC'd.
      }
      this.releaseRecord(record)
      this.records.delete(id)
      this.refreshOrders()
      this.emit('plugin/uninstalled', {
        ...this.eventPayload(id, this.manifestOf(record), this.generationNumber(record)),
        displaced,
      })
    })
  }

  /**
   * Enable: create-class write order (commit → persist → return).
   * @param id - plugin id to enable.
   */
  async enable(id: string): Promise<void> {
    return this.withLock(id, 'enable', async () => {
      const record = this.requireRecord(id, 'enable')
      if (record.status === 'enabled') return
      // Shadowed dynamic rows stay inert while the static incumbent owns the id.
      if (record.status === 'shadowed') return
      const generation = record.generations.at(-1)
      if (generation !== undefined && !generation.mounted) {
        await this.mountDeclared(record, generation)
        return
      }
      record.status = 'enabled'
      delete record.reason
      this.refreshOrders()
      try {
        await this.store.writeStatus(id, this.statusRecord(record))
      } catch (error) {
        record.status = 'disabled'
        this.refreshOrders()
        throw fail('persist-failed', { operation: 'enable', table: 'status' }, id, error)
      }
      this.emit('plugin/enabled', this.eventPayload(id, this.manifestOf(record), this.generationNumber(record)))
    })
  }

  /** Mount a recovered-disabled generation: stage, apply, persist (#17 closure). */
  private async mountDeclared(record: ManagedRecord, declared: EngineGeneration): Promise<void> {
    const definition = await this.resolveSource(record.source as PluginSource)
    const snapshot = record.snapshot === undefined
      ? undefined
      : await this.persistence?.snapshots.read(
        record.id,
        declared.number,
        record.snapshot,
        (message) => { this.logger.warn(message) },
      )
    const previous = { generation: declared.number, version: declared.manifest.version }
    const staged = await this.stageNew(definition, record.source, declared.resolvedConfig, previous, snapshot)
    this.assertToolNamesAvailable(staged, record.id)
    const previousOrders = this.deriveOrderMap()
    this.applyRegistrations(staged)
    this.updateProvideTable(staged, record.id)
    this.updateToolTable(staged, record.id)
    record.generations.push(staged)
    record.status = 'enabled'
    delete record.reason
    const previousSnapshot = record.snapshot
    delete record.snapshot
    this.refreshOrders()
    try {
      await this.store.writeGeneration(record.id, staged.number, {
        v: 1,
        source: record.source,
        manifest: definition,
        resolvedConfig: staged.resolvedConfig,
      })
      await this.store.writeStatus(record.id, { ...this.statusRecord(record), status: 'enabled' })
    } catch (error) {
      this.compensate(record.id, staged, previousOrders, null)
      record.generations = record.generations.filter(candidate => candidate.number !== staged.number)
      record.status = 'disabled'
      if (previousSnapshot === undefined) delete record.snapshot
      else record.snapshot = previousSnapshot
      this.refreshOrders()
      throw fail('persist-failed', { operation: 'enable', table: 'status' }, record.id, error)
    }
    // mountDeclared only runs for recovered dynamic rows; static records are
    // always mounted through adoptStatic.
    await this.auditMount(record.id, definition.version, staged.number, record.origin as InstallOrigin)
    this.emit('plugin/activated', this.eventPayload(record.id, definition, staged.number))
    this.emit('plugin/enabled', this.eventPayload(record.id, this.manifestOf(record), this.generationNumber(record)))
  }

  /**
   * Disable: delete-class write order (persist first, then runtime removal).
   * @param id - plugin id to disable.
   * @param reason - optional durable reason stamped on the status row.
   */
  async disable(id: string, reason?: string): Promise<void> {
    return this.withLock(id, 'disable', async () => {
      const record = this.requireRecord(id, 'disable')
      if (record.status === 'disabled') return
      if (record.status === 'shadowed') return
      try {
        await this.store.writeStatus(id, {
          ...this.statusRecord(record, reason),
          status: 'disabled',
        })
      } catch (error) {
        throw fail('persist-failed', { operation: 'disable', table: 'status' }, id, error)
      }
      record.status = 'disabled'
      if (reason === undefined) delete record.reason
      else record.reason = reason
      this.refreshOrders()
      this.emit('plugin/disabled', {
        ...this.eventPayload(id, this.manifestOf(record), this.generationNumber(record)),
        ...(reason === undefined ? {} : { reason }),
      })
    })
  }

  /**
   * Replace: the seven-step protocol (§14).
   * @param id - plugin id whose generation is replaced.
   * @param source - the new source; `resolveSource` resolves it inside the plan.
   * @param options - force flag and replacement config.
   * @returns the managed handle of the replaced plugin.
   */
  async replace(
    id: string,
    source: PluginSource,
    options: { readonly force?: boolean; readonly config?: unknown } = {},
  ): Promise<PluginHandleInfo> {
    return this.withLock(id, 'replace', async () => {
      this.requireRecord(id, 'replace')
      const definition = await this.resolveSource(source)
      return this.replaceWithDefinition(id, source, definition, options.force === true, options.config)
    })
  }

  /**
   * Hot-config update: reuse the replace path with the same code (HP:98).
   * @param id - plugin id to reconfigure.
   * @param patch - new resolved config value.
   */
  async updateConfig(id: string, patch: unknown): Promise<void> {
    await this.withLock(id, 'updateConfig', async () => {
      const record = this.requireRecord(id, 'updateConfig')
      const manifest = record.generations.at(-1)?.manifest
      if (manifest === undefined) {
        throw fail('staging-failed', { stage: 'cache', cause: 'no generation to update' }, id)
      }
      await this.replaceWithDefinition(id, record.source, manifest, false, patch)
    })
  }

  /**
   * Return to a cached generation: a fresh replace with the cache as source (HP:138).
   * @param id - plugin id to roll back.
   * @param generation - cached generation number to restore.
   * @returns the managed handle of the restored plugin.
   */
  async replaceToGeneration(id: string, generation: number): Promise<PluginHandleInfo> {
    return this.withLock(id, 'replace', async () => {
      const record = this.requireRecord(id, 'replace')
      const cached = record.generations.find(candidate => candidate.number === generation)
      if (cached === undefined) {
        throw fail('staging-failed', { stage: 'cache', cause: `generation ${generation} not retained` }, id)
      }
      try {
        return await this.replaceWithDefinition(id, cached.source, cached.manifest, false, cached.resolvedConfig)
      } catch (error) {
        if (error instanceof PluginError && isRelationshipCode(error.code)) {
          throw fail('companion-conflict', { companion: firstPeer(error.details, id) }, id, error)
        }
        throw error
      }
    })
  }

  /**
   * Read-only view of the managed set.
   * @returns handles sorted by plugin id.
   */
  plugins(): readonly PluginHandleInfo[] {
    return [...this.records.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(record => this.handleOf(record))
  }

  /**
   * Plan preview against the current managed set (§15.3/PO:242). Async since
   * install/replace resolve their source through the manager's resolver;
   * resolution is pure-read — no fiber, no hooks, no registry writes
   * (2026-08-08 ruling #4).
   * @param operation - the operation to preview.
   * @returns the plan verdict.
   */
  async plan(operation: PluginOperation): Promise<PluginOperationPlan> {
    if (operation.op === 'install') {
      const definition = await this.resolveSource(operation.source)
      return planOperation({ op: 'install', plugin: declarationOf(definition) }, this.planState())
    }
    if (operation.op === 'replace') {
      const definition = await this.resolveSource(operation.source)
      return planOperation({
        op: 'replace',
        id: operation.id,
        plugin: declarationOf(definition),
        force: operation.force === true,
      }, this.planState())
    }
    return planOperation({ op: operation.op, id: operation.id }, this.planState())
  }

  /**
   * T4 boot recovery: revalidate every row, mount or quarantine, then GC.
   * @returns the recovery report of every row processed.
   */
  async recover(): Promise<LifecycleRecoveryReport> {
    const rows: RecoveryRow[] = []
    let orphanGenerations = 0
    let historyTrimmed = 0
    const ids = await this.store.listIds()
    for (const id of ids) {
      let status: StatusRecord | undefined
      try {
        status = await this.store.readStatus(id)
      } catch {
        await this.store.writeStatus(id, {
          v: 1,
          currentGen: 0,
          previousGen: null,
          status: 'quarantined',
          reason: 'damaged-record',
          provenance: { origin: 'runtime-api', mountedAt: 0 },
        })
        await this.auditRecovery('quarantine', id, 'damaged-record')
        rows.push({ id, status: 'quarantined', reason: 'damaged-record' })
        continue
      }
      if (status === undefined) {
        await this.store.deletePlugin(id)
        orphanGenerations += 1
        rows.push({ id, status: 'gc', reason: 'orphan' })
        continue
      }
      if (this.staticIds.has(id)) {
        await this.store.writeStatus(id, { ...status, status: 'shadowed', reason: 'shadowed' })
        await this.auditRecovery('shadow', id, 'shadowed')
        // The dynamic row stays visible with status shadowed (T2-4): the
        // record is generation-less until the static incumbent adopts the id
        // or the operator revives it through a replace.
        this.records.set(id, {
          id,
          origin: status.provenance.origin,
          source: { type: 'inline', code: '' },
          status: 'shadowed',
          reason: 'shadowed',
          generations: [],
          state: undefined,
        })
        rows.push({ id, status: 'shadowed', reason: 'shadowed' })
        continue
      }
      let gens: readonly { readonly gen: number; readonly record: GenerationRecord }[]
      try {
        gens = await this.store.readGenerations(id)
      } catch {
        await this.store.writeStatus(id, { ...status, status: 'quarantined', reason: 'damaged-record' })
        await this.auditRecovery('quarantine', id, 'damaged-record')
        rows.push({ id, status: 'quarantined', reason: 'damaged-record' })
        continue
      }
      const current = gens.find(entry => entry.gen === status.currentGen)
      if (current === undefined) {
        await this.store.writeStatus(id, { ...status, status: 'quarantined', reason: 'damaged-record' })
        await this.auditRecovery('quarantine', id, 'damaged-record')
        rows.push({ id, status: 'quarantined', reason: 'damaged-record' })
        continue
      }
      const record = current.record
      if ((record as { readonly v?: unknown }).v !== 1 || !isManifestShaped(record.manifest)) {
        await this.store.writeStatus(id, { ...status, status: 'quarantined', reason: 'damaged-record' })
        await this.auditRecovery('quarantine', id, 'damaged-record')
        rows.push({ id, status: 'quarantined', reason: 'damaged-record' })
        continue
      }
      let definition: PluginDefinition
      try {
        definition = await this.resolveSource(record.source as PluginSource)
      } catch {
        await this.store.writeStatus(id, { ...status, status: 'quarantined', reason: 'package-not-resolvable' })
        await this.auditRecovery('quarantine', id, 'package-not-resolvable')
        rows.push({ id, status: 'quarantined', reason: 'package-not-resolvable' })
        continue
      }
      try {
        this.validate(definition, status.provenance.origin, record.source)
      } catch (error) {
        // Mount validation always rejects with a PluginError.
        const code = (error as PluginError).code
        await this.store.writeStatus(id, { ...status, status: 'quarantined', reason: 'validation-failed' })
        await this.auditRecovery('quarantine', id, 'validation-failed', { code })
        rows.push({ id, status: 'quarantined', reason: 'validation-failed', errorCode: code })
        continue
      }
      if (status.status === 'enabled') {
        const previous = { generation: status.currentGen, version: definition.version }
        const captured = status.snapshot === undefined
          ? undefined
          : await this.persistence?.snapshots.read(
            id,
            status.currentGen,
            status.snapshot,
            (message) => { this.logger.warn(message) },
          )
        let generation: EngineGeneration
        try {
          generation = await this.stageNew(definition, record.source, record.resolvedConfig, previous, captured)
          this.assertToolNamesAvailable(generation, id)
        } catch (error) {
          await this.store.writeStatus(id, { ...status, status: 'quarantined', reason: 'validation-failed' })
          await this.auditRecovery('quarantine', id, 'validation-failed', {
            code: errorCodeOf(error),
          })
          rows.push({ id, status: 'quarantined', reason: 'validation-failed', errorCode: errorCodeOf(error) })
          continue
        }
        const previousOrders = this.deriveOrderMap()
        await this.commitGeneration(id, status.provenance.origin, record.source, generation, 'enabled', previousOrders, null)
        await this.auditMount(
          id,
          definition.version,
          generation.number,
          status.provenance.origin as InstallOrigin,
        )
        rows.push({ id, status: 'restored' })
      } else {
        // Full disabled recovery (#17 closure): the manifest is restaged
        // without mounting, so declarations and dependency edges survive.
        // Quarantined rows stay status-only: their manifest failed the
        // environment's validation, so it is not trusted for declarations.
        const declared: EngineGeneration[] = status.status === 'disabled'
          ? [{
            number: status.currentGen,
            manifest: definition,
            code: record.source.type === 'inline' ? record.source.code : '',
            source: record.source,
            resolvedConfig: this.resolveConfig(definition, record.resolvedConfig),
            registrations: [],
            disposers: [],
            remainingEvents: new Set(),
            provides: new Map(),
            tools: new Map(),
            promptSections: new Map(),
            mounted: false,
          }]
          : []
        this.records.set(id, {
          id,
          origin: status.provenance.origin,
          source: record.source,
          status: status.status,
          generations: declared,
          state: undefined,
          ...(status.snapshot === undefined ? {} : { snapshot: status.snapshot }),
          ...(status.reason === undefined ? {} : { reason: status.reason }),
        })
        rows.push({
          id,
          status: status.status === 'disabled' ? 'restored' : 'quarantined',
          ...(status.reason === undefined ? {} : { reason: status.reason }),
        })
      }
      const trimmed = await this.trimHistory(id, status)
      historyTrimmed += trimmed
    }
    for (const record of this.records.values()) {
      for (const generation of record.generations) {
        this.nextGeneration = Math.max(this.nextGeneration, generation.number + 1)
      }
    }
    if (this.persistence !== undefined) {
      const keep = new Set<string>()
      for (const record of this.records.values()) {
        const current = record.generations.at(-1)
        if (current !== undefined) keep.add(`${record.id}/${current.number}`)
      }
      const removedSnapshots = await this.persistence.snapshots.gc(keep)
      if (orphanGenerations + historyTrimmed + removedSnapshots > 0) {
        await this.persistence.audit.append({
          class: 'boot-gc',
          actor: 'system',
          details: { orphanGenerations, historyTrimmed, removedSnapshots },
        })
      }
    }
    this.logger.info(
      `plugin registry recovery: restored ${rows.filter(row => row.status === 'restored').length}, `
      + `shadowed ${rows.filter(row => row.status === 'shadowed').length}, `
      + `quarantined ${rows.filter(row => row.status === 'quarantined').length}, `
      + `gc ${orphanGenerations} generations / ${historyTrimmed} history rows`,
    )
    return {
      restored: rows.filter(row => row.status === 'restored').length,
      shadowed: rows.filter(row => row.status === 'shadowed').length,
      quarantined: rows.filter(row => row.status === 'quarantined').length,
      gc: { orphanGenerations, historyTrimmed },
      rows,
    }
  }

  /** T5 audit entry for one recovery classification. */
  private async auditRecovery(
    kind: 'quarantine' | 'shadow',
    _id: string,
    reason: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    // Recovery classification entries are written before the row's record is
    // materialized, so no plugin identity is attached (schema-optional).
    await this.persistence?.audit.append({
      class: kind,
      actor: 'system',
      reason,
      ...(details === undefined ? {} : { details }),
    })
  }

  /** Dispose every retained generation and clear engine state. */
  dispose(): void {
    for (const disposer of this.idleDisposers.values()) disposer()
    this.idleDisposers.clear()
    for (const disposer of this.toolRegistryDisposers.values()) disposer()
    this.toolRegistryDisposers.clear()
    for (const disposer of this.promptSectionDisposers.values()) disposer()
    this.promptSectionDisposers.clear()
    for (const record of this.records.values()) {
      for (const generation of record.generations) {
        for (const disposer of generation.disposers) disposer()
      }
    }
    this.records.clear()
    this.provideTable.clear()
    this.toolIndirections.clear()
    this.promptSectionTable.clear()
    this.locks.clear()
    this.neutral.clear()
  }

  /**
   * Current value of one manager-held capability (staging-env accessor).
   * @param capability - capability key to read.
   * @returns the live value, or `undefined` when not provided.
   */
  provideValue(capability: string): unknown {
    return this.provideTable.get(capability)?.value
  }

  /**
   * Read-only sessionPersistence projection, or `undefined` without the host seam (Proposal B).
   * @returns the manager-curated projection, or `undefined` when no seam exists.
   */
  sessionPersistenceProjection(): SessionPersistenceProjection | undefined {
    return this.sessionPersistence === undefined
      ? undefined
      : createSessionPersistenceProjection(this.sessionPersistence)
  }

  /** One rate-limited logger per plugin id (SEC:71), shared across generations. */
  private envLogger(id: string): Logger {
    const existing = this.logLimiters.get(id)
    if (existing !== undefined) return existing
    const limited = createRateLimitedLogger(this.logger, this.now)
    this.logLimiters.set(id, limited)
    return limited
  }

  private async withLock<T>(id: string, operation: string, body: () => Promise<T>): Promise<T> {
    const running = this.locks.get(id)
    if (running !== undefined) {
      throw fail('concurrent-operation', { id, operation: running }, id)
    }
    this.locks.set(id, operation)
    try {
      return await body()
    } finally {
      this.locks.delete(id)
    }
  }

  private requireRecord(id: string, operation: string): ManagedRecord {
    const record = this.records.get(id)
    if (record === undefined) throw fail('plugin-not-found', { id, operation }, id)
    return record
  }

  private validate(definition: PluginDefinition, origin: 'static' | InstallOrigin, source: PluginSource | { readonly type: 'static' }): void {
    const ceiling = origin === 'model'
      ? 'transform'
      : origin === 'static'
        ? 'claims'
        : this.config.maxRuntimeApiPermissionLevel
    validateMount(definition, {
      source,
      origin,
      channelCeiling: ceiling,
      ...(this.config.grants?.[definition.id] === undefined ? {} : { grants: this.config.grants[definition.id] }),
      ...(this.config.protectedFields === undefined ? {} : { protectedFields: this.config.protectedFields }),
      ...(this.config.development === undefined ? {} : { development: this.config.development }),
      ...(this.config.trustedScopes === undefined ? {} : { trustedScopes: this.config.trustedScopes }),
      vocabulary: this.eventVocabulary,
    })
  }

  private assertNoConflicts(id: string, definition: PluginDefinition, operation: 'install' | 'replace'): void {
    const next = operation === 'install'
      ? [...this.planState().plugins, declarationOf(definition)]
      : this.planState().plugins.map(plugin => plugin.id === id ? declarationOf(definition) : plugin)
    const issues = evaluateConflicts({ ...this.planState(), plugins: next })
    const issue = issues[0]
    if (issue !== undefined) throw fail(issue.code, issue.details, id)
  }

  /** T6 registry quotas: code bytes, projected registry bytes, row count. */
  private async assertRegistryQuota(source: PluginSource, pluginId: string): Promise<void> {
    const codeBytes = source.type === 'inline' ? new TextEncoder().encode(source.code).length : 0
    if (codeBytes > this.config.maxCodeBytes) {
      throw fail('quota-registry-exceeded', { limit: this.config.maxCodeBytes, current: codeBytes }, pluginId)
    }
    const usage = await this.store.usage()
    if (usage.rows >= this.config.maxDynamicPlugins) {
      throw fail('quota-registry-exceeded', { limit: this.config.maxDynamicPlugins, current: usage.rows }, pluginId)
    }
    // Conservative per-install estimate: the gens row (code) plus a small
    // status/manifest overhead.
    const estimated = codeBytes + 1024
    if (usage.bytes + estimated > this.config.maxRegistryBytes) {
      throw fail('quota-registry-exceeded', {
        limit: this.config.maxRegistryBytes,
        current: usage.bytes + estimated,
      }, pluginId)
    }
  }

  /** T5 audit-after-commit: one `mount` entry per successful mount. */
  private async auditMount(id: string, version: string, gen: number, origin: InstallOrigin): Promise<void> {
    await this.persistence?.audit.append({
      class: 'mount',
      plugin: { id, version, gen },
      actor: origin === 'model' ? 'model' : 'operator',
    })
  }

  private async installShadowed(definition: PluginDefinition, source: PluginSource): Promise<PluginHandleInfo> {
    const generation = await this.stageNew(definition, source, undefined, null, undefined)
    this.assertToolNamesAvailable(generation, definition.id)
    try {
      await this.store.writeGeneration(definition.id, generation.number, {
        v: 1,
        source,
        manifest: generation.manifest,
        resolvedConfig: generation.resolvedConfig,
      })
      await this.store.writeStatus(definition.id, {
        v: 1,
        currentGen: generation.number,
        previousGen: null,
        status: 'shadowed',
        reason: 'shadowed',
        provenance: { origin: 'runtime-api', mountedAt: this.now() },
      })
    } catch (error) {
      throw fail('persist-failed', { operation: 'install', table: 'status' }, definition.id, error)
    }
    this.emit('plugin/installed', this.eventPayload(definition.id, definition, generation.number))
    this.emit('plugin/disabled', {
      ...this.eventPayload(definition.id, definition, generation.number),
      reason: 'shadowed',
    })
    return {
      id: definition.id,
      version: definition.version,
      generation: generation.number,
      origin: 'runtime-api',
      status: 'shadowed',
      reason: 'shadowed',
      kinds: definition.kinds,
      requires: definition.requires,
      provides: definition.provides,
      orderNeutral: false,
      source,
    }
  }

  private async stageNew(
    definition: PluginDefinition,
    source: PluginSource | { readonly type: 'static' },
    config: unknown,
    previous: { readonly generation: number; readonly version: string } | null,
    capturedState: unknown,
  ): Promise<EngineGeneration> {
    const resolvedConfig = this.resolveConfig(definition, config)
    const registrations: StagedRegistration[] = []
    const phase: PhaseHolder = { phase: 'setup' }
    const quotas: PluginEffectQuota = { listeners: 0, tools: 0, services: 0 }
    const grants = this.config.grants?.[definition.id]
    const logger = this.envLogger(definition.id)
    const fs = createPluginFs(definition.id, grants, this.io)
    const fetch = createNetworkFetch(definition.id, grants, this.fetchImpl)
    const layers = previous === null ? ['*'] : ['*', ...this.existingScopes(definition.id)]
    const generation = this.nextGeneration
    this.nextGeneration += 1
    try {
      for (const layer of layers) {
        const env = new StagingEnv(
          this,
          definition.id,
          definition,
          registrations,
          layer === '*' ? undefined : layer,
          phase,
          logger,
          fs,
          fetch,
          quotas,
        )
        phase.phase = 'setup'
        if (definition.hooks.setup !== undefined) await definition.hooks.setup(env, resolvedConfig)
        if (definition.stateful && definition.hooks.restoreState !== undefined) {
          await definition.hooks.restoreState(capturedState, previous)
        }
        phase.phase = 'activate'
        const activation = definition.hooks.activate(env)
        if (activation !== undefined) await activation
      }
    } catch (error) {
      throw fail('staging-failed', { stage: 'staging', cause: String(error) }, definition.id, error)
    }
    for (const registration of registrations) {
      if (registration.kind === 'tool') assertToolOutputShape(registration.definition, definition.id)
    }
    return {
      number: generation,
      manifest: definition,
      code: source.type === 'inline' ? source.code : '',
      source,
      resolvedConfig,
      registrations,
      disposers: [],
      remainingEvents: new Set(),
      provides: new Map(),
      tools: new Map(),
      promptSections: new Map(),
      mounted: true,
    }
  }

  private existingScopes(id: string): string[] {
    const record = this.records.get(id)
    return [...new Set((record?.generations.at(-1)?.registrations ?? [])
      .map(registration => registration.scope)
      .filter((scope): scope is string => scope !== undefined))]
      .sort()
  }

  private resolveConfig(definition: PluginDefinition, config: unknown): unknown {
    try {
      return definition.config(config ?? {})
    } catch (error) {
      throw fail('manifest-invalid', { field: 'config', expected: String(error) }, definition.id, error)
    }
  }

  private async commitGeneration(
    id: string,
    origin: 'static' | InstallOrigin,
    source: PluginSource | { readonly type: 'static' },
    generation: EngineGeneration,
    status: 'enabled' | 'disabled' | 'quarantined' | 'shadowed',
    previousOrders: ReadonlyMap<string, readonly string[]>,
    previousGeneration: EngineGeneration | null,
  ): Promise<void> {
    // Runtime commit first (T3 rule 1): registrations, tables, record, orders.
    // Boot recovery and install always commit into a fresh record for the id.
    this.applyRegistrations(generation)
    this.updateProvideTable(generation, id)
    this.updateToolTable(generation, id)
    this.updatePromptSectionTable(generation, id)
    this.syncToolPublishState()
    this.syncPromptSectionState()
    this.records.set(id, {
      id,
      origin,
      source,
      status,
      generations: [generation],
      state: undefined,
    })
    this.refreshOrders()
    try {
      await this.store.writeGeneration(id, generation.number, {
        v: 1,
        source,
        manifest: generation.manifest,
        resolvedConfig: generation.resolvedConfig,
      })
      await this.store.writeStatus(id, {
        v: 1,
        currentGen: generation.number,
        previousGen: previousGeneration?.number ?? null,
        status,
        provenance: { origin, mountedAt: this.now() },
      })
    } catch (error) {
      this.compensate(id, generation, previousOrders, previousGeneration)
      this.records.delete(id)
      const table = String(error).includes('gens') ? 'gens' : 'status'
      throw fail('persist-failed', { operation: 'install', table }, id, error)
    }
  }

  private async replaceWithDefinition(
    id: string,
    source: PluginSource | { readonly type: 'static' },
    definition: PluginDefinition,
    force: boolean,
    config: unknown,
  ): Promise<PluginHandleInfo> {
    const record = this.requireRecord(id, 'replace')
    this.validate(definition, record.origin === 'static' ? 'runtime-api' : record.origin, source)
    if (!force) this.assertNoConflicts(id, definition, 'replace')
    const incumbent = record.generations.at(-1)
    const incumbentProvides = incumbent?.manifest.provides ?? []
    const lost = incumbentProvides.filter(service => !definition.provides.includes(service))
    const added = definition.provides.filter(service => !incumbentProvides.includes(service))
    const dependents = this.dependentsOf(id, lost)
    if (dependents.length > 0) throw fail('dependent-exists', { dependents }, id)
    const plan = planOperation({ op: 'replace', id, plugin: declarationOf(definition), force }, this.planState())
    const newGeneration = (incumbent?.number ?? 0) + 1

    this.emit('plugin/replacing', this.eventPayload(id, definition, newGeneration))

    let state: unknown
    let snapshot: SnapshotMeta | undefined
    if (definition.stateful) {
      try {
        state = incumbent !== undefined && incumbent.manifest.hooks.captureState !== undefined
          ? incumbent.manifest.hooks.captureState()
          : undefined
        if (state !== undefined) {
          try {
            assertJsonState(state, id)
          } catch (error) {
            // 16.4: a rejected capture is a warning surface plus the normal
            // step-3 failure path.
            this.logger.warn(`state-rejected: plugin ${id} capture rejected: ${String(error)}`)
            await this.persistence?.audit.append({
              class: 'state-rejected',
              plugin: { id, version: definition.version, gen: newGeneration },
              actor: record.origin === 'model' ? 'model' : 'operator',
              reason: String(error),
            })
            throw error
          }
        }
      } catch (error) {
        this.emit('plugin/replace-failed', this.failurePayload(id, definition, newGeneration, 'staging-failed', String(error)))
        throw fail('staging-failed', { stage: 'capture', cause: String(error) }, id, error)
      }
      record.state = state
      if (state !== undefined && this.persistence !== undefined) {
        // Snapshot write failure follows the normal step-3 failure path
        // (outer catch): the replace is aborted before any staging side
        // effect and the old generation stays live.
        snapshot = await this.persistence.snapshots.write(id, newGeneration, state)
      }
    }

    const previous = incumbent === undefined ? null : { generation: incumbent.number, version: incumbent.manifest.version }
    let generation: EngineGeneration
    try {
      generation = await this.stageNew(definition, source, config, previous, state)
      this.assertToolNamesAvailable(generation, id)
      this.assertToolRegistryConflicts(generation, id)
      if (definition.swapPolicy !== 'immediate') {
        await this.waitForQuiescence(definition.swapPolicy, affectedEvents(incumbent), id)
      }
    } catch (error) {
      this.emit('plugin/replace-failed', this.failurePayload(id, definition, newGeneration, errorCodeOf(error), String(error)))
      throw error
    }

    const previousOrders = this.deriveOrderMap()
    const previousStatus = record.status
    const previousSnapshot = record.snapshot
    // Runtime commit first: registrations, tables, record, orders.
    this.applyRegistrations(generation)
    this.replaceTables(id, incumbent ?? null, generation)
    this.syncToolPublishState()
    this.syncPromptSectionState()
    record.generations.push(generation)
    record.status = 'enabled'
    if (snapshot === undefined) delete record.snapshot
    else record.snapshot = snapshot
    this.refreshOrders()
    try {
      await this.store.writeGeneration(id, generation.number, {
        v: 1,
        source,
        manifest: generation.manifest,
        resolvedConfig: generation.resolvedConfig,
      })
      await this.store.writeStatus(id, {
        v: 1,
        currentGen: generation.number,
        previousGen: incumbent?.number ?? null,
        status: 'enabled',
        provenance: { origin: record.origin, mountedAt: this.now() },
        ...(snapshot === undefined ? {} : { snapshot }),
      })
    } catch (error) {
      this.compensate(id, generation, previousOrders, incumbent ?? null)
      record.generations = record.generations.filter(candidate => candidate.number !== generation.number)
      record.status = previousStatus
      if (previousSnapshot === undefined) delete record.snapshot
      else record.snapshot = previousSnapshot
      throw fail('persist-failed', { operation: 'replace', table: 'status' }, id, error)
    }
    this.crashAfterPersist()
    if (incumbent !== undefined && this.persistence !== undefined) {
      try {
        await this.persistence.snapshots.delete(id, incumbent.number)
      } catch {
        // Old snapshot cleanup is best-effort: orphan files are boot-GC'd.
      }
    }
    this.trimInMemoryHistory(record)
    if (incumbent !== undefined) this.releaseGeneration(record, incumbent, affectedEvents(incumbent))
    await this.auditMount(id, definition.version, generation.number, record.origin === 'static' ? 'runtime-api' : record.origin)
    const providesPath = lost.length > 0 ? 'dropped' : added.length > 0 ? 'added' : 'unchanged'
    this.emit('plugin/replaced', {
      ...this.eventPayload(id, definition, generation.number),
      displaced: plan.displaced,
      providesPath,
    })
    return this.handleOf(record)
  }

  private async waitForQuiescence(
    policy: 'drain' | 'next-idle',
    events: readonly string[],
    id: string,
  ): Promise<void> {
    const deadline = this.now() + this.swapTimeoutMs
    for (;;) {
      const drainIdle = policy === 'drain' && events.every(event => this.dispatch.inFlightCount(event) === 0)
      const turnIdle = policy === 'next-idle' && !(await this.isTurnBusy())
      if (drainIdle || turnIdle) return
      const waitedMs = this.now() - deadline + this.swapTimeoutMs
      if (waitedMs >= this.swapTimeoutMs) {
        throw fail('swap-timeout', { policy, waitedMs }, id)
      }
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  private releaseGeneration(record: ManagedRecord, generation: EngineGeneration, events: readonly string[]): void {
    const inFlight = events.filter(event => this.dispatch.inFlightCount(event) > 0)
    if (inFlight.length === 0) {
      this.disposeGeneration(generation)
      this.emit('plugin/deactivated', this.eventPayload(record.id, generation.manifest, generation.number))
      return
    }
    generation.remainingEvents = new Set(inFlight)
    const disposers: (() => void)[] = []
    for (const event of inFlight) {
      disposers.push(this.dispatch.onIdle(event, () => {
        generation.remainingEvents.delete(event)
        if (generation.remainingEvents.size > 0) return
        for (const disposer of disposers) disposer()
        this.idleDisposers.delete(record.id)
        this.disposeGeneration(generation)
        this.emit('plugin/deactivated', this.eventPayload(record.id, generation.manifest, generation.number))
      }))
    }
    this.idleDisposers.set(record.id, () => {
      for (const disposer of disposers) disposer()
    })
  }

  private releaseRecord(record: ManagedRecord): void {
    for (const generation of record.generations) {
      this.disposeGeneration(generation)
      this.emit('plugin/deactivated', this.eventPayload(record.id, generation.manifest, generation.number))
    }
    for (const [capability, entry] of this.provideTable) {
      if (entry.pluginId === record.id) this.provideTable.delete(capability)
    }
    for (const [name, entry] of this.toolIndirections) {
      if (entry.pluginId === record.id) this.toolIndirections.delete(name)
    }
    for (const [name, entry] of this.promptSectionTable) {
      if (entry.pluginId === record.id) this.promptSectionTable.delete(name)
    }
    this.syncToolPublishState()
    this.syncPromptSectionState()
    this.idleDisposers.get(record.id)?.()
    this.idleDisposers.delete(record.id)
  }

  private disposeGeneration(generation: EngineGeneration): void {
    for (const disposer of generation.disposers) disposer()
    generation.disposers.length = 0
  }

  private applyRegistrations(generation: EngineGeneration): void {
    for (const registration of generation.registrations) {
      if (registration.kind === 'listener') {
        const disposer = this.dispatch.register(registration.event, {
          pluginId: registration.pluginId,
          mode: registration.mode,
          position: registration.position,
          ...(registration.returns === undefined ? {} : { returns: registration.returns }),
          ...(registration.scope === undefined ? {} : { scope: registration.scope }),
          listener: registration.listener,
        })
        generation.disposers.push(disposer)
      } else if (registration.kind === 'provide') {
        generation.provides.set(registration.capability, registration.value)
      } else if (registration.kind === 'prompt-section') {
        generation.promptSections.set(registration.section.name, registration.section)
      } else {
        // The registration union is closed: not a listener or provide is a tool.
        generation.tools.set(registration.definition.name, registration.definition)
      }
    }
  }

  private assertToolNamesAvailable(generation: EngineGeneration, id: string): void {
    for (const registration of generation.registrations) {
      if (registration.kind !== 'tool') continue
      const name = registration.definition.name
      const existing = this.toolIndirections.get(name)
      if (existing !== undefined && existing.pluginId !== id) {
        throw fail('staging-failed', { stage: 'tool-output', cause: `tool ${name} is already registered by plugin ${existing.pluginId}` }, id)
      }
    }
  }

  /**
   * Staging claims/shadow checks against the real registry (Proposal A,
   * ruling question ②): a managed tool whose name a raw registration already
   * holds is rejected loudly — claims on the slot are `claims-unmanaged-incumbent`
   * (a raw holder's disposer is not the manager's to call), a scoped shadow
   * without a claims declaration is `shadow-undeclared`, and an unscoped
   * registration without claims is `staging-failed`. The later registrant
   * never silently wins.
   */
  private assertToolRegistryConflicts(generation: EngineGeneration, id: string): void {
    const registry = this.toolRegistry
    if (registry === undefined) return
    const claims = new Set(generation.manifest.permissions.claims)
    for (const registration of generation.registrations) {
      if (registration.kind !== 'tool') continue
      const name = registration.definition.name
      if (this.toolRegistryDisposers.has(name)) continue
      if (registry.get(name) === undefined) continue
      const slot = `tool:${name}`
      if (claims.has(slot)) {
        throw fail('claims-unmanaged-incumbent', { slot }, id)
      }
      if (registration.scope !== undefined) {
        throw fail('shadow-undeclared', { tool: name, holder: 'unmanaged registration' }, id)
      }
      throw fail('staging-failed', {
        stage: 'tool-output',
        cause: `tool ${name} is held by an unmanaged registration; the manager cannot evict it`,
      }, id)
    }
  }

  private updateProvideTable(generation: EngineGeneration, id: string): void {
    for (const [capability, value] of generation.provides) {
      this.provideTable.set(capability, { pluginId: id, value })
    }
  }

  private updateToolTable(generation: EngineGeneration, id: string): void {
    for (const [name, definition] of generation.tools) {
      this.toolIndirections.set(name, { pluginId: id, definition })
    }
  }

  private updatePromptSectionTable(generation: EngineGeneration, id: string): void {
    for (const [name, section] of generation.promptSections) {
      this.promptSectionTable.set(name, { pluginId: id, section })
    }
  }

  /**
   * Publish every live manager-held tool into the real registry exactly once,
   * and dispose the indirection of any name that is no longer live. The
   * registry-facing definition is a live view over the manager's current
   * `toolIndirections` entry, so a replace mutates the manager's table and
   * the registry sees no re-registration (no `tools/change`, stable
   * `schemas()` position — F1).
   */
  private syncToolPublishState(): void {
    const registry = this.toolRegistry
    if (registry === undefined) return
    const wanted = new Set(this.toolIndirections.keys())
    for (const [name, disposer] of [...this.toolRegistryDisposers]) {
      if (wanted.has(name)) continue
      disposer()
      this.toolRegistryDisposers.delete(name)
    }
    for (const name of wanted) {
      if (this.toolRegistryDisposers.has(name)) continue
      this.toolRegistryDisposers.set(name, registry.register(this.registryToolView(name)))
    }
  }

  /**
   * Publish every live manager-held prompt section into the host systemPrompt
   * service exactly once as a live view (name/order/text resolve through the
   * current table entry), and dispose the published contribution of any name
   * that is no longer live (Proposal B; HMR-safety).
   */
  private syncPromptSectionState(): void {
    const service = this.promptService
    if (service === undefined) return
    const wanted = new Set(this.promptSectionTable.keys())
    for (const [name, disposer] of [...this.promptSectionDisposers]) {
      if (wanted.has(name)) continue
      disposer()
      this.promptSectionDisposers.delete(name)
    }
    for (const name of wanted) {
      if (this.promptSectionDisposers.has(name)) continue
      this.promptSectionDisposers.set(name, service.section(this.promptSectionView(name)))
    }
  }

  /** Live host-service view of one manager-held prompt section. */
  private promptSectionView(name: string): unknown {
    const current = (): PluginPromptSection => {
      const entry = this.promptSectionTable.get(name)
      if (entry === undefined) throw new Error(`managed prompt section ${name} is not live`)
      return entry.section
    }
    return {
      get name(): string {
        return current().name
      },
      get order(): number {
        return current().order
      },
      get text(): string | ((context: unknown) => string) {
        return current().text
      },
    }
  }

  /** Live registry-facing view of one manager-held tool. */
  private registryToolView(name: string): unknown {
    const current = (): PluginToolDefinition => {
      const entry = this.toolIndirections.get(name)
      if (entry === undefined) throw new Error(`managed tool ${name} is not live`)
      return entry.definition
    }
    return {
      get name(): string {
        return name
      },
      get description(): string {
        return current().description
      },
      get parameters(): Record<string, unknown> {
        return current().input
      },
      get output(): { readonly schema: Record<string, unknown>; render(args: unknown, value: unknown): unknown[] } {
        return {
          get schema(): Record<string, unknown> {
            return current().output
          },
          render: (_args: unknown, value: unknown) => [{
            type: 'text',
            text: typeof value === 'string' ? value : JSON.stringify(value),
          }],
        }
      },
      execute: (args: unknown, exec: unknown) => current().execute(args, exec as PluginToolExecutionContext),
    }
  }

  /** Go-live table swap: publish `next` values, then drop entries the previous
      generation owned that `next` does not re-register (§14 step ⑤). */
  private replaceTables(id: string, previous: EngineGeneration | null, next: EngineGeneration): void {
    this.updateProvideTable(next, id)
    this.updateToolTable(next, id)
    this.updatePromptSectionTable(next, id)
    if (previous === null) return
    for (const capability of previous.provides.keys()) {
      if (next.provides.has(capability)) continue
      const entry = this.provideTable.get(capability)
      if (entry?.pluginId === id) this.provideTable.delete(capability)
    }
    for (const name of previous.tools.keys()) {
      if (next.tools.has(name)) continue
      // Tool names are globally unique (assertToolNamesAvailable), so an old
      // generation's un-re-registered tool cannot belong to another plugin.
      this.toolIndirections.delete(name)
    }
    for (const name of previous.promptSections.keys()) {
      if (next.promptSections.has(name)) continue
      this.promptSectionTable.delete(name)
    }
  }

  private compensate(
    id: string,
    generation: EngineGeneration,
    previousOrders: ReadonlyMap<string, readonly string[]>,
    previousGeneration: EngineGeneration | null,
  ): void {
    this.disposeGeneration(generation)
    this.dispatch.setOrders(new Map(previousOrders))
    // The failed generation must leave no effects behind: drop every table
    // entry this id owns that the previous generation does not re-provide,
    // then restore the previous generation's exact tables.
    for (const [capability, entry] of this.provideTable) {
      if (entry.pluginId === id && !previousGeneration?.provides.has(capability)) {
        this.provideTable.delete(capability)
      }
    }
    for (const [name, entry] of this.toolIndirections) {
      if (entry.pluginId === id && !previousGeneration?.tools.has(name)) {
        this.toolIndirections.delete(name)
      }
    }
    for (const [name, entry] of this.promptSectionTable) {
      if (entry.pluginId === id && !previousGeneration?.promptSections.has(name)) {
        this.promptSectionTable.delete(name)
      }
    }
    if (previousGeneration !== null) {
      for (const [capability, value] of previousGeneration.provides) {
        this.provideTable.set(capability, { pluginId: id, value })
      }
      for (const [name, definition] of previousGeneration.tools) {
        this.toolIndirections.set(name, { pluginId: id, definition })
      }
      for (const [name, section] of previousGeneration.promptSections) {
        this.promptSectionTable.set(name, { pluginId: id, section })
      }
    }
    this.syncToolPublishState()
    this.syncPromptSectionState()
  }

  private refreshOrders(): void {
    const derived = deriveOrders(this.planState())
    this.dispatch.setOrders(derived.orders)
    this.neutral.clear()
    for (const [id, flag] of derived.orderNeutral) this.neutral.set(id, flag)
  }

  private deriveOrderMap(): ReadonlyMap<string, readonly string[]> {
    return deriveOrders(this.planState()).orders
  }

  private planState(): PlanState {
    return {
      plugins: [...this.records.values()]
        // Shadowed rows are part of the managed set with empty placeholder
        // declarations; the derivation excludes them from orders (not enabled).
        .filter(record => record.status === 'enabled' || record.status === 'disabled' || record.status === 'shadowed')
        .map(record => this.declarationOf(record)),
      slotKinds: this.slotKinds,
    }
  }

  private declarationOf(record: ManagedRecord): PluginDeclarationInput {
    const generation = record.generations.at(-1)
    return {
      id: record.id,
      permissions: generation?.manifest.permissions ?? emptyPermissions(),
      requires: generation?.manifest.requires ?? [],
      provides: generation?.manifest.provides ?? [],
      scopes: this.existingScopes(record.id),
      enabled: record.status === 'enabled',
      origin: record.origin === 'static' ? 'static' : record.origin,
    }
  }

  private dependentsOf(id: string, services?: readonly string[]): string[] {
    const lost = services ?? this.records.get(id)?.generations.at(-1)?.manifest.provides ?? []
    return [...this.records.values()]
      .filter(record => record.id !== id)
      .filter(record => (record.generations.at(-1)?.manifest.requires ?? []).some(service => lost.includes(service)))
      .map(record => record.id)
      .sort()
  }

  private trimInMemoryHistory(record: ManagedRecord): void {
    while (record.generations.length > this.historyKeep) {
      // The loop condition guarantees a shift result.
      this.disposeGeneration(record.generations.shift() as EngineGeneration)
    }
  }

  private async trimHistory(id: string, status: StatusRecord): Promise<number> {
    const gens = await this.store.readGenerations(id)
    const keep = new Set<number>([status.currentGen, ...(status.previousGen === null ? [] : [status.previousGen])])
    let trimmed = 0
    for (const entry of gens) {
      if (keep.has(entry.gen)) continue
      await this.store.deleteGeneration(id, entry.gen)
      trimmed += 1
    }
    return trimmed
  }

  private handleOf(record: ManagedRecord): PluginHandleInfo {
    const generation = record.generations.at(-1)
    return {
      id: record.id,
      version: generation?.manifest.version ?? '',
      generation: generation?.number ?? 0,
      origin: record.origin,
      status: record.status,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
      kinds: generation?.manifest.kinds ?? [],
      requires: generation?.manifest.requires ?? [],
      provides: generation?.manifest.provides ?? [],
      orderNeutral: this.neutral.get(record.id) ?? false,
      source: record.source,
    }
  }

  private record(id: string): ManagedRecord {
    // Every caller has just created or adopted the record.
    return this.records.get(id) as ManagedRecord
  }

  /** The latest generation's manifest, or an empty placeholder for status-only records. */
  private manifestOf(record: ManagedRecord): PluginDefinition {
    return record.generations.at(-1)?.manifest ?? emptyManifest(record.id)
  }

  /** The latest generation number, or 0 for status-only records. */
  private generationNumber(record: ManagedRecord): number {
    return record.generations.at(-1)?.number ?? 0
  }

  private statusRecord(record: ManagedRecord, reason?: string): StatusRecord {
    // Every managed record owns at least one generation (recovered shadowed
    // rows are the only generation-less records and never reach this path).
    const generation = record.generations.at(-1) as EngineGeneration
    return {
      v: 1,
      currentGen: generation.number,
      previousGen: record.generations.length > 1 ? (record.generations.at(-2) as EngineGeneration).number : null,
      status: record.status,
      ...(reason === undefined ? {} : { reason }),
      ...(record.snapshot === undefined ? {} : { snapshot: record.snapshot }),
      provenance: { origin: record.origin, mountedAt: this.now() },
    }
  }

  private eventPayload(id: string, manifest: PluginDefinition, generation: number): PluginLifecycleEventPayload {
    return { id, name: id, version: manifest.version, generation }
  }

  private failurePayload(
    id: string,
    manifest: PluginDefinition,
    generation: number,
    code: string,
    message: string,
  ): PluginLifecycleEventPayload {
    return { ...this.eventPayload(id, manifest, generation), error: { code, message } }
  }

  private emit(event: string, payload: PluginLifecycleEventPayload): void {
    this.ctx.emit(event as keyof Events, payload)
  }
}

function declarationOf(definition: PluginDefinition): PluginDeclarationInput {
  return {
    id: definition.id,
    permissions: definition.permissions,
    requires: definition.requires,
    provides: definition.provides,
  }
}

function emptyPermissions(): PluginDefinition['permissions'] {
  return { observe: [], transform: [], intercept: [], position: 'derived', claims: [] }
}

function emptyManifest(id: string): PluginDefinition {
  return {
    id,
    version: '',
    kinds: [],
    requires: [],
    provides: [],
    permissions: emptyPermissions(),
    stateful: false,
    swapPolicy: 'immediate',
    config: {} as PluginDefinition['config'],
    hooks: {} as PluginDefinition['hooks'],
  }
}

function affectedEvents(generation: EngineGeneration | undefined): string[] {
  return [...new Set((generation?.registrations ?? [])
    .filter(registration => registration.kind === 'listener')
    .map(registration => registration.event))]
    .filter(event => event !== '')
    .sort()
}

function assertToolOutputShape(definition: PluginToolDefinition, pluginId: string): void {
  const output: unknown = definition.output
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    throw fail('staging-failed', { stage: 'tool-output', cause: `output schema of ${definition.name} is not an object` }, pluginId)
  }
}

function assertJsonState(state: unknown, pluginId: string): void {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(state))
    if (bytes.length > 10 * 1024 * 1024) {
      throw new Error('state exceeds 10MB')
    }
  } catch (error) {
    throw fail('staging-failed', { stage: 'capture', cause: String(error) }, pluginId, error)
  }
}

function isManifestShaped(value: unknown): value is PluginDefinition {
  return typeof value === 'object' && value !== null && typeof (value as PluginDefinition).id === 'string'
}

function isRelationshipCode(code: PluginErrorCode): boolean {
  return [
    'write-conflict',
    'intercept-branch-conflict',
    'ordering-cycle',
    'veto-position-conflict',
    'claims-conflict',
    'claims-unmanaged-incumbent',
    'shadow-undeclared',
  ].includes(code)
}

function firstPeer(details: Record<string, unknown>, id: string): string {
  const candidates = [details.a, details.b, details.companion, details.slot]
    .filter((value): value is string => typeof value === 'string')
  return candidates.find(candidate => candidate !== id) ?? String(candidates[0])
}

function errorCodeOf(error: unknown): PluginErrorCode {
  // The engine wraps every staging failure into a PluginError before this point.
  return (error as PluginError).code
}

function fail(code: PluginErrorCode, details: Record<string, unknown>, pluginId: string | undefined, cause?: unknown): PluginError {
  const error = new PluginError(code, formatPluginError(code, details), details, pluginId)
  if (cause !== undefined) (error as PluginError & { cause?: unknown }).cause = cause
  return error
}
