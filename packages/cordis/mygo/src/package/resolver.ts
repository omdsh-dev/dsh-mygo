/**
 * 确定性版本求解器（《收敛任务》resolve 规则）：在满足全部 depends、不在
 * 任何 breaks 区间、core 满足的候选中取版本最高者；同输入必同输出。
 * 失败时一次性收集全部冲突（断点/链/候选拒绝原因/建议动作），环依赖整体拒绝。
 * @module @deepseek-ai/dsh-mygo/src/package/resolver
 */

import { compareVersions, matchesVersionRange, parseVersion } from '../semver-range.ts'
import { sortConstraints, suggestActions, type ConflictEntry, type ResolutionReport } from './report.ts'

/** Per-version manifest constraints. */
export interface VersionConstraints {
  readonly depends: Readonly<Record<string, string>>
  readonly breaks: Readonly<Record<string, string>>
  readonly core: string
  readonly entry?: string
}

/** One candidate version of one plugin. */
export interface PluginCandidate {
  readonly version: string
  readonly constraints?: VersionConstraints
  /** 来源标签：pinned / registry / locked / bundle（全序 tie-break 用）。 */
  readonly source?: string
  /** 本版本对外提供的 id 列表（桥接/分叉，provides 别名解析）。 */
  readonly provides?: readonly string[]
  /** profile 钉定的唯一候选。 */
  readonly pinned?: boolean
  /** 嵌套深度（bundle 层；越浅越优先，R2 §2 / C3）。 */
  readonly depth?: number
  /** 父插件 id（bundle 展开来源；parent 优先级）。 */
  readonly parent?: string
  /** manifest sha256 字典序 tie-break（闭合全序，design-r3 §3.1-6）。 */
  readonly manifestSha256?: string
}

/** Resolver input: requests, candidate sets, installed facts, core version. */
export interface ResolverInput {
  /** Requested changes: id -> optional version-range filter. */
  readonly requests: ReadonlyMap<string, { readonly range?: string }>
  /** Candidate versions per id (registry + store), unsorted. */
  readonly candidates: ReadonlyMap<string, readonly PluginCandidate[]>
  /** Currently installed versions (keep pinned unless requested). */
  readonly installed: ReadonlyMap<string, PluginCandidate>
  /** dsh core version under resolution. */
  readonly coreVersion: string | undefined
  /** profile 钉定：包名 → 精确版本（根节点硬约束，唯一候选）。 */
  readonly pins?: ReadonlyMap<string, { readonly version: string; readonly source?: string }>
  /** P1-global 回滚报告世代目标（EB-D4：回到哪一代；B7）。 */
  readonly generation?: { readonly from: string; readonly to: string }
}

/** One resolved plugin. */
export interface ResolvedPlugin {
  readonly id: string
  readonly version: string
  readonly constraints?: VersionConstraints
  readonly source?: string
}

export type ResolveOutcome =
  | { readonly ok: true; readonly resolved: readonly ResolvedPlugin[]; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly report: ResolutionReport }

function compareVersionsDesc(left: string, right: string): number {
  const l = parseVersion(left)
  const r = parseVersion(right)
  if (l === undefined || r === undefined) return left < right ? 1 : left > right ? -1 : 0
  const base = compareVersions(r, l)
  return base !== 0 ? base : left < right ? -1 : left > right ? 1 : 0
}

function sourceOf(candidate: PluginCandidate): string {
  return candidate.pinned === true ? 'pinned' : candidate.source ?? ''
}

/** 来源优先级：pinned > registry > locked > bundle（R2 §2.2；其余按字典序兜底）。 */
function sourceRank(candidate: PluginCandidate): number {
  const source = sourceOf(candidate)
  if (source === 'pinned') return 0
  if (source === 'registry' || source === '') return 1
  if (source === 'locked') return 2
  if (source === 'bundle') return 3
  return 4
}

/**
 * 确定性候选全序（design-r3 §3.1）：
 * root 优先 → id 升序 → 版本降序 → 嵌套浅优先 → parent 升序 → 来源序
 * （pinned > registry > locked > bundle）→ manifest sha256 字典序。
 */
