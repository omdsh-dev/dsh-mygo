/**
 * PluginEnv capability boundaries (#16, §3/§17/§18): the file-access gate
 * with write⊃read implication and runtime `..`/symlink normalization, the
 * network allowlist gate, the per-plugin registration quotas, and the
 * rate-limited logger. Every denial is a synchronous `PluginError` from the
 * shared template vocabulary and precedes any actual I/O or network call.
 * @module @deepseek-ai/dsh-mygo/src/capabilities
 */

import { readFile, writeFile, realpath as fsRealpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { PluginError, formatPluginError } from '@deepseek-ai/dsh-mygo-api'
import type { FileAccessEntry, Logger, PluginEnv, PluginErrorCode } from '@deepseek-ai/dsh-mygo-api'
import { coveredByNetworkGrants } from './mount.ts'
import type { PluginGrants } from './types.ts'

/** Host I/O seam for the `env.fs` boundary; the node implementation is the default. */
export interface PluginIo {
  /** Read one file's bytes. */
  read(path: string): Promise<Uint8Array>
  /** Write one file's bytes. */
  write(path: string, data: Uint8Array): Promise<void>
  /** Resolve symlinks to a canonical absolute path. */
  realpath(path: string): Promise<string>
}

/** Default `PluginIo` over Node's `fs/promises`. */
export const nodePluginIo: PluginIo = {
  read: path => readFile(path),
  write: (path, data) => writeFile(path, data),
  realpath: path => fsRealpath(path),
}

/** Per-plugin registration-effect counters shared across scope layers. */
export interface PluginEffectQuota {
  listeners: number
  tools: number
  services: number
}

/**
 * Normalize one path for gate comparison: `\` → `/`, `..` collapsed, absolute.
 * @param path - request path in host form.
 * @returns the normalized absolute gate path.
 */
export function normalizeGatePath(path: string): string {
  const normalized = resolve(path.replace(/\\/g, '/')).replace(/\/+$/, '')
  return normalized.length === 0 ? '/' : normalized
}

/**
 * Path-boundary prefix: `/project` covers `/project` and `/project/x`, never `/projectile`.
 * @param base - normalized grant base path.
 * @param path - normalized request path.
 * @returns true when `base` is a path-boundary prefix of `path`.
 */
export function pathPrefixCovers(base: string, path: string): boolean {
  if (path === base) return true
  const boundary = base.endsWith('/') ? base : `${base}/`
  return path.startsWith(boundary)
}

/**
 * The runtime file-access verdict (SEC:149, decision #9): a grant covers a
 * request when its mode implies the requested mode (`write` ⊇ `read`) and
 * its normalized path is a path-boundary prefix of the request path.
 * @param path - request path in host form.
 * @param entries - deployment `fileAccess` entries, or `undefined` for none.
 * @returns the strongest granted mode, or `undefined` when nothing covers.
 */
export function fileModeForPath(
  path: string,
  entries: readonly FileAccessEntry[] | undefined,
): 'read' | 'write' | undefined {
  if (entries === undefined) return undefined
  const requested = normalizeGatePath(path)
  let allowed: 'read' | 'write' | undefined
  for (const [grantMode, base] of entries) {
    if (!pathPrefixCovers(normalizeGatePath(base), requested)) continue
    if (grantMode === 'write') return 'write'
    allowed = 'read'
  }
  return allowed
}

/**
 * Throw `fs-denied` when the lexical path is outside the grant set.
 * @param path - request path in host form.
 * @param required - requested access mode.
 * @param entries - deployment `fileAccess` entries, or `undefined` for none.
 * @param pluginId - owning plugin id for error attribution.
 */
export function assertFileMode(
  path: string,
  required: 'read' | 'write',
  entries: readonly FileAccessEntry[] | undefined,
  pluginId: string,
): void {
  const allowed = fileModeForPath(path, entries)
  if (allowed === undefined || (required === 'write' && allowed !== 'write')) {
    throw fail('fs-denied', { plugin: pluginId, path: normalizeGatePath(path), mode: required }, pluginId)
  }
}

/**
 * Resolve symlinks along the longest existing ancestor and append the rest.
 * @param path - request path in host form.
 * @param io - host I/O seam providing `realpath`.
 * @returns the fully resolved real path.
 */
export async function realPathOf(path: string, io: PluginIo): Promise<string> {
  let candidate = normalizeGatePath(path)
  const suffix: string[] = []
  for (;;) {
    try {
      const resolved = await io.realpath(candidate)
      if (suffix.length === 0) return resolved
      return normalizeGatePath(join(resolved, ...suffix.reverse()))
    } catch {
      const parent = dirname(candidate)
      if (parent === candidate) throw new Error(`no existing ancestor for ${path}`)
      suffix.push(basename(candidate))
      candidate = parent
    }
  }
}

/**
 * Build the `env.fs` boundary for one plugin. The lexical check throws
 * synchronously before any I/O; a symlink-resolved real path is re-checked
 * against real-resolved grant bases before the host read/write is called.
 * @param pluginId - owning plugin id for `fs-denied` attribution.
 * @param grants - the deployment grant set executed at runtime (§17 rule 1).
 * @param io - host I/O seam; denied requests never reach it.
 * @returns the gated fs surface.
 */
export function createPluginFs(pluginId: string, grants: PluginGrants | undefined, io: PluginIo): PluginEnv['fs'] {
  const entries = grants?.fileAccess
  const granted = entries ?? []
  const realBases = new Map<string, string>()
  const realBase = async (base: string): Promise<string> => {
    const cached = realBases.get(base)
    if (cached !== undefined) return cached
    const resolved = await realPathOf(base, io)
    realBases.set(base, resolved)
    return resolved
  }
  const gate = async (path: string, required: 'read' | 'write'): Promise<string> => {
    const lexical = normalizeGatePath(path)
    const real = await realPathOf(lexical, io)
    let allowed: 'read' | 'write' | undefined
    for (const [grantMode, base] of granted) {
      if (!pathPrefixCovers(await realBase(base), real)) continue
      if (grantMode === 'write') {
        allowed = 'write'
        break
      }
      allowed = 'read'
    }
    if (allowed === undefined || (required === 'write' && allowed !== 'write')) {
      throw fail('fs-denied', { plugin: pluginId, path: real, mode: required }, pluginId)
    }
    return real
  }
  return {
    read: (path: string): Promise<Uint8Array> => {
      assertFileMode(path, 'read', entries, pluginId)
      return gate(path, 'read').then(real => io.read(real))
    },
    write: (path: string, data: Uint8Array | string): Promise<void> => {
      assertFileMode(path, 'write', entries, pluginId)
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
      return gate(path, 'write').then(real => io.write(real, bytes))
    },
  }
}

/**
 * Runtime network allowlist (SEC:150): the request URL must start at an allow
 * entry's scheme/host boundary, mirroring the mount-time coverage rule.
 * @param url - request URL to test.
 * @param allow - deployment `networkAccess.allow` entries, or `undefined`.
 * @returns true when a boundary prefix of `url` is allowlisted.
 */
export function networkUrlAllowed(url: string, allow: readonly string[] | undefined): boolean {
  return coveredByNetworkGrants(url, allow)
}

/**
 * Build the `env.fetch` boundary for one plugin: the allowlist check throws
 * synchronously (`network-denied`) before the host fetch is invoked.
 * @param pluginId - owning plugin id for `network-denied` attribution.
 * @param grants - the deployment grant set executed at runtime (§17 rule 1).
 * @param fetchImpl - host fetch; denied requests never reach it.
 * @returns the gated fetch function.
 */
export function createNetworkFetch(
  pluginId: string,
  grants: PluginGrants | undefined,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): (url: string, init?: RequestInit) => Promise<Response> {
  return (url, init) => {
    if (!networkUrlAllowed(url, grants?.networkAccess?.allow)) {
      throw fail('network-denied', { plugin: pluginId, url }, pluginId)
    }
    return fetchImpl(url, init)
  }
}

/**
 * Registration-effect quotas (§18): 100 listeners / 50 tools / 20 services.
 * @param quota - per-plugin counters shared across scope layers.
 * @param kind - which quota bucket to claim.
 * @param pluginId - owning plugin id for error attribution.
 */
export function claimEffect(
  quota: PluginEffectQuota,
  kind: 'listener' | 'tool' | 'service',
  pluginId: string,
): void {
  const key = kind === 'listener' ? 'listeners' : kind === 'tool' ? 'tools' : 'services'
  const limit = kind === 'listener' ? 100 : kind === 'tool' ? 50 : 20
  if (quota[key] >= limit) {
    throw fail('quota-effects-exceeded', { kind, limit }, pluginId)
  }
  quota[key] += 1
}

/**
 * Rate-limited logger (SEC:71): at most 1000 lines per plugin per minute;
 * excess lines are dropped and the plugin is warned once per window.
 * @param raw - the engine's logger.
 * @param now - clock for the minute window.
 * @returns the gated logger handed to one plugin.
 */
export function createRateLimitedLogger(raw: Logger, now: () => number): Logger {
  let windowStart = now()
  let count = 0
  let warned = false
  const emit = (method: 'error' | 'info' | 'warn' | 'debug', format: unknown, params: unknown[]): void => {
    const current = now()
    if (current - windowStart >= 60_000) {
      windowStart = current
      count = 0
      warned = false
    }
    if (count >= 1000) {
      if (!warned) {
        raw.warn('plugin log rate limit exceeded (1000 lines/minute); further lines are dropped until the next minute')
        warned = true
      }
      return
    }
    count += 1
    raw[method](format, ...params)
  }
  return {
    error: (format, ...params) => { emit('error', format, params) },
    info: (format, ...params) => { emit('info', format, params) },
    warn: (format, ...params) => { emit('warn', format, params) },
    debug: (format, ...params) => { emit('debug', format, params) },
  }
}

/** Build a `PluginError` with the shared template vocabulary. */
function fail(
  code: PluginErrorCode,
  details: Record<string, unknown>,
  pluginId: string | undefined,
): PluginError {
  return new PluginError(code, formatPluginError(code, details), details, pluginId)
}
