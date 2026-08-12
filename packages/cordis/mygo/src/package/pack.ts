/**
 * mygo plugin pack 分发体系（design-r4）：
 * - 自建最小格式 `mygo-pack/v1`（tar.gz 容器 + 单一清单）；
 * - 确定性打包（固定成员序 / mtime/owner 归一 / gzip 无时间戳）；
 * - 安装 = 清单自校验 → 成员预检（自实现 tar 头部解析）→ vendored 哈希校验
 *   → 既有求解器（B5）→ store 安装 → lockfile 写入；MUST NOT 绕过三阶段。
 * 零新增第三方依赖；tar 头部遍历为最小自实现（design-r4 §3/§6）。
 * @module @deepseek-ai/dsh-mygo/src/package/pack
 */

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { gunzipSync, gzipSync } from 'node:zlib'
import { constraintsOf, isEscapingPath, parsePackageManifest, pathProblemsOf, type PluginManifestV2 } from './manifest-v2.ts'
import { lockfilePath, packageDir, type MygoPaths } from './paths.ts'
import { installPackageToStore, readInstalledPackage } from './package-store.ts'
import { sha256Text, writeLockfile, readLockfile, type Lockfile, type LockedPlugin } from './lockfile.ts'
import { resolve, type PluginCandidate } from './resolver.ts'
import type { ConflictEntry, ResolutionReport } from './report.ts'
import { isValidRange, matchesVersionRange } from '../semver-range.ts'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Pack manifest schema（design-r4 §2；D-A1/D-A2）
// ---------------------------------------------------------------------------

export interface PackGenerated {
  readonly by: string
  readonly version: string
  readonly profile: string
  readonly at: string
}

export interface PackPluginDecl {
  readonly id: string
  readonly packageName: string
  /** 声明区间（可选）；精确钉版由 lockfile 快照承担（D-A2/T39）。 */
  readonly range?: string
}

export interface PackFileEntry {
  /** `files/<i>.tgz`（i = files[] 下标；files[] 按 (id, version) 排序）。 */
  readonly path: string
  readonly pluginId: string
  readonly packageName: string
  readonly sha512: string
  readonly fileSize: number
  /** packer 侧 lockfile 记录的 npm integrity（若有）；透传保语义载荷。 */
  readonly integrity?: string
}

export interface PackCommunityDep {
  readonly name: string
  /** package.json 中声明的区间（dependencies/peerDependencies 原文值）。 */
  readonly range: string
  readonly kind: 'dependency' | 'peerDependency'
  readonly owner: string
}

export interface PackManifest {
  readonly format: 'mygo-pack/v1'
  readonly formatVersion: 1
  readonly name: string
  readonly version: string
  readonly generated: PackGenerated
  readonly manifestSha256: string
  readonly plugins: readonly PackPluginDecl[]
  /** dsh.lock/v1 语义载荷快照（时间戳归一 '<t>'，D-A5）。 */
  readonly lockfile: Lockfile
  readonly files: readonly PackFileEntry[]
  readonly communityDeps: readonly PackCommunityDep[]
}

export interface ManifestProblemRef {
  readonly path: string
  readonly message: string
}

const PACK_FORMAT = 'mygo-pack/v1'
const ID_RE = /^[a-z][a-z0-9-]*$/
const SHA512_RE = /^[0-9a-f]{128}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const FILE_PATH_RE = /^files\/\d+\.tgz$/

/** gzip 解压上限（A7）：单条 gzip 流解压后 ≤ 256 MiB，超限 → pack-invalid。 */
export const MAX_GUNZIP_BYTES = 256 * 1024 * 1024
/** 单 archive 成员数上限（A7）：≤ 10000，超限 → pack-invalid。 */
export const MAX_TAR_MEMBERS = 10000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  if (!isRecord(value)) return false
  return Object.values(value).every(item => typeof item === 'string')
}

/** 轻量 lockfile 结构校验（语义载荷形状；不校验哈希——哈希由安装期验证）。 */
function validateLockfileShape(value: unknown): readonly string[] {
  const problems: string[] = []
  if (!isRecord(value) || value.format !== 'dsh.lock/v1' || !isRecord(value.plugins)) {
    problems.push('lockfile 不是 dsh.lock/v1（缺 format/plugins）')
    return problems
  }
  for (const [id, entry] of Object.entries(value.plugins)) {
    if (!isRecord(entry)) {
      problems.push(`lockfile.plugins.${id} 不是对象`)
      continue
    }
    if (typeof entry.version !== 'string' || typeof entry.entry !== 'string'
      || typeof entry.core !== 'string') {
      problems.push(`lockfile.plugins.${id} 缺 version/entry/core`)
    }
    if (!isStringRecord(entry.depends) || !isStringRecord(entry.breaks)) {
      problems.push(`lockfile.plugins.${id} 的 depends/breaks 必须是 string map`)
    }
    if (typeof entry.entrySha256 !== 'string' || typeof entry.manifestSha256 !== 'string') {
      problems.push(`lockfile.plugins.${id} 缺 entrySha256/manifestSha256`)
    }
  }
  return problems
}

