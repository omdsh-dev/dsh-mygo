/**
 * 插件包 store（《收敛任务》不变量 6）：不可变目录
 * `$DSH_HOME/mygo/packages/<id>/<version>/`，内容哈希写入
 * `.mygo-package.json`；与 dsh 安装目录、npx 缓存无耦合。
 * @module @deepseek-ai/dsh-mygo/src/package/package-store
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { downloadTarball, type RegistryVersionInfo } from './registry-client.ts'
import { sha256File } from './lockfile.ts'
import { parsePackageManifest, type PluginManifestV2 } from './manifest-v2.ts'
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
  readonly integrity?: string
}

export interface InstallPackageOptions {
  readonly token?: string
  /** tar executable; defaults to `tar` (POSIX/Windows 10+ ship it). */
  readonly tarCmd?: string
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
    await downloadTarball(versionInfo.tarball, tarball, {
      ...(options.token === undefined ? {} : { token: options.token }),
      ...(versionInfo.integrity === undefined ? {} : { integrity: versionInfo.integrity }),
    })
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
    assertInside(pkgRoot, parsed.value.entry)
    await writeFile(
      join(pkgRoot, '.mygo-package.json'),
      JSON.stringify({
        format: 'dsh.mygo-package/v1',
        id: parsed.value.id,
        version: versionInfo.version,
        entry: parsed.value.entry,
        manifest: parsed.value,
        ...(versionInfo.integrity === undefined ? {} : { integrity: versionInfo.integrity }),
        installedAt: new Date().toISOString(),
      }, null, 2),
    )
    await mkdir(dirname(target), { recursive: true })
    await rename(pkgRoot, target)
    const entrySha256 = await sha256File(assertInside(target, parsed.value.entry))
    const manifestSha256 = await sha256File(join(target, '.mygo-package.json'))
    return {
      id: parsed.value.id,
      version: versionInfo.version,
      dir: target,
      entry: parsed.value.entry,
      manifest: parsed.value,
      entrySha256,
      manifestSha256,
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
    }
    if (fact.format !== 'dsh.mygo-package/v1' || fact.id !== id || fact.version !== version) return undefined
    const manifest = fact.manifest as PluginManifestV2 | undefined
    if (manifest === undefined || typeof fact.entry !== 'string') return undefined
    const entrySha256 = typeof fact.entrySha256 === 'string' ? fact.entrySha256 : await sha256File(assertInside(dir, fact.entry))
    const manifestSha256 = typeof fact.manifestSha256 === 'string'
      ? fact.manifestSha256
      : await sha256File(join(dir, '.mygo-package.json'))
    return {
      id,
      version,
      dir,
      entry: fact.entry,
      manifest,
      entrySha256,
      manifestSha256,
      ...(typeof fact.integrity === 'string' ? { integrity: fact.integrity } : {}),
    }
  } catch {
    return undefined
  }
}
