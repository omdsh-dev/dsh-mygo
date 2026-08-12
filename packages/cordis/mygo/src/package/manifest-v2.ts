/**
 * Plugin manifest v3（design-r3 §2 字段全集）：
 * formatVersion / id / version / entry / depends / breaks / requires /
 * core / recommends / bundles / loader / patches / grants / provides /
 * symbolAliases / environment / entrypoints / shared。
 * 纯函数、零运行时依赖；兼容 v1 的 `compatibility.requires|breaks` 别名
 * （裸键 → depends，`service:` 前缀键 → requires）与既有扩展字段。
 * @module @deepseek-ai/dsh-mygo/src/package/manifest-v2
 */

import { isValidRange } from '../semver-range.ts'

/** A normalized v3 plugin manifest. */
export interface PluginManifestV3 {
  /** manifest schema 版本；当前 1（design-r3 §2.7）。 */
  readonly formatVersion: number
  readonly id: string
  readonly version: string
  readonly entry: string
  readonly depends: Readonly<Record<string, string>>
  readonly breaks: Readonly<Record<string, string>>
  /** 服务级依赖（裸服务名；规范内禁止 `service:` 前缀）。仅运行期政策闸。 */
  readonly requires: Readonly<Record<string, string | readonly string[]>>
  /** dsh core compatibility range; missing legacy manifests normalize to `*`. */
  readonly core: string
  /** 可选推荐依赖：只校验不选择、只警告不阻断、永不自动安装（design-r3 §2.6）。 */
  readonly recommends: Readonly<Record<string, string | readonly string[]>>
  readonly provides: readonly string[]
  readonly entrypoints: Readonly<Record<string, unknown>>
  /** 内嵌包声明（id + version + 包内路径）。 */
  readonly bundles: readonly BundledPackage[]
  /** 挂载语义声明（v2.1）。 */
  readonly loader?: LoaderDeclaration
  /** 显式共享状态标记（用于禁止内联检测）。 */
  readonly shared?: boolean
  /** mixin patch 目标声明（loader=mixin 时使用）。 */
  readonly patches?: readonly PatchDeclaration[]
  /** 政策授权（capability → 授权表达式）；默认拒绝（design-r3 §2.2）。 */
  readonly grants?: Readonly<Record<string, unknown>>
  /** 符号别名/兼容映射：别名 → 规范符号（EB-D19；前置门管辖）。 */
  readonly symbolAliases?: Readonly<Record<string, string>>
  /** 只读环境元数据（如 {platform:"web"}）；不设硬门、不阻断（design-r3 §2.5）。 */
  readonly environment?: Readonly<Record<string, unknown>>
}

/** Backward-compatible alias: the previous v2 shape is now the v3 shape. */
export type PluginManifestV2 = PluginManifestV3

/** One bundled dependency declaration. */
export interface BundledPackage {
  readonly id: string
  readonly version: string
  readonly path: string
}

/** Loader contract declaration. */
export interface LoaderDeclaration {
  readonly id: string
  readonly range: string
}

/** One mixin patch target declaration (symbol-path anchor). */
export interface PatchDeclaration {
  readonly id: string
  readonly target: {
    readonly module: string
    readonly filePath?: string
    readonly symbol: string
    readonly operation: 'before' | 'after' | 'around' | 'replace'
  }
  /** 补丁文件（相对路径；禁逃逸，B10 安装期校验复用本路径规则）。 */
  readonly file?: string
}

/** One manifest validation problem (path + message). */
export interface ManifestProblem {
  readonly path: string
  readonly message: string
}

const ID_RE = /^[a-z][a-z0-9-]*$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SERVICE_PREFIX = 'service:'

/** Absolute-path / drive-letter / parent-traversal escapes (design-r3 §3.4, C8)。 */
export function isEscapingPath(value: string): boolean {
  return value.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith('../')
    || value.includes('/../')
    || value.split('/').some(segment => segment === '..')
}

