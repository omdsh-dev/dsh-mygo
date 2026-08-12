/**
 * lockfile（《收敛任务》不变量 1/2）：记录每 id 精确版本与内容哈希；
 * 加载时只对照 lockfile 验证磁盘（版本+哈希），不重新求解。
 * @module @deepseek-ai/dsh-mygo/src/package/lockfile
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { packageDir, type MygoPaths } from './paths.ts'

/** One locked plugin entry. */
export interface LockedPlugin {
  readonly version: string
  readonly entry: string
  readonly core: string
  readonly depends: Readonly<Record<string, string>>
  readonly breaks: Readonly<Record<string, string>>
  /**
   * 服务级依赖声明快照（修复批次 3 / A3）：manifest `requires` 原样落盘，
   * 重启后 loadEntry 从本字段还原（不再硬编码 {}）。值可为区间数组（OR）。
   */
  readonly requires: Readonly<Record<string, string | readonly string[]>>
  /** 符号别名声明快照（修复批次 3 / A3；EB-D19 载体）。 */
  readonly symbolAliases: Readonly<Record<string, string>>
  readonly entrySha256: string
  readonly manifestSha256: string
  /**
   * 入口文件内容 sha512（hex；DG-2 裁决拆字段后的真 entrySha512）。
   * 写入点 = install/restore 落盘时（package-store 现场计算）；BOM 对账消费。
   */
  readonly entrySha512: string
  /**
   * vendored tarball 文件整体 sha512（hex；原 entrySha512 之实，DG-2 归位）。
   * npm 安装来自 integrity（SRI sha512-base64 转 hex），pack 安装来自
   * files[].sha512；integrity 不可解析或缺省时缺省。
   */
  readonly tarballSha512?: string
  /** BOM 对账：entry 文件字节数（G10）。 */
  readonly entryFileSize?: number
  readonly integrity?: string
  readonly source?: string
  /** npm package name this plugin was installed from (id = manifest id). */
  readonly packageName?: string
  /** 本版本对外提供的 id 列表（provides 别名）。 */
  readonly provides?: readonly string[]
  /** 内嵌包锁定事实（参与跨插件去重）。 */
  readonly bundles?: readonly LockedBundle[]
  /** 安装期符号校验结果（加载期对照 import 集）。 */
  readonly symbols?: readonly LockedSymbolCheck[]
}

/** One locked bundled package. */
export interface LockedBundle {
  readonly id: string
  readonly version: string
  readonly path: string
  readonly depends: Readonly<Record<string, string>>
  readonly breaks: Readonly<Record<string, string>>
  readonly core: string
  readonly provides?: readonly string[]
}

/** One recorded symbol check. */
export interface LockedSymbolCheck {
  readonly specifier: string
  readonly file: string
  readonly symbol: string
  readonly missing: boolean
}

/** The `dsh.lock/v1` document. */
export interface Lockfile {
  readonly format: 'dsh.lock/v1'
  readonly generated: {
    readonly by: 'dsh-mygo'
    readonly version: string
    readonly profile: string
    readonly core?: string
    readonly at: string
  }
  readonly plugins: Readonly<Record<string, LockedPlugin>>
}

/** SHA-256 hex of one file's bytes. */
export async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

/** SHA-512 hex of one file's bytes（BOM 对账；C5/G11）。 */
export async function sha512File(path: string): Promise<string> {
  const bytes = await readFile(path)
  return createHash('sha512').update(bytes).digest('hex')
}

/** SHA-256 hex of a UTF-8 string. */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 解析 npm `integrity` SRI（`sha512-base64`）为 hex（design-r3 §3.5/C5）。
 * 无法解析返回 undefined（不猜测、不阻断）。
 */
export function integritySha512Hex(integrity: string | undefined): string | undefined {
  if (integrity === undefined) return undefined
  const match = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity.trim())
  if (match === null) return undefined
  return Buffer.from(match[1] as string, 'base64').toString('hex')
}

/** Write a lockfile atomically (temp + rename), keeping a `.bak`. */
export async function writeLockfile(path: string, lockfile: Lockfile): Promise<void> {
  await mkdir(path.slice(0, Math.max(path.lastIndexOf('/'), 0)) || '.', { recursive: true })
  const tmp = `${path}.tmp`
  const existing = await readFile(path, 'utf8').catch(() => undefined)
  await writeFile(tmp, JSON.stringify(lockfile, null, 2) + '\n', 'utf8')
  if (existing !== undefined) await writeFile(`${path}.bak`, existing, 'utf8')
  await rename(tmp, path)
}

