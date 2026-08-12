/**
 * 插件包管理器（《收敛任务》总编排）：安装时求解 → 下载入 store → 写
 * lockfile；加载时只校验（不重新求解、不查 registry）；失败输出全量结构化报告。
 * @module @deepseek-ai/dsh-mygo/src/package/package-manager
 */

import { readLockfile, verifyLockfile, writeLockfile, type Lockfile, type LockedPlugin } from './lockfile.ts'
import { detectUndeclaredBundles, scanBundles, type ScannedBundle } from './bundle-scan.ts'
import { probePackageExports, scanPluginImports, verifyPluginSymbols, type SymbolCheck } from './symbol-verify.ts'
import { matchesVersionRange } from '../semver-range.ts'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { constraintsOf, type PluginManifestV2 } from './manifest-v2.ts'
import { computeMountOrder, type MountEdge } from './mount-order.ts'
import { installPackageToStore, type InstalledPackage } from './package-store.ts'
import { lockfilePath, packageDir, type MygoPaths } from './paths.ts'
import { fetchRegistryMetadata, type RegistryVersionInfo } from './registry-client.ts'
import { resolve, type PluginCandidate, type ResolveOutcome } from './resolver.ts'
import { extractPlugin, loadPluginEntry } from './entry-loader.ts'
import type { ResolutionReport } from './report.ts'

export interface PackageManagerOptions {
  readonly paths: MygoPaths
  readonly profile: string
  readonly registry?: string
  readonly token?: string
  readonly tarCmd?: string
  readonly coreVersion?: string
  /** profile 钉定（包名 → 精确版本），作为求解器输入约束。 */
  readonly pins?: ReadonlyMap<string, { readonly version: string; readonly source?: string }>
  /** 符号校验的 exports 提供者；缺省从 profile node_modules 解析。 */
  readonly exportsProvider?: (specifier: string) => Promise<ReadonlySet<string> | undefined>
  readonly managerVersion: string
}

export type PackageInstallOutcome =
  | {
    readonly ok: true
    readonly installed: InstalledPackage
    readonly lockfile: Lockfile
    readonly warnings: readonly string[]
  }
  | { readonly ok: false; readonly report: ResolutionReport }

/** 默认 exports 提供者：从 profile node_modules 解析目标包并探测运行时导出。 */
function defaultExportsProvider(
  paths: MygoPaths,
  profile: string,
): (specifier: string) => Promise<ReadonlySet<string> | undefined> {
  const profileDir = join(paths.base, '..', 'profiles', profile)
  return async (specifier: string): Promise<ReadonlySet<string> | undefined> => {
    try {
      const req = createRequire(join(profileDir, 'noop.js'))
      const pkgPath = req.resolve(`${specifier}/package.json`)
      const root = dirname(pkgPath)
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as {
        readonly main?: unknown
        readonly exports?: Readonly<Record<string, { readonly default?: unknown }>>
      }
      let entry = 'lib/index.js'
      if (typeof pkg.main === 'string') entry = pkg.main
      const defaultExport = pkg.exports?.['.']?.default
      if (typeof defaultExport === 'string') entry = defaultExport
      return probePackageExports(join(root, entry))
    } catch {
      return undefined
    }
  }
}

/** The package management orchestration surface. */
export class PluginPackageManager {
  constructor(private readonly options: PackageManagerOptions) {}

  private lockPath(): string {
    return lockfilePath(this.options.paths, this.options.profile)
  }

  /** Read the current lockfile (undefined when legacy/no lockfile). */
  async readLock(): Promise<Lockfile | undefined> {
    return readLockfile(this.lockPath())
  }

