/**
 * design-r4 单元测试：pack 清单/规范哈希/tar 成员解析鲁棒性 + KF-1 分类。
 * 字节级确定性断言与真实往返在 tests/e2e/pack-verification.spec.ts（T32+）。
 * @module @deepseek-ai/dsh-mygo/tests/package/pack
 */

import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  computePackManifestSha256,
  canonicalPackPayload,
  listTarMembers,
  listGzipTarMembers,
  parsePackManifest,
  type PackManifest,
} from '../../src/package/pack.ts'
import { detectUndeclaredBundles } from '../../src/package/bundle-scan.ts'

const execFileAsync = promisify(execFile)

function sampleManifest(overrides: Partial<PackManifest> = {}): PackManifest {
  return {
    format: 'mygo-pack/v1',
    formatVersion: 1,
    name: 'sample',
    version: '1.0.0',
    generated: { by: 'dsh-mygo', version: '0.3.0', profile: 'web', at: '<t>' },
    manifestSha256: '',
    plugins: [{ id: 'calc', packageName: '@test/calc' }],
    lockfile: {
      format: 'dsh.lock/v1',
      generated: { by: 'dsh-mygo', version: '0.3.0', profile: 'web', at: '2026-08-12T00:00:00.000Z' },
      plugins: {
        calc: {
          version: '1.0.0',
          entry: 'lib/index.js',
          core: '*',
          depends: {},
          breaks: {},
          entrySha256: 'a'.repeat(64),
          manifestSha256: 'b'.repeat(64),
        },
      },
    },
    files: [{
      path: 'files/0.tgz',
      pluginId: 'calc',
      packageName: '@test/calc',
      sha512: 'c'.repeat(128),
      fileSize: 0,
    }],
    communityDeps: [],
    ...overrides,
  }
}

describe('pack manifest schema + 规范哈希', () => {
  it('canonical 载荷归一 generated.at，两次计算哈希一致', () => {
    const first = sampleManifest()
    const second = sampleManifest({
      generated: { by: 'dsh-mygo', version: '0.3.0', profile: 'web', at: '2026-08-12T01:00:00.000Z' },
      lockfile: {
        ...first.lockfile,
        generated: { ...first.lockfile.generated, at: '2026-08-12T01:00:00.000Z' },
      },
    })
    expect(canonicalPackPayload(first).generated).toMatchObject({ at: '<t>' })
    expect(computePackManifestSha256(first)).toBe(computePackManifestSha256(second))
    expect(computePackManifestSha256(first)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('parsePackManifest 往返保持同一规范哈希', () => {
    const manifest = { ...sampleManifest(), manifestSha256: computePackManifestSha256(sampleManifest()) }
    const parsed = parsePackManifest(JSON.parse(JSON.stringify(manifest)))
    expect(parsed.problems).toEqual([])
    expect(parsed.value).toBeDefined()
    expect(computePackManifestSha256(parsed.value as PackManifest)).toBe(manifest.manifestSha256)
  })

  it('拒绝 formatVersion 不兼容（T38 基础）', () => {
    const parsed = parsePackManifest({ ...sampleManifest(), formatVersion: 2 })
    expect(parsed.value).toBeUndefined()
    expect(parsed.problems.some(problem => problem.path === 'formatVersion')).toBe(true)
  })

  it('拒绝 files[].path 逃逸（T41 基础）', () => {
    const manifest = sampleManifest({
      files: [{ path: '../evil.tgz', pluginId: 'calc', packageName: '@test/calc', sha512: 'c'.repeat(128), fileSize: 0 }],
    })
    const parsed = parsePackManifest(manifest)
    expect(parsed.value).toBeUndefined()
    expect(parsed.problems.some(problem => problem.path === 'files[0].path')).toBe(true)
  })

  it('拒绝非法 communityDeps 与 lockfile 形状', () => {
    const badKind = parsePackManifest({
      ...sampleManifest(),
      communityDeps: [{ name: 'x', range: '*', kind: 'runtime', owner: 'calc' }],
    })
    expect(badKind.value).toBeUndefined()
    expect(badKind.problems.some(problem => problem.path === 'communityDeps[0].kind')).toBe(true)

    const badLock = parsePackManifest({
      ...sampleManifest(),
      lockfile: { format: 'dsh.lock/v1', generated: sampleManifest().lockfile.generated, plugins: { calc: { version: 1 } } },
    })
    expect(badLock.value).toBeUndefined()
    expect(badLock.problems.some(problem => problem.path === 'lockfile')).toBe(true)
  })
})

describe('tar 成员解析鲁棒性（design-r4 §3）', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mygo-pack-unit-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('换行文件名是一个成员而非两行（逐行白名单可被绕过的实证）', async () => {
    const src = join(root, 'src')
    await mkdir(src, { recursive: true })
    await writeFile(join(src, 'evil\nname.txt'), 'x')
    const tar = join(root, 'nl.tar')
    await execFileAsync('tar', ['-cf', tar, '-C', src, '.'])
    const parsed = listTarMembers(new Uint8Array(await readFile(tar)))
    expect(parsed.problems).toEqual([])
    const evil = parsed.members.filter(member => member.name.includes('\n'))
    expect(evil).toHaveLength(1)
    expect(evil[0]?.name).toBe('evil\nname.txt')
  })

  it('gzip 损坏 → problems 而非抛错', async () => {
    const parsed = listGzipTarMembers(new Uint8Array([1, 2, 3]))
    expect(parsed.members).toBeUndefined()
    expect(parsed.problems.length).toBeGreaterThan(0)
  })
})

describe('KF-1 分类修正（design-r4 §9 / B26）', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mygo-kf1-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-cordis-fabric',
      peerDependencies: { '@deepseek-ai/dsh-tools': '*' },
    }))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function writeSource(content: string): Promise<void> {
    await writeFile(join(root, 'src', 'a.ts'), content)
  }

  it('无声明信息时整包扫描仍抓全部 @deepseek-ai import', async () => {
    await writeSource("import { defineTool } from '@deepseek-ai/dsh-tools'\n")
    const problems = await detectUndeclaredBundles(root, [])
    expect(problems.some(problem => problem.includes('dsh-tools'))).toBe(true)
  })

  it('npm 声明内 + 自身包名不误伤；未声明仍硬错', async () => {
    await writeSource([
      "import { defineTool } from '@deepseek-ai/dsh-tools'\n",
      "import type { Agent } from '@deepseek-ai/dsh-agent'\n",
      "import { api } from '@deepseek-ai/dsh-cordis-fabric/api'\n",
      "import { ghost } from '@deepseek-ai/ghost'\n",
    ].join(''))
    const declared = new Set(['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent'])
    const problems = await detectUndeclaredBundles(root, [], {
      declaredSpecifiers: declared,
      selfPackageName: '@deepseek-ai/dsh-cordis-fabric',
    })
    expect(problems.some(problem => problem.includes('dsh-tools'))).toBe(false)
    expect(problems.some(problem => problem.includes('dsh-agent'))).toBe(false)
    expect(problems.some(problem => problem.includes('dsh-cordis-fabric'))).toBe(false)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('@deepseek-ai/ghost')
  })

  it('子路径 import 按包名归一后命中声明', async () => {
    await writeSource("import type { Command } from '@deepseek-ai/dsh-tools/client'\n")
    const problems = await detectUndeclaredBundles(root, [], {
      declaredSpecifiers: new Set(['@deepseek-ai/dsh-tools']),
    })
    expect(problems).toEqual([])
  })
})