/** 安装期/加载期共用路径安全校验（B10；entry/bundles.path/patches.file）。 */
export function pathProblemsOf(manifest: PluginManifestV3): readonly ManifestProblem[] {
  const problems: ManifestProblem[] = []
  if (isEscapingPath(manifest.entry)) {
    problems.push({ path: 'dsh.mygo.entry', message: `entry 不得逃出包目录（${manifest.entry}）` })
  }
  for (const bundle of manifest.bundles) {
    if (isEscapingPath(bundle.path)) {
      problems.push({ path: `dsh.mygo.bundles.${bundle.id}.path`, message: `path 不得逃出包目录（${bundle.path}）` })
    }
  }
  for (const patch of manifest.patches ?? []) {
    if (patch.file !== undefined && isEscapingPath(patch.file)) {
      problems.push({ path: `dsh.mygo.patches.${patch.id}.file`, message: `file 不得逃出包目录（${patch.file}）` })
    }
  }
  return problems
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readRangeMap(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string' || raw.trim() === '') return undefined
    out[key] = raw
  }
  return out
}

/** Read a record whose values are npm semver ranges (strings; arrays OR 保留后续）。 */
function readRangeMapOrArray(value: unknown): Readonly<Record<string, string | readonly string[]>> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string | readonly string[]> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string' && raw.trim() !== '') {
      out[key] = raw
    } else if (Array.isArray(raw) && raw.length > 0 && raw.every(item => typeof item === 'string' && item.trim() !== '')) {
      out[key] = raw as readonly string[]
    } else {
      return undefined
    }
  }
  return out
}

/** Read a record whose values are arbitrary grant expressions. */
function readUnknownMap(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined
  return value
}

function readBundles(value: unknown): readonly BundledPackage[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: BundledPackage[] = []
  for (const raw of value) {
    if (!isRecord(raw)) return undefined
    const id = readString(raw.id)
    const version = readString(raw.version)
    const path = readString(raw.path)
    if (id === undefined || version === undefined || path === undefined) return undefined
    out.push({ id, version, path })
  }
  return out
}

function readLoader(value: unknown): LoaderDeclaration | undefined {
  if (!isRecord(value)) return undefined
  const id = readString(value.id)
  const range = readString(value.range)
  return id === undefined || range === undefined ? undefined : { id, range }
}

function readPatches(value: unknown): readonly PatchDeclaration[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: PatchDeclaration[] = []
  for (const raw of value) {
    if (!isRecord(raw) || !isRecord(raw.target)) return undefined
    const id = readString(raw.id)
    const module = readString(raw.target.module)
    const symbol = readString(raw.target.symbol)
    const operation = raw.target.operation
    const filePath = readString(raw.target.filePath)
    if (id === undefined || module === undefined || symbol === undefined
      || (operation !== 'before' && operation !== 'after' && operation !== 'around' && operation !== 'replace')) {
      return undefined
    }
    out.push({
      id,
      target: {
        module,
        ...(filePath === undefined ? {} : { filePath }),
        symbol,
        operation,
      },
      ...(typeof raw.file === 'string' && raw.file.length > 0 ? { file: raw.file } : {}),
    })
  }
  return out
}

/**
 * Parse and validate one package.json into a v2 manifest.
 * @param pkg - parsed package.json (name/version/main/dsh.mygo).
 * @returns manifest plus problems/warnings; `value` is present only when the
 * manifest passes the MUST fields and interval syntax.
 */
