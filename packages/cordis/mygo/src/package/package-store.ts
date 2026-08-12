/**
 * 插件包 store（《收敛任务》不变量 6）：不可变目录
 * `$DSH_HOME/mygo/packages/<id>/<version>/`，内容哈希写入
 * `.mygo-package.json`；与 dsh 安装目录、npx 缓存无耦合。
 * @module @deepseek-ai/dsh-mygo/src/package/package-store
 */

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { downloadTarball, type RegistryVersionInfo } from './registry-client.ts'
import { integritySha512Hex, sha256File, sha256Text, sha512File } from './lockfile.ts'
import { parsePackageManifest, pathProblemsOf, type PluginManifestV2 } from './manifest-v2.ts'
import { packageDir, type MygoPaths } from './paths.ts'

const execFileAsync = promisify(execFile)

/** One installed package fact. */
export interface InstalledPackage {
  readonly id: string
  readonly version: string
  readonly dir: string
  readonly entry: string
  readonly manifest: PluginManifestV2
  readonly entrySha256: string
  readonly manifestSha256: string
  /** 入口文件内容 sha512（hex；DG-2 拆字段后的真 entrySha512，安装时现场计算）。 */
  readonly entrySha512: string
  /** vendored tarball 整体 sha512（hex；npm integrity 解析转 hex，缺省缺省）。 */
  readonly tarballSha512?: string
  /** entry 文件字节数。 */
  readonly entryFileSize?: number
  readonly integrity?: string
}

export interface InstallPackageOptions {
  readonly token?: string
  /** tar executable; defaults to `tar` (POSIX/Windows 10+ ship it). */
  readonly tarCmd?: string
  /** 本地 tarball 字节（pack 安装；跳过 registry 下载，design-r4 D-A3）。 */
  readonly localTarballBytes?: Uint8Array
  /** 本地 tarball 期望 sha512（hex；pack files[].sha512，先校验后落盘）。 */
  readonly expectedSha512Hex?: string
}

/** Path traversal guard: resolved path must stay under the package root. */
function assertInside(root: string, candidate: string): string {
  const resolved = resolve(root, candidate)
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`entry 逃出包目录：${candidate}`)
  }
  return resolved
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readdir(path)
    return true
  } catch {
    return false
  }
}

/**
 * Download, verify, extract, and atomically install one plugin version into
 * the immutable store. Reuses an existing identical installation.
 */
