/**
 * profile 版本钉定测试（《第二轮增强》5/6/8 条）：钉定作为唯一候选、
 * 校验作用于钉定后版本、冲突归因含 profile 与双向建议；provides 别名解析。
 */

import { describe, expect, it } from 'vitest'
import { resolve, type PluginCandidate } from '../../src/package/resolver.ts'

function candidate(
  version: string,
  depends: Record<string, string> = {},
  provides: string[] = [],
): PluginCandidate {
  return { version, constraints: { depends, breaks: {}, core: '*' }, ...(provides.length === 0 ? {} : { provides }) }
}

describe('profile pins', () => {
  it('pins force the pinned version as the sole candidate', () => {
    const outcome = resolve({
      requests: new Map([['A', {}]]),
      candidates: new Map([
        ['A', [candidate('1.0.0', { base: '>=1.0.0' })]],
        ['base', [candidate('1.0.0'), candidate('2.0.0'), candidate('1.5.0')]],
      ]),
      installed: new Map(),
      coreVersion: '0.0.1-rc.1',
      pins: new Map([['base', { version: '1.5.0' }]]),
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.resolved.find(plugin => plugin.id === 'base')?.version).toBe('1.5.0')
  })

  it('hard-blocks a pin that conflicts with depends and attributes the profile', () => {
    const outcome = resolve({
      requests: new Map([['A', {}]]),
      candidates: new Map([
        ['A', [candidate('1.0.0', { base: '>=2.0.0' })]],
        ['base', [candidate('1.0.0'), candidate('2.0.0')]],
      ]),
      installed: new Map(),
      coreVersion: '0.0.1-rc.1',
      pins: new Map([['base', { version: '1.0.0' }]]),
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    const text = JSON.stringify(outcome.report)
    expect(text).toContain('profile 钉定 1.0.0')
    expect(outcome.report.conflicts.some(conflict => conflict.constraint.kind === 'pin')).toBe(true)
    expect(text).toContain('提升 profile/core 钉定版本')
    expect(text).toContain('改用兼容当前钉定版本')
  })

  it('resolves depends aliases through provides', () => {
    const outcome = resolve({
      requests: new Map([['A', {}]]),
      candidates: new Map([
        ['A', [candidate('1.0.0', { 'service:voice': '>=1.0.0' })]],
        ['B', [candidate('2.0.0', {}, ['service:voice'])]],
      ]),
      installed: new Map(),
      coreVersion: '0.0.1-rc.1',
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.resolved.find(plugin => plugin.id === 'B')?.version).toBe('2.0.0')
  })

  it('hard-blocks when the alias provider version violates the range', () => {
    const outcome = resolve({
      requests: new Map([['A', {}]]),
      candidates: new Map([
        ['A', [candidate('1.0.0', { 'service:voice': '>=2.0.0' })]],
        ['B', [candidate('1.0.0', {}, ['service:voice'])]],
      ]),
      installed: new Map(),
      coreVersion: '0.0.1-rc.1',
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.report.conflicts[0]?.candidates[0]?.rejected.join()).toContain('service:voice')
  })
})
