/**
 * profile 安装执行面（P3 原生形态；P5 从 mygo-cli 收敛进本包）：
 * profile 目录跑 pnpm + 按 `dsh.bundle` 声明对账 `dsh.profile.bundles`
 * （对齐官方 `dsh plugin` 的 reconcile 语义，直接复用
 * @deepseek-ai/dsh-app-boot 的 profile API）；enable/disable = profile
 * cordis.patch.yml 的 id 定向 `disabled` patch 块写入/移除。
 * 本面是所有其他 loader 的最终执行面。
 * @module @r05en1cu/dsh-mygo-loader-profile/face
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import {
  DEFAULT_PROFILE_BUNDLES,
  initProfile,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveBundleDir,
  resolveProfileDir,
  writeProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import type { ProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { assertInsideHome, resolveDshHome } from '@r05en1cu/dsh-mygo'

export interface ProfileExecOptions {
  /** 目标 profile 名。 */
  readonly profile: string
  /** $DSH_HOME 覆盖（测试注入；缺省进程环境）。 */
  readonly home?: string
  /** pnpm 命令的调用目录（相对路径 spec 的锚点；缺省 process.cwd()）。 */
  readonly cwd?: string
}

export interface ProfileExecResult {
  readonly ok: boolean
  readonly profile: string
  /** 对账后的 dsh.profile.bundles 列表（install/uninstall）。 */
  readonly bundles?: readonly string[]
  readonly error?: string | undefined
}

/** dsh 安装锚点（in-box bundle 解析用）；不可解析时退回 profile 自身锚点。 */
function installAnchor(profileDir: string): string {
  try {
    return createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
  } catch {
    return join(profileDir, 'package.json')
  }
}

/** 对齐官方 plugin.ts：依赖解析出 dsh.bundle 声明即为 bundle。 */
function exportsPatch(packageName: string, profileDir: string): boolean {
  let dir: string
  try {
    dir = resolveBundleDir('mygo', packageName, installAnchor(profileDir), profileDir)
  } catch {
    return false
  }
  const manifest = readProfileManifest('mygo', dir)
  return manifest.dsh?.bundle?.patch !== undefined
}

/** 按安装后对账 dsh.profile.bundles（官方 reconcilePlugins 同语义）。 */
function reconcilePlugins(before: ProfileManifest, profileDir: string): void {
  const after = readProfileManifest('mygo', profileDir)
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const dependencies = Object.keys(after.dependencies ?? {})
  const plugins = [...(after.dsh?.profile?.bundles ?? [])]
  let changed = false
  for (const packageName of dependencies) {
    const isBundle = exportsPatch(packageName, profileDir)
    if (isBundle && !plugins.includes(packageName)) {
      plugins.push(packageName)
      changed = true
    }
  }
  const dependencySet = new Set(dependencies)
  for (const packageName of [...plugins]) {
    const wasDependency = beforeDeps.has(packageName) || dependencySet.has(packageName)
    const stillBundle = dependencySet.has(packageName) && exportsPatch(packageName, profileDir)
    if (wasDependency && !stillBundle) {
      plugins.splice(plugins.indexOf(packageName), 1)
      changed = true
    }
  }
  if (!changed) return
  after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles: plugins } }
  writeProfileManifest(profileDir, after)
}

/** 相对路径 spec 锚定到调用目录（pnpm 以 profile 目录为 cwd）。 */
function anchorPathSpec(argument: string, cwd: string): string {
  const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument)
  if (match?.groups?.path === undefined) return argument
  return `${match.groups.prefix ?? ''}${resolve(cwd, match.groups.path)}`
}

function runPnpm(profileDir: string, args: readonly string[], cwd: string): { readonly ok: boolean; readonly error?: string } {
  const result = spawnSync('pnpm', args.map(argument => anchorPathSpec(argument, cwd)), {
    cwd: profileDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, error: 'pnpm 不在 PATH 上' }
    return { ok: false, error: String(result.error) }
  }
  if (result.status !== 0) return { ok: false, error: `pnpm 退出码 ${result.status ?? 1}（profile 目录 ${profileDir}）` }
  return { ok: true }
}

/** 确保 profile 目录已初始化（官方模板规则）；P4 隔离闸：目录必须在目标实例 HOME 内。 */
function ensureProfile(options: ProfileExecOptions): string {
  const dir = resolveProfileDir(options.profile, options.home)
  assertInsideHome(options.home ?? resolveDshHome(process.env), dir)
  if (!existsSync(join(dir, 'package.json'))) {
    initProfile(dir, PROFILE_TEMPLATES[options.profile] ?? DEFAULT_PROFILE_BUNDLES)
  }
  return dir
}

/** profile 安装：profile 目录 pnpm add + bundle 对账。 */
export function profileInstall(spec: string, options: ProfileExecOptions): ProfileExecResult {
  const dir = ensureProfile(options)
  const before = readProfileManifest('mygo', dir)
  const run = runPnpm(dir, ['add', spec], options.cwd ?? process.cwd())
  if (!run.ok) return { ok: false, profile: options.profile, error: run.error }
  reconcilePlugins(before, dir)
  const after = readProfileManifest('mygo', dir)
  return { ok: true, profile: options.profile, bundles: after.dsh?.profile?.bundles ?? [] }
}

/** profile 卸载：profile 目录 pnpm remove + bundle 对账。 */
export function profileUninstall(name: string, options: ProfileExecOptions): ProfileExecResult {
  const dir = ensureProfile(options)
  const before = readProfileManifest('mygo', dir)
  const run = runPnpm(dir, ['remove', name], options.cwd ?? process.cwd())
  if (!run.ok) return { ok: false, profile: options.profile, error: run.error }
  reconcilePlugins(before, dir)
  const after = readProfileManifest('mygo', dir)
  return { ok: true, profile: options.profile, bundles: after.dsh?.profile?.bundles ?? [] }
}

const DISABLE_BLOCK_BEGIN = '# --- mygo managed disable'
const DISABLE_BLOCK_END = '# --- end mygo managed disable ---'

/** 读 profile 用户 patch 层文本（缺省为空文档）。 */
function readPatchText(dir: string): string {
  const path = join(dir, 'cordis.patch.yml')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/**
 * profile 启停：写 profile cordis.patch.yml 的 id 定向 disabled patch 块
 * （标记块包裹，enable = 移除块，disable = 追加块，幂等）。
 */
export function profileSetEnabled(id: string, enabled: boolean, options: ProfileExecOptions): ProfileExecResult {
  const dir = ensureProfile(options)
  const path = join(dir, 'cordis.patch.yml')
  const text = readPatchText(dir)
  const begin = `${DISABLE_BLOCK_BEGIN} (id:${id}) ---`
  const pattern = new RegExp(`\\n?${escapeRegExp(begin)}\\n(?:.*\\n)*?${escapeRegExp(DISABLE_BLOCK_END)}\\n?`)
  const stripped = text.replace(pattern, '\n').replace(/\n{3,}/g, '\n\n')
  if (enabled) {
    const next = stripped === text ? text : stripped
    if (next !== text) writeFileSync(path, next === '' ? '' : next, 'utf8')
    return { ok: true, profile: options.profile }
  }
  if (stripped !== text) return { ok: true, profile: options.profile } // 已有禁用块，幂等
  const block = `${begin}\n- id: ${id}\n  disabled: true\n${DISABLE_BLOCK_END}\n`
  const head = text.trimEnd()
  writeFileSync(path, (head === '' ? '' : `${head}\n\n`) + block, 'utf8')
  return { ok: true, profile: options.profile }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
