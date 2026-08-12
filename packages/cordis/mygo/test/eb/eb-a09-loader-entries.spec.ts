/**
 * A9：loader entry 暴露 fiber.epoch/inertia 的可达路径。
 * 源码核验：Loader extends EntryTree（vendor/loader/src/index.ts:61），
 * EntryTree.entries() 可枚举（config/tree.ts:27,37），Entry.fiber 为 public
 * （config/entry.ts:56），fiber.epoch/inertia 为 public 字段（fiber.ts:104,200）。
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { makeHarness, provider, settle } from './helpers.ts'

const LOADER_SRC = new URL('../../../../../vendor/loader/src/index.ts', import.meta.url).pathname
const TREE_SRC = new URL('../../../../../vendor/loader/src/config/tree.ts', import.meta.url).pathname
const ENTRY_SRC = new URL('../../../../../vendor/loader/src/config/entry.ts', import.meta.url).pathname
const FIBER_SRC = new URL('../../../../../vendor/cordis/src/fiber.ts', import.meta.url).pathname

describe('EB-A9 mygo can reach fiber.epoch/inertia via loader entries', () => {
  it('源码路径存在：Loader extends EntryTree；entries() 可枚举；Entry.fiber public；epoch/inertia public', async () => {
    const loaderSrc = await readFile(LOADER_SRC, 'utf8')
    const treeSrc = await readFile(TREE_SRC, 'utf8')
    const entrySrc = await readFile(ENTRY_SRC, 'utf8')
    const fiberSrc = await readFile(FIBER_SRC, 'utf8')
    expect(loaderSrc).toMatch(/export class Loader extends EntryTree/)
    expect(treeSrc).toMatch(/\* entries\(\)/)
    expect(treeSrc).toMatch(/return \[\.\.\.this\.entries\(\)\]/)
    expect(entrySrc).toMatch(/public fiber\?: Fiber/)
    expect(fiberSrc).toMatch(/epoch: T/)
    expect(fiberSrc).toMatch(/public inertia: Promise<void> \| undefined/)
  })

  it('运行期可达：挂载后 entry.fiber.epoch/inertia/state 可读', async () => {
    const harness = await makeHarness()
    harness.ctx.loader.builtins.a = { name: 'a', inject: ['missing'], apply() {} }
    const id = await harness.ctx.loader.create({ name: 'cordis:a' })
    await settle(() => harness.find(id)?.fiber !== undefined)
    const fiber = harness.find(id)?.fiber
    expect(fiber).toBeDefined()
    // 结论边界：inertia 与 epoch 均为公开字段（epoch getter 见 PATCHES.md #1）。
    expect('inertia' in (fiber as object)).toBe(true)
    expect((fiber as { inertia?: unknown }).inertia).toBeUndefined()
    expect(typeof (fiber as { epoch?: unknown }).epoch).toBe('string')
    expect(fiber?.state).toBe(0 /* PENDING：依赖缺失 */)
  })
})