export function parsePackageManifest(
  pkg: unknown,
): { readonly value?: PluginManifestV3; readonly problems: readonly ManifestProblem[]; readonly warnings: readonly string[] } {
  const problems: ManifestProblem[] = []
  const warnings: string[] = []
  if (!isRecord(pkg)) return { problems: [{ path: 'package', message: 'package.json 不是对象' }], warnings }

  const name = readString(pkg.name)
  const pkgVersion = readString(pkg.version)
  const dshBlock = isRecord(pkg.dsh) && isRecord(pkg.dsh.mygo) ? pkg.dsh.mygo : undefined
  const compat = isRecord(dshBlock?.compatibility) ? dshBlock.compatibility : undefined

  // formatVersion：显式声明只接受当前值 1；legacy manifest（未声明）默认 1 并告警。
  const formatVersionRaw = dshBlock?.formatVersion
  let formatVersion = 1
  if (formatVersionRaw === undefined) {
    warnings.push('未声明 formatVersion（当前 schema 版本 1），按 1 解析')
  } else if (typeof formatVersionRaw !== 'number' || !Number.isInteger(formatVersionRaw) || formatVersionRaw !== 1) {
    problems.push({
      path: 'dsh.mygo.formatVersion',
      message: `不支持的 formatVersion（得到 ${String(formatVersionRaw)}；当前仅支持 1）`,
    })
  } else {
    formatVersion = formatVersionRaw
  }

  const id = readString(dshBlock?.id) ?? (name === undefined ? undefined : name.replace(/^@[^/]+\//, ''))
  if (id === undefined || !ID_RE.test(id)) {
    problems.push({ path: 'dsh.mygo.id', message: `id 必须匹配 /^[a-z][a-z0-9-]*$/（得到 ${String(id)}）` })
  }

  const version = readString(dshBlock?.version) ?? pkgVersion
  if (version === undefined || !SEMVER_RE.test(version)) {
    problems.push({ path: 'dsh.mygo.version', message: `version 必须是 semver（允许预发布段）（得到 ${String(version)}）` })
  }

  const entry = readString(dshBlock?.entry) ?? readString(pkg.main)
  if (entry === undefined) {
    problems.push({ path: 'dsh.mygo.entry', message: 'entry 缺失（package.json main 也未提供）' })
  } else if (isEscapingPath(entry)) {
    problems.push({ path: 'dsh.mygo.entry', message: `entry 不得逃出包目录（${entry}）` })
  }

  // 兼容层（design-r3 §2.3）：compatibility.requires 中裸键 → depends，
  // `service:` 前缀键 → requires（去前缀）；新旧同时声明同名键 → manifest-invalid。
  const compatRequires = readRangeMap(compat?.requires)
  const compatDepends = readRangeMap(compat?.depends)
  const compatBreaks = readRangeMap(compat?.breaks)
  const legacyDependsFromRequires: Record<string, string> = {}
  const legacyRequires: Record<string, string> = {}
  for (const [key, range] of Object.entries(compatRequires ?? {})) {
    if (key.startsWith(SERVICE_PREFIX)) {
      legacyRequires[key.slice(SERVICE_PREFIX.length)] = range
    } else {
      legacyDependsFromRequires[key] = range
    }
  }

  // depends：顶层 dsh.mygo.depends 优先，其次 compatibility.depends + 裸键 requires。
  let depends = readRangeMap(dshBlock?.depends)
  if (depends === undefined) {
    depends = {}
    if (compatDepends !== undefined) Object.assign(depends, compatDepends)
    Object.assign(depends, legacyDependsFromRequires)
  } else if (compatDepends !== undefined) {
    problems.push({ path: 'dsh.mygo.depends', message: 'depends 与 compatibility.depends 同时声明，禁止二义' })
  } else {
    for (const key of Object.keys(legacyDependsFromRequires)) {
      if (depends[key] !== undefined) {
        problems.push({ path: `dsh.mygo.depends.${key}`, message: 'depends 与 compatibility.requires 同时声明同名键，禁止二义' })
      }
    }
  }
  for (const [target, range] of Object.entries(depends)) {
    if (!isValidRange(range)) {
      problems.push({ path: `dsh.mygo.depends.${target}`, message: `不是有效 semver 区间（禁止裸写包名）：${range}` })
    }
  }

  // requires（服务级）：顶层 dsh.mygo.requires 优先，其次 compatibility.requires 的 service: 键。
  const requiresRaw = readRangeMapOrArray(dshBlock?.requires)
  const requires: Record<string, string | readonly string[]> = {}
  if (requiresRaw === undefined && dshBlock?.requires !== undefined) {
    problems.push({ path: 'dsh.mygo.requires', message: 'requires 必须是 服务名 → semver 区间 的映射（值可为区间数组 OR）' })
  } else {
    if (requiresRaw !== undefined) Object.assign(requires, requiresRaw)
    for (const [key, range] of Object.entries(legacyRequires)) {
      if (requires[key] !== undefined) {
        problems.push({ path: `dsh.mygo.requires.${key}`, message: 'requires 与 compatibility.requires 同时声明同名服务，禁止二义' })
      } else {
        requires[key] = range
      }
    }
  }
  for (const [service, rawRange] of Object.entries(requires)) {
    if (service.startsWith(SERVICE_PREFIX)) {
      problems.push({ path: `dsh.mygo.requires.${service}`, message: 'requires 键禁止 `service:` 前缀（design-r3 §2.1 规范内禁止）' })
    }
    const ranges = Array.isArray(rawRange) ? rawRange : [rawRange]
    for (const range of ranges) {
      if (!isValidRange(range)) {
        problems.push({ path: `dsh.mygo.requires.${service}`, message: `不是有效 semver 区间：${range}` })
      }
    }
  }

  let breaks = readRangeMap(dshBlock?.breaks)
  if (breaks === undefined) breaks = compatBreaks ?? {}
  else if (compatBreaks !== undefined) {
    problems.push({ path: 'dsh.mygo.breaks', message: 'breaks 与 compatibility.breaks 同时声明，禁止二义' })
  }
  for (const [target, range] of Object.entries(breaks)) {
    if (!isValidRange(range)) {
      problems.push({ path: `dsh.mygo.breaks.${target}`, message: `不是有效 semver 区间：${range}` })
    }
  }

  const rawCore = readString(dshBlock?.core)
  if (rawCore !== undefined && !isValidRange(rawCore)) {
    problems.push({ path: 'dsh.mygo.core', message: `core 不是有效 semver 区间：${rawCore}` })
  }
  if (rawCore === undefined) {
    warnings.push('未声明 core（dsh 核心版本区间），按 "*" 放行')
  }

  // recommends：只校验不选择、只警告不阻断、永不自动安装（design-r3 §2.6）。
  const recommendsRaw = readRangeMapOrArray(dshBlock?.recommends)
  const recommends: Record<string, string | readonly string[]> = {}
  if (recommendsRaw === undefined && dshBlock?.recommends !== undefined) {
    problems.push({ path: 'dsh.mygo.recommends', message: 'recommends 必须是 插件 id → semver 区间 的映射' })
  } else if (recommendsRaw !== undefined) {
    Object.assign(recommends, recommendsRaw)
  }
  for (const [target, rawRange] of Object.entries(recommends)) {
    const ranges = Array.isArray(rawRange) ? rawRange : [rawRange]
    for (const range of ranges) {
      if (!isValidRange(range)) {
        problems.push({ path: `dsh.mygo.recommends.${target}`, message: `不是有效 semver 区间：${range}` })
      }
    }
    warnings.push(`recommends ${target} 仅作安装期告警，不做候选选择、不自动安装`)
  }

  // symbolAliases：别名 → 规范符号（EB-D19）；目标符号存在性由前置门校验。
  const symbolAliasesRaw = readRangeMap(dshBlock?.symbolAliases)
  if (dshBlock?.symbolAliases !== undefined && symbolAliasesRaw === undefined) {
    problems.push({ path: 'dsh.mygo.symbolAliases', message: 'symbolAliases 必须是 别名 → 规范符号 的字符串映射' })
  }

  // grants：capability → 授权表达式；默认拒绝（design-r3 §2.2）。
  const grants = readUnknownMap(dshBlock?.grants)
  if (dshBlock?.grants !== undefined && grants === undefined) {
    problems.push({ path: 'dsh.mygo.grants', message: 'grants 必须是 能力名 → 授权表达式 的映射' })
  } else if (grants !== undefined) {
    for (const capability of Object.keys(grants)) {
      if (capability.trim() === '') {
        problems.push({ path: 'dsh.mygo.grants', message: '能力名不能为空' })
      }
    }
  }

  // environment：只读元数据对象；不设硬门、不阻断（design-r3 §2.5）。
  const environment = readUnknownMap(dshBlock?.environment)
  if (dshBlock?.environment !== undefined && environment === undefined) {
    problems.push({ path: 'dsh.mygo.environment', message: 'environment 必须是只读元数据对象（如 {platform:"web"}）' })
  }

  const providesRaw = dshBlock?.provides
  const provides = Array.isArray(providesRaw)
    ? providesRaw.filter((item): item is string => typeof item === 'string')
    : []
  const entrypoints = isRecord(dshBlock?.entrypoints) ? dshBlock.entrypoints : {}
  const bundles = readBundles(dshBlock?.bundles)
  if (bundles === undefined && dshBlock?.bundles !== undefined) {
    problems.push({ path: 'dsh.mygo.bundles', message: 'bundles 必须是 {id,version,path} 数组' })
  }
  for (const bundle of bundles ?? []) {
    if (!ID_RE.test(bundle.id)) {
      problems.push({ path: `dsh.mygo.bundles.${bundle.id}.id`, message: `id 非法：${bundle.id}` })
    }
    if (!SEMVER_RE.test(bundle.version)) {
      problems.push({ path: `dsh.mygo.bundles.${bundle.id}.version`, message: `version 非法：${bundle.version}` })
    }
    if (isEscapingPath(bundle.path)) {
      problems.push({ path: `dsh.mygo.bundles.${bundle.id}.path`, message: `path 不得逃出包目录：${bundle.path}` })
    }
  }
  const loader = readLoader(dshBlock?.loader)
  if (dshBlock?.loader !== undefined && loader === undefined) {
    problems.push({ path: 'dsh.mygo.loader', message: 'loader 必须是 {id, range}' })
  } else if (loader !== undefined) {
    if (!isValidRange(loader.range)) {
      problems.push({ path: 'dsh.mygo.loader.range', message: `range 非法：${loader.range}` })
    }
    if (loader.id !== 'standard' && loader.id !== 'mixin') {
      problems.push({ path: 'dsh.mygo.loader.id', message: `未知 loader：${loader.id}（v1 支持 standard/mixin）` })
    }
  }
  const patches = readPatches(dshBlock?.patches)
  if (dshBlock?.patches !== undefined && patches === undefined) {
    problems.push({ path: 'dsh.mygo.patches', message: 'patches 必须是 {id, target:{module,filePath?,symbol,operation}} 数组' })
  } else {
    for (const patch of patches ?? []) {
      if (patch.file !== undefined && isEscapingPath(patch.file)) {
        problems.push({ path: `dsh.mygo.patches.${patch.id}.file`, message: `file 不得逃出包目录：${patch.file}` })
      }
    }
  }
  const shared = dshBlock?.shared === true

  if (problems.length > 0) return { problems, warnings }
  return {
    value: {
      formatVersion,
      id: id as string,
      version: version as string,
      entry: entry as string,
      depends,
      breaks,
      requires: requires as Readonly<Record<string, string | readonly string[]>>,
      core: rawCore ?? '*',
      recommends: recommends as Readonly<Record<string, string | readonly string[]>>,
      provides,
      entrypoints,
      bundles: bundles ?? [],
      ...(loader === undefined ? {} : { loader }),
      ...(shared ? { shared: true } : {}),
      ...(patches === undefined || patches.length === 0 ? {} : { patches }),
      ...(grants === undefined || Object.keys(grants).length === 0 ? {} : { grants }),
      ...(symbolAliasesRaw === undefined || Object.keys(symbolAliasesRaw).length === 0 ? {} : { symbolAliases: symbolAliasesRaw }),
      ...(environment === undefined || Object.keys(environment).length === 0 ? {} : { environment }),
    },
    problems,
    warnings,
  }
}

/** Extract the constraints of a v2 manifest. */
export function constraintsOf(manifest: PluginManifestV2): {
  readonly depends: Readonly<Record<string, string>>
  readonly breaks: Readonly<Record<string, string>>
  readonly core: string
  readonly entry: string
} {
  return { depends: manifest.depends, breaks: manifest.breaks, core: manifest.core, entry: manifest.entry }
}
