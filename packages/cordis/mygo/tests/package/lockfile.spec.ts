/**
 * lockfile 测试：写入原子性、版本+哈希校验、篡改检测、registry 无关性。
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  integritySha512Hex,
  readLockfile,
  sha256File,
  sha256Text,
  verifyLockfile,
  writeLockfile,
} from '../../src/package/lockfile.ts'
import { packageDir, resolveMygoPaths } from '../../src/package/paths.ts'
import type { Lockfile } from '../../src/package/lockfile.ts'

describe('lockfile', () => {
  let root: string
  let paths: ReturnType<typeof resolveMygoPaths>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mygo-lock-'))
    paths = resolveMygoPaths('web', { DSH_HOME: root })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function seed(entryContent: string): Promise<Lockfile> {
    const dir = packageDir(paths, 'tool', '1.2.3')
    await mkdir(join(dir, 'lib'), { recursive: true })
    await writeFile(join(dir, 'lib', 'index.js'), entryContent)
    const manifest = JSON.stringify({ id: 'tool', version: '1.2.3', entry: 'lib/index.js' })
    await writeFile(join(dir, '.mygo-package.json'), manifest)
    const lockfile: Lockfile = {
      format: 'dsh.lock/v1',
      generated: { by: 'dsh-mygo', version: '0.2.1', profile: 'web', core: '0.0.1-rc.1', at: '2026-08-11T00:00:00Z' },
      plugins: {
        tool: {
          version: '1.2.3',
          entry: 'lib/index.js',
          core: '*',
          depends: {},
          breaks: {},
          // 修复批次 3（A3/DG-2）：新 schema 必填字段。
          requires: {},
          symbolAliases: {},
          entrySha256: await sha256File(join(dir, 'lib', 'index.js')),
          manifestSha256: await sha256File(join(dir, '.mygo-package.json')),
          entrySha512: 'c'.repeat(128),
          source: 'npm',
        },
      },
    }
    return lockfile
  }

  it('round-trips and verifies a clean installation', async () => {
    const lockfile = await seed('export default {}')
    const path = join(paths.lockfileDir, 'web.dsh.lock.json')
    await writeLockfile(path, lockfile)
    const loaded = await readLockfile(path)
    expect(loaded?.ok).toBe(true)
    if (loaded === undefined || !loaded.ok) return
    expect(loaded.lockfile.plugins.tool?.version).toBe('1.2.3')
    const verified = await verifyLockfile(paths, loaded.lockfile)
    expect(verified.ok).toBe(true)
  })

  it('detects entry tampering (hash mismatch)', async () => {
    const lockfile = await seed('export default {}')
    const dir = packageDir(paths, 'tool', '1.2.3')
    await writeFile(join(dir, 'lib', 'index.js'), 'export default { hacked: true }')
    const verified = await verifyLockfile(paths, lockfile)
    expect(verified.ok).toBe(false)
    if (verified.ok) return
    expect(verified.issues[0]?.reason).toContain('哈希不匹配')
  })

  it('detects a missing package directory', async () => {
    const lockfile = await seed('export default {}')
    await rm(packageDir(paths, 'tool', '1.2.3'), { recursive: true, force: true })
    const verified = await verifyLockfile(paths, lockfile)
    expect(verified.ok).toBe(false)
    if (verified.ok) return
    expect(verified.issues[0]?.reason).toContain('缺失')
  })

  it('is pure hash math (never consults a registry)', async () => {
    expect(sha256Text('abc')).toHaveLength(64)
  })

  it('parses npm integrity sha512-SRI into hex (B9/C5)', () => {
    const raw = 'sha512-' + Buffer.from('a'.repeat(64), 'hex').toString('base64')
    expect(integritySha512Hex(raw)).toBe('a'.repeat(64))
    expect(integritySha512Hex('sha1-abc')).toBeUndefined()
    expect(integritySha512Hex(undefined)).toBeUndefined()
  })

  it('rejects an escaping lockfile entry at load time (B10/T8)', async () => {
    const lockfile = await seed('export default {}')
    const escaped: Lockfile = {
      ...lockfile,
      plugins: {
        tool: {
          ...(lockfile.plugins.tool as NonNullable<typeof lockfile.plugins.tool>),
          entry: '../outside.js',
        },
      },
    }
    const verified = await verifyLockfile(paths, escaped)
    expect(verified.ok).toBe(false)
    if (verified.ok) return
    expect(verified.issues[0]?.reason).toContain('逃逸')
  })
})

describe('lockfile 形状校验（修复批次 3 / A12 显式演进）', () => {
  let root: string
  let paths: ReturnType<typeof resolveMygoPaths>
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mygo-lock-shape-'))
    paths = resolveMygoPaths('web', { DSH_HOME: root })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function seed(entryContent: string): Promise<Lockfile> {
    const dir = packageDir(paths, 'tool', '1.2.3')
    await mkdir(join(dir, 'lib'), { recursive: true })
    await writeFile(join(dir, 'lib', 'index.js'), entryContent)
    await writeFile(join(dir, '.mygo-package.json'), JSON.stringify({ id: 'tool', version: '1.2.3', entry: 'lib/index.js' }))
    return {
      format: 'dsh.lock/v1',
      generated: { by: 'dsh-mygo', version: '0.2.1', profile: 'web', core: '0.0.1-rc.1', at: '2026-08-11T00:00:00Z' },
      plugins: {
        tool: {
          version: '1.2.3',
          entry: 'lib/index.js',
          core: '*',
          depends: {},
          breaks: {},
          requires: {},
          symbolAliases: {},
          entrySha256: await sha256File(join(dir, 'lib', 'index.js')),
          manifestSha256: await sha256File(join(dir, '.mygo-package.json')),
          entrySha512: 'c'.repeat(128),
          source: 'npm',
        },
      },
    }
  }

  it('畸形矩阵：非对象 / 缺字段 / 字段错类型 → 显式问题（带字段指针，非崩溃非静默）', async () => {
    const path = join(paths.lockfileDir, 'web.dsh.lock.json')
    await mkdir(paths.lockfileDir, { recursive: true })

    const notObject = async (): Promise<string> => {
      await writeFile(path, '42')
      const result = await readLockfile(path)
      return result !== undefined && !result.ok ? result.problem : ''
    }
    expect(await notObject()).toContain('lockfile 不是对象')

    const missingFields = async (): Promise<string> => {
      await writeFile(path, JSON.stringify({
        format: 'dsh.lock/v1',
        generated: { by: 'dsh-mygo', version: '0.3.0', profile: 'web', at: '<t>' },
        plugins: { a: { version: '1.0.0', entry: 'lib/index.js', core: '*', depends: {}, breaks: {}, entrySha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) } },
      }))
      const result = await readLockfile(path)
      return result !== undefined && !result.ok ? result.problem : ''
    }
    // 旧 schema（本批前格式）：缺 requires / symbolAliases / entrySha512 → 显式指引。
    const missing = await missingFields()
    expect(missing).toContain('plugins.a.requires')
    expect(missing).toContain('plugins.a.entrySha512')
    expect(missing).toContain('重新 restore/重装')

    const wrongTypes = async (): Promise<string> => {
      await writeFile(path, JSON.stringify({
        format: 'dsh.lock/v1',
        generated: { by: 'dsh-mygo', version: '0.3.0', profile: 'web', at: '<t>' },
        plugins: {
          a: {
            version: 1, entry: 'lib/index.js', core: '*',
            depends: 'not-a-map', breaks: {},
            requires: { svc: 42 }, symbolAliases: {},
            entrySha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), entrySha512: 'c'.repeat(128),
          },
        },
      }))
      const result = await readLockfile(path)
      return result !== undefined && !result.ok ? result.problem : ''
    }
    const wrong = await wrongTypes()
    expect(wrong).toContain('plugins.a.version')
    expect(wrong).toContain('plugins.a.depends')
    expect(wrong).toContain('plugins.a.requires')

    const badJson = async (): Promise<string> => {
      await writeFile(path, '{oops')
      const result = await readLockfile(path)
      return result !== undefined && !result.ok ? result.problem : ''
    }
    expect(await badJson()).toContain('不是合法 JSON')
  })

  it('verifyAtBoot 对旧 schema lockfile 显式 lockfile-mismatch（含 restore 指引）', async () => {
    const { PluginPackageManager } = await import('../../src/package/package-manager.ts')
    const manager = new PluginPackageManager({
      paths,
      profile: 'web',
      coreVersion: '0.0.1-rc.1',
      managerVersion: '0.3.0',
    })
    await mkdir(paths.lockfileDir, { recursive: true })
    await writeFile(join(paths.lockfileDir, 'web.dsh.lock.json'), JSON.stringify({
      format: 'dsh.lock/v1',
      generated: { by: 'dsh-mygo', version: '0.3.0', profile: 'web', at: '<t>' },
      plugins: { old: { version: '1.0.0', entry: 'lib/index.js', core: '*', depends: {}, breaks: {}, entrySha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) } },
    }))
    const verified = await manager.verifyAtBoot()
    expect(verified.ok).toBe(false)
    if (verified.ok) return
    expect(verified.report.code).toBe('lockfile-mismatch')
    expect(verified.report.summary).toContain('plugins.old.requires')
    expect(verified.report.summary).toContain('重新 restore/重装')
  })

  it('DG-2：新 schema 的 entrySha512（入口哈希）与 tarballSha512（tarball 哈希）各自校验', async () => {
    const path = join(paths.lockfileDir, 'web.dsh.lock.json')
    await mkdir(paths.lockfileDir, { recursive: true })
    const entry = await seed('export default {}')
    const withTarball: Lockfile = {
      ...entry,
      plugins: {
        tool: { ...(entry.plugins.tool as NonNullable<typeof entry.plugins.tool>), tarballSha512: 'e'.repeat(128) },
      },
    }
    await writeLockfile(path, withTarball)
    const loaded = await readLockfile(path)
    expect(loaded?.ok).toBe(true)
    if (loaded === undefined || !loaded.ok) return
    expect(loaded.lockfile.plugins.tool?.entrySha512).toBe('c'.repeat(128))
    expect(loaded.lockfile.plugins.tool?.tarballSha512).toBe('e'.repeat(128))
    // entrySha512 字段错类型 → 显式问题。
    const bad = await readLockfile(path)
    expect(bad?.ok).toBe(true)
    const tampered: Lockfile = {
      ...entry,
      plugins: {
        tool: { ...(entry.plugins.tool as NonNullable<typeof entry.plugins.tool>), entrySha512: 'not-hex' },
      },
    }
    await writeLockfile(path, tampered)
    const rejected = await readLockfile(path)
    expect(rejected?.ok).toBe(false)
    if (rejected === undefined || rejected.ok) return
    expect(rejected.problem).toContain('plugins.tool.entrySha512')
  })
})
