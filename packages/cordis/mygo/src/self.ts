/**
 * mygo 自身安装事实（版本 / 远端 / commit）。
 *
 * 版本事实来源按优先级：`$DSH_HOME/mygo-self.json#version`（install.sh
 * 写入，与仓库 `VERSION` 文件同源）→ 内置回退 `0.1.0`（开发/harness 环境）。
 * 统一依赖图（`dsh-mygo` 成员）与 BOM 导出都用这一份事实，避免
 * `MYGO_MANAGER_VERSION` 硬编码漂移（历史坑：常量 0.1.0 与仓库 0.1.1 不一致）。
 * @module @deepseek-ai/dsh-mygo/src/self
 */

import { readFileSync } from 'node:fs'
import { dshHomePath } from '@deepseek-ai/dsh-paths'
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

/** 回退版本：开发/harness 环境没有 mygo-self.json 时的图成员版本。 */
const FALLBACK_VERSION = '0.1.0'

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