  /**
   * Install one npm plugin package: registry metadata → candidates →
   * deterministic resolve → store install → lockfile write.
   */
  async resolveInstall(
    source: { readonly package: string; readonly range?: string },
  ): Promise<PackageInstallOutcome> {
    const metadata = await this.fetchMetadata(source.package)
    const idCandidates = metadata.versions.filter(entry => entry.manifest !== undefined)
    if (idCandidates.length === 0) {
      return {
        ok: false,
        report: {
          code: 'resolve-failed',
          summary: `${source.package} 没有带有效 dsh.mygo manifest 的候选版本`,
          cycles: [],
          conflicts: [{
            plugin: source.package,
            constraint: { kind: 'entry', target: 'self', range: 'manifest' },
            chain: [source.package],
            candidates: metadata.versions.map(version => ({
              version: version.version,
              rejected: version.manifestProblems ?? ['无有效 manifest'],
            })),
            actions: ['由插件作者补充 dsh.mygo（id/version/entry/depends/breaks/core）'],
          }],
        },
      }
    }

    const canonicalId = idCandidates[0]?.manifest?.id
    if (canonicalId === undefined) {
      return { ok: false, report: { code: 'resolve-failed', summary: `${source.package} 无 manifest id`, cycles: [], conflicts: [] } }
    }
    const candidates = new Map<string, readonly PluginCandidate[]>()
    candidates.set(canonicalId, idCandidates.map(entry => ({
      version: entry.version,
      ...(entry.manifest === undefined ? {} : { constraints: constraintsOf(entry.manifest) }),
      ...(entry.manifest === undefined || entry.manifest.provides.length === 0
        ? {}
        : { provides: entry.manifest.provides }),
      source: 'registry',
    })))
    const lockfile = await this.readLock()
    const installed = new Map<string, PluginCandidate>()
    if (lockfile !== undefined) {
      for (const [id, lock] of Object.entries(lockfile.plugins)) {
        installed.set(id, {
          version: lock.version,
          constraints: { depends: lock.depends, breaks: lock.breaks, core: lock.core, entry: lock.entry },
          ...(lock.provides === undefined || lock.provides.length === 0 ? {} : { provides: lock.provides }),
          source: 'locked',
        })
      }
    }
    if (lockfile !== undefined) {
      for (const [owner, lock] of Object.entries(lockfile.plugins)) {
        for (const bundle of lock.bundles ?? []) {
          const existing = candidates.get(bundle.id) ?? []
          candidates.set(bundle.id, [...existing, {
            version: bundle.version,
            constraints: { depends: bundle.depends, breaks: bundle.breaks, core: bundle.core },
            ...(bundle.provides === undefined || bundle.provides.length === 0 ? {} : { provides: bundle.provides }),
            source: `bundle:${owner}`,
          }])
        }
      }
    }
    const requests = new Map([[canonicalId, { ...(source.range === undefined ? {} : { range: source.range }) }]])
    const outcome = resolve({
      requests,
      candidates,
      installed,
      coreVersion: this.options.coreVersion,
      ...(this.options.pins === undefined ? {} : { pins: this.options.pins }),
    })
    if (!outcome.ok) return outcome
    const chosen = (outcome as Extract<ResolveOutcome, { ok: true }>).resolved.find(plugin => plugin.id === canonicalId)
    if (chosen === undefined) {
      return { ok: false, report: { code: 'resolve-failed', summary: '求解结果缺少目标插件', cycles: [], conflicts: [] } }
    }
    const versionInfo = idCandidates.find(entry => entry.version === chosen.version) as RegistryVersionInfo
    const installedPackage = await installPackageToStore(this.options.paths, versionInfo, {
      ...(this.options.token === undefined ? {} : { token: this.options.token }),
      ...(this.options.tarCmd === undefined ? {} : { tarCmd: this.options.tarCmd }),
    })
    const scanned = await scanBundles(installedPackage.manifest.id, installedPackage.dir, installedPackage.manifest.bundles)
    const undeclared = await detectUndeclaredBundles(
      installedPackage.dir,
      installedPackage.manifest.bundles.map(bundle => bundle.path),
    )
    if (scanned.problems.length > 0 || undeclared.length > 0) {
      return {
        ok: false,
        report: {
          code: 'manifest-invalid',
          summary: [...scanned.problems, ...undeclared].join('；'),
          cycles: [],
          conflicts: [{
            plugin: installedPackage.manifest.id,
            constraint: { kind: 'entry', target: 'bundles', range: 'manifest' },
            chain: [installedPackage.manifest.id],
            candidates: [{ version: installedPackage.version, rejected: [...scanned.problems, ...undeclared] }],
            actions: ['补充/修正 dsh.mygo.bundles 声明或移除未声明内嵌包'],
          }],
        },
      }
    }
    const symbolChecks = await verifyPluginSymbols(
      installedPackage.dir,
      this.options.exportsProvider ?? defaultExportsProvider(this.options.paths, this.options.profile),
    )
    const missing = symbolChecks.filter(check => check.missing)
    if (missing.length > 0) {
      return {
        ok: false,
        report: {
          code: 'symbol-missing',
          summary: `${installedPackage.manifest.id} 引用了目标包不存在的符号（${missing.length} 个）`,
          cycles: [],
          conflicts: [{
            plugin: installedPackage.manifest.id,
            constraint: { kind: 'entry', target: 'symbols', range: 'exports' },
            chain: [installedPackage.manifest.id],
            candidates: [{
              version: installedPackage.version,
              rejected: missing.map(check => `${check.file}: ${check.specifier}#${check.symbol} 不存在`),
            }],
            actions: ['升级/降级目标包到提供该符号的版本，或改用不引用该符号的插件版本'],
          }],
        },
      }
    }
    const warnings: string[] = symbolChecks
      .filter(check => check.unverified === true)
      .map(check => `${check.file}: ${check.specifier}#${check.symbol} 无法验证（目标包不可解析），按警告放行`)
    // 版本区间说谎但符号存在 → 警告放行（符号是事实源）。
    for (const [target, range] of Object.entries(installedPackage.manifest.depends)) {
      if (symbolChecks.some(check => check.specifier === target)) {
        const actual = this.options.pins?.get(target)?.version
        if (actual !== undefined && !matchesVersionRange(actual, range)) {
          warnings.push(`版本区间 ${target} ${range} 未满足（实际 ${actual}），但符号存在，按警告放行`)
        }
      }
    }
    const next = await this.withLocked(lockfile, installedPackage, source.package, scanned.bundles, symbolChecks)
    await writeLockfile(this.lockPath(), next)
    return { ok: true, installed: installedPackage, lockfile: next, warnings }
  }

