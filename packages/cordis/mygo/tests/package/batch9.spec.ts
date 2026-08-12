/**
 * 批次 9 测试（B14/B15/B16/T16/T18）：bundle patch 展开 → entry 行；
 * legacy dsh.plugin.json 只读映射；官方模板对齐校验。
 */

import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { expandBundlePatch } from '../../src/package/bundle-expand.ts'
import { mapLegacyPluginFile } from '../../src/package/legacy-mapping.ts'
import { checkTemplateAlignment } from '../../src/package/template-align.ts'

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

describe('legacy dsh.plugin.json mapping (B15/T16)', () => {
  it('maps id/version/main/engines/contributes/client and warns without blocking', () => {
    const result = mapLegacyPluginFile({
      id: 'dsh-external/chat-width',
      version: '0.1.0',
      main: './index.mjs',
      engines: { dsh: '>=0.0.1' },
      contributes: { tools: [], skills: [] },
      client: { main: './client.js', inject: ['@deepseek-ai/dsh-client-runtime'] },
    })
    expect(result.value).toMatchObject({
      id: 'chat-width',
      version: '0.1.0',
      entry: 'index.mjs',
      core: '>=0.0.1',
      environment: {
        contributes: { tools: [], skills: [] },
        client: { main: './client.js', inject: ['@deepseek-ai/dsh-client-runtime'] },
      },
    })
    expect(result.warnings.some(line => line.includes('legacy dsh.plugin.json'))).toBe(true)
  })

  it('is read-only: invalid legacy files map to warnings, never exceptions', () => {
    const result = mapLegacyPluginFile({ id: '', main: '../escape.mjs' })
    expect(result.value).toBeUndefined()
    expect(result.unmapped).toContain('id')
  })
})

describe('template alignment (B16/T18)', () => {
  it('passes the official plugin-template package.json shape', async () => {
    const raw = await readFile('/tmp/plugin-template-mRkOi6/tpl/package.json', 'utf8')
    const result = checkTemplateAlignment(JSON.parse(raw))
    expect(result.aligned).toBe(true)
    expect(result.gaps).toEqual([])
  })

  it('reports gaps for a non-aligned package without throwing', () => {
    const result = checkTemplateAlignment({ name: 'p', version: '1.0.0' })
    expect(result.aligned).toBe(false)
    expect(result.gaps.length).toBeGreaterThan(3)
  })
})
