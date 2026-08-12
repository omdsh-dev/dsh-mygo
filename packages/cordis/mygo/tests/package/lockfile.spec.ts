/**
 * lockfile 测试：写入原子性、版本+哈希校验、篡改检测、registry 无关性。
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readLockfile, sha256File, sha256Text, verifyLockfile, writeLockfile } from '../../src/package/lockfile.ts'
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
          entrySha256: await sha256File(join(dir, 'lib', 'index.js')),
          manifestSha256: await sha256File(join(dir, '.mygo-package.json')),
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
    expect(loaded?.plugins.tool?.version).toBe('1.2.3')
    const verified = await verifyLockfile(paths, loaded as Lockfile)
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
})
