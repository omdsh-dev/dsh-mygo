/**
 * Mount-time validation chain (§16 group 1/2). Every rejection is a
 * `PluginError` whose code, message, and details come from the dsh-mygo-api
 * vocabulary; `pluginId` is always attributed to the source definition.
 * The harness event vocabulary is the generated `EVENT_VOCABULARY` — no
 * handwritten allowlist — and property/branch names resolve against each
 * event's real return type from the same Typert projection.
 * @module @deepseek-ai/dsh-mygo/src/mount
 */

import { PluginError, formatPluginError } from '@deepseek-ai/dsh-mygo-api'
import type {
  FileAccessEntry,
  PluginDefinition,
  PluginErrorCode,
} from '@deepseek-ai/dsh-mygo-api'
import { EVENT_VOCABULARY } from './event-vocabulary.ts'
import type { PluginEventVocabularyEntry } from './event-vocabulary.ts'
import { validateManifest } from './manifest.ts'
import type {
  MountValidationOptions,
  MountValidationResult,
  PermissionLevel,
  PluginGrants,
} from './types.ts'

/** Mode → maximum declared permission level (§7, #7-correction: serial allows intercept, never transform). */
const MODE_CEILING: Readonly<Record<string, PermissionLevel>> = {
  emit: 'observe',
  parallel: 'observe',
  serial: 'intercept',
  waterfall: 'transform',
}

/** Level ladder used by `ceiling-exceeded` (§15.6). */
const LEVEL_RANK: Readonly<Record<PermissionLevel, number>> = {
  observe: 0,
  transform: 1,
  intercept: 2,
  claims: 3,
}

/**
 * Validate one plugin manifest and declaration set at mount time (§16 group
 * 1/2). The first violation throws; a successful pass returns warnings the
 * caller must surface (16.4), currently only the `development-mode`
 * provenance bypass (SEC:158).
 * @param definition - the plugin manifest to mount.
 * @param options - source, channel identity/ceiling, grants, and deployment policy inputs.
 * @returns non-fatal warnings for the caller to log.
 */
export function validateMount(
  definition: PluginDefinition,
  options: MountValidationOptions,
): MountValidationResult {
  validateManifest(definition)
  const id = definition.id
  const vocabulary = options.vocabulary ?? EVENT_VOCABULARY
  const byEvent = new Map(vocabulary.map(entry => [entry.name, entry]))
  const warnings: string[] = []

  // 组 1：manifest 与声明校验（fiber 建立前）
  for (const event of declaredEvents(definition)) {
    const entry = byEvent.get(event)
    if (entry === undefined) {
      throw fail('event-not-mountable', { event, tier: 'harness' }, id)
    }
  }
  for (const declaration of definition.permissions.transform) {
    // Reachability of every declared event was established above.
    const entry = byEvent.get(declaration.event) as PluginEventVocabularyEntry
    if (entry.mode !== 'waterfall') {
      throw fail('mode-ceiling-exceeded', {
        event: declaration.event,
        mode: 'transform',
        // `entry.mode !== 'waterfall'` narrows to emit/parallel/serial, all
        // present in MODE_CEILING; noUncheckedIndexedAccess keeps the union.
        ceiling: MODE_CEILING[entry.mode],
      }, id)
    }
    validatePropertyNames(declaration.event, declaration.reads ?? [], entry, id)
    validatePropertyNames(declaration.event, declaration.writes ?? [], entry, id)
    validatePropertyNames(declaration.event, declaration.appends ?? [], entry, id)
  }
  for (const declaration of definition.permissions.intercept) {
    const entry = byEvent.get(declaration.event) as PluginEventVocabularyEntry
    if (entry.mode === 'emit' || entry.mode === 'parallel') {
      throw fail('mode-ceiling-exceeded', {
        event: declaration.event,
        mode: 'intercept',
        ceiling: 'observe',
      }, id)
    }
    for (const branch of declaration.returns) {
      if (!entry.branches.includes(branch)) {
        throw fail('unknown-property', {
          event: declaration.event,
          name: branch,
          valid: entry.branches,
        }, id)
      }
    }
  }
  for (const entry of [...definition.requires, ...definition.provides]) {
    if (entry.includes('@')) {
      throw fail('capability-range-reserved', { entry, note: 'v2 name@range' }, id)
    }
  }

  // 组 2：权限与授权（mount 期）
  if (options.origin === 'model' && options.source.type === 'npm') {
    throw fail('source-not-allowed', { channel: 'model', source: 'npm' }, id)
  }
  assertGrants(definition, options.grants, id)
  if (options.origin !== 'static') {
    const level = declaredLevel(definition)
    if (LEVEL_RANK[level] > LEVEL_RANK[options.channelCeiling]) {
      throw fail('ceiling-exceeded', {
        level,
        channel: options.origin,
        ceiling: options.channelCeiling,
      }, id)
    }
  }
  for (const declaration of definition.permissions.transform) {
    for (const name of declaration.writes ?? []) {
      const field = `${declaration.event}.${name}`
      if ((options.protectedFields ?? []).includes(field)) {
        throw fail('protected-field', { field }, id)
      }
    }
  }
  if (options.source.type === 'npm') {
    const scope = npmScope(options.source.package)
    const trusted = scope !== null && (options.trustedScopes ?? []).includes(scope)
    if (!trusted) {
      if (options.development === true) {
        warnings.push(`development-mode: provenance check skipped for package ${options.source.package}`)
      } else {
        throw fail('provenance-rejected', {
          source: options.source.package,
          missing: 'trusted scope or provenance attestation',
        }, id)
      }
    }
  }
  return { warnings }
}

