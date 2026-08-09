/**
 * Manager Config contract (§15.6 + §17): T6 defaults, the stateRoot harness
 * default, per-plugin grants parsing, and loud rejection of invalid input.
 */

import { describe, expect, it } from 'vitest'
import { resolvePluginManagerConfig } from '@deepseek-ai/dsh-mygo'
import { dshHomePath } from '@deepseek-ai/dsh-paths'

describe('resolvePluginManagerConfig', () => {
  it('applies the T6 defaults for an absent input', () => {
    const config = resolvePluginManagerConfig()
    expect(config).toMatchObject({
      maxCodeBytes: 256 * 1024,
      maxRegistryBytes: 64 * 1024 * 1024,
      maxDynamicPlugins: 1000,
      auditMaxBytes: 50 * 1024 * 1024,
      auditKeepFiles: 5,
      historyKeep: 2,
      maxRuntimeApiPermissionLevel: 'claims',
      swapTimeoutMs: 30_000,
      grants: {},
      protectedFields: [],
      development: false,
      trustedScopes: [],
    })
    expect(config.stateRoot).toBe(dshHomePath('plugin-state'))
  })

  it('honors explicit scalars and deployment fields', () => {
    const config = resolvePluginManagerConfig({
      maxCodeBytes: 1024,
      swapTimeoutMs: 500,
      stateRoot: '/srv/plugin-state',
      grants: {
        'policy-plugin': {
          intercept: true,
          claims: false,
          fileAccess: [['read', '/data'], ['write', '/out']],
          networkAccess: { allow: ['https://example.dev'] },
        },
      },
      protectedFields: ['tools/post-execute.result'],
      development: true,
      trustedScopes: ['@deepseek-ai'],
    })
    expect(config.maxCodeBytes).toBe(1024)
    expect(config.swapTimeoutMs).toBe(500)
    expect(config.stateRoot).toBe('/srv/plugin-state')
    expect(config.grants?.['policy-plugin']).toEqual({
      intercept: true,
      claims: false,
      fileAccess: [['read', '/data'], ['write', '/out']],
      networkAccess: { allow: ['https://example.dev'] },
    })
    expect(config.protectedFields).toEqual(['tools/post-execute.result'])
    expect(config.development).toBe(true)
    expect(config.trustedScopes).toEqual(['@deepseek-ai'])
  })

  it('rejects invalid quota values and unknown grant fields', () => {
    expect(() => resolvePluginManagerConfig({ maxCodeBytes: 0 })).toThrow()
    expect(() => resolvePluginManagerConfig({ maxRuntimeApiPermissionLevel: 'root' })).toThrow()
    expect(() => resolvePluginManagerConfig({ grants: { x: { intercept: 'yes' } } })).toThrow()
  })
})
