/**
 * PluginEnv capability boundaries (#16, §3/§17/§18): fileAccess with the
 * write⊃read implication and runtime `..`/symlink normalization (SEC:149),
 * networkAccess boundary matching (SEC:150), registration quotas, the
 * rate-limited logger (SEC:71), and denial-before-I/O ordering.
 */

import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginError } from '@deepseek-ai/dsh-mygo-api'
import {
  assertFileMode,
  claimEffect,
  createNetworkFetch,
  createPluginFs,
  createRateLimitedLogger,
  fileModeForPath,
  networkUrlAllowed,
  nodePluginIo,
  normalizeGatePath,
  pathPrefixCovers,
  realPathOf,
  type PluginEffectQuota,
  type PluginIo,
} from '@deepseek-ai/dsh-mygo'

describe('fileAccess vocabulary and write⊃read implication (decision #9)', () => {
  it('grants read from a read entry and never lets a read entry imply write', () => {
    const entries = [['read', '/project']] as const
    expect(fileModeForPath('/project', entries)).toBe('read')
    expect(fileModeForPath('/project/a.txt', entries)).toBe('read')
    expect(fileModeForPath('/etc/passwd', entries)).toBeUndefined()
    expect(fileModeForPath('/projectile/x', entries)).toBeUndefined()
    expect(() => { assertFileMode('/project/a.txt', 'write', entries, 'p') }).toThrow(/write on \/project\/a\.txt is outside fileAccess/)
  })

  it('write implies read at the same path and wins over a read entry', () => {
    const entries = [['read', '/project'], ['write', '/project/logs']] as const
    expect(fileModeForPath('/project/a.txt', entries)).toBe('read')
    expect(fileModeForPath('/project/logs/x', entries)).toBe('write')
    expect(fileModeForPath('/project/logs/x', [['write', '/project']] as const)).toBe('write')
    assertFileMode('/project/logs/x', 'read', entries, 'p')
    assertFileMode('/project/logs/x', 'write', entries, 'p')
    expect(() => { assertFileMode('/project/a.txt', 'write', entries, 'p') }).toThrow(PluginError)
  })

  it('denies with fs-denied details naming plugin, normalized path, and required mode', () => {
    const entries = [['read', '/project']] as const
    try {
      assertFileMode('/etc/passwd', 'read', entries, 'p')
      throw new Error('expected fs-denied')
    } catch (error) {
      expect(error).toBeInstanceOf(PluginError)
      expect((error as PluginError).code).toBe('fs-denied')
      expect((error as PluginError).details).toEqual({ plugin: 'p', path: '/etc/passwd', mode: 'read' })
      expect((error as PluginError).pluginId).toBe('p')
    }
  })

  it('normalizes .. and trailing separators before boundary comparison', () => {
    const entries = [['read', '/project']] as const
    expect(normalizeGatePath('/')).toBe('/')
    expect(normalizeGatePath('/project/../etc/passwd')).toBe('/etc/passwd')
    expect(normalizeGatePath('/project//a/')).toBe('/project/a')
    expect(fileModeForPath('/project/../project/a', entries)).toBe('read')
    expect(fileModeForPath('/project/../etc/passwd', entries)).toBeUndefined()
    expect(pathPrefixCovers('/project', '/project')).toBe(true)
    expect(pathPrefixCovers('/project', '/project/a')).toBe(true)
    expect(pathPrefixCovers('/project', '/projectile/a')).toBe(false)
    expect(pathPrefixCovers('/', '/etc/passwd')).toBe(true)
  })

  it('denies an empty or absent grant set', () => {
    expect(fileModeForPath('/project/a', undefined)).toBeUndefined()
    expect(() => { assertFileMode('/project/a', 'read', undefined, 'p') }).toThrow(PluginError)
  })
})

describe('networkAccess boundary matching (SEC:150)', () => {
  it('covers the same host and subpaths but never a host suffix', () => {
    const allow = ['https://example.dev']
    expect(networkUrlAllowed('https://example.dev', allow)).toBe(true)
    expect(networkUrlAllowed('https://example.dev/api', allow)).toBe(true)
    expect(networkUrlAllowed('https://example.dev.evil/x', allow)).toBe(false)
    expect(networkUrlAllowed('http://example.dev/x', allow)).toBe(false)
    expect(networkUrlAllowed('ftp://example.dev/x', allow)).toBe(false)
  })

  it('honors an entry path prefix and an absent allowlist', () => {
    expect(networkUrlAllowed('https://example.dev/api/v1', ['https://example.dev/api'])).toBe(true)
    expect(networkUrlAllowed('https://example.dev/other', ['https://example.dev/api'])).toBe(false)
    expect(networkUrlAllowed('https://example.dev', undefined)).toBe(false)
  })

  it('denies before the host fetch runs and forwards allowed requests', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok'))
    const fetch = createNetworkFetch('p', { networkAccess: { allow: ['https://example.dev'] } }, fetchImpl)
    expect(() => fetch('https://evil.dev/x')).toThrow(PluginError)
    expect(fetchImpl).not.toHaveBeenCalled()
    const response = await fetch('https://example.dev/api')
    expect(await response.text()).toBe('ok')
    expect(fetchImpl).toHaveBeenCalledWith('https://example.dev/api', undefined)
  })
})

