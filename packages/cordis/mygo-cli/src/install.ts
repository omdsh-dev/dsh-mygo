/**
 * 安装执行面（P3 原生形态）：`mygo install/uninstall` = 目标 profile 目录跑
 * pnpm + 按 `dsh.bundle` 声明对账 `dsh.profile.bundles`（对齐官方
 * `dsh plugin` 的 reconcile 语义，直接复用 @deepseek-ai/dsh-app-boot 的
 * profile API）；`mygo enable/disable` = profile cordis.patch.yml 的 id 定向
 * `disabled` patch 块写入/移除。
 * @module @r05en1cu/dsh-mygo-cli/install
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
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
import {
  MYGO_MANAGER_VERSION,
  assertInsideHome,
  buildPluginPack,
  cachePack,
  compareVersions,
  importCachedPack,
  installPluginPack,
  listInstances,
  parseVersion,
  registerInstance,
  resolveDshHome,
  resolveMygoPaths,
} from '@r05en1cu/dsh-mygo'
import type { InstanceRecord } from '@r05en1cu/dsh-mygo'

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

/** `mygo install <spec>`：profile 目录 pnpm add + bundle 对账。 */
export function profileInstall(spec: string, options: ProfileExecOptions): ProfileExecResult {
  const dir = ensureProfile(options)
  const before = readProfileManifest('mygo', dir)
  const run = runPnpm(dir, ['add', spec], options.cwd ?? process.cwd())
  if (!run.ok) return { ok: false, profile: options.profile, error: run.error }
  reconcilePlugins(before, dir)
  const after = readProfileManifest('mygo', dir)
  return { ok: true, profile: options.profile, bundles: after.dsh?.profile?.bundles ?? [] }
}

/** `mygo uninstall <name>`：profile 目录 pnpm remove + bundle 对账。 */
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
 * `mygo enable/disable <id>`：写 profile cordis.patch.yml 的 id 定向 disabled
 * patch 块（标记块包裹，enable = 移除块，disable = 追加块，幂等）。
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

// ---------------------------------------------------------------------------
// P4 多实例接管：adopt（登记 + 首次对账）与 clone（跨实例插件搬运）
// ---------------------------------------------------------------------------

/** adopt 对账结果（只读扫描 + 用户级登记；不写对端插件状态）。 */
export interface AdoptInstanceResult {
  readonly ok: boolean
  readonly home: string
  /** 登记后的实例记录（用户级登记处）。 */
  readonly record?: InstanceRecord
  /** 首次对账发现的 profile 名列表。 */
  readonly profiles?: readonly string[]
  /** 对端 mygo 自身安装版本（$HOME/mygo-self.json 事实）。 */
  readonly mygoVersion?: string
  readonly error?: string | undefined
}

/** 从对端 HOME 的 profile 安装里探测 dsh 版本（首个可解析的为准）。 */
function detectDshVersion(home: string, profiles: readonly string[]): string | undefined {
  for (const profile of profiles) {
    try {
      const pkg = JSON.parse(readFileSync(
        join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
        'utf8',
      )) as { readonly version?: unknown }
      if (typeof pkg.version === 'string' && pkg.version !== '') return pkg.version
    } catch {
      // 该 profile 未安装 dsh 运行时，继续找
    }
  }
  return undefined
}

/**
 * `mygo adopt --home <path>`：把另一个实例（$DSH_HOME）登记进用户级
 * 登记处并做首次对账（只读扫描 profiles / mygo-self.json / dsh 版本）。
 * 唯一的写入面是用户级登记处本身——不写对端插件状态。
 */