export function sortCandidates(
  candidates: readonly PluginCandidate[],
): readonly PluginCandidate[] {
  return [...candidates].sort((a, b) => {
    const byVersion = compareVersionsDesc(a.version, b.version)
    if (byVersion !== 0) return byVersion
    const byId = a.version < b.version ? -1 : a.version > b.version ? 1 : 0
    if (byId !== 0) return byId
    const depthA = a.depth ?? 0
    const depthB = b.depth ?? 0
    if (depthA !== depthB) return depthA - depthB
    const parentA = a.parent ?? ''
    const parentB = b.parent ?? ''
    if (parentA !== parentB) return parentA < parentB ? -1 : 1
    const bySource = sourceRank(a) - sourceRank(b)
    if (bySource !== 0) return bySource
    const hashA = a.manifestSha256 ?? ''
    const hashB = b.manifestSha256 ?? ''
    return hashA < hashB ? -1 : hashA > hashB ? 1 : 0
  })
}

/** Find one directed cycle in the depends graph; deterministic DFS. */
export function findDependsCycle(
  ids: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): readonly string[] | undefined {
  const sorted = [...ids].sort()
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  for (const root of sorted) {
    if (state.get(root) === 2) continue
    const visit = (id: string): readonly string[] | undefined => {
      const mark = state.get(id) ?? 0
      if (mark === 1) {
        const start = stack.indexOf(id)
        return start >= 0 ? [...stack.slice(start), id] : [id]
      }
      if (mark === 2) return undefined
      state.set(id, 1)
      stack.push(id)
      const targets = [...(edges.get(id) ?? [])].filter(target => ids.includes(target)).sort()
      for (const target of targets) {
        const cycle = visit(target)
        if (cycle !== undefined) return cycle
      }
      stack.pop()
      state.set(id, 2)
      return undefined
    }
    const cycle = visit(root)
    if (cycle !== undefined) return cycle
  }
  return undefined
}

/**
 * Deterministic topological order (Kahn + min-heap by id). Edges mean
 * `from depends on to`, so dependencies are emitted before dependents:
 * internally the graph is reversed (to → from).
 */
export function topologicalOrder(
  ids: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): readonly string[] | undefined {
  const indegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()
  for (const id of ids) indegree.set(id, 0)
  for (const id of ids) adjacency.set(id, [])
  for (const id of ids) {
    for (const target of edges.get(id) ?? []) {
      if (ids.includes(target)) {
        adjacency.get(target)?.push(id)
        indegree.set(id, (indegree.get(id) ?? 0) + 1)
      }
    }
  }
  const heap: string[] = [...ids].filter(id => (indegree.get(id) ?? 0) === 0).sort()
  const out: string[] = []
  while (heap.length > 0) {
    const id = heap.shift() as string
    out.push(id)
    for (const dependent of (adjacency.get(id) ?? []).sort()) {
      const next = (indegree.get(dependent) ?? 1) - 1
      indegree.set(dependent, next)
      if (next === 0) {
        heap.push(dependent)
        heap.sort()
      }
    }
  }
  return out.length === ids.length ? out : undefined
}

/** DFS chain from any request root to the target (deterministic). */
function findChain(
  roots: readonly string[],
  target: string,
  edges: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const stack: string[] = []
  const visited = new Set<string>()
  const walk = (id: string): boolean => {
    stack.push(id)
    if (id === target) return true
    visited.add(id)
    for (const next of [...(edges.get(id) ?? [])].sort()) {
      if (visited.has(next)) continue
      if (walk(next)) return true
    }
    stack.pop()
    return false
  }
  for (const root of [...roots].sort()) {
    stack.length = 0
    if (walk(root)) return [...stack]
  }
  return [target]
}