  /** Registry metadata with auth options applied. */
  private async fetchMetadata(name: string): Promise<ReturnType<typeof fetchRegistryMetadata>> {
    return fetchRegistryMetadata(name, {
      ...(this.options.registry === undefined ? {} : { registry: this.options.registry }),
      ...(this.options.token === undefined ? {} : { token: this.options.token }),
    })
  }

  /**
   * Pure resolution preview (no download, no lockfile write): returns the
   * chosen version's manifest so `plan()` can preview without side effects.
   */
  async preview(
    source: { readonly package: string; readonly range?: string },
  ): Promise<{ readonly ok: true; readonly manifest: PluginManifestV2 } | { readonly ok: false; readonly report: ResolutionReport }> {
    const metadata = await this.fetchMetadata(source.package)
    const idCandidates = metadata.versions.filter(entry => entry.manifest !== undefined)
    if (idCandidates.length === 0) {
      return {
        ok: false,
        report: {
          code: 'resolve-failed',
          summary: `${source.package} 没有带有效 dsh.mygo manifest 的候选版本`,
          cycles: [],
          conflicts: [{
            plugin: source.package,
            constraint: { kind: 'entry', target: 'self', range: 'manifest' },
            chain: [source.package],
            candidates: metadata.versions.map(version => ({
              version: version.version,
              rejected: version.manifestProblems ?? ['无有效 manifest'],
            })),
            actions: ['由插件作者补充 dsh.mygo（id/version/entry/depends/breaks/core）'],
          }],
        },
      }
    }
    const canonicalId = idCandidates[0]?.manifest?.id
    if (canonicalId === undefined) {
      return { ok: false, report: { code: 'resolve-failed', summary: `${source.package} 无 manifest id`, cycles: [], conflicts: [] } }
    }
    const candidates = new Map<string, readonly PluginCandidate[]>()
    candidates.set(canonicalId, idCandidates.map(entry => ({
      version: entry.version,
      ...(entry.manifest === undefined ? {} : { constraints: constraintsOf(entry.manifest) }),
      ...(entry.manifest === undefined || entry.manifest.provides.length === 0
        ? {}
        : { provides: entry.manifest.provides }),
      source: 'registry',
    })))
    const lockfile = await this.readLock()
    const installed = new Map<string, PluginCandidate>()
    if (lockfile !== undefined) {
      for (const [id, lock] of Object.entries(lockfile.plugins)) {
        installed.set(id, {
          version: lock.version,
          constraints: { depends: lock.depends, breaks: lock.breaks, core: lock.core, entry: lock.entry },
          ...(lock.provides === undefined || lock.provides.length === 0 ? {} : { provides: lock.provides }),
          source: 'locked',
        })
      }
    }
    if (lockfile !== undefined) {
      for (const [owner, lock] of Object.entries(lockfile.plugins)) {
        for (const bundle of lock.bundles ?? []) {
          const existing = candidates.get(bundle.id) ?? []
          candidates.set(bundle.id, [...existing, {
            version: bundle.version,
            constraints: { depends: bundle.depends, breaks: bundle.breaks, core: bundle.core },
            ...(bundle.provides === undefined || bundle.provides.length === 0 ? {} : { provides: bundle.provides }),
            source: `bundle:${owner}`,
          }])
        }
      }
    }
    const requests = new Map([[canonicalId, { ...(source.range === undefined ? {} : { range: source.range }) }]])
    const outcome = resolve({
      requests,
      candidates,
      installed,
      coreVersion: this.options.coreVersion,
      ...(this.options.pins === undefined ? {} : { pins: this.options.pins }),
    })
    if (!outcome.ok) return outcome
    const chosen = (outcome as Extract<ResolveOutcome, { ok: true }>).resolved.find(plugin => plugin.id === canonicalId)
    const versionInfo = idCandidates.find(entry => entry.version === chosen?.version)
    if (versionInfo?.manifest === undefined) {
      return { ok: false, report: { code: 'resolve-failed', summary: 'preview 无选定 manifest', cycles: [], conflicts: [] } }
    }
    return { ok: true, manifest: versionInfo.manifest }
  }

