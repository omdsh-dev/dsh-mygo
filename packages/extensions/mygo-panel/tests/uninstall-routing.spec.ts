/**
 * bundle 卸载路由测试（r6 追加）：profile 执行面卸载（pnpm remove +
 * reconcile）、面板自卸载拒绝、dsh-mygo 核心 force 守卫、plan 预览拒绝
 * 透传。全部临时 $DSH_HOME（离线 file: 包装置）。
 * 注意：面板模块的 HOME_ROOT 在 import 时定型——本套件在 beforeAll 先
 * 设临时 DSH_HOME 再动态导入（教训：先于 import 设 env 是硬要求）。
 * @module @r05en1cu/dsh-mygo-ext-panel/tests/uninstall-routing
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { profileInstall } from '@r05en1cu/dsh-mygo-loader-profile'
import type { BundleMember } from '@r05en1cu/dsh-mygo'
import type { BundleUninstallOutcome } from '../src/index.ts'

const ORIGINAL_DSH_HOME = process.env.DSH_HOME

let home: string
let routeBundleUninstall: typeof import('../src/index.ts').routeBundleUninstall
type PanelContext = import('../src/index.ts').PanelContext

function memberOf(id: string, packageName: string): BundleMember {
  return { id, packageName, enabled: true } as BundleMember
}

function mockCtx(members: readonly BundleMember[], planAccepted = true): PanelContext {
  return {
    pluginManager: {
      bundleList: () => members,
      plan: () => Promise.resolve(planAccepted
        ? { accepted: true }
        : { accepted: false, error: { code: 'dependent-exists', message: '存在依赖者' } }),
      plugins: () => [],
      configOf: () => ({}),
      updateConfig: () => Promise.resolve(),
    },
  } as unknown as PanelContext
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'mygo-uninstall-route-'))
  process.env.DSH_HOME = home
  const mod = await import('../src/index.ts')
  routeBundleUninstall = mod.routeBundleUninstall
})

afterAll(async () => {
  if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = ORIGINAL_DSH_HOME
  await rm(home, { recursive: true, force: true })
})

async function writeBundleFixture(name: string): Promise<string> {
  const dir = join(home, `fixture-${name.replace('/', '_')}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2))
  await writeFile(join(dir, 'cordis.patch.yml'), '- insert: []\n')
  return dir
}

async function profileManifest(): Promise<{
  readonly dependencies?: Record<string, string>
  readonly dsh?: { readonly profile?: { readonly bundles?: readonly string[] } }
}> {
  return JSON.parse(await readFile(join(home, 'profiles', 'web', 'package.json'), 'utf8')) as never
}

describe('routeBundleUninstall（bundle 轨卸载路由）', () => {
  it('面板自身拒绝经该路径卸载（指引 dsh plugin remove）', async () => {
    const outcome = await routeBundleUninstall(
      mockCtx([memberOf('dsh-mygo-ext-panel', '@r05en1cu/dsh-mygo-ext-panel')]),
      'dsh-mygo-ext-panel',
      false,
      'web',
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('dsh plugin remove')
  })

  it('dsh-mygo 核心：无 force 拒绝；force 后经 profile 执行面卸载', async () => {
    const bundleDir = await writeBundleFixture('@r05en1cu/dsh-mygo')
    expect(profileInstall(bundleDir, { profile: 'web', home }).ok).toBe(true)
    const members = [memberOf('dsh-mygo', '@r05en1cu/dsh-mygo')]
    const refused = await routeBundleUninstall(mockCtx(members), 'dsh-mygo', false, 'web')
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('force: true')
    // 未动 profile
    expect(Object.keys((await profileManifest()).dependencies ?? {})).toContain('@r05en1cu/dsh-mygo')
    const outcome = await routeBundleUninstall(mockCtx(members), 'dsh-mygo', true, 'web')
    expect(outcome.ok).toBe(true)
    expect(outcome.warning).toContain('中断')
    expect(Object.keys((await profileManifest()).dependencies ?? {})).not.toContain('@r05en1cu/dsh-mygo')
    expect((await profileManifest()).dsh?.profile?.bundles).not.toContain('@r05en1cu/dsh-mygo')
  }, 120_000)

  it('普通 bundle 成员：plan 通过后经 pnpm remove + reconcile 卸载', async () => {
    const bundleDir = await writeBundleFixture('@test/community-one')
    expect(profileInstall(bundleDir, { profile: 'web', home }).ok).toBe(true)
    const outcome: BundleUninstallOutcome = await routeBundleUninstall(
      mockCtx([memberOf('community-one', '@test/community-one')]),
      'community-one',
      false,
      'web',
    )
    expect(outcome.ok).toBe(true)
    const manifest = await profileManifest()
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain('@test/community-one')
    expect(manifest.dsh?.profile?.bundles).not.toContain('@test/community-one')
  }, 120_000)

  it('plan 预览拒绝（dependent-exists）透传且不执行卸载', async () => {
    const bundleDir = await writeBundleFixture('@test/community-two')
    expect(profileInstall(bundleDir, { profile: 'web', home }).ok).toBe(true)
    const outcome = await routeBundleUninstall(
      mockCtx([memberOf('community-two', '@test/community-two')], false),
      'community-two',
      false,
      'web',
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('存在依赖者')
    expect(Object.keys((await profileManifest()).dependencies ?? {})).toContain('@test/community-two')
  }, 120_000)
})
