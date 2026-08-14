/**
 * mygo 工作区包枚举（HMR 体验迭代 R1）：mygo 自更新把「整个仓库」作为
 * 最小更新单元——克隆后按 packages/<group>/<name> 枚举全部 @r05en1cu/*
 * 包目录并逐一同步/构建，取代早期 install.sh 时代的固定三目录清单
 * （vendor/dsh-mygo-panel 布局已在 P1/P3 退役）。纯函数面，供
 * updateMygoFromRemote 调用、包级测试直测。
 * @module @r05en1cu/dsh-mygo-ext-panel/workspace-packages
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 仓库内工作区组（packages 下的一级目录）。 */
const WORKSPACE_GROUPS = ['core', 'cordis', 'extensions', 'loaders'] as const

/** 一个 mygo 工作区包的仓库内相对路径（如 `packages/cordis/mygo`）。 */
export type MygoPackagePath = string

/**
 * 枚举克隆仓库 packages/ 下全部 @r05en1cu/* 工作区包，返回相对仓库根的
 * 目录路径（排序稳定：组序 + 目录名字典序）。非包目录（无 package.json
 * 或 name 不以 @r05en1cu/ 开头）跳过。
 * @param root - 仓库根（克隆的 tmp 目录）。
 * @returns 相对路径数组；仓库结构异常时为空数组。
 */
export async function listMygoPackageDirs(root: string): Promise<MygoPackagePath[]> {
  const out: MygoPackagePath[] = []
  for (const group of WORKSPACE_GROUPS) {
    const groupDir = join(root, 'packages', group)
    let entries: string[]
    try {
      entries = (await readdir(groupDir, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort()
    } catch {
      continue
    }
    for (const entry of entries) {
      try {
        const pkg = JSON.parse(await readFile(join(groupDir, entry, 'package.json'), 'utf8')) as {
          readonly name?: unknown
        }
        if (typeof pkg.name === 'string' && pkg.name.startsWith('@r05en1cu/')) {
          out.push(`packages/${group}/${entry}`)
        }
      } catch {
        // not a package directory
      }
    }
  }
  return out
}

/**
 * 判定一个包目录的构建形态：面板包用 `tsc -p tsconfig.json` +
 * `tsdown --config tsdown.config.mjs`（client 双产物），其余标准包用
 * `tsc -b` + `tsdown --config tsdown.config.ts`（项目引用随 tsc -b 走）。
 * @param packageDir - 包目录绝对路径。
 * @returns 该包的 tsc / tsdown 命令参数（不含可执行文件本身）。
 */
export async function buildArgsFor(
  packageDir: string,
): Promise<{ readonly tsc: readonly string[]; readonly tsdown: readonly string[] }> {
  const hasMjs = await exists(join(packageDir, 'tsdown.config.mjs'))
  if (hasMjs) {
    return { tsc: ['-p', 'tsconfig.json'], tsdown: ['--config', 'tsdown.config.mjs'] }
  }
  return { tsc: ['-b'], tsdown: ['--config', 'tsdown.config.ts'] }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}
