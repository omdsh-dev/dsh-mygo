/**
 * A3 重启还原验收（修复批次 3）：loadEntry 从 lockfile 还原 requires /
 * symbolAliases（不再硬编码 {}），模拟重启后政策闸输入与门状态一致。
 * 断线方式：注释 package-manager.ts loadEntry 内 `requires: lock.requires`
 * 还原行 → 本文件「requires 还原」与「对照组」用例变红。
 */

import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'
import { fromCordisPlugin, type PluginDefinition, type PluginSource } from '@deepseek-ai/dsh-mygo-api'
import { PluginPackageManager } from '../../src/package/package-manager.ts'
import { resolveMygoPaths } from '../../src/package/paths.ts'
import { DispatchMachine } from '../../src/dispatch.ts'
import { InMemoryRegistryStore } from '../../src/store.ts'
import { LifecycleEngine } from '../../src/lifecycle.ts'
import { resolvePluginManagerConfig } from '../../src/config.ts'

const sha256Text = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const sha512Text = (text: string): string => createHash('sha512').update(text, 'utf8').digest('hex')

interface SeedPlugin {
  readonly id: string
  readonly version: string
  readonly requires?: Readonly<Record<string, string>>
  readonly symbolAliases?: Readonly<Record<string, string>>
  readonly provides?: readonly string[]
}

/** 造一个已装 profile：store 目录 + 事实文件 + 新 schema lockfile。 */
async function seedLockedProfile(
  home: string,
  entries: readonly SeedPlugin[],
): Promise<{ readonly manager: PluginPackageManager; readonly paths: ReturnType<typeof resolveMygoPaths> }> {
  const paths = resolveMygoPaths('web', { DSH_HOME: home })
  const plugins: Record<string, Record<string, unknown>> = {}
  for (const entry of entries) {
    const { id, version } = entry
    const requires = entry.requires ?? {}
    const symbolAliases = entry.symbolAliases ?? {}
    const provides = entry.provides ?? []
    const entryBytes = 'export const apply = () => {}\n'
    const dir = join(paths.packagesRoot, id, version)
    await mkdir(join(dir, 'lib'), { recursive: true })
    await writeFile(join(dir, 'lib', 'index.js'), entryBytes)
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: `@test/${id}`, version, main: 'lib/index.js',
      dsh: { mygo: { formatVersion: 1, id, version, entry: 'lib/index.js', depends: {}, breaks: {}, requires, core: '*', ...(Object.keys(symbolAliases).length === 0 ? {} : { symbolAliases }) } },
    }, null, 2))
    const manifest = {
      formatVersion: 1, id, version, entry: 'lib/index.js',
      depends: {}, breaks: {}, requires, core: '*',
      recommends: {}, provides, entrypoints: {}, bundles: [],
    }
    const factBase = { format: 'dsh.mygo-package/v1', id, version, entry: 'lib/index.js', manifest }
    await writeFile(join(dir, '.mygo-package.json'), JSON.stringify({
      ...factBase, entrySha512: sha512Text(entryBytes), manifestSha256: sha256Text(JSON.stringify(factBase)), installedAt: '2026-08-13T00:00:00.000Z',
    }, null, 2))
    plugins[id] = {
      version, entry: 'lib/index.js', core: '*', depends: {}, breaks: {},
      requires, symbolAliases,
      entrySha256: sha256Text(entryBytes), manifestSha256: sha256Text(JSON.stringify(factBase)),
      entrySha512: sha512Text(entryBytes),
      packageName: `@test/${id}`,
      ...(provides.length === 0 ? {} : { provides }),
    }
  }
  await mkdir(paths.lockfileDir, { recursive: true })
  await writeFile(join(paths.lockfileDir, 'web.dsh.lock.json'), JSON.stringify({
    format: 'dsh.lock/v1',
    generated: { by: 'dsh-mygo', version: '0.3.0', profile: 'web', at: '<t>' },
    plugins,
  }, null, 2))
  const manager = new PluginPackageManager({ paths, profile: 'web', coreVersion: '0.0.1-rc.1', managerVersion: '0.3.0' })
  return { manager, paths }
}

function permissions(): PluginDefinition['permissions'] {
  return { observe: [], transform: [], intercept: [], position: 'derived', claims: [] }
}

function harness(): { readonly engine: LifecycleEngine; readonly definitions: Map<string, PluginDefinition> } {
  const ctx = new Context()
  const machine = new DispatchMachine(ctx, { vocabulary: [] })
  machine.start()
  const definitions = new Map<string, PluginDefinition>()
  const engine = new LifecycleEngine({
    ctx,
    dispatch: machine,
    store: new InMemoryRegistryStore(),
    config: resolvePluginManagerConfig({ swapTimeoutMs: 40, historyKeep: 2 }),
    eventVocabulary: [],
    resolveSource: async (value: PluginSource) => {
      const definition = definitions.get(value.type === 'inline' ? value.code : value.package)
      if (definition === undefined) throw new Error('unresolvable')
      return definition
    },
  })
  return { engine, definitions }
}

