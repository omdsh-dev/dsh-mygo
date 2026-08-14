/**
 * config-cards 纯函数面测试（r6）：bundle 行 id 推导、导出文档构造、
 * 导入解析/校验/目标分面。
 * @module @r05en1cu/dsh-mygo-ext-panel/tests/config-cards
 */

import { describe, expect, it } from 'vitest'
import {
  buildConfigExport,
  bundleRowIdOf,
  CONFIG_EXPORT_FORMAT,
  parseConfigImport,
  partitionImportTargets,
} from '../src/config-cards.ts'

describe('bundleRowIdOf', () => {
  it('取 bundle patch 首个 insert 行 id；无 insert 行回退 undefined', () => {
    expect(bundleRowIdOf('- insert:\n    - id: advisor\n      name: dsh-advisor\n')).toBe('advisor')
    expect(bundleRowIdOf("- insert:\n    - id: 'quoted-row'\n")).toBe('quoted-row')
    expect(bundleRowIdOf('# empty\n- insert: []\n')).toBeUndefined()
    expect(bundleRowIdOf('')).toBeUndefined()
  })
})

describe('配置导出/导入（dsh.mygo-configs/v1）', () => {
  it('buildConfigExport 形状', () => {
    const doc = buildConfigExport('web', { alpha: { step: 1 } }, '2026-08-14T00:00:00.000Z')
    expect(doc).toEqual({
      format: 'dsh.mygo-configs/v1',
      profile: 'web',
      exportedAt: '2026-08-14T00:00:00.000Z',
      configs: { alpha: { step: 1 } },
    })
  })

  it('parseConfigImport：合法文档往返；非法输入逐项拒绝', () => {
    expect(parseConfigImport({ format: CONFIG_EXPORT_FORMAT, configs: { alpha: { step: 1 } } })).toEqual({
      ok: true,
      configs: { alpha: { step: 1 } },
    })
    expect(parseConfigImport(null).ok).toBe(false)
    expect(parseConfigImport([]).ok).toBe(false)
    expect(parseConfigImport({ format: 'other/v9', configs: {} })).toMatchObject({ ok: false })
    expect(parseConfigImport({ format: CONFIG_EXPORT_FORMAT, configs: [] })).toMatchObject({ ok: false })
    expect(parseConfigImport({ format: CONFIG_EXPORT_FORMAT, configs: { 'Bad Id': {} } })).toMatchObject({ ok: false })
    expect(parseConfigImport({ format: CONFIG_EXPORT_FORMAT, configs: { alpha: 'not-object' } })).toMatchObject({ ok: false })
  })

  it('partitionImportTargets：受管集内放行，集外拒绝并指认', () => {
    const partition = partitionImportTargets(
      { alpha: {}, ghost: {} },
      new Set(['alpha', 'beta']),
    )
    expect(partition.accepted).toEqual(['alpha'])
    expect(partition.rejected).toEqual([{ id: 'ghost', reason: expect.stringContaining('不在当前 profile') }])
  })
})
