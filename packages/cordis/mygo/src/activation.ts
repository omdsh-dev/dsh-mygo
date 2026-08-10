/**
 * P2 activation solver: given the current installed set (with enabled
 * flags) and one requested operation, compute the minimal legal activation
 * plan. Hard `depends` edges are walked transitively and satisfied by
 * enabling disabled members (`required-by`), capability edges
 * (`service:` / `cap:`) resolve to deterministic providers, `breaks`
 * conflicts are resolved by minimal disablement (`conflict-resolution`),
 * and unresolvable gaps become advisory actions plus a rejection.
 *
 * Version selection stays with pnpm: the solver only proposes `enable` /
 * `disable` / `install` actions and `suggest-update` text; it never mutates
 * state itself and never changes an installed version.
 * @module @deepseek-ai/dsh-mygo/src/activation
 */

import { formatPluginError } from '@deepseek-ai/dsh-mygo-api'
import type { ActivationAction, ActivationPlan, CompatibilityEdge, PluginCompatibility } from '@deepseek-ai/dsh-mygo-api'
import {
  compatibilityViolationLines,
  compatibilityWarningLines,
  evaluateCompatibility,
  isCapabilityKey,
  normalizeCompatibility,
  type CompatibilityPlugin,
} from './compatibility.ts'
import { isValidRange, matchesVersionRange } from './semver-range.ts'

/** One plugin in the activation universe (install order = list order). */
export interface ActivationPlugin {
  id: string
  version?: string
  compatibility?: PluginCompatibility
  provides?: readonly string[]
  enabled: boolean
  /** Which management rail owns this member. */
  rail?: 'bridge' | 'bundle'
}

/** One requested operation to solve. */
export type ActivationOperation =
  | { readonly op: 'enable'; readonly id: string }
  | { readonly op: 'disable'; readonly id: string; readonly force?: boolean }
  | { readonly op: 'install'; readonly plugin: ActivationPlugin }
  | { readonly op: 'replace'; readonly id: string; readonly plugin: ActivationPlugin }

const MAX_ROUNDS = 64

/**
 * Solve one activation request. Pure — returns a plan; the caller applies
 * the actions through the normal lifecycle protocol.
 */