describe('createPluginFs gate ordering', () => {
  it('denies lexically outside paths synchronously before any io call', () => {
    const read = vi.fn(async () => new Uint8Array())
    const write = vi.fn(async () => {})
    const realpath = vi.fn(async (path: string) => path)
    const io: PluginIo = {
      read,
      write,
      realpath,
    }
    const fs = createPluginFs('p', { fileAccess: [['read', '/project']] }, io)
    expect(() => fs.read('/etc/passwd')).toThrow(PluginError)
    expect(() => fs.read('/project/../etc/passwd')).toThrow(PluginError)
    expect(() => fs.write('/project/a', 'x')).toThrow(/write on \/project\/a is outside fileAccess/)
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('resolves symlinks and re-checks the real path before io', async () => {
    const read = vi.fn(async () => new Uint8Array())
    const write = vi.fn(async () => {})
    const realpath = vi.fn(async (path: string) => path === '/project/link' ? '/etc/passwd' : path)
    const io: PluginIo = {
      read,
      write,
      realpath,
    }
    const fs = createPluginFs('p', { fileAccess: [['read', '/project']] }, io)
    await expect(fs.read('/project/link')).rejects.toMatchObject({
      code: 'fs-denied',
      details: { plugin: 'p', path: '/etc/passwd', mode: 'read' },
    })
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('denies writes through a symlinked directory before io', async () => {
    const read = vi.fn(async () => new Uint8Array())
    const write = vi.fn(async () => {})
    const realpath = vi.fn(async (path: string) => path.startsWith('/project/etc-link') ? `/etc/${path.slice('/project/etc-link/'.length)}` : path)
    const io: PluginIo = {
      read,
      write,
      realpath,
    }
    const fs = createPluginFs('p', { fileAccess: [['write', '/project']] }, io)
    await expect(fs.write('/project/etc-link/new.txt', 'x')).rejects.toMatchObject({
      code: 'fs-denied',
      details: { path: '/etc/new.txt', mode: 'write' },
    })
    expect(write).not.toHaveBeenCalled()
  })

  it('reads and writes through an allowed real path, converting strings to bytes', async () => {
    const bytes = new TextEncoder().encode('ok')
    const read = vi.fn(async () => bytes)
    const write = vi.fn(async () => {})
    const realpath = vi.fn(async (path: string) => path)
    const io: PluginIo = {
      read,
      write,
      realpath,
    }
    const fs = createPluginFs('p', { fileAccess: [['write', '/project']] }, io)
    expect(await fs.read('/project/a')).toBe(bytes)
    expect(read).toHaveBeenCalledWith('/project/a')
    await fs.write('/project/b', 'text')
    expect(write).toHaveBeenCalledWith('/project/b', new TextEncoder().encode('text'))
    const rawBytes = new TextEncoder().encode('bytes')
    await fs.write('/project/c', rawBytes)
    expect(write).toHaveBeenCalledWith('/project/c', rawBytes)
  })

  it('resolves a symlinked grant root and caches the real base', async () => {
    const read = vi.fn(async () => new Uint8Array())
    const write = vi.fn(async () => {})
    const realpath = vi.fn(async (path: string) => {
      if (path === '/project') return '/data/project'
      throw new Error('missing')
    })
    const io: PluginIo = {
      read,
      write,
      realpath,
    }
    const fs = createPluginFs('p', { fileAccess: [['read', '/project']] }, io)
    expect(await fs.read('/project/x')).toBeInstanceOf(Uint8Array)
    expect(read).toHaveBeenCalledWith('/data/project/x')
    expect(realpath).toHaveBeenCalledTimes(3)
    await fs.read('/project/y')
    expect(realpath).toHaveBeenCalledTimes(5)
  })
})

describe('realPathOf', () => {
  it('walks to the longest existing ancestor and appends the missing suffix', async () => {
    const io: PluginIo = {
      read: async () => new Uint8Array(),
      write: async () => {},
      realpath: vi.fn(async (path: string) => {
        if (path === '/project') return '/real/project'
        throw new Error('missing')
      }),
    }
    await expect(realPathOf('/project/a/b', io)).resolves.toBe('/real/project/a/b')
  })

  it('rejects when no ancestor exists', async () => {
    const io: PluginIo = {
      read: async () => new Uint8Array(),
      write: async () => {},
      realpath: async () => { throw new Error('missing') },
    }
    await expect(realPathOf('/nope/a', io)).rejects.toThrow(/no existing ancestor/)
  })
})

describe('registration-effect quotas (§18)', () => {
  it('enforces 100 listeners / 50 tools / 20 services at the call point', () => {
    const quota: PluginEffectQuota = { listeners: 100, tools: 50, services: 20 }
    expect(() => { claimEffect(quota, 'listener', 'p') }).toThrow(/registration quota exceeded for listener: limit 100/)
    expect(() => { claimEffect(quota, 'tool', 'p') }).toThrow(/registration quota exceeded for tool: limit 50/)
    expect(() => { claimEffect(quota, 'service', 'p') }).toThrow(/registration quota exceeded for service: limit 20/)
  })

  it('increments counters while under the limit', () => {
    const quota: PluginEffectQuota = { listeners: 0, tools: 0, services: 0 }
    claimEffect(quota, 'listener', 'p')
    claimEffect(quota, 'tool', 'p')
    claimEffect(quota, 'service', 'p')
    expect(quota).toEqual({ listeners: 1, tools: 1, services: 1 })
  })
})

describe('rate-limited logger (SEC:71)', () => {
  it('forwards every severity to the raw logger while under the limit', () => {
    const raw = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
    const logger = createRateLimitedLogger(raw, () => 0)
    logger.error('error')
    logger.info('info')
    logger.warn('warn')
    logger.debug('debug')
    expect(raw.error).toHaveBeenCalledWith('error')
    expect(raw.info).toHaveBeenCalledWith('info')
    expect(raw.warn).toHaveBeenCalledWith('warn')
    expect(raw.debug).toHaveBeenCalledWith('debug')
  })

  it('drops the 1001st line per minute and warns the plugin once per window', () => {
    let now = 0
    const raw = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
    const logger = createRateLimitedLogger(raw, () => now)
    for (let index = 0; index < 1000; index += 1) logger.info('line', index)
    expect(raw.info).toHaveBeenCalledTimes(1000)
    logger.info('dropped')
    logger.warn('also dropped')
    expect(raw.info).toHaveBeenCalledTimes(1000)
    expect(raw.warn).toHaveBeenCalledTimes(1)
    expect(raw.warn).toHaveBeenCalledWith(expect.stringContaining('log rate limit exceeded'))
    now = 60_000
    logger.info('next minute')
    expect(raw.info).toHaveBeenCalledTimes(1001)
  })
})

describe('SEC:149 real-filesystem path boundary', () => {
  it('rejects /etc/passwd, ../ escapes, and symlink escapes under a /project grant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pm-'))
    const project = join(root, 'project')
    await mkdir(project)
    await writeFile(join(project, 'ok.txt'), 'ok')
    await symlink('/etc/passwd', join(project, 'escape'))
    await symlink('/etc', join(project, 'etc-link'))
    const fs = createPluginFs('p', { fileAccess: [['write', project]] }, nodePluginIo)
    try {
      expect(() => fs.read('/etc/passwd')).toThrow(/filesystem access denied for plugin p: read on \/etc\/passwd/)
      expect(() => fs.read(join(project, '..', 'secret'))).toThrow(/filesystem access denied/)
      expect(() => fs.read(join(project, '..', '..', 'etc', 'passwd'))).toThrow(/filesystem access denied/)
      await expect(fs.read(join(project, 'escape'))).rejects.toMatchObject({
        code: 'fs-denied',
        details: { plugin: 'p', path: '/etc/passwd', mode: 'read' },
      })
      await expect(fs.write(join(project, 'etc-link', 'new.txt'), 'x')).rejects.toMatchObject({
        code: 'fs-denied',
        details: { mode: 'write' },
      })
      expect(new TextDecoder().decode(await fs.read(join(project, 'ok.txt')))).toBe('ok')
      await fs.write(join(project, 'written.txt'), 'written')
      expect(new TextDecoder().decode(await fs.read(join(project, 'written.txt')))).toBe('written')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