export function adoptInstance(home: string, options: { readonly root?: string } = {}): AdoptInstanceResult {
  const resolved = resolve(home)
  if (!existsSync(resolved)) {
    return { ok: false, home: resolved, error: `目标实例 HOME 不存在：${resolved}` }
  }
  let profiles: readonly string[] = []
  try {
    profiles = readdirSync(join(resolved, 'profiles'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch {
    // 无 profiles 目录：空实例
  }
  let mygoVersion: string | undefined
  try {
    const self = JSON.parse(readFileSync(join(resolved, 'mygo-self.json'), 'utf8')) as { readonly version?: unknown }
    if (typeof self.version === 'string' && self.version !== '') mygoVersion = self.version
  } catch {
    // mygo-self.json 缺失/损坏：版本事实缺省
  }
  const dshVersion = detectDshVersion(resolved, profiles)
  const record = registerInstance(
    { home: resolved, ...(dshVersion === undefined ? {} : { dshVersion }) },
    options.root === undefined ? {} : { root: options.root },
  )
  return {
    ok: true,
    home: resolved,
    record,
    profiles,
    ...(mygoVersion === undefined ? {} : { mygoVersion }),
  }
}

/** clone 结果。 */
export interface ClonePluginResult {
  readonly ok: boolean
  readonly id: string
  readonly version?: string
  /** 共享缓存内容寻址键（整 pack sha512）。 */
  readonly sha512?: string
  /** 共享缓存是否命中（true = 第二次导入零写盘）。 */
  readonly cacheHit?: boolean
  /** 缓存导入方式（hardlink 优先，copy 兜底）。 */
  readonly via?: 'hardlink' | 'copy'
  readonly error?: string | undefined
}

/**
 * `mygo clone --from <homeA> --to <homeB> <plugin>`：A 侧把指定插件确定性
 * 重打包为 mygo-pack → 发布进用户级共享缓存（内容寻址，第二次命中零写盘）
 * → 导入 B 侧 tmp（hardlink 优先 copy 兜底）→ 经 installPluginPack 还原
 * 安装进 B 的 `$DSH_HOME/mygo/packages/`。两侧 HOME 都必须已登记
 * （adopt 或服务启动登记）；from 与 to 不得相同；所有 B 侧落盘过
 * assertInsideHome 闸（跨 HOME 写被拒绝）。
 */
export async function clonePlugin(
  from: string,
  to: string,
  id: string,
  options: { readonly root?: string } = {},
): Promise<ClonePluginResult> {
  const fromHome = resolve(from)
  const toHome = resolve(to)
  if (fromHome === toHome) {
    return { ok: false, id, error: 'from 与 to 是同一实例 HOME，clone 无意义（已拒绝）' }
  }
  const registry = listInstances(options.root === undefined ? {} : { root: options.root })
  if (!registry.some(record => record.home === fromHome)) {
    return { ok: false, id, error: `源实例未登记（先 mygo adopt --home ${fromHome}）` }
  }
  if (!registry.some(record => record.home === toHome)) {
    return { ok: false, id, error: `目标实例未登记（先 mygo adopt --home ${toHome}）` }
  }
  const fromPaths = resolveMygoPaths('clone', { DSH_HOME: fromHome })
  const toPaths = resolveMygoPaths('clone', { DSH_HOME: toHome })
  // 隔离闸：B 侧一切落盘必须落在 B 的 HOME 内。
  assertInsideHome(toHome, toPaths.packagesRoot)
  assertInsideHome(toHome, toPaths.tmpDir)
  const idDir = join(fromPaths.packagesRoot, id)
  let versions: string[]
  try {
    versions = readdirSync(idDir).sort((left, right) => {
      const parsedLeft = parseVersion(left)
      const parsedRight = parseVersion(right)
      if (parsedLeft === undefined || parsedRight === undefined) {
        return left < right ? -1 : left > right ? 1 : 0
      }
      return compareVersions(parsedLeft, parsedRight)
    })
  } catch {
    return { ok: false, id, error: `源实例没有已还原的插件 ${id}（${idDir} 不存在）` }
  }
  const version = versions[versions.length - 1]
  if (version === undefined) {
    return { ok: false, id, error: `源实例没有已还原的插件 ${id}（无版本目录）` }
  }
  if (readRestoredPackageSync(idDir, id, version) === undefined) {
    return { ok: false, id, error: `源实例的 ${id}@${version} 缺少有效事实文件（.mygo-package.json）` }
  }
  await mkdir(fromPaths.tmpDir, { recursive: true })
  await mkdir(toPaths.tmpDir, { recursive: true })
  const stagingPack = join(fromPaths.tmpDir, `clone-${id}-${randomUUID()}.mygo-pack`)
  try {
    const built = await buildPluginPack(
      { installRoot: fromPaths.packagesRoot, tmpDir: fromPaths.tmpDir, profile: 'clone', managerVersion: MYGO_MANAGER_VERSION },
      { output: stagingPack, plugins: [id], includeCommunityDeps: false },
    )
    if (!built.ok) {
      return { ok: false, id, error: `A 侧导出失败：${built.report.summary}` }
    }
    const cached = await cachePack(stagingPack, options.root === undefined ? {} : { root: options.root })
    const imported = await importCachedPack(cached.sha512, toPaths.tmpDir, options.root === undefined ? {} : { root: options.root })
    const installed = await installPluginPack(
      { installRoot: toPaths.packagesRoot, tmpDir: toPaths.tmpDir, profile: 'clone', managerVersion: MYGO_MANAGER_VERSION },
      imported.path,
    )
    if (!installed.ok) {
      return { ok: false, id, error: `B 侧还原失败：${installed.report.summary}` }
    }
    return {
      ok: true,
      id,
      version,
      sha512: cached.sha512,
      cacheHit: cached.cached,
      via: imported.via,
    }
  } finally {
    await rm(stagingPack, { force: true })
  }
}

/** 同步版事实文件读取（clone 预检用；异步版 readRestoredPackage 的轻量镜像）。 */
function readRestoredPackageSync(idDir: string, id: string, version: string): boolean {
  try {
    const fact = JSON.parse(readFileSync(join(idDir, version, '.mygo-package.json'), 'utf8')) as {
      readonly format?: unknown
      readonly id?: unknown
      readonly version?: unknown
    }
    return fact.format === 'dsh.mygo-package/v1' && fact.id === id && fact.version === version
  } catch {
    return false
  }
}
