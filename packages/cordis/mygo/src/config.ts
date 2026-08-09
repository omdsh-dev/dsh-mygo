/**
 * Manager Config schema and resolver (§15.6 + §17). Defaults follow the
 * schedule's T6 values: 256KB code, 64MB registry, 1000 dynamic plugins,
 * 50MB audit × 5 files, 2 retained generations, `claims` runtime-api ceiling.
 * `stateRoot` defaults to the harness-home `plugin-state` directory.
 * @module @deepseek-ai/dsh-mygo/src/config
 */

import { dshHomePath } from '@deepseek-ai/dsh-paths'
import z from 'schemastery'
import type { PluginManagerConfig } from './types.ts'

/** The schema's normalized output: `stateRoot` is optional until the resolver fills it. */
type ParsedConfig = Omit<PluginManagerConfig, 'stateRoot'> & { readonly stateRoot?: string }

const fileAccessEntry = z.tuple([
  z.union([z.const('read'), z.const('write')]),
  z.string(),
])

const grantsSchema = z.object({
  intercept: z.boolean(),
  claims: z.boolean(),
  fileAccess: z.array(fileAccessEntry),
  networkAccess: z.object({ allow: z.array(z.string()) }),
})

const permissionLevelSchema = z.union([
  z.const('observe'),
  z.const('transform'),
  z.const('intercept'),
  z.const('claims'),
])

/**
 * Schemastery schema for the manager Config. All fields except `stateRoot`
 * carry their spec defaults; `stateRoot` is filled by
 * {@link resolvePluginManagerConfig} so the harness-home default is resolved
 * against the environment at resolve time.
 */
export const PluginManagerConfigSchema = z.object({
  maxCodeBytes: z.number().step(1).min(1).default(256 * 1024),
  maxRegistryBytes: z.number().step(1).min(1).default(64 * 1024 * 1024),
  maxDynamicPlugins: z.number().step(1).min(1).default(1000),
  auditMaxBytes: z.number().step(1).min(1).default(50 * 1024 * 1024),
  auditKeepFiles: z.number().step(1).min(1).default(5),
  stateRoot: z.string(),
  historyKeep: z.number().step(1).min(1).default(2),
  maxRuntimeApiPermissionLevel: permissionLevelSchema.default('claims'),
  swapTimeoutMs: z.number().step(1).min(1).default(30_000),
  grants: z.dict(grantsSchema).default({}),
  protectedFields: z.array(z.string()).default([]),
  development: z.boolean().default(false),
  trustedScopes: z.array(z.string()).default([]),
})

/**
 * Resolve a manager Config value: parse the input against the schema (invalid
 * input fails loud with schemastery's error) and fill the `stateRoot` default
 * from the current harness home.
 * @param input - partial manager Config; `undefined` yields all defaults.
 * @returns the fully resolved Config.
 */
export function resolvePluginManagerConfig(input?: unknown): PluginManagerConfig {
  // Schemastery's tuple/dict inference is looser than the FileAccessEntry
  // tuple contract, so the normalized output crosses through `unknown`.
  const parsed = PluginManagerConfigSchema(input ?? {}) as unknown as ParsedConfig
  return parsed.stateRoot === undefined
    ? { ...parsed, stateRoot: dshHomePath('plugin-state') }
    : { ...parsed, stateRoot: parsed.stateRoot }
}