/** 读入结果：合法载荷 / 形状问题（带字段指针）。undefined = 文件缺失。 */
export type LockfileReadResult =
  | { readonly ok: true; readonly lockfile: Lockfile }
  | { readonly ok: false; readonly problem: string }

const SHA256_HEX_RE = /^[0-9a-f]{64}$/
const SHA512_HEX_RE = /^[0-9a-f]{128}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 字符串映射（depends/breaks/symbolAliases 形状）。 */
function isStringMap(value: unknown): value is Readonly<Record<string, string>> {
  if (!isRecord(value)) return false
  return Object.values(value).every(item => typeof item === 'string')
}

/** requires 形状：服务名 → 区间字符串或区间数组（OR）。 */
function isRangeMap(value: unknown): value is Readonly<Record<string, string | readonly string[]>> {
  if (!isRecord(value)) return false
  return Object.values(value).every(item => typeof item === 'string'
    || (Array.isArray(item) && item.length > 0 && item.every(entry => typeof entry === 'string')))
}

/**
 * lockfile 形状校验（修复批次 3 / A12）：schema 显式演进——新字段
 * requires / symbolAliases / entrySha512 为必填，旧 schema（本批前格式）读入
 * 即报问题（不静默补默认值）。返回问题清单，逐条带字段指针。
 */
export function validateLockfileShape(value: unknown): readonly string[] {
  const problems: string[] = []
  if (!isRecord(value)) {
    return ['lockfile 不是对象']
  }
  if (value.format !== 'dsh.lock/v1') {
    problems.push('lockfile.format 必须是 dsh.lock/v1')
    return problems
  }
  if (!isRecord(value.plugins)) {
    problems.push('lockfile.plugins 必须是对象')
    return problems
  }
  for (const [id, raw] of Object.entries(value.plugins)) {
    const entry = raw
    const path = `lockfile.plugins.${id}`
    if (!isRecord(entry)) {
      problems.push(`${path} 不是对象`)
      continue
    }
    if (typeof entry.version !== 'string' || entry.version === '') problems.push(`${path}.version 必须是非空字符串`)
    if (typeof entry.entry !== 'string' || entry.entry === '') problems.push(`${path}.entry 必须是非空字符串`)
    if (typeof entry.core !== 'string' || entry.core === '') problems.push(`${path}.core 必须是非空字符串`)
    if (!isStringMap(entry.depends)) problems.push(`${path}.depends 必须是 string 映射`)
    if (!isStringMap(entry.breaks)) problems.push(`${path}.breaks 必须是 string 映射`)
    if (!isRangeMap(entry.requires)) problems.push(`${path}.requires 必须是 服务名 → 区间(string|string[]) 映射（旧 schema 缺本字段：请重新 restore/重装）`)
    if (!isStringMap(entry.symbolAliases)) problems.push(`${path}.symbolAliases 必须是 string 映射（旧 schema 缺本字段：请重新 restore/重装）`)
    if (typeof entry.entrySha256 !== 'string' || !SHA256_HEX_RE.test(entry.entrySha256)) problems.push(`${path}.entrySha256 必须是 64 位 hex`)
    if (typeof entry.manifestSha256 !== 'string' || !SHA256_HEX_RE.test(entry.manifestSha256)) problems.push(`${path}.manifestSha256 必须是 64 位 hex`)
    if (typeof entry.entrySha512 !== 'string' || !SHA512_HEX_RE.test(entry.entrySha512)) problems.push(`${path}.entrySha512 必须是 128 位 hex（旧 schema 缺本字段：请重新 restore/重装）`)
    if (entry.tarballSha512 !== undefined && (typeof entry.tarballSha512 !== 'string' || !SHA512_HEX_RE.test(entry.tarballSha512))) problems.push(`${path}.tarballSha512 必须是 128 位 hex`)
    if (entry.entryFileSize !== undefined && (typeof entry.entryFileSize !== 'number' || !Number.isInteger(entry.entryFileSize) || entry.entryFileSize < 0)) problems.push(`${path}.entryFileSize 必须是非负整数`)
    if (entry.integrity !== undefined && typeof entry.integrity !== 'string') problems.push(`${path}.integrity 必须是字符串`)
    if (entry.source !== undefined && typeof entry.source !== 'string') problems.push(`${path}.source 必须是字符串`)
    if (entry.packageName !== undefined && typeof entry.packageName !== 'string') problems.push(`${path}.packageName 必须是字符串`)
    if (entry.provides !== undefined && (!Array.isArray(entry.provides) || entry.provides.some(item => typeof item !== 'string'))) problems.push(`${path}.provides 必须是 string 数组`)
    if (entry.bundles !== undefined) {
      if (!Array.isArray(entry.bundles)) {
        problems.push(`${path}.bundles 必须是数组`)
      } else {
        for (const [index, bundle] of entry.bundles.entries()) {
          if (!isRecord(bundle) || typeof bundle.id !== 'string' || typeof bundle.version !== 'string'
            || typeof bundle.path !== 'string' || !isStringMap(bundle.depends)
            || !isStringMap(bundle.breaks) || typeof bundle.core !== 'string') {
            problems.push(`${path}.bundles[${index}] 形状非法（需 id/version/path/depends/breaks/core）`)
          }
        }
      }
    }
    if (entry.symbols !== undefined) {
      if (!Array.isArray(entry.symbols)) {
        problems.push(`${path}.symbols 必须是数组`)
      } else {
        for (const [index, symbol] of entry.symbols.entries()) {
          if (!isRecord(symbol) || typeof symbol.specifier !== 'string' || typeof symbol.file !== 'string'
            || typeof symbol.symbol !== 'string' || typeof symbol.missing !== 'boolean') {
            problems.push(`${path}.symbols[${index}] 形状非法（需 specifier/file/symbol/missing）`)
          }
        }
      }
    }
  }
  return problems
}