  /** Merge one installed package into the lockfile. */
  private async withLocked(
    lockfile: Lockfile | undefined,
    installed: InstalledPackage,
    packageName: string,
    bundles: readonly ScannedBundle[],
    symbols: readonly SymbolCheck[],
  ): Promise<Lockfile> {
    const plugins: Record<string, LockedPlugin> = {}
    if (lockfile !== undefined) {
      for (const [id, lock] of Object.entries(lockfile.plugins)) plugins[id] = { ...lock }
    }
    plugins[installed.id] = {
      version: installed.version,
      entry: installed.entry,
      core: installed.manifest.core,
      depends: installed.manifest.depends,
      breaks: installed.manifest.breaks,
      entrySha256: installed.entrySha256,
      manifestSha256: installed.manifestSha256,
      packageName,
      ...(installed.manifest.provides.length === 0 ? {} : { provides: installed.manifest.provides }),
      ...(bundles.length === 0
        ? {}
        : {
            bundles: bundles.map(bundle => ({
              id: bundle.manifest.id,
              version: bundle.manifest.version,
              path: bundle.declared.path,
              depends: bundle.manifest.depends,
              breaks: bundle.manifest.breaks,
              core: bundle.manifest.core,
              ...(bundle.manifest.provides.length === 0 ? {} : { provides: bundle.manifest.provides }),
            })),
          }),
      symbols,
      ...(installed.integrity === undefined ? {} : { integrity: installed.integrity }),
      source: 'npm',
    }
    return {
      format: 'dsh.lock/v1',
      generated: {
        by: 'dsh-mygo',
        version: this.options.managerVersion,
        profile: this.options.profile,
        ...(this.options.coreVersion === undefined ? {} : { core: this.options.coreVersion }),
        at: new Date().toISOString(),
      },
      plugins,
    }
  }

  /**
   * Load-time verification (MUST NOT re-solve): pure disk check against the
   * lockfile. Missing lockfile = legacy profile (ok).
   */
  async verifyAtBoot(): Promise<{ readonly ok: true } | { readonly ok: false; readonly report: ResolutionReport }> {
    const lockfile = await this.readLock()
    if (lockfile === undefined) return { ok: true }
    const verified = await verifyLockfile(this.options.paths, lockfile)
    if (verified.ok) {
      const importIssues = await this.verifySymbolImportsAgainstLock(lockfile)
      if (importIssues.length === 0) return { ok: true }
      return {
        ok: false,
        report: {
          code: 'lockfile-mismatch',
          summary: `符号 import 集校验失败：${importIssues.length} 项`,
          cycles: [],
          conflicts: importIssues.map(issue => ({
            plugin: issue.split(' ')[0] as string,
            constraint: { kind: 'entry', target: 'symbols', range: 'lockfile' },
            chain: [issue.split(' ')[0] as string],
            candidates: [{ version: 'locked', rejected: [issue] }],
            actions: ['执行 mygo reinstall 重新校验并更新 lockfile'],
          })),
        },
      }
    }
    const conflicts = verified.issues.map(issue => ({
      plugin: issue.id,
      constraint: { kind: 'entry' as const, target: issue.id, range: issue.version },
      chain: [issue.id],
      candidates: [{ version: issue.version, rejected: [issue.reason] }],
      actions: ['执行 mygo update / reinstall 重新求解并修复安装'],
    }))
    return {
      ok: false,
      report: {
        code: 'lockfile-mismatch',
        summary: `lockfile 校验失败：${verified.issues.length} 项不匹配`,
        cycles: [],
        conflicts,
      },
    }
  }

