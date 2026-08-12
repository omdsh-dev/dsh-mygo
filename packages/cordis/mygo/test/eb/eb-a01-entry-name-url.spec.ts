/**
 * A1：paper 的 entry url 与 dsh entry name 的等价性。
 * 源码核验：EntryOptions 只有 name（模块说明符），无 url 字段；
 * tree.import(name) 用该说明符加载模块（vendor/loader/src/config/tree.ts:145-161）。
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { makeHarness, provider, settle } from './helpers.ts'

const ENTRY_SRC = new URL('../../../../../vendor/loader/src/config/entry.ts', import.meta.url).pathname
const TREE_SRC = new URL('../../../../../vendor/loader/src/config/tree.ts', import.meta.url).pathname

describe('EB-A1 entry name is the module specifier (paper url equivalent)', () => {
  it('EntryOptions 声明 name 且不声明 url；tree.import 用 name 加载', async () => {
    const entrySrc = await readFile(ENTRY_SRC, 'utf8')
    const treeSrc = await readFile(TREE_SRC, 'utf8')
    expect(entrySrc).toMatch(/name: string/)
    expect(entrySrc).not.toMatch(/url\?: string/)
    expect(treeSrc).toMatch(/import\(name: string/)
    expect(treeSrc).toMatch(/name\.startsWith\('cordis:'\)/)
  })

  it('以 name 声明的 entry 可被加载并挂载（等价于 url 的运行时行为）', async () => {
    const harness = await makeHarness()
    harness.ctx.loader.builtins.a = provider('a', 'svc', {})
    const id = await harness.ctx.loader.create({ name: 'cordis:a' })
    await settle(() => harness.find(id)?.fiber?.state === 2 /* ACTIVE */)
    expect(harness.find(id)?.fiber?.state).toBe(2)
  })
})
