import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { parseVersion } from './semver-range.ts'

/** mygo 自身安装记录（`mygo-self.json` 的解析结果）。 */
export interface MygoSelfInfo {
  /** 安装版本；缺失/非法时回退 `0.1.0`。 */
  readonly version: string
  readonly url?: string
  readonly ref?: string
  readonly commit?: string
  readonly installedAt?: number
}

/** 回退版本：开发/harness 环境没有 mygo-self.json 时读取包自身版本。 */
function packageVersionFallback(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { readonly version?: unknown }
    if (typeof pkg.version === 'string' && isSemver(pkg.version)) return pkg.version
  } catch {
    // fall through to the hardcoded fallback
  }
  return '0.1.0'
}

const FALLBACK_VERSION = packageVersionFallback()

function isSemver(value: unknown): value is string {
  return typeof value === 'string' && parseVersion(value) !== undefined
}

/** 读取当前 mygo 自身安装事实；文件缺失/损坏时返回回退版本。 */
export function readMygoSelf(): MygoSelfInfo {
  try {
    const raw = readFileSync(dshHomePath('mygo-self.json'), 'utf8')
    const parsed = JSON.parse(raw) as {
      readonly version?: unknown
      readonly url?: unknown
      readonly ref?: unknown
      readonly commit?: unknown
      readonly installedAt?: unknown
    }
    return {
      version: isSemver(parsed.version) ? parsed.version : FALLBACK_VERSION,
      ...(typeof parsed.url === 'string' ? { url: parsed.url } : {}),
      ...(typeof parsed.ref === 'string' ? { ref: parsed.ref } : {}),
      ...(typeof parsed.commit === 'string' ? { commit: parsed.commit } : {}),
      ...(typeof parsed.installedAt === 'number' ? { installedAt: parsed.installedAt } : {}),
    }
  } catch {
    return { version: FALLBACK_VERSION }
  }
}

/** 模块加载时解析一次：统一依赖图与 BOM 导出共享同一版本事实。 */
export const MYGO_SELF = readMygoSelf()

/** mygo 自身在统一依赖图中的版本（`dsh-mygo` 成员版本）。 */
export const MYGO_MANAGER_VERSION = MYGO_SELF.version

export function writeMygoSelfInstallation(now: () => number = () => Math.floor(Date.now() / 1000)): void {
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    let pkg: { readonly name?: unknown; readonly version?: unknown; readonly repository?: unknown } | undefined
    for (let depth = 0; depth < 4; depth += 1) {
      try {
        const candidate = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as typeof pkg
        if (candidate?.name === '@r05en1cu/dsh-mygo') {
          pkg = candidate
          break
        }
      } catch {
        // 继续向上找
      }
      dir = dirname(dir)
    }
    if (pkg === undefined || !isSemver(pkg.version)) return
    const repo = pkg.repository as { readonly url?: unknown } | undefined
    const next = {
      ...(typeof repo?.url === 'string' ? { url: repo.url } : {}),
      version: pkg.version,
      installedAt: now(),
    }
    const path = dshHomePath('mygo-self.json')
    const existing = readMygoSelf()
    if (existing.version === next.version && existing.url === next.url) return
    writeFileSync(path, JSON.stringify(next) + '\n', 'utf8')
  } catch {
    // best-effort：自身事实缺失不阻断服务启动（self.ts 回退链兜底）
  }
}
