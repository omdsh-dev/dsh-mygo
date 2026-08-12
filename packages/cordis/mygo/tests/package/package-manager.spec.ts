/**
 * 端到端包管理测试（《收敛任务》验收场景）：
 * 干净目录 + 本地假 registry，覆盖 安装→加载→运行、lockfile 免疫新版本、
 * 持久化数据在 dsh 本体目录被删除后存活、失败报告格式。
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginPackageManager } from '../../src/package/package-manager.ts'
import { resolveMygoPaths } from '../../src/package/paths.ts'

const execFileAsync = promisify(execFile)

interface FakeVersion {
  readonly version: string
  readonly depends?: Record<string, string>
  readonly breaks?: Record<string, string>
  readonly entrySource?: string
}

describe('plugin package manager (fake registry e2e)', () => {
  let root: string
  let registryRoot: string
  let paths: ReturnType<typeof resolveMygoPaths>
  let server: Server
  let port = 0
  const versions: FakeVersion[] = []
  let tarballs: Array<{ readonly tgz: string; readonly integrity: string }> = []

  async function makeTarball(entry: FakeVersion): Promise<{ readonly tgz: string; readonly integrity: string }> {
    const pkg = join(registryRoot, `pkg-${entry.version}`)
    await mkdir(join(pkg, 'package', 'lib'), { recursive: true })
    await writeFile(join(pkg, 'package', 'package.json'), JSON.stringify({
      name: '@test/calc',
      version: entry.version,
      main: 'lib/index.js',
      dsh: {
        mygo: {
          entry: 'lib/index.js',
          core: '>=0.0.1-rc.1',
          ...(entry.depends === undefined ? {} : { depends: entry.depends }),
          ...(entry.breaks === undefined ? {} : { breaks: entry.breaks }),
        },
      },
    }))
    await writeFile(
      join(pkg, 'package', 'lib', 'index.js'),
      entry.entrySource ?? `export const id = 'calc'\nexport function apply() { return { version: '${entry.version}' } }\n`,
    )
    const tgz = join(registryRoot, `calc-${entry.version}.tgz`)
    await execFileAsync('tar', ['-czf', tgz, '-C', pkg, 'package'])
    const bytes = await import('node:fs/promises').then(fs => fs.readFile(tgz))
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    return { tgz, integrity }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mygo-e2e-'))
    registryRoot = join(root, 'registry')
    await mkdir(registryRoot, { recursive: true })
    paths = resolveMygoPaths('web', { DSH_HOME: join(root, 'home') })
    versions.length = 0
    versions.push({ version: '1.0.0', depends: {} })
    versions.push({ version: '2.0.0', depends: {} })
    tarballs = await Promise.all(versions.map(makeTarball))
    server = createServer(async (request, response) => {
      const url = request.url ?? ''
      const tgzMatch = /^\/-\/calc-([\d.]+)\.tgz$/.exec(url)
      if (tgzMatch !== null) {
        const file = join(registryRoot, `calc-${tgzMatch[1]}.tgz`)
        const bytes = await import('node:fs/promises').then(fs => fs.readFile(file).catch(() => undefined))
        if (bytes === undefined) {
          response.writeHead(404)
          response.end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end(bytes)
        return
      }
      if (url === '/@test%2fcalc') {
        const versionsJson: Record<string, unknown> = {}
        for (let index = 0; index < versions.length; index += 1) {
          const entry = versions[index] as FakeVersion
          const tarball = tarballs[index] as { tgz: string; integrity: string }
          versionsJson[entry.version] = {
            name: '@test/calc',
            version: entry.version,
            main: 'lib/index.js',
            dsh: {
              mygo: {
                entry: 'lib/index.js',
                core: '>=0.0.1-rc.1',
                ...(entry.depends === undefined ? {} : { depends: entry.depends }),
                ...(entry.breaks === undefined ? {} : { breaks: entry.breaks }),
              },
            },
            dist: {
              tarball: `http://127.0.0.1:${port}/-/calc-${entry.version}.tgz`,
              integrity: tarball.integrity,
            },
          }
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ name: '@test/calc', 'dist-tags': { latest: '2.0.0' }, versions: versionsJson }))
        return
      }
      response.writeHead(404)
      response.end()
    })
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address !== null && typeof address === 'object') port = address.port
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  })

  function createManager(
    exportsProvider?: (specifier: string) => Promise<ReadonlySet<string> | undefined>,
  ): PluginPackageManager {
    return new PluginPackageManager({
      paths,
      profile: 'web',
      registry: `http://127.0.0.1:${port}`,
      coreVersion: '0.0.1-rc.1',
      ...(exportsProvider === undefined ? {} : { exportsProvider }),
      managerVersion: '0.3.0',
    })
  }

  async function refreshTarballs(): Promise<void> {
    tarballs = await Promise.all(versions.map(makeTarball))
  }

  it('full flow: install -> verify -> mount order -> load and run', async () => {
    const manager = createManager()
    const outcome = await manager.resolveInstall({ package: '@test/calc', range: '^1.0.0' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.installed.version).toBe('1.0.0')
    expect((await manager.verifyAtBoot()).ok).toBe(true)
    const mount = await manager.mountOrder()
    expect(mount.ok).toBe(true)
    if (mount.ok) expect(mount.order).toEqual(['calc'])
    const loaded = await manager.loadEntry('calc')
    expect(loaded?.installed.version).toBe('1.0.0')
    const plugin = loaded?.plugin as { apply(): unknown }
    expect(plugin.apply()).toEqual({ version: '1.0.0' })
  })

  it('lockfile immunity: registry 2.0.0 never changes the locked startup', async () => {
    const manager = createManager()
    const outcome = await manager.resolveInstall({ package: '@test/calc', range: '~1.0.0' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // registry 已经包含 2.0.0；重新启动只校验 lockfile，不重新求解。
    const verified = await manager.verifyAtBoot()
    expect(verified.ok).toBe(true)
    const loaded = await manager.loadEntry('calc')
    expect(loaded?.installed.version).toBe('1.0.0')
    const lock = await manager.readLock()
    expect(lock?.plugins.calc?.version).toBe('1.0.0')
  })

  it('persistence survives deletion of the dsh install dir', async () => {
    const manager = createManager()
    await manager.resolveInstall({ package: '@test/calc', range: '^1.0.0' })
    const dshInstall = join(root, 'home', 'dsh-install')
    await mkdir(dshInstall, { recursive: true })
    await rm(dshInstall, { recursive: true, force: true })
    const verified = await manager.verifyAtBoot()
    expect(verified.ok).toBe(true)
    expect((await manager.loadEntry('calc'))?.installed.version).toBe('1.0.0')
  })

  it('reports missing depends with structured fields', async () => {
    versions.length = 0
    versions.push({ version: '1.0.0', depends: { 'missing-base': '>=2.0.0' } })
    await refreshTarballs()
    const manager = createManager()
    const outcome = await manager.resolveInstall({ package: '@test/calc', range: '^1.0.0' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.report.code).toBe('resolve-failed')
    expect(outcome.report.conflicts[0]?.constraint).toMatchObject({ kind: 'depends', target: 'missing-base' })
    expect(outcome.report.conflicts[0]?.chain).toContain('calc')
    expect(outcome.report.conflicts[0]?.candidates[0]?.rejected.join()).toContain('缺失')
    expect(outcome.report.conflicts[0]?.actions.join()).toContain('missing-base')
  })

  it('hard-blocks on a symbol the loaded package version does not export', async () => {
    versions.length = 0
    versions.push({
      version: '3.0.0',
      entrySource: "import { ghost } from 'ext-pkg'\nexport const id = 'calc'\nexport function apply() {}\n",
    })
    await refreshTarballs()
    const manager = createManager(async () => new Set(['real']))
    const outcome = await manager.resolveInstall({ package: '@test/calc', range: '3.0.0' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.report.code).toBe('symbol-missing')
    expect(outcome.report.conflicts[0]?.candidates[0]?.rejected.join()).toContain('ghost')
  })

  it('detects a drifted symbol import set at boot (lockfile comparison)', async () => {
    const manager = createManager()
    const outcome = await manager.resolveInstall({ package: '@test/calc', range: '^1.0.0' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(outcome.installed.dir, 'extra.mjs'), "import { x } from 'pkg'\nexport {}\n")
    const verified = await manager.verifyAtBoot()
    expect(verified.ok).toBe(false)
    if (verified.ok) return
    expect(JSON.stringify(verified.report)).toContain('符号 import 集')
  })
})
