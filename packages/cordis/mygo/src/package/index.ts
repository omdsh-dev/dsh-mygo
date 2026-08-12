/**
 * mygo 插件包管理体系（《收敛任务》）公共面。
 * @module @deepseek-ai/dsh-mygo/src/package
 */

export { extractPlugin, loadPluginEntry } from './entry-loader.ts'
export { scanBundles, detectUndeclaredBundles, sourceCallsDshCore } from './bundle-scan.ts'
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
export type { ManifestProblem, PluginManifestV2 } from './manifest-v2.ts'
export { computeMountOrder } from './mount-order.ts'
export type { MountEdge, MountOrderResult } from './mount-order.ts'
export { PluginPackageManager } from './package-manager.ts'
export type { PackageInstallOutcome, PackageManagerOptions } from './package-manager.ts'
export { installPackageToStore, readInstalledPackage } from './package-store.ts'
export type { InstalledPackage, InstallPackageOptions } from './package-store.ts'
export { resolveDshHome, resolveMygoPaths, lockfilePath, packageDir, pluginConfigPath, resolveCoreVersion } from './paths.ts'
export type { MygoPaths } from './paths.ts'
export { fetchRegistryMetadata, downloadTarball, encodeRegistryName } from './registry-client.ts'
export type { RegistryClientOptions, RegistryMetadata, RegistryVersionInfo } from './registry-client.ts'
export { findDependsCycle, resolve, sortCandidates, topologicalOrder } from './resolver.ts'
export type { PluginCandidate, ResolvedPlugin, ResolverInput, VersionConstraints, ResolveOutcome } from './resolver.ts'
export { sortConstraints, suggestActions } from './report.ts'
export type { CandidateRejection, ConflictEntry, ConstraintRef, CycleEntry, ResolutionReport } from './report.ts'
