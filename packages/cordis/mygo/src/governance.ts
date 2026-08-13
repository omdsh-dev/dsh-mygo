/**
 * 治理视图（P3，pnpm 安装状态为唯一真相源）：从 profile 实际安装状态
 * （package.json dependencies + dsh.profile.bundles 层列表 + 用户 patch 层
 * 的 disabled 行）重建的只读视图。RegistryStore 降级为运行时缓存——治理
 * 事实（装/卸/启/停）以 profile 文件为准，每次读取实时重建。
 * @module @r05en1cu/dsh-mygo/src/governance
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 一份 profile 的治理视图。 */
export interface GovernanceView {
  readonly profile: string
  readonly profileDir: string
  /** profile 清单 dependencies（pnpm 安装状态）。 */
  readonly dependencies: Readonly<Record<string, string>>
  /** dsh.profile.bundles 层列表（bundle 对账结果）。 */
  readonly bundles: readonly string[]
  /** 用户 patch 层中 disabled 的行 id（启停事实）。 */
  readonly disabledRows: readonly string[]
  /** 用户 patch 层路径（缺失时视图各面为空集合）。 */
  readonly patchPath: string
}

/** 从 patch 层文本提取 `disabled: true` 的行 id（文本级，容忍 !!js 等自定义标签）。 */
export function disabledRowsOf(patchText: string): readonly string[] {
  const out: string[] = []
  const entry = /-\s+id:\s*([a-z][a-z0-9-]*)((?:\n(?![-\s]).*)*)\n?\s+disabled:\s*true/g
  for (const match of patchText.matchAll(entry)) {
    if (match[1] !== undefined) out.push(match[1])
  }
  return out.sort()
}

/** 重建一个 profile 的治理视图（profile 目录缺文件时按空集合计）。 */
export function readGovernanceView(profileDir: string, profile?: string): GovernanceView {
  const name = profile ?? profileDir.split('/').filter(segment => segment !== '').pop() ?? ''
  let dependencies: Readonly<Record<string, string>> = {}
  let bundles: readonly string[] = []
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      readonly dependencies?: Readonly<Record<string, string>>
      readonly dsh?: { readonly profile?: { readonly bundles?: readonly string[] } }
    }
    dependencies = manifest.dependencies ?? {}
    bundles = manifest.dsh?.profile?.bundles ?? []
  } catch {
    // profile 未初始化：空视图
  }
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  return {
    profile: name,
    profileDir,
    dependencies,
    bundles,
    disabledRows: disabledRowsOf(patchText),
    patchPath,
  }
}
