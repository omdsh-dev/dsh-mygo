/**
 * 确定性版本求解器测试（《收敛任务》）：最高版本裁决、钻石确定性、
 * 依赖缺失/区间不满足/breaks/环 的失败报告。
 */

import { describe, expect, it } from 'vitest'
import { findDependsCycle, resolve, topologicalOrder, type PluginCandidate } from '../../src/package/resolver.ts'

function candidate(
  version: string,
  depends: Record<string, string> = {},
  breaks: Record<string, string> = {},
  core = '*',
): PluginCandidate {
  return { version, constraints: { depends, breaks, core } }
}

describe('plugin resolver', () => {
  it('picks the highest version satisfying all depends', () => {
    const outcome = resolve({
      requests: new Map([['A', {}]]),
      candidates: new Map([
        ['A', [candidate('1.0.0', { B: '>=2.0.0' })]],
        ['B', [candidate('1.0.0'), candidate('2.1.0'), candidate('3.0.0')]],
      ]),
      installed: new Map(),
      coreVersion: '0.0.1-rc.1',
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.resolved.find(plugin => plugin.id === 'B')?.version).toBe('3.0.0')
  })

  it('resolves a diamond deterministically (byte-identical twice)', () => {
    const build = () => resolve({
      requests: new Map([['A', {}]]),
      candidates: new Map([
        ['A', [candidate('1.0.0', { B: '>=1.0.0', C: '>=1.0.0' })]],
        ['B', [candidate('1.0.0', { D: '>=1.0.0' })]],
        ['C', [candidate('1.0.0', { D: '>=1.0.0' })]],
        ['D', [candidate('1.0.0'), candidate('1.5.0'), candidate('2.0.0')]],
      ]),
      installed: new Map(),
      coreVersion: '0.0.1-rc.1',
    })
    const first = build()
    const second = build()
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.resolved.find(plugin => plugin.id === 'D')?.version).toBe('2.0.0')
  })

  it('reports version-range failure with candidates, chain and actions', () => {
    const outcome = resolve({
      requests: new Map([['A', {}]]),
      candidates: new Map([
        ['A', [candidate('1.0.0', { B: '>=2.0.0' })]],
        ['B', [candidate('1.0.0'), candidate('1.5.0')]],
      ]),
      installed: new Map(),
      coreVersion: '0.0.1-rc.1',
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.report.code).toBe('resolve-failed')
    expect(outcome.report.conflicts[0]?.plugin).toBe('A')
    expect(outcome.report.conflicts[0]?.constraint).toMatchObject({ kind: 'depends', target: 'B', range: '>=2.0.0' })
    expect(outcome.report.conflicts[0]?.candidates.length).toBeGreaterThan(0)
    expect(outcome.report.conflicts[0]?.candidates[0]?.rejected.join()).toContain('不满足 >=2.0.0')
    expect(outcome.report.conflicts[0]?.actions.join()).toContain('B')
  })

  it('blocks breaks hits', () => {
    const outcome = resolve({
      requests: new Map([['A', {}]]),
      candidates: new Map([
        ['A', [candidate('1.0.0', {}, { B: '>=1.0.0' })]],
        ['B', [candidate('1.0.0')]],
      ]),
      installed: new Map(),
      coreVersion: '0.0.1-rc.1',
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.report.conflicts[0]?.constraint.kind).toBe('breaks')
    expect(outcome.report.conflicts[0]?.candidates[0]?.rejected.join()).toContain('命中')
  })

  it('reports missing dependencies as conflicts', () => {
    const outcome = resolve({
      requests: new Map([['A', {}]]),
      candidates: new Map([
        ['A', [candidate('1.0.0', { B: '>=2.0.0' })]],
      ]),
      installed: new Map(),
      coreVersion: '0.0.1-rc.1',
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.report.conflicts[0]?.candidates[0]?.rejected.join()).toContain('缺失')
    expect(outcome.report.conflicts[0]?.actions.join()).toContain('安装 B')
  })

  it('rejects dependency cycles with an explicit report', () => {
    const outcome = resolve({
      requests: new Map([['A', {}]]),
      candidates: new Map([
        ['A', [candidate('1.0.0', { B: '>=1.0.0' })]],
        ['B', [candidate('1.0.0', { A: '>=1.0.0' })]],
      ]),
      installed: new Map(),
      coreVersion: '0.0.1-rc.1',
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.report.code).toBe('dependency-cycle')
    expect(outcome.report.cycles[0]?.cycle).toEqual(['A', 'B', 'A'])
  })

  it('finds cycles and topo orders deterministically', () => {
    const edges = new Map([
      ['A', ['B']],
      ['B', ['C', 'D']],
      ['C', ['D']],
      ['D', []],
    ])
    // 边方向 = “依赖谁”：D 先于 C/B，C/B 先于 A（同层按 id 字典序）。
    expect(topologicalOrder(['A', 'B', 'C', 'D'], edges)).toEqual(['D', 'C', 'B', 'A'])
    expect(findDependsCycle(['A', 'B', 'C', 'D'], edges)).toBeUndefined()
    expect(findDependsCycle(['A', 'B'], new Map([['A', ['B']], ['B', ['A']]]))).toEqual(['A', 'B', 'A'])
  })
})
