/**
 * 确定性版本求解器测试（《收敛任务》）：最高版本裁决、钻石确定性、
 * 依赖缺失/区间不满足/breaks/环 的失败报告。
 */

import { describe, expect, it } from 'vitest'
import { findDependsCycle, resolve, sortCandidates, topologicalOrder, type PluginCandidate } from '../../src/package/resolver.ts'

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

  it('is byte-identical for the same input on two runs, including tie-break candidates (T19)', () => {
    const build = () => resolve({
      requests: new Map([['A', {}], ['B', {}]]),
      candidates: new Map([
        ['A', [
          { version: '1.0.0', constraints: { depends: { C: '>=1.0.0' }, breaks: {}, core: '*' }, source: 'registry' },
          { version: '2.0.0', constraints: { depends: { C: '>=1.0.0' }, breaks: {}, core: '*' }, source: 'bundle', depth: 2, parent: 'root' },
        ]],
        ['B', [
          { version: '1.0.0', constraints: { depends: { C: '>=1.0.0' }, breaks: {}, core: '*' }, source: 'locked' },
        ]],
        ['C', [
          { version: '1.0.0', constraints: { depends: {}, breaks: {}, core: '*' }, source: 'registry' },
        ]],
      ]),
      installed: new Map(),
      coreVersion: '0.0.1-rc.1',
    })
    const first = build()
    const second = build()
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    // 全序闭合：同优先级缝隙由 source 序 + sha256 字典序裁决。
    const ordered = sortCandidates([
      { version: '1.0.0', source: 'locked', manifestSha256: 'bbb' },
      { version: '1.0.0', source: 'registry', manifestSha256: 'aaa' },
      { version: '1.0.0', source: 'bundle', manifestSha256: 'ccc' },
      { version: '1.0.0', source: 'registry', manifestSha256: 'ddd' },
      { version: '1.0.0', source: 'pinned', manifestSha256: 'eee' },
    ])
    expect(ordered.map(item => `${item.source ?? ''}:${item.manifestSha256 ?? ''}`)).toEqual([
      'pinned:eee',
      'registry:aaa',
      'registry:ddd',
      'locked:bbb',
      'bundle:ccc',
    ])
    // 嵌套浅优先（depth 升序）与 parent 升序。
    const nested = sortCandidates([
      { version: '2.0.0', depth: 3, parent: 'z' },
      { version: '2.0.0', depth: 1, parent: 'm' },
      { version: '2.0.0', depth: 1, parent: 'a' },
      { version: '2.0.0' },
    ])
    expect(nested.map(item => `${item.depth ?? 0}:${item.parent ?? ''}`)).toEqual(['0:', '1:a', '1:m', '3:z'])
  })

  it('carries generation from/to on failure reports for P1-global rollback attribution (B7/EB-D4)', () => {
    const outcome = resolve({
      requests: new Map([['A', {}]]),
      candidates: new Map([
        ['A', [candidate('1.0.0', { B: '>=2.0.0' })]],
        ['B', [candidate('1.0.0')]],
      ]),
      installed: new Map(),
      coreVersion: '0.0.1-rc.1',
      generation: { from: 'g2', to: 'g1' },
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.report.generation).toEqual({ from: 'g2', to: 'g1' })
  })
})