export function solveActivation(
  installed: readonly ActivationPlugin[],
  operation: ActivationOperation,
): ActivationPlan {
  const state = new Map<string, ActivationPlugin>()
  const order = new Map<string, number>()
  installed.forEach((plugin, index) => {
    state.set(plugin.id, { ...plugin })
    order.set(plugin.id, index)
  })
  const actions: ActivationAction[] = []
  const advisorySeen = new Set<string>()

  const advisory = (op: ActivationAction['op'], id: string, reason: string): void => {
    const key = `${op}:${id}`
    if (advisorySeen.has(key)) return
    advisorySeen.add(key)
    actions.push({ op, id, kind: 'advisory', reason })
  }

  const userRequested = operation.op === 'enable' || operation.op === 'disable'
    ? operation.id
    : operation.plugin.id

  // ---- apply the requested operation -----------------------------------
  if (operation.op === 'enable') {
    const entry = state.get(operation.id)
    if (entry === undefined) return notFound('enable', operation.id, actions)
    if (!entry.enabled) {
      entry.enabled = true
      actions.push(userAction('enable', operation.id, '用户请求启用'))
    }
  } else if (operation.op === 'disable') {
    const entry = state.get(operation.id)
    if (entry === undefined) return notFound('disable', operation.id, actions)
    if (entry.enabled) {
      const dependents = closureDependents(state, operation.id)
      if (dependents.length > 0 && operation.force !== true) {
        return {
          accepted: false,
          actions,
          warnings: [],
          error: {
            code: 'dependent-exists',
            message: formatPluginError('dependent-exists', { dependents }),
            details: { dependents },
          },
        }
      }
      for (const dependent of dependents) {
        const target = state.get(dependent)
        if (target === undefined) continue
        target.enabled = false
        actions.push({
          op: 'disable',
          id: dependent,
          kind: 'conflict-resolution',
          reason: `级联停用：依赖链经过 ${operation.id}`,
        })
      }
      entry.enabled = false
      actions.push(userAction('disable', operation.id, '用户请求停用'))
    }
  } else if (operation.op === 'install') {
    if (state.has(operation.plugin.id)) {
      return {
        accepted: false,
        actions,
        warnings: [],
        error: {
          code: 'concurrent-operation',
          message: formatPluginError('concurrent-operation', { id: operation.plugin.id, operation: 'install' }),
        },
      }
    }
    state.set(operation.plugin.id, { ...operation.plugin, enabled: true })
    order.set(operation.plugin.id, installed.length)
    actions.push(userAction('install', operation.plugin.id, '用户请求安装'))
  } else {
    const incumbent = state.get(operation.id)
    if (incumbent === undefined) return notFound('replace', operation.id, actions)
    state.set(operation.id, { ...operation.plugin, enabled: incumbent.enabled })
    actions.push(userAction('replace', operation.id, '用户请求替换'))
  }

  // ---- hard closure: enable required-by members -------------------------
  let changed = true
  let rounds = 0
  while (changed && rounds++ < MAX_ROUNDS) {
    changed = false
    for (const plugin of [...state.values()]) {
      if (!plugin.enabled) continue
      const compat = normalizeCompatibility(plugin.compatibility).value
      if (compat === undefined) continue
      for (const [target, range] of Object.entries(compat.depends ?? {})) {
        if (!isValidRange(range)) continue
        const edge: CompatibilityEdge = { declarer: plugin.id, kind: 'depends', target, range }
        if (isCapabilityKey(target)) {
          const candidates = [...state.values()].filter(candidate => candidate.provides?.includes(target))
          const enabledOk = candidates.find(candidate => candidate.enabled && matchesRange(candidate.version, range))
          if (enabledOk !== undefined) continue
          const disabledCandidate = candidates.find(candidate => !candidate.enabled && matchesRange(candidate.version, range))
          if (disabledCandidate !== undefined) {
            disabledCandidate.enabled = true
            actions.push(requiredByAction('enable', disabledCandidate.id, edge))
            changed = true
          } else if (candidates.some(candidate => candidate.version !== undefined)) {
            advisory('suggest-update', target, `已装候选版本不满足 ${range}（候选：${candidates.map(candidate => candidate.id).join(', ')}）`)
          } else {
            advisory('install', target, `能力 ${target} 无已装提供者（${edge.declarer} 声明）`)
          }
          continue
        }
        const targetPlugin = state.get(target)
        if (targetPlugin === undefined) {
          advisory('install', target, `缺失依赖（${edge.declarer} 声明）`)
          continue
        }
        if (!targetPlugin.enabled) {
          targetPlugin.enabled = true
          actions.push(requiredByAction('enable', target, edge))
          changed = true
        } else if (!matchesRange(targetPlugin.version, range)) {
          advisory('suggest-update', target, `已装 ${targetPlugin.version ?? '未知版本'} 不满足 ${range}`)
        }
      }
    }
  }

  // ---- breaks conflict resolution (minimal disablement) ------------------
  rounds = 0
  let conflict = true
  while (conflict && rounds++ < MAX_ROUNDS) {
    conflict = false
    const found = findFirstBreaksConflict(state)
    if (found === undefined) break
    const { declarer, target, range } = found
    const edge: CompatibilityEdge = { declarer, kind: 'breaks', target, range }
    if (declarer === userRequested || target === userRequested) {
      // The user's requested change itself is part of the broken pair: the
      // request is refused with the chain instead of auto-disabling.
      return rejectedWithBreaks(actions, userRequested, [edge])
    }
    const declarerRequired = closureDependents(state, declarer).length > 0
    const targetRequired = closureDependents(state, target).length > 0
    let victim: string
    if (!declarerRequired && !targetRequired) {
      const declarerOrder = order.get(declarer) ?? 0
      const targetOrder = order.get(target) ?? 0
      victim = declarerOrder > targetOrder ? declarer : target
    } else if (!declarerRequired) {
      victim = declarer
    } else if (!targetRequired) {
      victim = target
    } else {
      return rejectedWithBreaks(actions, userRequested, [edge])
    }
    const victimPlugin = state.get(victim)
    if (victimPlugin === undefined) continue
    victimPlugin.enabled = false
    actions.push({
      op: 'disable',
      id: victim,
      kind: 'conflict-resolution',
      reason: `${edge.declarer} breaks ${edge.target} "${edge.range}"（最小变更消解）`,
      chain: [edge],
    })
    conflict = true
  }

  // ---- final validation + soft warnings -----------------------------------
  const finalPlugins: CompatibilityPlugin[] = [...state.values()].map(plugin => ({
    id: plugin.id,
    ...(plugin.version === undefined ? {} : { version: plugin.version }),
    ...(plugin.compatibility === undefined ? {} : { compatibility: plugin.compatibility }),
    ...(plugin.provides === undefined ? {} : { provides: plugin.provides }),
    enabled: plugin.enabled,
  }))
  const set = {
    enabled: finalPlugins.filter(plugin => plugin.enabled),
    installed: finalPlugins,
  }
  const violations: string[] = []
  const warnings = new Set<string>()
  for (const plugin of finalPlugins.filter(plugin => plugin.enabled)) {
    const report = evaluateCompatibility(
      {
        id: plugin.id,
        ...(plugin.version === undefined ? {} : { version: plugin.version }),
        ...(plugin.compatibility === undefined ? {} : { compatibility: plugin.compatibility }),
        ...(plugin.provides === undefined ? {} : { provides: plugin.provides }),
      },
      set,
      'reconcile',
    )
    violations.push(...compatibilityViolationLines(report))
    for (const line of compatibilityWarningLines(report)) warnings.add(line)
  }
  if (violations.length > 0) {
    return {
      accepted: false,
      actions,
      warnings: [...warnings],
      error: {
        code: 'compatibility-conflict',
        message: formatPluginError('compatibility-conflict', { plugin: userRequested, violations }),
      },
    }
  }
  return { accepted: true, actions, warnings: [...warnings] }
}

