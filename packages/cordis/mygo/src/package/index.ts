/**
 * mygo 插件包管理体系（《收敛任务》）公共面。
 * @module @deepseek-ai/dsh-mygo/src/package
 */

export { extractPlugin, loadPluginEntry } from './entry-loader.ts'
export { scanBundles, detectUndeclaredBundles, sourceCallsDshCore, dshCoreSpecifiers, packageNameOfSpecifier } from './bundle-scan.ts'
export type { BundleScanResult, ScannedBundle } from './bundle-scan.ts'
export { BUILTIN_LOADERS, validateLoaderDeclaration } from './loader-registry.ts'
export type { LoaderContract, LoaderValidation } from './loader-registry.ts'
export { MountOrchestrator, PatchLateRegistrationError } from './mount-orchestrator.ts'
export type { MountPhase, Phase0Outcome, PhaseTrace } from './mount-orchestrator.ts'
export { detectPatchConflicts, deterministicPatchOrder, patchTargetKey } from './patch-table.ts'
export type { DeclaredPatch, PatchConflict } from './patch-table.ts'
export {
  collectNamedImports,
  probePackageExports,
  scanPluginImports,
  verifySymbols,
} from './symbol-verify.ts'
export type { ImportRef, SymbolCheck } from './symbol-verify.ts'
export { writeLockfile, readLockfile, verifyLockfile, sha256File, sha256Text } from './lockfile.ts'
export type { Lockfile, LockedPlugin, VerifyIssue } from './lockfile.ts'
export { parsePackageManifest, constraintsOf } from './manifest-v2.ts'
export type { ManifestProblem, PluginManifestV2, PluginManifestV3 } from './manifest-v2.ts'
export { computeMountOrder } from './mount-order.ts'
export type { MountEdge, MountOrderResult } from './mount-order.ts'
export { PluginPackageManager } from './package-manager.ts'
export type { PackageInstallOutcome, PackageManagerOptions } from './package-manager.ts'
export {
  buildPluginPack,
  installPluginPack,
  parsePackManifest,
  computePackManifestSha256,
  canonicalPackPayload,
  listTarMembers,
  listGzipTarMembers,
  normalizeTarName,
} from './pack.ts'
export type {
  PackBuildOptions,
  PackBuildOutcome,
  PackCommunityDep,
  PackContext,
  PackFileEntry,
  PackGenerated,
  PackInstallOptions,
  PackInstallOutcome,
  PackManifest,
  PackPluginDecl,
  TarMember,
} from './pack.ts'
export { installPackageToStore, readInstalledPackage } from './package-store.ts'
export type { InstalledPackage, InstallPackageOptions } from './package-store.ts'
export { resolveDshHome, resolveMygoPaths, lockfilePath, packageDir, pluginConfigPath, resolveCoreVersion } from './paths.ts'
export type { MygoPaths } from './paths.ts'
export { fetchRegistryMetadata, downloadTarball, encodeRegistryName } from './registry-client.ts'
export type { RegistryClientOptions, RegistryMetadata, RegistryVersionInfo } from './registry-client.ts'
export { findDependsCycle, resolve, sortCandidates, topologicalOrder } from './resolver.ts'
export type { PluginCandidate, ResolvedPlugin, ResolverInput, VersionConstraints, ResolveOutcome } from './resolver.ts'
export { sortConstraints, suggestActions } from './report.ts'
export type {
  CandidateRejection,
  ConflictEntry,
  ConstraintRef,
  CycleEntry,
  ResolutionReport,
  ServiceConflictEntry,
  ServiceResolutionReport,
} from './report.ts'
export { integritySha512Hex, sha512File } from './lockfile.ts'
export { FineEpochRegistry, captureExports, fineEpoch, preGate } from './fine-epoch.ts'
export type { PreGateResult, ProviderSymbolSnapshot } from './fine-epoch.ts'
export { ProviderObservationRegistry } from './provider-observations.ts'
export type { ProviderLifecycleState, ProviderObservation } from './provider-observations.ts'
export { evaluateRequiresGate, requiresGateReport } from './requires-gate.ts'
export type { RequiresGateInput, RequiresGateResult, RequiresViolationKind } from './requires-gate.ts'
export { harvestPackageMetadata, CORDIS_DSH_ANCHORS } from './harvester.ts'
export type { HarvestResult } from './harvester.ts'
export { detectDualPresence } from './dual-presence.ts'
export type { DualPresenceInput, DualPresenceWarning } from './dual-presence.ts'
export { expandBundlePatch } from './bundle-expand.ts'
export type { ExpandedEntryRow } from './bundle-expand.ts'
export { mapLegacyPluginFile } from './legacy-mapping.ts'
export type { LegacyMappingResult, LegacyPluginFile } from './legacy-mapping.ts'
export { checkTemplateAlignment, TEMPLATE_REFERENCE } from './template-align.ts'
export type { TemplateAlignResult } from './template-align.ts'