export async function installPackageToStore(
  paths: MygoPaths,
  versionInfo: RegistryVersionInfo,
  options: InstallPackageOptions = {},
): Promise<InstalledPackage> {
  const manifest = versionInfo.manifest
  if (manifest === undefined) {
    throw new Error(
      `候选 ${versionInfo.version} 没有有效 dsh.mygo manifest：${(versionInfo.manifestProblems ?? []).join('；')}`,
    )
  }
  const target = packageDir(paths, manifest.id, versionInfo.version)
  if (await pathExists(target)) {
    const existing = await readInstalledPackage(target, manifest.id, versionInfo.version)
    if (existing !== undefined && existing.entrySha256 !== '') return existing
    await rm(target, { recursive: true, force: true })
  }

  const work = join(paths.tmpDir, randomUUID())
  const tarball = join(work, 'package.tgz')
  const extracted = join(work, 'extracted')
  const pkgRoot = join(extracted, 'package')
  await mkdir(work, { recursive: true })
  try {
    if (options.localTarballBytes !== undefined) {
      if (options.expectedSha512Hex !== undefined) {
        const actual = createHash('sha512').update(options.localTarballBytes).digest('hex')
        if (actual !== options.expectedSha512Hex) {
          throw new Error(`本地 tarball 完整性校验失败（sha512 期望 ${options.expectedSha512Hex.slice(0, 12)}…）`)
        }
      }
      await writeFile(tarball, options.localTarballBytes)
    } else {
      await downloadTarball(versionInfo.tarball, tarball, {
        ...(options.token === undefined ? {} : { token: options.token }),
        ...(versionInfo.integrity === undefined ? {} : { integrity: versionInfo.integrity }),
      })
    }
    await mkdir(extracted, { recursive: true })
    await execFileAsync(options.tarCmd ?? 'tar', ['-xzf', tarball, '-C', extracted])
    if (!(await pathExists(pkgRoot))) {
      throw new Error(`tarball 缺少 package/ 根目录（${versionInfo.version}）`)
    }
    const packageJsonRaw = await readFile(join(pkgRoot, 'package.json'), 'utf8')
    const parsed = parsePackageManifest(JSON.parse(packageJsonRaw))
    if (parsed.value === undefined) {
      throw new Error(`包内 manifest 校验失败：${parsed.problems.map(problem => `${problem.path}: ${problem.message}`).join('；')}`)
    }
    if (parsed.value.id !== manifest.id || parsed.value.version !== versionInfo.version) {
      throw new Error(`包内 manifest 与 registry 元数据不一致（${parsed.value.id}@${parsed.value.version}）`)
    }
    // B10 安装期路径安全：manifest 解析已验 entry/bundles/paches，此处双保险。
    const pathProblems = pathProblemsOf(parsed.value)
    if (pathProblems.length > 0) {
      throw new Error(`包内 manifest 路径逃逸：${pathProblems.map(problem => `${problem.path}: ${problem.message}`).join('；')}`)
    }
    assertInside(pkgRoot, parsed.value.entry)
    // DG-2 拆字段（修复批次 3）：entrySha512 = 入口文件内容哈希（现场计算，
    // 真实写入点）；tarballSha512 = vendored tarball 整体哈希（npm integrity
    // 解析转 hex；integrity 不可解析或缺省时缺省）。两者都在落盘前计算，
    // 保证事实文件与 lockfile 载荷同源。
    const entrySha512 = await sha512File(assertInside(pkgRoot, parsed.value.entry))
    const tarballSha512 = integritySha512Hex(versionInfo.integrity)
    // 确定性（S2/T19 真实图扩展）：manifestSha256 只对稳定载荷计算；
    // installedAt / entrySha512 仅作尾部记账字段保留在事实文件里，不进哈希
    // （否则同输入两次安装产物不等）。
    const factBase = {
      format: 'dsh.mygo-package/v1',
      id: parsed.value.id,
      version: versionInfo.version,
      entry: parsed.value.entry,
      manifest: parsed.value,
      ...(versionInfo.integrity === undefined ? {} : { integrity: versionInfo.integrity }),
      ...(tarballSha512 === undefined ? {} : { tarballSha512 }),
    }
    const manifestSha256 = sha256Text(JSON.stringify(factBase))
    await writeFile(
      join(pkgRoot, '.mygo-package.json'),
      JSON.stringify({ ...factBase, entrySha512, manifestSha256, installedAt: new Date().toISOString() }, null, 2),
    )
    await mkdir(dirname(target), { recursive: true })
    await rename(pkgRoot, target)
    const entryPath = assertInside(target, parsed.value.entry)
    const entrySha256 = await sha256File(entryPath)
    const entryStats = await stat(entryPath)
    return {
      id: parsed.value.id,
      version: versionInfo.version,
      dir: target,
      entry: parsed.value.entry,
      manifest: parsed.value,
      entrySha256,
      manifestSha256,
      entrySha512,
      ...(tarballSha512 === undefined ? {} : { tarballSha512 }),
      entryFileSize: entryStats.size,
      ...(versionInfo.integrity === undefined ? {} : { integrity: versionInfo.integrity }),
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** Read one installed package's fact file. */
export async function readInstalledPackage(
  dir: string,
  id: string,
  version: string,
): Promise<InstalledPackage | undefined> {
  try {
    const raw = await readFile(join(dir, '.mygo-package.json'), 'utf8')
    const fact = JSON.parse(raw) as {
      readonly format?: unknown
      readonly id?: unknown
      readonly version?: unknown
      readonly entry?: unknown
      readonly manifest?: unknown
      readonly integrity?: unknown
      readonly entrySha256?: unknown
      readonly manifestSha256?: unknown
      readonly entrySha512?: unknown
      readonly tarballSha512?: unknown
      readonly entryFileSize?: unknown
    }
    if (fact.format !== 'dsh.mygo-package/v1' || fact.id !== id || fact.version !== version) return undefined
    const manifest = fact.manifest as PluginManifestV2 | undefined
    if (manifest === undefined || typeof fact.entry !== 'string') return undefined
    const entrySha256 = typeof fact.entrySha256 === 'string' ? fact.entrySha256 : await sha256File(assertInside(dir, fact.entry))
    const manifestSha256 = typeof fact.manifestSha256 === 'string'
      ? fact.manifestSha256
      : (() => {
        const stable = JSON.parse(raw) as Record<string, unknown>
        delete stable.manifestSha256
        delete stable.installedAt
        delete stable.entrySha512
        return sha256Text(JSON.stringify(stable))
      })()
    return {
      id,
      version,
      dir,
      entry: fact.entry,
      manifest,
      entrySha256,
      manifestSha256,
      // DG-2（修复批次 3）：entrySha512 有事实文件写入点；旧事实文件回退现场计算。
      entrySha512: typeof fact.entrySha512 === 'string'
        ? fact.entrySha512
        : await sha512File(assertInside(dir, fact.entry)),
      ...(typeof fact.tarballSha512 === 'string' ? { tarballSha512: fact.tarballSha512 } : {}),
      entryFileSize: typeof fact.entryFileSize === 'number'
        ? fact.entryFileSize
        : (await stat(assertInside(dir, fact.entry))).size,
      ...(typeof fact.integrity === 'string' ? { integrity: fact.integrity } : {}),
    }
  } catch {
    return undefined
  }
}