/** Solve the plugin graph deterministically. */
export function resolve(input: ResolverInput): ResolveOutcome {
  const ids = [...new Set([
    ...input.requests.keys(),
    ...input.candidates.keys(),
    ...input.installed.keys(),
  ])].sort()
  // root 优先：请求根先于纯依赖候选处理（design-r3 §3.1 全序第 1 级）。
  ids.sort((a, b) => {
    const aRoot = input.requests.has(a) ? 1 : 0
    const bRoot = input.requests.has(b) ? 1 : 0
    return aRoot !== bRoot ? bRoot - aRoot : a < b ? -1 : a > b ? 1 : 0
  })

  // Constraint view: prefer the requested/id's best-known constraints.
  const constraintsOf = (id: string, candidate: PluginCandidate): VersionConstraints | undefined => {
    return candidate.constraints ?? input.installed.get(id)?.constraints
  }

  const edges = new Map<string, string[]>()
  for (const id of ids) {
    const targets = new Set<string>()
    const candidates = input.candidates.get(id) ?? [input.installed.get(id)].filter((c): c is PluginCandidate => c !== undefined)
    for (const candidate of candidates) {
      const constraints = constraintsOf(id, candidate)
      if (constraints === undefined) continue
      for (const target of Object.keys(constraints.depends)) targets.add(target)
    }
    edges.set(id, [...targets])
  }

  const cycle = findDependsCycle(ids, edges)
  if (cycle !== undefined) {
    return {
      ok: false,
      report: {
        code: 'dependency-cycle',
        summary: `检测到环依赖：${cycle.join(' → ')}`,
        ...(input.generation === undefined ? {} : { generation: input.generation }),
        cycles: [{ cycle }],
        conflicts: [],
      },
    }
  }

  const order = topologicalOrder(ids, edges)
  if (order === undefined) {
    return {
      ok: false,
      report: {
        code: 'dependency-cycle',
        summary: '依赖图无法拓扑排序（存在环）',
        ...(input.generation === undefined ? {} : { generation: input.generation }),
        cycles: [],
        conflicts: [],
      },
    }
  }

  const rejectionLog = new Map<string, string[]>()
  const assigned = new Map<string, string>()
  const roots = [...input.requests.keys()]
  const candidatesById = new Map<string, readonly PluginCandidate[]>()
  for (const id of ids) {
    let list = [...(input.candidates.get(id) ?? [])]
    const installed = input.installed.get(id)
    if (installed !== undefined) list.push({ ...installed, source: installed.source ?? 'installed' })
    const pin = input.pins?.get(id)
    if (pin !== undefined) {
      const pinned = list.find(candidate => candidate.version === pin.version)
      // 修复批次 4（review#2 A5/A8 口径）：钉定版本不在候选源中时 MUST NOT
      // 编造零约束候选——候选集置空，报告阶段产出 kind:'pin' 冲突与具体原因。
      list = pinned === undefined
        ? []
        : [{
            version: pin.version,
            ...(pinned.constraints === undefined ? {} : { constraints: pinned.constraints }),
            ...(pinned.provides === undefined ? {} : { provides: pinned.provides }),
            source: pin.source ?? 'profile',
            pinned: true,
          }]
    }
    const request = input.requests.get(id)
    if (request?.range !== undefined) {
      list = list.filter(candidate => matchesVersionRange(candidate.version, request.range as string))
    }
    candidatesById.set(id, sortCandidates(list))
  }

  const logRejection = (id: string, version: string, reason: string): void => {
    const key = `${id}@${version}`
    const list = rejectionLog.get(key) ?? []
    if (!list.includes(reason)) {
      list.push(reason)
      rejectionLog.set(key, list)
    }
  }

  // provides 别名索引：别名 → 提供者 id 列表（确定性排序）。
  const providerIndex = new Map<string, string[]>()
  for (const id of ids) {
    for (const candidate of candidatesById.get(id) ?? []) {
      for (const provided of candidate.provides ?? []) {
        const list = providerIndex.get(provided) ?? []
        if (!list.includes(id)) {
          list.push(id)
          providerIndex.set(provided, list)
        }
      }
    }
  }

  const check = (id: string, candidate: PluginCandidate, coreVersion: string | undefined): readonly string[] => {
    const reasons: string[] = []
    const constraints = constraintsOf(id, candidate)
    if (constraints === undefined) {
      reasons.push(`候选 ${candidate.version} 缺少 manifest 约束信息`)
      return reasons
    }
    for (const [target, range] of Object.entries(constraints.depends).sort()) {
      const assignedVersion = assigned.get(target)
      if (assignedVersion === undefined) {
        if (!ids.includes(target)) {
          const providers = providerIndex.get(target) ?? []
          const assignedProvider = providers.find(provider => assigned.has(provider))
          if (assignedProvider !== undefined) {
            const providedVersion = assigned.get(assignedProvider)
            if (providedVersion !== undefined && !matchesVersionRange(providedVersion, range)) {
              reasons.push(`depends ${target}（由 ${assignedProvider}=${providedVersion} 提供）不满足 ${range}`)
            }
            continue
          }
          if (providers.length > 0) continue // 提供者在后续顺序中，finalCheck 会覆盖
          reasons.push(`depends ${target} 缺失（未安装且无候选）`)
        }
        continue
      }
      if (!matchesVersionRange(assignedVersion, range)) {
        const pinned = input.pins?.get(target)
        reasons.push(
          pinned === undefined
            ? `depends ${target}=${assignedVersion} 不满足 ${range}`
            : `depends ${target}=${assignedVersion} 不满足 ${range}（profile 钉定 ${pinned.version}）`,
        )
      }
    }
    for (const [target, range] of Object.entries(constraints.breaks).sort()) {
      const assignedVersion = assigned.get(target)
      if (assignedVersion !== undefined && matchesVersionRange(assignedVersion, range)) {
        reasons.push(`breaks ${target}=${assignedVersion} 命中 ${range}`)
      }
    }
    if (coreVersion !== undefined && constraints.core !== '*' && !matchesVersionRange(coreVersion, constraints.core)) {
      reasons.push(`core ${coreVersion} 不满足 ${constraints.core}`)
    }
    return reasons
  }

  /** Final validation over the complete assignment: all depends/breaks/core. */
  const finalCheck = (): boolean => {
    let clean = true
    for (const id of order) {
      const version = assigned.get(id)
      if (version === undefined) continue
      const candidate = (candidatesById.get(id) ?? []).find(item => item.version === version)
      if (candidate === undefined) continue
      const reasons = check(id, candidate, input.coreVersion)
      if (reasons.length > 0) {
        clean = false
        for (const reason of reasons) logRejection(id, version, reason)
      }
    }
    return clean
  }

  const attempt = (index: number): boolean => {
    if (index >= order.length) return finalCheck()
    const id = order[index] as string
    const candidates = candidatesById.get(id) ?? []
    if (candidates.length === 0) {
      logRejection(id, '(无候选)', '没有任何候选版本')
      return false
    }
    for (const candidate of candidates) {
      const reasons = check(id, candidate, input.coreVersion)
      if (reasons.length > 0) {
        for (const reason of reasons) logRejection(id, candidate.version, reason)
        continue
      }
      assigned.set(id, candidate.version)
      if (attempt(index + 1)) return true
      assigned.delete(id)
    }
    return false
  }

  const ok = attempt(0)
  if (ok) {
    return {
      ok: true,
      resolved: order.map(id => {
        const version = assigned.get(id) as string
        const candidate = (candidatesById.get(id) ?? []).find(item => item.version === version)
        return {
          id,
          version,
          ...(candidate?.constraints === undefined ? {} : { constraints: candidate.constraints }),
          ...(candidate?.source === undefined ? {} : { source: candidate.source }),
        }
      }),
      warnings: [],
    }
  }

  // ---- 全量失败报告 -----------------------------------------------
  const conflicts: ConflictEntry[] = []
  for (const id of order) {
    const candidates = candidatesById.get(id) ?? []
    const pin = input.pins?.get(id)
    const request = input.requests.get(id)
    const allRejections = candidates.map(candidate => ({
      version: candidate.version,
      rejected: [...(rejectionLog.get(`${id}@${candidate.version}`) ?? [])],
    })).filter(entry => entry.rejected.length > 0)
    if (allRejections.length === 0 && candidates.length > 0) continue
    if (pin !== undefined) {
      // 修复批次 4（review#2 A5/A8）：钉定失败 → constraint.kind:'pin'，
      // 原因具体化（不在候选源 / 不满足声明区间 / 约束冲突），不再落
      // kind:'core' 兜底（design-r3 §2.4-2「报告 constraint.kind: pin」）。
      const reasons: string[] = []
      const existedInSources = (input.candidates.get(id) ?? []).some(candidate => candidate.version === pin.version)
        || input.installed.get(id)?.version === pin.version
      if (!existedInSources) reasons.push(`profile 钉定 ${pin.version} 不在候选源（registry/store/pack）中`)
      if (request?.range !== undefined && !matchesVersionRange(pin.version, request.range)) {
        reasons.push(`profile 钉定 ${pin.version} 不满足声明区间 ${request.range}`)
      }
      reasons.push(...(rejectionLog.get(`${id}@${pin.version}`) ?? []))
      conflicts.push({
        plugin: id,
        constraint: { kind: 'pin', target: id, range: pin.version },
        chain: findChain(roots, id, edges),
        candidates: [{
          version: pin.version,
          rejected: reasons.length > 0 ? [...new Set(reasons)] : ['没有任何候选版本'],
        }],
        actions: [
          `调整 profile 钉定版本（当前 ${pin.version}）或解除钉定`,
          `提供满足声明区间的候选版本`,
        ],
      })
      continue
    }
    const first = candidates[0]
    const constraints = (first === undefined ? undefined : constraintsOf(id, first)) ?? {
      depends: {},
      breaks: {},
      core: '*',
    }
    const primary = sortConstraints(constraints.depends, constraints.breaks, constraints.core, constraints.entry)[0]
    const chain = findChain(roots, id, edges)
      const installedTarget = primary !== undefined && primary.kind !== 'core' && primary.kind !== 'entry'
      ? input.installed.get(primary.target)?.version
      : input.coreVersion
    let actions = primary === undefined ? [] : suggestActions(id, primary, installedTarget)
    if (primary?.kind === 'depends') {
      const targetCandidates = (candidatesById.get(primary.target) ?? []).map(candidate => candidate.version)
      if (targetCandidates.length > 0) {
        actions = [
          `将 ${primary.target} 调整到满足 ${primary.range} 的版本（候选：${targetCandidates.join(', ')}）`,
          ...actions,
        ]
      }
    }
    conflicts.push({
      plugin: id,
      constraint: primary ?? { kind: 'depends', target: '(none)', range: '*' },
      chain,
      candidates: allRejections.length > 0 ? allRejections : [{ version: '(无候选)', rejected: ['没有任何候选版本'] }],
      actions,
    })
  }
  // 钉定归因：被 profile 钉定且卷入冲突的包，作为冲突方单独列出（双向建议）。
  if (input.pins !== undefined) {
    for (const [pinId, pin] of input.pins) {
      const involved = [...rejectionLog.keys()].some(key => {
        const [pluginId, version] = key.split('@')
        const reasons = rejectionLog.get(key) ?? []
        return reasons.some(reason => reason.includes(`profile 钉定 ${pin.version}`) && pluginId !== pinId)
          || (pluginId === pinId && version === pin.version && reasons.length > 0)
      })
      if (!involved) continue
      const targetPlugins = [...rejectionLog.keys()]
        .filter(key => (rejectionLog.get(key) ?? []).some(reason => reason.includes(`profile 钉定 ${pin.version}`)))
        .map(key => key.split('@')[0] as string)
      const plugin = targetPlugins[0] ?? pinId
      conflicts.push({
        plugin: pinId,
        constraint: { kind: 'pin', target: plugin, range: pin.version },
        chain: ['profile', pinId, plugin],
        candidates: [{ version: pin.version, rejected: [`profile 钉定 ${pin.version} 与 ${plugin} 的约束冲突`] }],
        actions: [
          `提升 profile/core 钉定版本到满足 ${plugin} 的 depends 区间`,
          `改用兼容当前钉定版本 ${pin.version} 的插件版本`,
        ],
      })
    }
  }
  const summary = conflicts.length === 1
    ? `求解失败：${conflicts[0]?.plugin ?? '?'} 无可用版本`
    : `求解失败：${conflicts.length} 个插件无可用版本`
  return {
    ok: false,
    report: {
      code: 'resolve-failed',
      summary,
      ...(input.generation === undefined ? {} : { generation: input.generation }),
      cycles: [],
      conflicts,
    },
  }
}
