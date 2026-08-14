/**
 * row-config 核心面测试（r6 收敛）：整行读写、upsert 追加 id 定向覆盖行、
 * 行 id 枚举。全部临时目录。
 * @module @r05en1cu/dsh-mygo/tests/row-config
 */

import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listPatchRowIds,
  readProfilePatchText,
  readRowConfig,
  upsertRowConfig,
  writeRowConfig,
} from '../src/row-config.ts'

const PATCH = [
  '# 用户层注释',
  '- insert:',
  '    - id: alpha',
  "      name: '@test/alpha'",
  '      config:',
  '        step: 1',
  '- id: beta',
  '  disabled: true',
  '',
].join('\n')

describe('row-config（整行读写 + upsert）', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mygo-row-config-'))
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  async function seed(text = PATCH): Promise<void> {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), text)
  }

  it('listPatchRowIds 出现序去重（insert 内与顶层行）', async () => {
    await seed()
    expect(listPatchRowIds(readProfilePatchText(home, 'web'))).toEqual(['alpha', 'beta'])
  })

  it('read/write 整行 config（浅合并，注释与邻行不动）', async () => {
    await seed()
    expect(readRowConfig(home, 'web', 'alpha')).toEqual({ ok: true, config: { step: 1 } })
    const written = writeRowConfig(home, 'web', 'alpha', { step: 2, extra: true })
    expect(written.ok).toBe(true)
    const text = await readFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    expect(text).toContain('# 用户层注释')
    expect(text).toContain('step: 2')
    expect(text).toContain('extra: true')
    expect(text).toContain('- id: beta')
  })

  it('upsert：行不存在追加 id 定向覆盖行；空文件落合法 YAML', async () => {
    await seed('[]\n')
    const result = upsertRowConfig(home, 'web', 'advisor', { model: 'x', budget: 5 })
    expect(result.ok).toBe(true)
    const text = await readFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    expect(text).toContain('- id: advisor')
    expect(text).toContain('config:')
    expect(text).toContain('model: x')
    expect(text).not.toContain('[]')
    // 二次 upsert 走浅合并路径（幂等）
    expect(upsertRowConfig(home, 'web', 'advisor', { budget: 6 }).ok).toBe(true)
    expect(readRowConfig(home, 'web', 'advisor').config).toEqual({ model: 'x', budget: 6 })
  })

  it('upsert：注释头 + 独立 [] 占位行 → 替换占位（合法 YAML，不产生 [] 后追加形态）', async () => {
    await seed('# user layer comment\n# second line\n[]\n')
    expect(upsertRowConfig(home, 'web', 'advisor', { model: 'x' }).ok).toBe(true)
    const text = await readFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    expect(text).toContain('# user layer comment')
    expect(text).not.toMatch(/\[\]/)
    expect(text).toContain('- id: advisor')
    // YAML 可解析且为数组
    const yaml = await import('js-yaml')
    const parsed = yaml.load(text) as unknown
    expect(Array.isArray(parsed)).toBe(true)
    expect((parsed as { id: string }[])[0]?.id).toBe('advisor')
  })

  it('upsert：既有行走 writeRowConfig 同语义', async () => {
    await seed()
    expect(upsertRowConfig(home, 'web', 'alpha', { step: 9 }).ok).toBe(true)
    expect(readRowConfig(home, 'web', 'alpha').config).toEqual({ step: 9 })
  })
})