const source = (id: string): PluginSource => ({ type: 'inline', code: id })

/** 模拟 service.ts 启动映射：loadEntry → definitionFromManifest（经 fromCordisPlugin）。 */
async function definitionFromLock(
  manager: PluginPackageManager,
  id: string,
  rawApply?: (ctx: { provide(name: string, value: unknown): unknown }) => void,
): Promise<PluginDefinition> {
  const loaded = await manager.loadEntry(id)
  expect(loaded).toBeDefined()
  const manifest = loaded!.installed.manifest
  // 无覆盖时用 loadEntry 还原的真实入口模块（apply 存在）；有覆盖时注入测试钩子。
  const raw = rawApply === undefined ? loaded!.plugin : { name: id, apply: rawApply }
  return fromCordisPlugin(raw as never, {
    id: manifest.id,
    version: manifest.version,
    kinds: [],
    events: [],
    requires: [],
    serviceRequires: manifest.requires,
    ...(manifest.symbolAliases === undefined ? {} : { symbolAliases: manifest.symbolAliases }),
    provides: manifest.provides,
    permissions: permissions(),
    stateful: false,
    swapPolicy: 'immediate',
    config: z.object({}),
  })
}

describe('A3 重启还原验收（修复批次 3）', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mygo-lockevo-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('loadEntry 从 lockfile 还原 requires 与 symbolAliases（不再硬编码 {}）', async () => {
    const { manager } = await seedLockedProfile(join(root, 'home'), [
      { id: 'provider', version: '1.0.0', provides: ['svc'] },
      { id: 'consumer', version: '1.0.0', requires: { svc: '>=1.0.0' }, symbolAliases: { old: 'new' } },
    ])
    const loaded = await manager.loadEntry('consumer')
    expect(loaded).toBeDefined()
    // 断线点：注释 loadEntry 的 requires 还原行 → 本断言变红。
    expect(loaded?.installed.manifest.requires).toEqual({ svc: '>=1.0.0' })
    expect(loaded?.installed.manifest.symbolAliases).toEqual({ old: 'new' })
  })

  it('重启还原：从 lockfile 重建的 B 门状态与重启前一致（提供者在 → active）', async () => {
    const { manager } = await seedLockedProfile(join(root, 'home'), [
      { id: 'provider', version: '1.0.0', provides: ['svc'] },
      { id: 'consumer', version: '1.0.0', requires: { svc: '>=1.0.0' } },
    ])
    const providerDef = await definitionFromLock(manager, 'provider', ctx => { ctx.provide('svc', { ok: true }) })
    const consumerDef = await definitionFromLock(manager, 'consumer')
    const h = harness()
    h.definitions.set('provider', providerDef)
    h.definitions.set('consumer', consumerDef)
    await h.engine.install(source('provider'))
    await h.engine.install(source('consumer'))
    expect(h.engine.plugins().find(p => p.id === 'consumer')?.policyStatus).toBe('active')
    expect(h.engine.provideValue('svc')).toBeDefined()
  })

  it('对照组：lockfile 中 B requires 无提供者 → 重启后 B policy-inactive', async () => {
    const { manager } = await seedLockedProfile(join(root, 'home'), [
      { id: 'consumer', version: '1.0.0', requires: { svc: '>=1.0.0' } },
    ])
    const consumerDef = await definitionFromLock(manager, 'consumer')
    const h = harness()
    h.definitions.set('consumer', consumerDef)
    await h.engine.install(source('consumer'))
    // 断线点：注释 loadEntry 的 requires 还原行 → 本断言变红（requires 丢失 →
    // 闸无输入 → consumer 误判 active）。
    expect(h.engine.plugins().find(p => p.id === 'consumer')?.policyStatus).toBe('inactive')
    expect(h.engine.policyReportOf('consumer')?.code).toBe('policy-rejected')
  })
})

describe('DG-2 BOM 输出链（修复批次 3）', () => {
  it('attachBomFacts 灌入 record 后 BOM 输出真 entrySha512 与 fileSize', async () => {
    const { buildBom } = await import('../../src/bom.ts')
    const h = harness()
    h.definitions.set('p', fromCordisPlugin({ name: 'p', apply: () => {} } as never, {
      id: 'p',
      version: '1.0.0',
      kinds: [],
      events: [],
      requires: [],
      provides: [],
      permissions: permissions(),
      stateful: false,
      swapPolicy: 'immediate',
      config: z.object({}),
    }))
    await h.engine.install(source('p'))
    const entrySha512 = 'ab'.repeat(64)
    h.engine.attachBomFacts(new Map([['p', { entrySha512, entryFileSize: 42 }]]))
    const bom = buildBom({
      profile: 'web',
      bridgePlugins: h.engine.plugins().filter(plugin => plugin.status === 'enabled'),
    })
    const lock = bom.lock.members.find(entry => entry.id === 'p')
    expect(lock).toMatchObject({ sha512: entrySha512, fileSize: 42 })
  })
})