/** Enabled plugins whose hard closure (direct or transitive) reaches `id`. */
function closureDependents(state: ReadonlyMap<string, ActivationPlugin>, id: string): string[] {
  const result: string[] = []
  for (const plugin of state.values()) {
    if (!plugin.enabled || plugin.id === id) continue
    if (closureReaches(state, plugin.id, id)) result.push(plugin.id)
  }
  return result.sort()
}

/** BFS reachability over `depends` edges (capability edges via providers). */
function closureReaches(state: ReadonlyMap<string, ActivationPlugin>, start: string, target: string): boolean {
  const seen = new Set<string>([start])
  const queue = [start]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) continue
    const plugin = state.get(current)
    if (plugin === undefined) continue
    const compat = normalizeCompatibility(plugin.compatibility).value
    for (const [dep, range] of Object.entries(compat?.depends ?? {})) {
      if (!isValidRange(range)) continue
      if (isCapabilityKey(dep)) {
        for (const candidate of state.values()) {
          if (!candidate.enabled || !candidate.provides?.includes(dep)) continue
          if (!matchesRange(candidate.version, range)) continue
          if (candidate.id === target) return true
          if (!seen.has(candidate.id)) {
            seen.add(candidate.id)
            queue.push(candidate.id)
          }
        }
        continue
      }
      if (dep === target) return true
      if (!seen.has(dep)) {
        seen.add(dep)
        queue.push(dep)
      }
    }
  }
  return false
}

/** First enabled breaks pair in deterministic (install-order) iteration. */
function findFirstBreaksConflict(
  state: ReadonlyMap<string, ActivationPlugin>,
): { readonly declarer: string; readonly target: string; readonly range: string } | undefined {
  for (const plugin of state.values()) {
    if (!plugin.enabled) continue
    const compat = normalizeCompatibility(plugin.compatibility).value
    if (compat === undefined) continue
    for (const [target, range] of Object.entries(compat.breaks ?? {})) {
      if (!isValidRange(range)) continue
      const targetPlugin = state.get(target)
      if (targetPlugin !== undefined && targetPlugin.enabled && matchesRange(targetPlugin.version, range)) {
        return { declarer: plugin.id, target, range }
      }
    }
  }
  return undefined
}

function matchesRange(version: string | undefined, range: string): boolean {
  return version !== undefined && isValidRange(range) && matchesVersionRange(version, range)
}

function userAction(op: ActivationAction['op'], id: string, reason: string): ActivationAction {
  return { op, id, kind: 'user-requested', reason }
}

function requiredByAction(op: ActivationAction['op'], id: string, edge: CompatibilityEdge): ActivationAction {
  return {
    op,
    id,
    kind: 'required-by',
    reason: `${edge.declarer} depends ${edge.target} "${edge.range}"`,
    chain: [edge],
  }
}

function notFound(operation: string, id: string, actions: readonly ActivationAction[]): ActivationPlan {
  return {
    accepted: false,
    actions,
    warnings: [],
    error: {
      code: 'plugin-not-found',
      message: formatPluginError('plugin-not-found', { id, operation }),
    },
  }
}

function rejectedWithBreaks(
  actions: readonly ActivationAction[],
  plugin: string,
  edges: readonly CompatibilityEdge[],
): ActivationPlan {
  const lines = edges.map(edge =>
    `${edge.declarer} breaks ${edge.target} "${edge.range}": 已装（由 ${edge.declarer} 声明）`)
  return {
    accepted: false,
    actions,
    warnings: [],
    error: {
      code: 'compatibility-conflict',
      message: formatPluginError('compatibility-conflict', { plugin, violations: lines }),
    },
  }
}
