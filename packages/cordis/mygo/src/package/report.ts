/**
 * Structured resolution/verification failure reports (《收敛任务》不变量 5):
 * every conflict is reported at once — breakpoint node, full chain, candidate
 * set with per-candidate rejection reasons, and suggested actions.
 * @module @deepseek-ai/dsh-mygo/src/package/report
 */

/** One unsatisfied constraint edge. */
export interface ConstraintRef {
  readonly kind: 'depends' | 'breaks' | 'core' | 'entry' | 'pin'
  readonly target: string
  readonly range: string
}

/** One candidate version and every reason it was rejected. */
export interface CandidateRejection {
  readonly version: string
  readonly rejected: readonly string[]
}

/** One failed plugin's conflict entry. */
export interface ConflictEntry {
  /** Breakpoint node: the plugin whose candidate set failed. */
  readonly plugin: string
  /** The primary unsatisfied constraint (first in deterministic order). */
  readonly constraint: ConstraintRef
  /** Full dependency path from a requested root to the breakpoint. */
  readonly chain: readonly string[]
  /** Every candidate and all observed rejection reasons. */
  readonly candidates: readonly CandidateRejection[]
  /** Suggested upgrade/downgrade actions. */
  readonly actions: readonly string[]
}

/** A detected dependency cycle. */
export interface CycleEntry {
  readonly cycle: readonly string[]
}

/** Full structured failure report. */
export interface ResolutionReport {
  readonly code: 'resolve-failed' | 'dependency-cycle' | 'lockfile-mismatch' | 'manifest-invalid' | 'symbol-missing'
  readonly summary: string
  readonly cycles: readonly CycleEntry[]
  readonly conflicts: readonly ConflictEntry[]
}

/** Deterministic order for constraints of one plugin: depends, breaks, core. */
export function sortConstraints(
  depends: Readonly<Record<string, string>>,
  breaks: Readonly<Record<string, string>>,
  core: string | undefined,
  entry: string | undefined,
): readonly ConstraintRef[] {
  const out: ConstraintRef[] = []
  for (const target of Object.keys(depends).sort()) {
    out.push({ kind: 'depends', target, range: depends[target] as string })
  }
  for (const target of Object.keys(breaks).sort()) {
    out.push({ kind: 'breaks', target, range: breaks[target] as string })
  }
  if (core !== undefined) out.push({ kind: 'core', target: 'dsh', range: core })
  if (entry !== undefined) out.push({ kind: 'entry', target: 'self', range: entry })
  return out
}

/** Heuristic upgrade/downgrade suggestions from one failed plugin. */
export function suggestActions(
  plugin: string,
  constraint: ConstraintRef,
  installedTarget: string | undefined,
): readonly string[] {
  if (constraint.kind === 'depends') {
    if (installedTarget === undefined) {
      return [`安装 ${constraint.target} 到满足 ${constraint.range} 的版本`]
    }
    return [
      `升级 ${constraint.target} 到满足 ${constraint.range} 的版本（当前 ${installedTarget}）`,
      `降级 ${plugin} 到不依赖 ${constraint.target} ${constraint.range} 的版本`,
    ]
  }
  if (constraint.kind === 'breaks') {
    return [
      `升级/降级 ${constraint.target} 避开 ${constraint.range}（当前 ${installedTarget ?? '未知'}）`,
      `降级 ${plugin} 到不再 breaks ${constraint.target} 的版本`,
    ]
  }
  if (constraint.kind === 'core') {
    return [
      `升级 dsh 核心到满足 ${constraint.range} 的版本（当前 ${installedTarget ?? '未知'}）`,
      `降级 ${plugin} 到 core 区间包含当前核心版本的版本`,
    ]
  }
  if (constraint.kind === 'pin') {
    return [
      `提升 profile/core 钉定版本到满足 ${plugin} 的约束`,
      `改用兼容当前钉定版本 ${constraint.range} 的插件版本`,
    ]
  }
  return [`修复 ${plugin} 的入口声明 ${constraint.range}`]
}
