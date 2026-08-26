import { describe, expect, it } from 'vitest'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expandBundlePatch } from '../../src/package/bundle-expand.ts'
import { checkTemplateAlignment } from '../../src/package/template-align.ts'

/** vendored 官方模板资产（mygo-cli 包内，plugin-template@87acac8）。 */
const TEMPLATE_ROOT = fileURLToPath(new URL('../../../mygo-cli/assets/plugin-template/', import.meta.url))

describe('bundle patch expansion (B14/T16)', () => {
  it('expands insert rows into entry rows and passes policy rows through', () => {
    const rows = expandBundlePatch(`
- id: ui-layout
  disabled: true
- insert:
    - id: dsh-101-app
      name: '@dsh-external/dsh-101'
      config:
        mode: reader
    - id: reader-tutor
      disabled: false
`)
    expect(rows).toEqual([
      { id: 'ui-layout', disabled: true, kind: 'override' },
      { id: 'dsh-101-app', name: '@dsh-external/dsh-101', config: { mode: 'reader' }, kind: 'insert' },
      { id: 'reader-tutor', disabled: false, kind: 'insert' },
    ])
  })

  it('expands the real dsh-101 cordis.patch.yml shape (census D4 样本)', () => {
    const rows = expandBundlePatch(`
- insert:
    - id: dsh-101-app
      name: '@dsh-external/dsh-101'
`)
    expect(rows[0]).toMatchObject({ id: 'dsh-101-app', kind: 'insert' })
  })
})

describe('template alignment (B16/T18)', () => {
  it('passes the official plugin-template package.json shape', async () => {
    // 修复批次 4（批次 1 回议 4）：不再依赖 /tmp 预置路径（硬编码
    // /tmp/plugin-template-mRkOi6 属 fixture-issue），测试内 mkdtemp 自建，
    // 素材取自仓库自带 vendored 模板资产。
    const work = await mkdtemp(join(tmpdir(), 'mygo-tpl-align-'))
    try {
      await cp(TEMPLATE_ROOT, join(work, 'tpl'), { recursive: true })
      const raw = await readFile(join(work, 'tpl', 'package.json'), 'utf8')
      const result = checkTemplateAlignment(JSON.parse(raw))
      expect(result.aligned).toBe(true)
      expect(result.gaps).toEqual([])
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })

  it('reports gaps for a non-aligned package without throwing', () => {
    const result = checkTemplateAlignment({ name: 'p', version: '1.0.0' })
    expect(result.aligned).toBe(false)
    expect(result.gaps.length).toBeGreaterThan(3)
  })
})