/** 解析并校验 pack 清单；返回问题清单（一次输出全部）。 */
export function parsePackManifest(raw: unknown): {
  readonly value?: PackManifest
  readonly problems: readonly ManifestProblemRef[]
} {
  const problems: ManifestProblemRef[] = []
  const push = (path: string, message: string): void => {
    problems.push({ path, message })
  }
  if (!isRecord(raw)) {
    push('$', '清单不是对象')
    return { problems }
  }
  if (raw.format !== PACK_FORMAT) {
    push('format', `期望 ${PACK_FORMAT}，实际 ${String(raw.format)}`)
  }
  if (raw.formatVersion !== 1) {
    push('formatVersion', `不支持的 formatVersion：${String(raw.formatVersion)}（当前支持 1）`)
  }
  if (typeof raw.name !== 'string' || raw.name === '') push('name', 'name 必须是非空字符串')
  if (typeof raw.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(raw.version)) {
    push('version', 'version 必须是 semver')
  }
  if (typeof raw.manifestSha256 !== 'string' || !SHA256_RE.test(raw.manifestSha256)) {
    push('manifestSha256', 'manifestSha256 必须是 64 位 hex')
  }
  const generated = raw.generated
  if (!isRecord(generated)
    || typeof generated.by !== 'string' || typeof generated.version !== 'string'
    || typeof generated.profile !== 'string' || typeof generated.at !== 'string') {
    push('generated', 'generated 缺 by/version/profile/at')
  }

  const plugins: PackPluginDecl[] = []
  if (!Array.isArray(raw.plugins)) {
    push('plugins', 'plugins 必须是数组')
  } else {
    for (const [index, entry] of raw.plugins.entries()) {
      const path = `plugins[${index}]`
      if (!isRecord(entry)) {
        push(path, '不是对象')
        continue
      }
      if (typeof entry.id !== 'string' || !ID_RE.test(entry.id)) push(`${path}.id`, '非法插件 id')
      if (typeof entry.packageName !== 'string' || entry.packageName === '') push(`${path}.packageName`, 'packageName 必须是非空字符串')
      if (entry.range !== undefined && (typeof entry.range !== 'string' || !isValidRange(entry.range))) {
        push(`${path}.range`, '非法 semver 区间')
      }
      plugins.push({
        id: String(entry.id ?? ''),
        packageName: String(entry.packageName ?? ''),
        ...(entry.range === undefined ? {} : { range: String(entry.range) }),
      })
    }
  }

  const lockfileProblems = validateLockfileShape(raw.lockfile)
  for (const message of lockfileProblems) push('lockfile', message)

  const files: PackFileEntry[] = []
  if (!Array.isArray(raw.files)) {
    push('files', 'files 必须是数组')
  } else {
    const pluginIds = new Set(plugins.map(plugin => plugin.id))
    for (const [index, entry] of raw.files.entries()) {
      const path = `files[${index}]`
      if (!isRecord(entry)) {
        push(path, '不是对象')
        continue
      }
      const filePath = typeof entry.path === 'string' ? entry.path : ''
      if (!FILE_PATH_RE.test(filePath) || isEscapingPath(filePath)) push(`${path}.path`, '路径必须是 files/<i>.tgz 形态且不逃逸')
      if (typeof entry.pluginId !== 'string' || !pluginIds.has(entry.pluginId)) {
        push(`${path}.pluginId`, 'pluginId 必须在 plugins 中')
      }
      if (typeof entry.packageName !== 'string' || entry.packageName === '') push(`${path}.packageName`, 'packageName 必须是非空字符串')
      if (typeof entry.sha512 !== 'string' || !SHA512_RE.test(entry.sha512)) push(`${path}.sha512`, 'sha512 必须是 128 位 hex')
      if (typeof entry.fileSize !== 'number' || !Number.isInteger(entry.fileSize) || entry.fileSize < 0) {
        push(`${path}.fileSize`, 'fileSize 必须是非负整数')
      }
      if (entry.integrity !== undefined && typeof entry.integrity !== 'string') push(`${path}.integrity`, 'integrity 必须是字符串')
      files.push({
        path: filePath,
        pluginId: String(entry.pluginId ?? ''),
        packageName: String(entry.packageName ?? ''),
        sha512: String(entry.sha512 ?? ''),
        fileSize: Number(entry.fileSize ?? -1),
        ...(entry.integrity === undefined ? {} : { integrity: String(entry.integrity) }),
      })
    }
  }

  const communityDeps: PackCommunityDep[] = []
  if (!Array.isArray(raw.communityDeps)) {
    push('communityDeps', 'communityDeps 必须是数组')
  } else {
    for (const [index, entry] of raw.communityDeps.entries()) {
      const path = `communityDeps[${index}]`
      if (!isRecord(entry)) {
        push(path, '不是对象')
        continue
      }
      if (typeof entry.name !== 'string' || entry.name === '') push(`${path}.name`, 'name 必须是非空字符串')
      if (typeof entry.range !== 'string' || !isValidRange(entry.range)) push(`${path}.range`, '非法 semver 区间')
      if (entry.kind !== 'dependency' && entry.kind !== 'peerDependency') push(`${path}.kind`, 'kind 必须是 dependency/peerDependency')
      if (typeof entry.owner !== 'string' || entry.owner === '') push(`${path}.owner`, 'owner 必须是非空字符串')
      communityDeps.push({
        name: String(entry.name ?? ''),
        range: String(entry.range ?? ''),
        kind: entry.kind === 'dependency' ? 'dependency' : 'peerDependency',
        owner: String(entry.owner ?? ''),
      })
    }
  }

  if (problems.length > 0) return { problems }
  return {
    value: {
      format: PACK_FORMAT,
      formatVersion: 1,
      name: raw.name as string,
      version: raw.version as string,
      generated: {
        by: (raw.generated as PackGenerated).by,
        version: (raw.generated as PackGenerated).version,
        profile: (raw.generated as PackGenerated).profile,
        at: (raw.generated as PackGenerated).at,
      },
      manifestSha256: raw.manifestSha256 as string,
      plugins,
      lockfile: raw.lockfile as unknown as Lockfile,
      files,
      communityDeps,
    },
    problems,
  }
}

/** 规范键序语义载荷（manifestSha256 计算口径；时间戳归一，D-A5）。 */
export function canonicalPackPayload(manifest: PackManifest): Record<string, unknown> {
  return {
    format: PACK_FORMAT,
    formatVersion: 1,
    name: manifest.name,
    version: manifest.version,
    generated: {
      by: manifest.generated.by,
      version: manifest.generated.version,
      profile: manifest.generated.profile,
      at: '<t>',
    },
    plugins: manifest.plugins.map(plugin => ({
      id: plugin.id,
      packageName: plugin.packageName,
      ...(plugin.range === undefined ? {} : { range: plugin.range }),
    })),
    lockfile: {
      format: manifest.lockfile.format,
      generated: {
        ...manifest.lockfile.generated,
        at: '<t>',
      },
      plugins: manifest.lockfile.plugins,
    },
    files: manifest.files.map(file => ({
      path: file.path,
      pluginId: file.pluginId,
      packageName: file.packageName,
      sha512: file.sha512,
      fileSize: file.fileSize,
      ...(file.integrity === undefined ? {} : { integrity: file.integrity }),
    })),
    communityDeps: manifest.communityDeps.map(dep => ({
      name: dep.name,
      range: dep.range,
      kind: dep.kind,
      owner: dep.owner,
    })),
  }
}

