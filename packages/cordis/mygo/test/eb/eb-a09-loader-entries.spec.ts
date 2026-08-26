import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeHarness, settle } from './helpers.ts'
import { createRequire } from 'node:module'
const require_ = createRequire(import.meta.url)
const pkgRoot = (name: string): string => dirname(require_.resolve(`${name}/package.json`))


const LOADER_SRC = join(pkgRoot('@deepseek-ai/cordis-plugin-loader'), 'src/index.ts')
const TREE_SRC = join(pkgRoot('@deepseek-ai/cordis-plugin-loader'), 'src/config/tree.ts')
const ENTRY_SRC = join(pkgRoot('@deepseek-ai/cordis-plugin-loader'), 'src/config/entry.ts')
describe('EB-A9 mygo can reach fiber.inertia/state via loader entries', () => {
  it('源码路径存在：Loader extends EntryTree；entries() 可枚举；Entry.fiber public', async () => {
    const loaderSrc = await readFile(LOADER_SRC, 'utf8')
    const treeSrc = await readFile(TREE_SRC, 'utf8')
    const entrySrc = await readFile(ENTRY_SRC, 'utf8')
    expect(loaderSrc).toMatch(/export class Loader extends EntryTree/)
    expect(treeSrc).toMatch(/\* entries\(\)/)
    expect(treeSrc).toMatch(/return \[\.\.\.this\.entries\(\)\]/)
    expect(entrySrc).toMatch(/public fiber\?: Fiber/)
  })

  it('运行期可达：挂载后 entry.fiber.inertia/state 可读', async () => {
    const harness = await makeHarness()
    harness.ctx.loader.builtins.a = { name: 'a', inject: ['missing'], apply() {} }
    const id = await harness.ctx.loader.create({ name: 'cordis:a' })
    await settle(() => harness.find(id)?.fiber !== undefined)
    const fiber = harness.find(id)?.fiber
    expect(fiber).toBeDefined()
    expect('inertia' in (fiber as object)).toBe(true)
    expect((fiber as { inertia?: unknown }).inertia).toBeUndefined()
    expect(fiber?.state).toBe(0 /* PENDING：依赖缺失 */)
  })
})