/**
 * Reject direct `EventOptions` on `env.on` (§3/§16.2 `unsupported-event-option`):
 * the manifest `position` is the only listener-option entry. The #12 skeleton
 * owns the guard and its message; the env bridge wires it into `env.on` in the
 * PluginEnv capability stage (#16).
 * @param options - trailing arguments passed to `env.on` beyond `(event, listener)`.
 * @param pluginId - owning plugin id for error attribution, when known.
 */
export function assertEventOptions(options: readonly unknown[], pluginId?: string): void {
  if (options.length === 0) return
  const first = options[0]
  const option = typeof first === 'object' && first !== null
    ? Object.keys(first)[0] ?? ''
    : String(first)
  throw fail('unsupported-event-option', { option }, pluginId)
}

/** Build a `PluginError` from the shared template vocabulary. */
function fail(code: PluginErrorCode, details: Record<string, unknown>, pluginId?: string): PluginError {
  return new PluginError(code, formatPluginError(code, details), details, pluginId)
}

/** Every event named by observe/transform/intercept declarations. */
function declaredEvents(definition: PluginDefinition): string[] {
  return [
    ...definition.permissions.observe,
    ...definition.permissions.transform.map(declaration => declaration.event),
    ...definition.permissions.intercept.map(declaration => declaration.event),
  ]
}

/**
 * Validate transform property names against the event's real return type.
 * Payload-external well-formed names (`service:*`) take the
 * `non-payload-name` message; unknown payload names take `unknown-property`.
 */
function validatePropertyNames(
  event: string,
  names: readonly string[],
  entry: PluginEventVocabularyEntry,
  pluginId: string,
): void {
  for (const name of names) {
    if (name.includes(':')) {
      throw fail('non-payload-name', { name, boundary: 'payload properties only' }, pluginId)
    }
    if (!entry.properties.includes(name)) {
      throw fail('unknown-property', { event, name, valid: entry.properties }, pluginId)
    }
  }
}

/** The three grants rules (§17): declared-before-granted, channel ceiling, and static same-table. */
function assertGrants(definition: PluginDefinition, grants: PluginGrants | undefined, pluginId: string): void {
  if (definition.permissions.intercept.length > 0 && grants?.intercept !== true) {
    throw fail('grant-missing', { grant: 'intercept' }, pluginId)
  }
  if (definition.permissions.claims.length > 0 && grants?.claims !== true) {
    throw fail('grant-missing', { grant: 'claims' }, pluginId)
  }
  for (const entry of definition.fileAccess ?? []) {
    if (!coveredByFileGrants(entry, grants?.fileAccess)) {
      throw fail('grant-missing', { grant: `fileAccess ${entry[0]} ${entry[1]}` }, pluginId)
    }
  }
  for (const url of definition.networkAccess?.allow ?? []) {
    if (!coveredByNetworkGrants(url, grants?.networkAccess?.allow)) {
      throw fail('grant-missing', { grant: `networkAccess ${url}` }, pluginId)
    }
  }
}

/**
 * Mount-time file-access coverage (§17 rule 1, decision #9): a grant covers a
 * declared entry when its mode implies the declared mode (`write` ⊇ `read`)
 * and its normalized path is a path-boundary prefix of the declared path.
 * Runtime `..`/symlink normalization is owned by the `env.fs` stage (#16).
 */
function coveredByFileGrants(
  declared: FileAccessEntry,
  grants: readonly FileAccessEntry[] | undefined,
): boolean {
  if (grants === undefined) return false
  const declaredPath = normalizePath(declared[1])
  return grants.some((grant) => {
    if (grant[0] === 'read' && declared[0] === 'write') return false
    return pathPrefixCovers(normalizePath(grant[1]), declaredPath)
  })
}

/**
 * Mount-time network-access coverage (§17 rule 1): an allow entry covers a
 * declared URL when the URL starts at the entry boundary (next character is
 * `:`, `/`, `?`, or `#`, or the URL is exactly the entry), so
 * `https://example.dev` does not cover a different host like
/**
 * Boundary-prefix network coverage shared by mount validation and the
 * runtime `env.fetch` gate (#16): the URL starts at the entry boundary (next
 * character is `:`, `/`, `?`, or `#`, or the URL is exactly the entry), so
 * `https://example.dev` does not cover a different host.
 * @param url - request URL to test.
 * @param allow - allowlist entries, or `undefined` for no coverage.
 * @returns true when the URL starts at an entry's scheme/host boundary.
 */
export function coveredByNetworkGrants(url: string, allow: readonly string[] | undefined): boolean {
  if (allow === undefined) return false
  return allow.some((entry) => {
    if (url === entry) return true
    if (!url.startsWith(entry) || entry.length >= url.length) return false
    // The length guard above makes this index read defined.
    const next = url[entry.length] as string
    return ':/?#'.includes(next)
  })
}

/** The plugin's highest declared permission level (§15.6 ladder). */
function declaredLevel(definition: PluginDefinition): PermissionLevel {
  if (definition.permissions.claims.length > 0) return 'claims'
  if (definition.permissions.intercept.length > 0) return 'intercept'
  if (definition.permissions.transform.length > 0) return 'transform'
  return 'observe'
}

/** Normalize a path for mount-time prefix comparison: `/` separators, no trailing slash. */
function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.length === 0 ? '/' : normalized
}

/** True when `prefix` is a path-boundary prefix of `path`. */
function pathPrefixCovers(prefix: string, path: string): boolean {
  if (prefix === path) return true
  const boundary = prefix.endsWith('/') ? prefix : `${prefix}/`
  return path.startsWith(boundary)
}

/** Npm package scope (`@scope/pkg` → `@scope`), or `null` for unscoped names. */
function npmScope(packageName: string): string | null {
  if (!packageName.startsWith('@')) return null
  const slash = packageName.indexOf('/')
  return slash === -1 ? null : packageName.slice(0, slash)
}