/** 计算清单自校验哈希（sha256 of 规范键序语义 JSON）。 */
export function computePackManifestSha256(manifest: PackManifest): string {
  return sha256Text(JSON.stringify(canonicalPackPayload(manifest)))
}

// ---------------------------------------------------------------------------
// 最小 tar 头部遍历（design-r4 §3/§6：成员预检防换行文件名绕过）
// ---------------------------------------------------------------------------

export interface TarMember {
  readonly name: string
  readonly typeflag: string
  readonly size: number
  /** 数据区起点（tar buffer 内绝对偏移；仅 regular file 有意义）。 */
  readonly dataOffset: number
}

function decodeField(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString('utf8')
  const nul = text.indexOf('\0')
  return (nul >= 0 ? text.slice(0, nul) : text).trimEnd()
}

/** 归一成员名：去掉前导 `./`（GNU tar 对 `.` 根产生的形态）。 */
export function normalizeTarName(name: string): string {
  return name.startsWith('./') ? name.slice(2) : name
}

/** 遍历 tar 头部（不验证内容哈希；gzip 已解压）。成员数受 maxMembers 上限（A7）。 */
export function listTarMembers(
  tar: Uint8Array,
  maxMembers = MAX_TAR_MEMBERS,
): {
  readonly members: readonly TarMember[]
  readonly problems: readonly string[]
} {
  const members: TarMember[] = []
  const problems: string[] = []
  let offset = 0
  let zeroBlocks = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (Array.from(header).every(byte => byte === 0)) {
      zeroBlocks += 1
      if (zeroBlocks >= 2) break
      offset += 512
      continue
    }
    zeroBlocks = 0
    const rawName = decodeField(header.subarray(0, 100))
    const rawSize = decodeField(header.subarray(124, 136))
    const size = Number.parseInt(rawSize === '' ? '0' : rawSize, 8)
    if (!Number.isFinite(size) || size < 0) {
      problems.push(`tar 头部大小字段非法：${rawSize}`)
      break
    }
    const typeflag = String.fromCharCode(header[156] ?? 0)
    const prefix = decodeField(header.subarray(345, 500))
    const name = prefix === '' ? rawName : `${prefix}/${rawName}`
    members.push({
      name: normalizeTarName(name),
      typeflag,
      size,
      dataOffset: offset + 512,
    })
    if (members.length >= maxMembers) {
      problems.push(`tar 成员数超过上限 ${maxMembers}（实际 ≥ ${maxMembers}）`)
      break
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return { members, problems }
}

/** 解压 gzip + 遍历成员（失败返回 problems）；解压受 MAX_GUNZIP_BYTES 上限（A7）。 */
export function listGzipTarMembers(bytes: Uint8Array): {
  readonly tar?: Uint8Array
  readonly members?: readonly TarMember[]
  readonly problems: readonly string[]
} {
  try {
    const tar = gunzipSync(bytes, { maxOutputLength: MAX_GUNZIP_BYTES })
    const result = listTarMembers(tar)
    if (result.problems.length > 0) return { problems: result.problems }
    return { tar, members: result.members, problems: [] }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof Error && (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      // Node 不返回流的实际解压大小；如实报告超限事实与上限值（A7）。
      return {
        problems: [`gzip 解压后超过上限 ${MAX_GUNZIP_BYTES} 字节（流实际大小无法在拒绝点测得，仅知超过上限）`],
      }
    }
    return { problems: [message] }
  }
}

function memberBytes(tar: Uint8Array, member: TarMember): Uint8Array {
  return tar.subarray(member.dataOffset, member.dataOffset + member.size)
}

function findMember(members: readonly TarMember[], name: string): TarMember | undefined {
  return members.find(member => member.name === name)
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await readdir(path)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 打包（design-r4 §5 确定性；B21）
// ---------------------------------------------------------------------------

export interface PackContext {
  readonly paths: MygoPaths
  readonly profile: string
  readonly managerVersion: string
  readonly coreVersion?: string
  readonly tarCmd?: string
}

export interface PackBuildOptions {
  readonly output: string
  /** 是否收割社区依赖声明（默认 true；B25）。 */
  readonly includeCommunityDeps?: boolean
}

export type PackBuildOutcome =
  | { readonly ok: true; readonly packPath: string; readonly sha256: string; readonly manifest: PackManifest }
  | { readonly ok: false; readonly report: ResolutionReport }

function packReport(summary: string, conflicts: readonly ConflictEntry[]): ResolutionReport {
  return {
    code: 'pack-invalid',
    summary,
    scope: 'pack',
    cycles: [],
    conflicts,
  }
}

async function readPackageJson(dir: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * 从 store 确定性重打包 vendored tarball：`package/` 根、固定排序、
 * mtime/owner 归一、排除 `.mygo-package.json`（含 installedAt，D-A5）。
 */
async function retarPackage(
  dir: string,
  tgzPath: string,
  tarPath: string,
  tarCmd: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  try {
    await execFileAsync(tarCmd, [
      '-cf', tarPath,
      '-C', dir,
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '--exclude=.mygo-package.json',
      '--transform=s,^\\./,package/,',
      '.',
    ])
    // gzip 无时间戳（Node zlib；与 gzip -n 同归一语义，D-A5）。
    await writeFile(tgzPath, gzipSync(await readFile(tarPath)))
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

function sha512Hex(bytes: Uint8Array): string {
  return createHash('sha512').update(bytes).digest('hex')
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 构建 mygo-pack（确定性；B21/B25）。 */
export async function buildPluginPack(
  ctx: PackContext,
  options: PackBuildOptions,
): Promise<PackBuildOutcome> {
  const lockfile = await readLockfile(lockfilePath(ctx.paths, ctx.profile))
  if (lockfile === undefined || Object.keys(lockfile.plugins).length === 0) {
    return { ok: false, report: packReport('没有可打包的 lockfile（插件集为空）', []) }
  }
  const work = await mkdtemp(join(ctx.paths.tmpDir, 'mygo-pack-'))
  const packageRoot = join(work, 'package')
  const filesDir = join(packageRoot, 'files')
  await mkdir(filesDir, { recursive: true })
  try {
    const tarCmd = ctx.tarCmd ?? 'tar'
    const ids = Object.keys(lockfile.plugins).sort()
    const managedNames = new Set(
      ids.map(id => lockfile.plugins[id]?.packageName ?? id),
    )
    const fileEntries: PackFileEntry[] = []
    const communityDeps: PackCommunityDep[] = []
    const problems: ConflictEntry[] = []
    for (const [index, id] of ids.entries()) {
      const lock = lockfile.plugins[id]
      if (lock === undefined) continue
      const dir = packageDir(ctx.paths, id, lock.version)
      const installed = await readInstalledPackage(dir, id, lock.version)
      if (installed === undefined) {
        problems.push({
          plugin: id,
          constraint: { kind: 'pack', target: dir, range: lock.version },
          chain: [id],
          candidates: [{ version: lock.version, rejected: ['store 缺少已安装包目录或事实文件'] }],
          actions: ['先对当前 profile 执行 mygo install/restore 修复 store'],
        })
        continue
      }
      const tgzPath = join(filesDir, `${index}.tgz`)
      const tarPath = join(work, `${index}.tar`)
      const retar = await retarPackage(dir, tgzPath, tarPath, tarCmd)
      if (!retar.ok) {
        problems.push({
          plugin: id,
          constraint: { kind: 'pack', target: id, range: lock.version },
          chain: [id],
          candidates: [{ version: lock.version, rejected: [`确定性重打包失败：${retar.reason}`] }],
          actions: ['检查系统 tar 是否支持 --sort=name/--transform'],
        })
        continue
      }
      const bytes = await readFile(tgzPath)
      const parsed = listGzipTarMembers(new Uint8Array(bytes))
      if (parsed.problems.length > 0 || parsed.members === undefined
        || findMember(parsed.members, 'package/package.json') === undefined) {
        problems.push({
          plugin: id,
          constraint: { kind: 'pack', target: tgzPath, range: lock.version },
          chain: [id],
          candidates: [{ version: lock.version, rejected: ['重打包产物不是合法 npm tarball（缺 package/package.json）'] }],
          actions: ['检查 store 目录完整性后重试'],
        })
        continue
      }
      fileEntries.push({
        path: `files/${index}.tgz`,
        pluginId: id,
        packageName: lock.packageName ?? id,
        sha512: sha512Hex(new Uint8Array(bytes)),
        fileSize: bytes.length,
        ...(lock.integrity === undefined ? {} : { integrity: lock.integrity }),
      })
      if (options.includeCommunityDeps !== false) {
        const pkg = await readPackageJson(dir)
        if (pkg !== undefined) {
          const collect = (
            source: Record<string, unknown> | undefined,
            kind: 'dependency' | 'peerDependency',
          ): void => {
            for (const [name, range] of Object.entries(source ?? {})) {
              if (typeof range !== 'string' || managedNames.has(name)) continue
              communityDeps.push({ name, range, kind, owner: id })
            }
          }
          collect(pkg.dependencies as Record<string, unknown> | undefined, 'dependency')
          collect(pkg.peerDependencies as Record<string, unknown> | undefined, 'peerDependency')
        }
      }
    }
    if (problems.length > 0) {
      return {
        ok: false,
        report: {
          ...packReport(`打包失败：${problems.length} 个插件无法打包`, problems),
        },
      }
    }
    communityDeps.sort((a, b) => {
      const byName = a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      if (byName !== 0) return byName
      const byOwner = a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0
      if (byOwner !== 0) return byOwner
      return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0
    })
    const manifestBase: Omit<PackManifest, 'manifestSha256'> = {
      format: PACK_FORMAT,
      formatVersion: 1,
      name: `${ctx.profile}-plugins`,
      version: '1.0.0',
      generated: {
        by: 'dsh-mygo',
        version: ctx.managerVersion,
        profile: ctx.profile,
        at: '<t>',
      },
      plugins: ids.map(id => ({
        id,
        packageName: lockfile.plugins[id]?.packageName ?? id,
      })),
      lockfile: {
        ...lockfile,
        generated: { ...lockfile.generated, at: '<t>' },
      },
      files: fileEntries,
      communityDeps,
    }
    const manifest: PackManifest = {
      ...manifestBase,
      manifestSha256: sha256Text(JSON.stringify(canonicalPackPayload(manifestBase as PackManifest))),
    }
    await writeFile(join(packageRoot, 'mygo-pack.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

    const tarPath = join(work, 'pack.tar')
    await execFileAsync(tarCmd, [
      '-cf', tarPath,
      '-C', packageRoot,
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      'mygo-pack.json',
      'files',
    ])
    // Node zlib gzipSync：gzip 头不嵌文件名/时间戳（与 gzip -n 同归一语义，D-A5）。
    const packBytes = gzipSync(await readFile(tarPath))
    await mkdir(dirname(options.output), { recursive: true })
    await writeFile(`${options.output}.tmp`, packBytes)
    await rename(`${options.output}.tmp`, options.output)
    return { ok: true, packPath: options.output, sha256: sha256Hex(new Uint8Array(packBytes)), manifest }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 安装（design-r4 §3/§6/§7；B22/B23/B24/B25）
// ---------------------------------------------------------------------------

export interface PackInstallOptions {
  /** 安装侧 core 版本覆盖（缺省用 PackContext.coreVersion）。 */
  readonly coreVersion?: string
}

export type PackInstallOutcome =
  | { readonly ok: true; readonly lockfile: Lockfile; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly report: ResolutionReport }

function hashReport(conflicts: readonly ConflictEntry[], summary: string): ResolutionReport {
  return {
    code: 'pack-hash-mismatch',
    summary,
    scope: 'pack',
    cycles: [],
    conflicts,
  }
}

/** 安装 mygo-pack：全部校验与求解先于任何 store 写入（整体拒绝，D-A7）。 */
export async function installPluginPack(
  ctx: PackContext,
  packPath: string,
  options: PackInstallOptions = {},
): Promise<PackInstallOutcome> {
  let packBytes: Uint8Array
  try {
    packBytes = new Uint8Array(await readFile(packPath))
  } catch (error) {
    return {
      ok: false,
      report: packReport(`无法读取 pack 文件：${error instanceof Error ? error.message : String(error)}`, []),
    }
  }
  const unpacked = listGzipTarMembers(packBytes)
  if (unpacked.tar === undefined || unpacked.members === undefined) {
    return {
      ok: false,
      report: packReport(`pack 不是合法 gzip/tar：${unpacked.problems.join('；')}`, []),
    }
  }
  const members = unpacked.members
  const manifestMember = findMember(members, 'mygo-pack.json')
  if (manifestMember === undefined || manifestMember.typeflag !== '0') {
    return { ok: false, report: packReport('pack 缺少 mygo-pack.json 成员', []) }
  }
  // A5-pack：清单成员 JSON 解析加固——畸形 JSON → pack-invalid（带文件指针），
  // 原始 SyntaxError MUST NOT 逃逸出 installPluginPack。
  let manifestRaw: unknown
  try {
    manifestRaw = JSON.parse(Buffer.from(memberBytes(unpacked.tar, manifestMember)).toString('utf8')) as unknown
  } catch (error) {
    return {
      ok: false,
      report: packReport(
        `pack 清单不是合法 JSON（mygo-pack.json）：${error instanceof Error ? error.message : String(error)}`,
        [{
          plugin: '<pack>',
          constraint: { kind: 'pack', target: 'mygo-pack.json', range: 'json' },
          chain: ['<pack>'],
          candidates: [{ version: '<manifest>', rejected: ['清单成员不是合法 JSON'] }],
          actions: ['重新打包或从可信来源获取 pack'],
        }],
      ),
    }
  }
  const parsed = parsePackManifest(manifestRaw)
  if (parsed.value === undefined) {
    return {
      ok: false,
      report: packReport(
        `pack 清单无效：${parsed.problems.map(problem => `${problem.path}: ${problem.message}`).join('；')}`,
        parsed.problems.map(problem => ({
          plugin: '<pack>',
          constraint: { kind: 'pack', target: problem.path, range: 'manifest' },
          chain: ['<pack>'],
          candidates: [{ version: '<manifest>', rejected: [problem.message] }],
          actions: ['重新打包或修复清单'],
        })),
      ),
    }
  }
  const manifest = parsed.value
  const expectedSha = computePackManifestSha256(manifest)
  if (expectedSha !== manifest.manifestSha256) {
    return {
      ok: false,
      report: packReport('pack 清单自校验失败（manifestSha256 失配）', [{
        plugin: '<pack>',
        constraint: { kind: 'pack', target: 'mygo-pack.json', range: 'manifestSha256' },
        chain: ['<pack>'],
        candidates: [{ version: '<manifest>', rejected: [`清单哈希失配（期望 ${manifest.manifestSha256.slice(0, 12)}…）`] }],
        actions: ['重新打包或从可信来源获取 pack'],
      }]),
    }
  }

  // 成员清单前置校验：精确成员集 + 类型限制（防换行文件名绕过，design-r4 §3）。
  const allowedNames = new Set(['mygo-pack.json', 'files/', ...manifest.files.map(file => file.path)])
  const unknownMembers = members
    .filter(member => !allowedNames.has(member.name) || (member.typeflag !== '0' && member.typeflag !== '5'))
    .map(member => `${member.name}（type ${member.typeflag}）`)
  if (unknownMembers.length > 0) {
    return {
      ok: false,
      report: packReport(`pack 含未知/非法成员：${unknownMembers.join('；')}`, unknownMembers.map(name => ({
        plugin: '<pack>',
        constraint: { kind: 'pack', target: name, range: 'members' },
        chain: ['<pack>'],
        candidates: [{ version: '<member>', rejected: ['成员不在清单声明集合内'] }],
        actions: ['从可信来源重新获取 pack'],
      }))),
    }
  }

  // 空 pack 显式拒绝（A18，已裁决）：plugins 为空 → pack-invalid，预检阶段拒绝。
  if (manifest.plugins.length === 0) {
    return {
      ok: false,
      report: packReport('pack 不含任何插件（plugins 为空），拒绝空 pack 还原', [{
        plugin: '<pack>',
        constraint: { kind: 'pack', target: 'plugins', range: 'empty' },
        chain: ['<pack>'],
        candidates: [{ version: '<manifest>', rejected: ['plugins 数组为空'] }],
        actions: ['重新打包并确认 pack 包含至少一个插件'],
      }]),
    }
  }

  // A4 预检：plugins[] ↔ files[] 一一对应 + lockfile 键集与 plugins[] 一致
  // （多/少/错配/重复/下标错位 → pack-invalid，最早时机拒绝；锚点：design-r4
  // D-A2 plugins[] 集合声明与 lockfile 语义载荷同源、D-A3 pins=lockfile.plugins、
  // D-A6 files[].path 下标形态、T33 两侧载荷逐字节一致、R1 单实例不变量）。
  const pluginIdSet = new Set<string>()
  for (const plugin of manifest.plugins) {
    if (pluginIdSet.has(plugin.id)) {
      return {
        ok: false,
        report: packReport(`pack 清单 plugins[] 重复声明插件 ${plugin.id}`, [{
          plugin: '<pack>',
          constraint: { kind: 'pack', target: plugin.id, range: 'plugins' },
          chain: ['<pack>'],
          candidates: [{ version: '<manifest>', rejected: ['plugins[] 重复 id'] }],
          actions: ['重新打包'],
        }]),
      }
    }
    pluginIdSet.add(plugin.id)
  }
  const seenFileIds = new Set<string>()
  for (const [index, file] of manifest.files.entries()) {
    if (file.path !== `files/${index}.tgz`) {
      return {
        ok: false,
        report: packReport(`pack 清单 files[${index}].path 必须是 files/${index}.tgz（实际 ${file.path}）`, [{
          plugin: '<pack>',
          constraint: { kind: 'pack', target: file.path, range: 'files' },
          chain: ['<pack>'],
          candidates: [{ version: '<manifest>', rejected: ['files[] 下标与 path 不匹配'] }],
          actions: ['重新打包'],
        }]),
      }
    }
    if (seenFileIds.has(file.pluginId)) {
      return {
        ok: false,
        report: packReport(`pack 清单 files[] 重复声明插件 ${file.pluginId}`, [{
          plugin: '<pack>',
          constraint: { kind: 'pack', target: file.path, range: 'files' },
          chain: ['<pack>'],
          candidates: [{ version: '<manifest>', rejected: ['files[] 重复 pluginId'] }],
          actions: ['重新打包'],
        }]),
      }
    }
    seenFileIds.add(file.pluginId)
  }
  if (seenFileIds.size !== pluginIdSet.size) {
    const missing = [...pluginIdSet].filter(id => !seenFileIds.has(id))
    const extra = [...seenFileIds].filter(id => !pluginIdSet.has(id))
    return {
      ok: false,
      report: packReport(
        `pack 清单 plugins[] 与 files[] 不一一对应（缺 vendored 文件：${missing.join(', ') || '无'}；多出：${extra.join(', ') || '无'}）`,
        [{
          plugin: '<pack>',
          constraint: { kind: 'pack', target: missing[0] ?? extra[0] ?? 'plugins', range: 'files' },
          chain: ['<pack>'],
          candidates: [{ version: '<manifest>', rejected: ['plugins[] 与 files[] 集合不一致'] }],
          actions: ['重新打包并保持 plugins[]/files[] 一一对应'],
        }],
      ),
    }
  }
  const lockIds = Object.keys(manifest.lockfile.plugins)
  if (lockIds.length !== pluginIdSet.size || lockIds.some(id => !pluginIdSet.has(id))) {
    const lockExtra = lockIds.filter(id => !pluginIdSet.has(id))
    return {
      ok: false,
      report: packReport(
        `pack 清单 lockfile.plugins 键集与 plugins[] 不一致（多出：${lockExtra.join(', ') || '无'}）`,
        [{
          plugin: '<pack>',
          constraint: { kind: 'pack', target: lockExtra[0] ?? 'lockfile', range: 'plugins' },
          chain: ['<pack>'],
          candidates: [{ version: '<manifest>', rejected: ['lockfile.plugins 键集与 plugins[] 不一致'] }],
          actions: ['重新打包'],
        }],
      ),
    }
  }

  // vendored 文件哈希校验（先于一切 store 写入，mrpack 先例）。
  const hashConflicts: ConflictEntry[] = []
  const fileBytes = new Map<string, Uint8Array>()
  for (const file of manifest.files) {
    const member = findMember(members, file.path)
    if (member === undefined || member.typeflag !== '0') {
      hashConflicts.push({
        plugin: '<pack>',
        constraint: { kind: 'pack', target: file.path, range: 'missing' },
        chain: ['<pack>'],
        candidates: [{ version: '<file>', rejected: ['清单声明的 vendored 文件不存在'] }],
        actions: ['重新打包'],
      })
      continue
    }
    const bytes = memberBytes(unpacked.tar, member)
    if (member.size !== file.fileSize || sha512Hex(bytes) !== file.sha512) {
      hashConflicts.push({
        plugin: '<pack>',
        constraint: { kind: 'pack', target: file.path, range: 'sha512' },
        chain: ['<pack>'],
        candidates: [{
          version: '<file>',
          rejected: [`内容哈希/大小失配（声明 sha512 ${file.sha512.slice(0, 12)}…，大小 ${file.fileSize}）`],
        }],
        actions: ['从可信来源重新获取 pack'],
      })
      continue
    }
    fileBytes.set(file.path, bytes)
  }
  if (hashConflicts.length > 0) {
    return {
      ok: false,
      report: hashReport(hashConflicts, `pack 文件校验失败：${hashConflicts.length} 个文件`),
    }
  }

  // 内层 tarball 预检（B23）：manifest 形状/一致性，全部通过才进入求解。
  const candidates = new Map<string, readonly PluginCandidate[]>()
  const preflightManifests = new Map<string, PluginManifestV2>()
  const preflightProblems: ConflictEntry[] = []
  for (const file of manifest.files) {
    const bytes = fileBytes.get(file.path)
    if (bytes === undefined) continue
    const inner = listGzipTarMembers(bytes)
    if (inner.tar === undefined || inner.members === undefined) {
      preflightProblems.push({
        plugin: file.pluginId,
        constraint: { kind: 'pack', target: file.path, range: 'tarball' },
        chain: [file.pluginId],
        candidates: [{ version: '<file>', rejected: [`内层 tarball 非法：${inner.problems.join('；')}`] }],
        actions: ['重新打包'],
      })
      continue
    }
    const pkgJsonMember = findMember(inner.members, 'package/package.json')
    if (pkgJsonMember === undefined || pkgJsonMember.typeflag !== '0') {
      preflightProblems.push({
        plugin: file.pluginId,
        constraint: { kind: 'pack', target: file.path, range: 'package.json' },
        chain: [file.pluginId],
        candidates: [{ version: '<file>', rejected: ['内层 tarball 缺 package/package.json'] }],
        actions: ['重新打包'],
      })
      continue
    }
    let pkgRaw: Record<string, unknown>
    try {
      pkgRaw = JSON.parse(Buffer.from(memberBytes(inner.tar, pkgJsonMember)).toString('utf8')) as Record<string, unknown>
    } catch {
      preflightProblems.push({
        plugin: file.pluginId,
        constraint: { kind: 'pack', target: file.path, range: 'package.json' },
        chain: [file.pluginId],
        candidates: [{ version: '<file>', rejected: ['package.json 不是合法 JSON'] }],
        actions: ['重新打包'],
      })
      continue
    }
    const pluginParsed = parsePackageManifest(pkgRaw)
    const lockEntry = manifest.lockfile.plugins[file.pluginId]
    if (pluginParsed.value === undefined) {
      preflightProblems.push({
        plugin: file.pluginId,
        constraint: { kind: 'pack', target: file.path, range: 'manifest' },
        chain: [file.pluginId],
        candidates: [{ version: '<file>', rejected: pluginParsed.problems.map(problem => `${problem.path}: ${problem.message}`) }],
        actions: ['由插件作者修复 dsh.mygo manifest'],
      })
      continue
    }
    if (pkgRaw.name !== file.packageName || pluginParsed.value.id !== file.pluginId
      || lockEntry === undefined || pluginParsed.value.version !== lockEntry.version) {
      preflightProblems.push({
        plugin: file.pluginId,
        constraint: { kind: 'pack', target: file.path, range: 'identity' },
        chain: [file.pluginId],
        candidates: [{
          version: pluginParsed.value.version,
          rejected: [`包身份与清单不一致（packageName=${String(pkgRaw.name)}，id=${pluginParsed.value.id}，锁定=${lockEntry?.version ?? '无'}）`],
        }],
        actions: ['重新打包'],
      })
      continue
    }
    const pathProblems = pathProblemsOf(pluginParsed.value)
    if (pathProblems.length > 0) {
      preflightProblems.push({
        plugin: file.pluginId,
        constraint: { kind: 'pack', target: file.path, range: 'paths' },
        chain: [file.pluginId],
        candidates: [{ version: pluginParsed.value.version, rejected: pathProblems.map(problem => `${problem.path}: ${problem.message}`) }],
        actions: ['由插件作者修复路径声明'],
      })
      continue
    }
    const existing = candidates.get(file.pluginId) ?? []
    preflightManifests.set(file.pluginId, pluginParsed.value)
    candidates.set(file.pluginId, [...existing, {
      version: pluginParsed.value.version,
      constraints: constraintsOf(pluginParsed.value),
      ...(pluginParsed.value.provides.length === 0 ? {} : { provides: pluginParsed.value.provides }),
      source: 'pack',
    }])
  }
  if (preflightProblems.length > 0) {
    // 任务 1.3：summary 必须携带实际违例与上限值（而非只报个数）。
    const detailLines = preflightProblems.flatMap(problem => problem.candidates[0]?.rejected ?? [])
    return {
      ok: false,
      report: packReport(`pack 内层校验失败：${preflightProblems.length} 个插件（${detailLines.join('；')}）`, preflightProblems),
    }
  }

  const requests = new Map<string, { readonly range?: string }>()
  for (const plugin of manifest.plugins) {
    requests.set(plugin.id, plugin.range === undefined ? {} : { range: plugin.range })
  }
  const pins = new Map<string, { readonly version: string; readonly source?: string }>()
  for (const [id, lock] of Object.entries(manifest.lockfile.plugins)) {
    pins.set(id, { version: lock.version, source: 'pack' })
  }
  const currentLock = await readLockfile(lockfilePath(ctx.paths, ctx.profile))
  const installed = new Map<string, PluginCandidate>()
  if (currentLock !== undefined) {
    for (const [id, lock] of Object.entries(currentLock.plugins)) {
      installed.set(id, {
        version: lock.version,
        constraints: { depends: lock.depends, breaks: lock.breaks, core: lock.core, entry: lock.entry },
        ...(lock.provides === undefined || lock.provides.length === 0 ? {} : { provides: lock.provides }),
        source: 'locked',
      })
    }
  }
  const coreVersion = options.coreVersion ?? ctx.coreVersion
  const outcome = resolve({
    requests,
    candidates,
    installed,
    coreVersion,
    pins,
  })
  if (!outcome.ok) {
    return { ok: false, report: { ...outcome.report, scope: 'pack' } }
  }

  // store 安装（A4）：全部预检通过后才写 store；仅「本次需要新写入的插件」
  // （在 files[] 内）要求 vendored 文件，已装节点豁免（任务书术语强定义）。
  // 原子性（D-A7）：任一失败回滚本次新增目录 + 还原移开的既有目录，
  // lockfile 保持原字节（写 lockfile 在本段成功完成之后）。
  const createdDirs: string[] = []
  const createdIdDirs: string[] = []
  const movedAside = new Map<string, string>()
  const rollback = async (): Promise<void> => {
    for (const dir of [...createdDirs].reverse()) {
      await rm(dir, { recursive: true, force: true })
    }
    // 本 restore 新建的 id 级目录（现为空）一并摘除；仅在 id 目录为本次新建时
    // 才允许递归删除，避免误删既有的其他版本目录（零残留口径）。
    for (const dir of [...createdIdDirs].reverse()) {
      await rm(dir, { recursive: true, force: true })
    }
    for (const [dir, backup] of movedAside) {
      await rm(dir, { recursive: true, force: true })
      await rename(backup, dir)
    }
  }
  for (const resolved of outcome.resolved) {
    const file = manifest.files.find(entry => entry.pluginId === resolved.id)
    if (file === undefined) continue // 已装节点：无需 vendored 文件、无需重写 store
    const bytes = fileBytes.get(file.path)
    const lock = manifest.lockfile.plugins[resolved.id]
    const preflightManifest = preflightManifests.get(resolved.id)
    if (bytes === undefined || lock === undefined || preflightManifest === undefined) {
      // 预检 1:1 + 哈希环之后本分支不可达；防御性保留并保证零残留。
      await rollback()
      return {
        ok: false,
        report: packReport(`求解结果缺少 vendored 文件：${resolved.id}`, [{
          plugin: resolved.id,
          constraint: { kind: 'pack', target: resolved.id, range: resolved.version },
          chain: [resolved.id],
          candidates: [{ version: resolved.version, rejected: ['无对应 files[] 条目'] }],
          actions: ['重新打包'],
        }]),
      }
    }
    const dir = packageDir(ctx.paths, resolved.id, lock.version)
    const existing = await readInstalledPackage(dir, resolved.id, lock.version)
    let fact: Awaited<ReturnType<typeof readInstalledPackage>>
    if (existing !== undefined && existing.entrySha256 !== '') {
      // 同版本有效事实文件已存在：复用，不写 store。
      fact = existing
    } else {
      // 目录不存在或损坏：先移开旧目录（若存在）再全新安装，失败可整体回滚。
      const idDir = dirname(dir)
      const existed = await dirExists(dir)
      const idDirExisted = existed || await dirExists(idDir)
      if (existed) {
        await mkdir(idDir, { recursive: true })
        await mkdir(ctx.paths.tmpDir, { recursive: true })
        const backup = join(ctx.paths.tmpDir, `mygo-restore-bak-${randomUUID()}`)
        await rename(dir, backup)
        movedAside.set(dir, backup)
      }
      try {
        fact = await installPackageToStore(ctx.paths, {
          version: lock.version,
          tarball: file.path,
          manifest: preflightManifest,
          ...(file.integrity === undefined ? {} : { integrity: file.integrity }),
        }, {
          localTarballBytes: bytes,
          expectedSha512Hex: file.sha512,
          ...(ctx.tarCmd === undefined ? {} : { tarCmd: ctx.tarCmd }),
        })
      } catch (error) {
        await rollback()
        return {
          ok: false,
          report: packReport(`store 安装失败：${resolved.id}（${error instanceof Error ? error.message : String(error)}）`, [{
            plugin: resolved.id,
            constraint: { kind: 'pack', target: file.path, range: lock.version },
            chain: [resolved.id],
            candidates: [{ version: lock.version, rejected: ['本地 tarball 提取/校验失败'] }],
            actions: ['从可信来源重新获取 pack 后重试'],
          }]),
        }
      }
      if (!existed) createdDirs.push(dir)
      if (!idDirExisted) createdIdDirs.push(idDir)
    }
    if (fact === undefined || fact.entrySha256 !== lock.entrySha256
      || fact.manifestSha256 !== lock.manifestSha256
      || (lock.entrySha512 !== undefined && fact.entrySha512 !== lock.entrySha512)
      || (lock.entryFileSize !== undefined && fact.entryFileSize !== lock.entryFileSize)) {
      await rollback()
      return {
        ok: false,
        report: packReport(`store 安装后哈希与锁定载荷不一致：${resolved.id}`, [{
          plugin: resolved.id,
          constraint: { kind: 'pack', target: resolved.id, range: lock.version },
          chain: [resolved.id],
          candidates: [{
            version: lock.version,
            rejected: ['entrySha256/manifestSha256/entrySha512/fileSize 与 pack lockfile 不一致'],
          }],
          actions: ['检查磁盘/存储完整性后重新安装 pack'],
        }]),
      }
    }
  }
  for (const backup of movedAside.values()) {
    await rm(backup, { recursive: true, force: true })
  }

  // 双存在 + 社区元数据告警（B25；永不阻断）。
  const warnings: string[] = []
  const managedPackageNames = new Set(
    Object.values(manifest.lockfile.plugins).map(lock => lock.packageName).filter((name): name is string => name !== undefined),
  )
  for (const dep of manifest.communityDeps) {
    warnings.push(`社区依赖（${dep.kind}）：${dep.owner} 声明 ${dep.name}@${dep.range}——mygo 不安装，需 npm 侧解析`)
    if (managedPackageNames.has(dep.name)) {
      warnings.push(`双存在风险：${dep.name} 既是本 pack 的 mygo 插件，又被 ${dep.owner} 以 ${dep.kind} 声明（重复实例风险，two-tier §10）`)
    }
    const isCoreSignal = dep.name === '@deepseek-ai/dsh' || dep.name === 'cordis' || dep.name === '@deepseek-ai/dsh-tools'
    if (isCoreSignal && coreVersion !== undefined && !matchesVersionRange(coreVersion, dep.range)) {
      warnings.push(`核心版本告警：当前 dsh 核心 ${coreVersion} 不满足 ${dep.name} 声明的 ${dep.range}`)
    }
  }

  // A4：lockfile 合并——pack 条目（pin 胜出，design-r3 §2.4-2）+ 目标 profile
  // 既有条目（未出现在 pack 内的保留；验收标准 1「lockfile 正确合并」）。
  // 空目标 profile 时输出与 pack 载荷逐字节一致（RT1/T33 保持）。
  const mergedPlugins: Record<string, LockedPlugin> = {}
  if (currentLock !== undefined) {
    for (const [id, lock] of Object.entries(currentLock.plugins)) {
      if (manifest.lockfile.plugins[id] === undefined) mergedPlugins[id] = lock
    }
  }
  for (const [id, lock] of Object.entries(manifest.lockfile.plugins)) {
    mergedPlugins[id] = lock
  }
  const next: Lockfile = {
    format: 'dsh.lock/v1',
    generated: {
      by: 'dsh-mygo',
      version: ctx.managerVersion,
      profile: ctx.profile,
      ...(coreVersion === undefined ? {} : { core: coreVersion }),
      at: new Date().toISOString(),
    },
    plugins: mergedPlugins,
  }
  await writeLockfile(lockfilePath(ctx.paths, ctx.profile), next)
  return { ok: true, lockfile: next, warnings }
}
