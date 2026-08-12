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
  readonly entrySha256: string
  readonly manifestSha256: string
  /** BOM 对账：entry 文件 sha512（hex；npm integrity 解析转 hex，C5/Rev-2）。 */
  readonly entrySha512?: string
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

/** Read a lockfile; `undefined` when missing or unparsable. */
export async function readLockfile(path: string): Promise<Lockfile | undefined> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Lockfile
    return parsed.format === 'dsh.lock/v1' && typeof parsed.plugins === 'object' && parsed.plugins !== null
      ? parsed
      : undefined
  } catch {
    return undefined
  }
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
      // manifestSha256 是稳定载荷哈希（不含 installedAt / manifestSha256 自身，
      // S2 确定性）；校验按同一口径重算。
      const actualManifest = await readFile(manifestPath, 'utf8')
        .then(raw => {
          const fact = JSON.parse(raw) as Record<string, unknown>
          delete fact.manifestSha256
          delete fact.installedAt
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