  /** 加载期符号校验：对照 lockfile 记录的 import 集（不重新解析目标包）。 */
  private async verifySymbolImportsAgainstLock(lockfile: Lockfile): Promise<readonly string[]> {
    const issues: string[] = []
    for (const [id, lock] of Object.entries(lockfile.plugins)) {
      if (lock.symbols === undefined) continue
      const dir = packageDir(this.options.paths, id, lock.version)
      const current = await scanPluginImports(dir)
      const lockedKeys = new Set(lock.symbols.map(symbol => `${symbol.specifier}#${symbol.file}#${symbol.symbol}`))
      const currentKeys = new Set(
        current.flatMap(ref => ref.named.map(symbol => `${ref.specifier}#${ref.file}#${symbol}`)),
      )
      if (lockedKeys.size !== currentKeys.size
        || [...lockedKeys].some(key => !currentKeys.has(key))
        || [...currentKeys].some(key => !lockedKeys.has(key))) {
        issues.push(`${id}@${lock.version} 符号 import 集与 lockfile 不一致（请执行重装）`)
      }
    }
    return issues
  }

  /** Topological mount order from the lockfile (dependencies first). */
  async mountOrder(): Promise<{ readonly ok: true; readonly order: readonly string[] } | { readonly ok: false; readonly report: ResolutionReport }> {
    const lockfile = await this.readLock()
    if (lockfile === undefined) return { ok: true, order: [] }
    const ids = Object.keys(lockfile.plugins).sort()
    const edges: MountEdge[] = []
    for (const id of ids) {
      const lock = lockfile.plugins[id]
      if (lock === undefined) continue
      for (const target of Object.keys(lock.depends)) {
        if (ids.includes(target)) edges.push({ from: id, to: target })
      }
    }
    const result = computeMountOrder(ids, edges)
    if (result.ok) return { ok: true, order: result.order }
    return {
      ok: false,
      report: {
        code: 'dependency-cycle',
        summary: `lockfile 依赖环：${result.cycle.join(' → ')}`,
        cycles: [{ cycle: result.cycle }],
        conflicts: [],
      },
    }
  }

  /** Load one locked plugin's entry from the store (no registry). */
  async loadEntry(packageNameOrId: string): Promise<{ readonly plugin: unknown; readonly installed: InstalledPackage } | undefined> {
    const lockfile = await this.readLock()
    if (lockfile === undefined) return undefined
    // 先按 manifest id 精确匹配，再按 npm packageName 匹配（兼容旧 lockfile）。
    const direct = lockfile.plugins[packageNameOrId]
    const byPackageName = direct === undefined
      ? Object.entries(lockfile.plugins).find(([, lock]) => lock.packageName === packageNameOrId)
      : undefined
    if (direct === undefined && byPackageName === undefined) return undefined
    const id = direct === undefined ? (byPackageName as [string, LockedPlugin])[0] : packageNameOrId
    const lock = direct ?? (byPackageName as [string, LockedPlugin])[1]
    const dir = packageDir(this.options.paths, id, lock.version)
    const module = await loadPluginEntry(dir, lock.entry)
    const plugin = extractPlugin(module)
    if (plugin === undefined) throw new Error(`插件 ${id} 入口未导出可挂载插件（${lock.entry}）`)
    const manifest: PluginManifestV2 = {
      id,
      version: lock.version,
      entry: lock.entry,
      depends: lock.depends,
      breaks: lock.breaks,
      core: lock.core,
      provides: lock.provides ?? [],
      entrypoints: {},
      bundles: [],
    }
    return {
      plugin,
      installed: {
        id,
        version: lock.version,
        dir,
        entry: lock.entry,
        manifest,
        entrySha256: lock.entrySha256,
        manifestSha256: lock.manifestSha256,
        ...(lock.integrity === undefined ? {} : { integrity: lock.integrity }),
      },
    }
  }
}
