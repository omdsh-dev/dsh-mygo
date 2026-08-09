/**
 * The managed-plugin bridge: `ctx.pluginManager` service key types, manager
 * Config, and the §16 group-1/2 mount-time validation chain. The #12 skeleton
 * ships the typed service surface and validation; operation semantics land
 * with the schedule's later stages (#13 plan, #15 lifecycle engine).
 * @module @deepseek-ai/dsh-mygo
 */

export { PluginManagerConfigSchema, resolvePluginManagerConfig } from './config.ts'
export { validateManifest, MANIFEST_SCHEMA } from './manifest.ts'
export { assertEventOptions, validateMount } from './mount.ts'
export { evaluateConflicts } from './conflicts.ts'
export { buildScopeGraph, deriveOrders, deriveScopeOrder, scopeMembers } from './order.ts'
export type { ScopeEdge, ScopeGraph } from './order.ts'
export { planOperation } from './plan.ts'
export { DispatchMachine, managedListenerOptions } from './dispatch.ts'
export { LifecycleEngine } from './lifecycle.ts'
export { PluginManagerService, PluginManagerServiceConfig } from './service.ts'
import { PluginManagerService } from './service.ts'
export type { PluginManagerServiceConfigValue } from './service.ts'
export { InMemoryRegistryStore } from './store.ts'
export { AuditLog } from './audit.ts'
export type { AuditClass, AuditEntry, AuditInput } from './audit.ts'
export { RegistryPersistence } from './persistence.ts'
export type { RegistryPersistenceOptions } from './persistence.ts'
export { sanitizeProfileName, pluginRegistryDomainSpec, fnv1a } from './registry-domain.ts'
export { SnapshotStore } from './snapshots.ts'
export type { SnapshotMeta } from './snapshots.ts'
export { openSqliteRegistryStore, parseGenerationRecord, parseStatusRecord, RegistryRowError, SqliteRegistryStore } from './sqlite-store.ts'
export {
  assertFileMode,
  claimEffect,
  createPluginFs,
  createRateLimitedLogger,
  createNetworkFetch,
  fileModeForPath,
  networkUrlAllowed,
  nodePluginIo,
  normalizeGatePath,
  pathPrefixCovers,
  realPathOf,
  type PluginEffectQuota,
  type PluginIo,
} from './capabilities.ts'
export type {
  GenerationRecord,
  ProvenanceRecord,
  RegistryStore,
  StatusRecord,
} from './store.ts'
export type {
  LifecycleEngineOptions,
  LifecycleRecoveryReport,
  PromptServiceLike,
  RecoveryRow,
  SessionPersistenceProjection,
  ToolRegistryLike,
} from './lifecycle.ts'
export { createSessionPersistenceProjection } from './lifecycle.ts'
export { EVENT_VOCABULARY } from './event-vocabulary.ts'
export type { PluginEventVocabularyEntry } from './event-vocabulary.ts'
export type {
  DispatchMachineOptions,
  DispatchViolation,
  EventDispatchMode,
  ManagedListenerEntry,
  ManagedListenerMetadata,
} from './dispatch.ts'
export type {
  ConflictIssue,
  DerivationResult,
  MountValidationOptions,
  MountValidationResult,
  PermissionLevel,
  PlanOperationInput,
  PlanState,
  PluginDeclarationInput,
  PluginGrants,
  PluginLifecycleEventPayload,
  PluginManager,
  PluginManagerConfig,
  PluginOperation,
  PluginOperationPlan,
  SlotKind,
} from './types.ts'

/** The Loader-facing service plugin (default export; named exports stay library surfaces). */
export default PluginManagerService