/**
 * Read and validate a lockfile. `undefined` = 文件缺失（legacy profile，调用方
 * 自行放行）；`{ok:false, problem}` = JSON 非法或形状校验失败（显式演进：旧
 * schema 不静默迁移，调用方转 lockfile-mismatch 报告）。
 */
export async function readLockfile(path: string): Promise<LockfileReadResult | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, problem: `lockfile 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  const problems = validateLockfileShape(parsed)
  if (problems.length > 0) return { ok: false, problem: problems.join('；') }
  return { ok: true, lockfile: parsed as Lockfile }
}

/** One load-time verification failure. */
export interface VerifyIssue {
  readonly id: string
  readonly version: string
  readonly reason: string
}

/**
 * Verify disk state against the lockfile: package dir, entry, and content
 * hashes. Pure read; never re-solves and never consults a registry.
 */
export async function verifyLockfile(
  paths: MygoPaths,
  lockfile: Lockfile,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly issues: readonly VerifyIssue[] }> {
  const issues: VerifyIssue[] = []
  for (const [id, lock] of Object.entries(lockfile.plugins)) {
    // B10 加载期路径安全：lockfile 内的 entry 必须是相对路径（禁逃逸/绝对/盘符）。
    if (lock.entry.startsWith('/') || /^[A-Za-z]:[\\/]/.test(lock.entry)
      || lock.entry.startsWith('../') || lock.entry.includes('/../')) {
      issues.push({ id, version: lock.version, reason: `lockfile entry 路径逃逸：${lock.entry}` })
      continue
    }
    const dir = packageDir(paths, id, lock.version)
    const entryPath = join(dir, lock.entry)
    const manifestPath = join(dir, '.mygo-package.json')
    if (!(await fileExists(dir))) {
      issues.push({ id, version: lock.version, reason: `包目录缺失：${dir}` })
      continue
    }
    if (!(await fileExists(entryPath))) {
      issues.push({ id, version: lock.version, reason: `入口缺失：${lock.entry}` })
    } else {
      const actualEntry = await sha256File(entryPath).catch(() => undefined)
      if (actualEntry !== lock.entrySha256) {
        issues.push({ id, version: lock.version, reason: `入口哈希不匹配（期望 ${lock.entrySha256.slice(0, 12)}…）` })
      }
    }
    if (!(await fileExists(manifestPath))) {
      issues.push({ id, version: lock.version, reason: '.mygo-package.json 缺失' })
    } else {
      // manifestSha256 是稳定载荷哈希（不含 installedAt / manifestSha256 /
      // entrySha512 自身——entrySha512 为修复批次 3 起的事实文件尾部记账字段，
      // S2 确定性）；校验按同一口径重算。
      const actualManifest = await readFile(manifestPath, 'utf8')
        .then(raw => {
          const fact = JSON.parse(raw) as Record<string, unknown>
          delete fact.manifestSha256
          delete fact.installedAt
          delete fact.entrySha512
          return sha256Text(JSON.stringify(fact))
        })
        .catch(() => undefined)
      if (actualManifest !== lock.manifestSha256) {
        issues.push({ id, version: lock.version, reason: '清单哈希不匹配' })
      }
    }
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
