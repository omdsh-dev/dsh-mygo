/**
 * Plugin manifest v2（《收敛任务》manifest 五字段）：
 * id / version / entry / depends / breaks / core。
 * 纯函数、零运行时依赖；兼容 v1 的 `compatibility.requires|breaks` 别名与
 * `dsh.mygo.entrypoints|provides` 扩展。
 * @module @deepseek-ai/dsh-mygo/src/package/manifest-v2
 */

import { isValidRange } from '../semver-range.ts'

/** A normalized v2 plugin manifest. */
export interface PluginManifestV2 {
  readonly id: string
  readonly version: string
  readonly entry: string
  readonly depends: Readonly<Record<string, string>>
  readonly breaks: Readonly<Record<string, string>>
  /** dsh core compatibility range; missing legacy manifests normalize to `*`. */
  readonly core: string
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
}

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
}

/** One manifest validation problem (path + message). */
export interface ManifestProblem {
  readonly path: string
  readonly message: string
}

const ID_RE = /^[a-z][a-z0-9-]*$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

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
): { readonly value?: PluginManifestV2; readonly problems: readonly ManifestProblem[]; readonly warnings: readonly string[] } {
  const problems: ManifestProblem[] = []
  const warnings: string[] = []
  if (!isRecord(pkg)) return { problems: [{ path: 'package', message: 'package.json 不是对象' }], warnings }

  const name = readString(pkg.name)
  const pkgVersion = readString(pkg.version)
  const dshBlock = isRecord(pkg.dsh) && isRecord(pkg.dsh.mygo) ? pkg.dsh.mygo : undefined
  const compat = isRecord(dshBlock?.compatibility) ? dshBlock.compatibility : undefined

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
  } else if (entry.startsWith('../') || entry.includes('/../')) {
    problems.push({ path: 'dsh.mygo.entry', message: `entry 不得逃出包目录（${entry}）` })
  }

  // depends：顶层 dsh.mygo.depends 优先，其次 compatibility.depends/requires。
  let depends = readRangeMap(dshBlock?.depends)
  const compatDepends = readRangeMap(compat?.depends)
  const compatRequires = readRangeMap(compat?.requires)
  if (depends === undefined) {
    depends = {}
    if (compatDepends !== undefined) Object.assign(depends, compatDepends)
    if (compatRequires !== undefined) Object.assign(depends, compatRequires)
  } else if (compatDepends !== undefined || compatRequires !== undefined) {
    problems.push({ path: 'dsh.mygo.depends', message: 'depends 与 compatibility.depends/requires 同时声明，禁止二义' })
  }
  for (const [target, range] of Object.entries(depends)) {
    if (!isValidRange(range)) {
      problems.push({ path: `dsh.mygo.depends.${target}`, message: `不是有效 semver 区间（禁止裸写包名）：${range}` })
    }
  }

  let breaks = readRangeMap(dshBlock?.breaks)
  const compatBreaks = readRangeMap(compat?.breaks)
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
    if (bundle.path.startsWith('../') || bundle.path.includes('/../')) {
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
  }
  const shared = dshBlock?.shared === true

  if (problems.length > 0) return { problems, warnings }
  return {
    value: {
      id: id as string,
      version: version as string,
      entry: entry as string,
      depends,
      breaks,
      core: rawCore ?? '*',
      provides,
      entrypoints,
      bundles: bundles ?? [],
      ...(loader === undefined ? {} : { loader }),
      ...(shared ? { shared: true } : {}),
      ...(patches === undefined || patches.length === 0 ? {} : { patches }),
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
