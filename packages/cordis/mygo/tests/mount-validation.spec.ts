/**
 * §16.5 mount-time acceptance: every group-1/group-2 code is triggerable
 * through the mount validation chain, every message names the entities its
 * template requires, and the success paths surface the development-mode
 * warning (SEC:158) instead of throwing.
 */

import { describe, expect, it } from 'vitest'
import { PluginError, definePlugin } from '@deepseek-ai/dsh-mygo-api'
import {
  assertEventOptions,
  validateMount,
  type MountValidationOptions,
} from '@deepseek-ai/dsh-mygo'
import { fixturePlugin } from './helpers.ts'

const BASE_OPTIONS: MountValidationOptions = {
  source: { type: 'inline', code: 'export default {}' },
  origin: 'runtime-api',
  channelCeiling: 'claims',
  grants: {},
  protectedFields: [],
  development: false,
  trustedScopes: [],
}

function caught(definition: Parameters<typeof validateMount>[0], options: MountValidationOptions = BASE_OPTIONS): PluginError {
  try {
    validateMount(definition, options)
  } catch (error) {
    expect(error).toBeInstanceOf(PluginError)
    return error as PluginError
  }
  throw new Error(`expected validateMount to throw for ${definition.id}`)
}

describe('validateMount group 1 (manifest and declarations)', () => {
  it('rejects a malformed manifest with manifest-invalid naming field and expected contract', () => {
    const error = caught({ ...fixturePlugin(), id: 'Bad_Id' })
    expect(error.code).toBe('manifest-invalid')
    expect(error.details).toMatchObject({ field: 'id' })
    expect(error.message).toContain('id')
    expect(error.message).toContain('expected')
    expect(error.pluginId).toBeUndefined()
  })

  it('names the manifest root for a non-object manifest', () => {
    const error = caught(null as unknown as Parameters<typeof validateMount>[0])
    expect(error.code).toBe('manifest-invalid')
    expect(error.details).toMatchObject({ field: 'manifest' })

    const nonStringId = caught({ id: 42 } as unknown as Parameters<typeof validateMount>[0])
    expect(nonStringId.code).toBe('manifest-invalid')
    expect(nonStringId.details).toMatchObject({ field: 'id' })
  })

  it('validates all optional hooks and rejects non-function hooks', () => {
    const allHooks = fixturePlugin({
      hooks: {
        setup: async () => {},
        activate: () => {},
        deactivate: async () => {},
        captureState: () => ({}),
        restoreState: async () => {},
        dispose: async () => {},
      },
    })
    expect(validateMount(allHooks, BASE_OPTIONS).warnings).toEqual([])

    const error = caught({
      ...fixturePlugin(),
      hooks: { activate: 'not-a-function' },
    } as unknown as Parameters<typeof validateMount>[0])
    expect(error.code).toBe('manifest-invalid')
    expect(error.details).toMatchObject({ field: 'hooks.activate' })
  })

  it('rejects observe declarations outside the harness tier with event-not-mountable', () => {
    const error = caught(fixturePlugin({
      permissions: { ...fixturePlugin().permissions, observe: ['internal/listener'] },
    }))
    expect(error.code).toBe('event-not-mountable')
    expect(error.details).toEqual({ event: 'internal/listener', tier: 'harness' })
    expect(error.message).toContain('internal/listener')
    expect(error.message).toContain('harness')
    expect(error.pluginId).toBe('fixture-plugin')
  })

  it('rejects transform declarations on non-waterfall events with mode-ceiling-exceeded', () => {
    const error = caught(fixturePlugin({
      permissions: {
        ...fixturePlugin().permissions,
        transform: [{ event: 'agent/status', writes: ['status'] }],
      },
    }))
    expect(error.code).toBe('mode-ceiling-exceeded')
    expect(error.details).toEqual({ event: 'agent/status', mode: 'transform', ceiling: 'observe' })
    expect(error.message).toContain('agent/status')
    expect(error.message).toContain('transform')
    expect(error.message).toContain('observe')
  })

  it('rejects intercept declarations on emit events with mode-ceiling-exceeded (serial allows intercept)', () => {
    const emit = caught(fixturePlugin({
      permissions: {
        ...fixturePlugin().permissions,
        intercept: [{ event: 'agent/status', returns: [] }],
      },
    }))
    expect(emit.code).toBe('mode-ceiling-exceeded')
    expect(emit.details).toEqual({ event: 'agent/status', mode: 'intercept', ceiling: 'observe' })

    const serial = validateMount(fixturePlugin({
      permissions: {
        ...fixturePlugin().permissions,
        intercept: [{ event: 'agent/turn-stopping', returns: [] }],
      },
    }), { ...BASE_OPTIONS, grants: { intercept: true } })
    expect(serial.warnings).toEqual([])
  })

  it('rejects payload-external names with non-payload-name', () => {
    const error = caught(fixturePlugin({
      permissions: {
        ...fixturePlugin().permissions,
        transform: [{ event: 'system-prompt/assemble', reads: ['service:memory.pending'] }],
      },
    }))
    expect(error.code).toBe('non-payload-name')
    expect(error.details).toEqual({ name: 'service:memory.pending', boundary: 'payload properties only' })
    expect(error.message).toContain('service:memory.pending')
    expect(error.message).toContain('payload properties only')
  })

  it('rejects unknown property names with unknown-property naming the valid set', () => {
    const error = caught(fixturePlugin({
      permissions: {
        ...fixturePlugin().permissions,
        transform: [{ event: 'system-prompt/assemble', writes: ['modle'] }],
      },
    }))
    expect(error.code).toBe('unknown-property')
    expect(error.details).toEqual({
      event: 'system-prompt/assemble',
      name: 'modle',
      valid: ['contexts', 'sections', 'tools', 'variables'],
    })
    expect(error.message).toContain('modle')
    expect(error.message).toContain('system-prompt/assemble')
    expect(error.message).toContain('contexts, sections, tools, variables')
  })

  it('rejects unknown intercept branches with unknown-property naming the branch vocabulary', () => {
    const error = caught(fixturePlugin({
      permissions: {
        ...fixturePlugin().permissions,
        intercept: [{ event: 'tools/pre-execute', returns: ['maybe'] }],
      },
    }))
    expect(error.code).toBe('unknown-property')
    expect(error.details).toEqual({
      event: 'tools/pre-execute',
      name: 'maybe',
      valid: ['allow', 'ask', 'deny'],
    })
    expect(error.message).toContain('maybe')
    expect(error.message).toContain('allow, ask, deny')
  })

  it('rejects capability range syntax with capability-range-reserved', () => {
    const requires = caught(fixturePlugin({ requires: ['loop-detection@2'] }))
    expect(requires.code).toBe('capability-range-reserved')
    expect(requires.details).toEqual({ entry: 'loop-detection@2', note: 'v2 name@range' })
    expect(requires.message).toContain('loop-detection@2')
    expect(requires.message).toContain('v2 name@range')

    const provides = caught(fixturePlugin({ provides: ['service@^1'] }))
    expect(provides.code).toBe('capability-range-reserved')
  })

  it('rejects direct event options through assertEventOptions', () => {
    expect(() => { assertEventOptions([], 'fixture-plugin') }).not.toThrow()
    try {
      assertEventOptions([{ prepend: true }], 'fixture-plugin')
    } catch (caughtError) {
      expect(caughtError).toBeInstanceOf(PluginError)
      expect((caughtError as PluginError).code).toBe('unsupported-event-option')
      expect((caughtError as PluginError).details).toEqual({ option: 'prepend' })
      expect((caughtError as PluginError).message).toContain('prepend')
      expect((caughtError as PluginError).pluginId).toBe('fixture-plugin')
      return
    }
    throw new Error('expected assertEventOptions to throw')
  })
})

describe('validateMount group 2 (permissions and grants)', () => {
  it('rejects a model-channel npm source with source-not-allowed', () => {
    const error = caught(fixturePlugin(), {
      ...BASE_OPTIONS,
      source: { type: 'npm', package: 'some-plugin' },
      origin: 'model',
    })
    expect(error.code).toBe('source-not-allowed')
    expect(error.details).toEqual({ channel: 'model', source: 'npm' })
    expect(error.message).toContain('model')
    expect(error.message).toContain('npm')
  })

  it('rejects declared intercept without the grant with grant-missing', () => {
    const error = caught(fixturePlugin({
      permissions: {
        ...fixturePlugin().permissions,
        intercept: [{ event: 'tools/pre-execute', returns: ['deny'] }],
      },
    }), { ...BASE_OPTIONS, grants: {} })
    expect(error.code).toBe('grant-missing')
    expect(error.details).toEqual({ grant: 'intercept' })
    expect(error.message).toContain('intercept')
  })

  it('rejects declared claims without the grant with grant-missing', () => {
    const error = caught(fixturePlugin({
      permissions: {
        ...fixturePlugin().permissions,
        claims: ['service:llm'],
      },
    }))
    expect(error.code).toBe('grant-missing')
    expect(error.details).toEqual({ grant: 'claims' })
  })

  it('rejects uncovered fileAccess and networkAccess declarations with grant-missing', () => {
    const fileError = caught(fixturePlugin({ fileAccess: [['write', '/data/secret.txt']] }), {
      ...BASE_OPTIONS,
      grants: { fileAccess: [['read', '/data']] },
    })
    expect(fileError.code).toBe('grant-missing')
    expect(fileError.details).toEqual({ grant: 'fileAccess write /data/secret.txt' })

    const networkError = caught(fixturePlugin({
      networkAccess: { allow: ['https://example.dev/api'] },
    }), { ...BASE_OPTIONS, grants: { networkAccess: { allow: ['https://other.dev'] } } })
    expect(networkError.code).toBe('grant-missing')
    expect(networkError.details).toEqual({ grant: 'networkAccess https://example.dev/api' })
  })

  it('accepts covered fileAccess and networkAccess declarations', () => {
    const result = validateMount(fixturePlugin({
      fileAccess: [['write', '/data/secret.txt'], ['read', '/notes/a.md']],
      networkAccess: { allow: ['https://example.dev/api', 'https://cdn.example.dev/x'] },
    }), {
      ...BASE_OPTIONS,
      grants: {
        fileAccess: [['write', '/data'], ['read', '/notes']],
        networkAccess: { allow: ['https://example.dev', 'https://cdn.example.dev'] },
      },
    })
    expect(result.warnings).toEqual([])
  })

  it('rejects declared fileAccess or networkAccess when the grant collection is absent', () => {
    const fileError = caught(fixturePlugin({ fileAccess: [['read', '/data']] }), {
      ...BASE_OPTIONS,
      grants: {},
    })
    expect(fileError.code).toBe('grant-missing')

    const networkError = caught(fixturePlugin({
      networkAccess: { allow: ['https://example.dev/api'] },
    }), {
      ...BASE_OPTIONS,
      grants: {},
    })
    expect(networkError.code).toBe('grant-missing')
  })

  it('accepts exact paths, the root prefix, and exact URLs', () => {
    const result = validateMount(fixturePlugin({
      fileAccess: [['read', '/etc/hosts'], ['read', '/var/log/app.log']],
      networkAccess: { allow: ['https://exact.example.dev/path'] },
    }), {
      ...BASE_OPTIONS,
      grants: {
        fileAccess: [['read', '/etc/hosts'], ['read', '/']],
        networkAccess: { allow: ['https://exact.example.dev/path'] },
      },
    })
    expect(result.warnings).toEqual([])
  })

  it('rejects declared levels above the channel ceiling with ceiling-exceeded naming both axes', () => {
    const error = caught(fixturePlugin({
      permissions: {
        ...fixturePlugin().permissions,
        intercept: [{ event: 'tools/pre-execute', returns: ['deny'] }],
      },
    }), {
      ...BASE_OPTIONS,
      source: { type: 'inline', code: 'export default {}' },
      origin: 'model',
      channelCeiling: 'transform',
      grants: { intercept: true },
    })
    expect(error.code).toBe('ceiling-exceeded')
    expect(error.details).toEqual({ level: 'intercept', channel: 'model', ceiling: 'transform' })
    expect(error.message).toContain('intercept')
    expect(error.message).toContain('model')
    expect(error.message).toContain('transform')
    expect(error.message).toContain('grants cannot exceed the ceiling')
  })

  it('rejects writes hitting protected fields with protected-field', () => {
    const error = caught(fixturePlugin({
      permissions: {
        ...fixturePlugin().permissions,
        transform: [{ event: 'tools/post-execute', writes: ['value'] }],
      },
    }), {
      ...BASE_OPTIONS,
      protectedFields: ['tools/post-execute.value'],
    })
    expect(error.code).toBe('protected-field')
    expect(error.details).toEqual({ field: 'tools/post-execute.value' })
    expect(error.message).toContain('tools/post-execute.value')
  })

  it('rejects untrusted npm scopes with provenance-rejected unless development warns', () => {
    const rejected = caught(fixturePlugin(), {
      ...BASE_OPTIONS,
      source: { type: 'npm', package: '@untrusted/pkg' },
      trustedScopes: ['@deepseek-ai'],
    })
    expect(rejected.code).toBe('provenance-rejected')
    expect(rejected.details).toEqual({
      source: '@untrusted/pkg',
      missing: 'trusted scope or provenance attestation',
    })
    expect(rejected.message).toContain('@untrusted/pkg')
    expect(rejected.message).toContain('trusted scope or provenance attestation')

    const result = validateMount(fixturePlugin(), {
      ...BASE_OPTIONS,
      source: { type: 'npm', package: '@untrusted/pkg' },
      trustedScopes: ['@deepseek-ai'],
      development: true,
    })
    expect(result.warnings).toEqual([
      'development-mode: provenance check skipped for package @untrusted/pkg',
    ])
  })

  it('rejects scoped npm packages when trustedScopes is absent and unscoped packages always', () => {
    const scoped = caught(fixturePlugin(), {
      source: { type: 'npm', package: '@deepseek-ai/some-plugin' },
      origin: BASE_OPTIONS.origin,
      channelCeiling: BASE_OPTIONS.channelCeiling,
      grants: {},
      protectedFields: [],
      development: false,
    })
    expect(scoped.code).toBe('provenance-rejected')

    const unscoped = caught(fixturePlugin(), {
      ...BASE_OPTIONS,
      source: { type: 'npm', package: 'plain-plugin' },
      trustedScopes: ['@deepseek-ai'],
    })
    expect(unscoped.code).toBe('provenance-rejected')
    expect(unscoped.details.source).toBe('plain-plugin')

    const bareScope = caught(fixturePlugin(), {
      ...BASE_OPTIONS,
      source: { type: 'npm', package: '@bare-scope' },
      trustedScopes: ['@bare-scope'],
    })
    expect(bareScope.code).toBe('provenance-rejected')
  })

  it('accepts a trusted npm scope without warnings', () => {
    const result = validateMount(fixturePlugin(), {
      ...BASE_OPTIONS,
      source: { type: 'npm', package: '@deepseek-ai/some-plugin' },
      trustedScopes: ['@deepseek-ai'],
    })
    expect(result.warnings).toEqual([])
  })
})

describe('validateMount success path', () => {
  it('accepts a fully granted waterfall transform with no warnings', () => {
    const definition = fixturePlugin({
      requires: ['llm'],
      provides: ['counter'],
      permissions: {
        ...fixturePlugin().permissions,
        observe: ['agent/status'],
        transform: [{
          event: 'tools/post-execute',
          reads: ['kind'],
          writes: ['value'],
          appends: ['additionalContexts'],
        }],
      },
    })
    const result = validateMount(definePlugin(definition), {
      source: BASE_OPTIONS.source,
      origin: BASE_OPTIONS.origin,
      channelCeiling: BASE_OPTIONS.channelCeiling,
      grants: {},
      trustedScopes: [],
    })
    expect(result.warnings).toEqual([])
  })

  it('accepts a transform that declares only reads and appends', () => {
    const result = validateMount(fixturePlugin({
      permissions: {
        ...fixturePlugin().permissions,
        transform: [{
          event: 'tools/post-execute',
          reads: ['kind'],
          appends: ['additionalContexts'],
        }],
      },
    }), {
      source: BASE_OPTIONS.source,
      origin: BASE_OPTIONS.origin,
      channelCeiling: BASE_OPTIONS.channelCeiling,
      grants: {},
    })
    expect(result.warnings).toEqual([])
  })

  it('accepts claims at the runtime-api ceiling when granted', () => {
    const result = validateMount(fixturePlugin({
      permissions: {
        ...fixturePlugin().permissions,
        claims: ['service:llm'],
      },
    }), { ...BASE_OPTIONS, grants: { claims: true } })
    expect(result.warnings).toEqual([])
  })

  it('applies no ceiling for static compositions and no provenance for inline sources', () => {
    const result = validateMount(fixturePlugin({
      permissions: {
        ...fixturePlugin().permissions,
        claims: ['service:llm'],
      },
    }), {
      ...BASE_OPTIONS,
      source: { type: 'static' },
      origin: 'static',
      channelCeiling: 'observe',
      grants: { claims: true },
    })
    expect(result.warnings).toEqual([])
  })

  it('accepts serial intercept with an empty returns list when granted', () => {
    const result = validateMount(fixturePlugin({
      permissions: {
        ...fixturePlugin().permissions,
        intercept: [{ event: 'agent/turn-stopping', returns: [] }],
      },
    }), { ...BASE_OPTIONS, grants: { intercept: true } })
    expect(result.warnings).toEqual([])
  })
})

describe('assertEventOptions', () => {
  it('names a string option, a keyed option object, and an empty object', () => {
    const cases: readonly [unknown, string][] = [
      ['prepend', 'prepend'],
      [{ prepend: true }, 'prepend'],
      [{}, ''],
    ]
    for (const [option, expected] of cases) {
      try {
        assertEventOptions([option], 'fixture-plugin')
      } catch (error) {
        expect((error as PluginError).code).toBe('unsupported-event-option')
        expect((error as PluginError).details).toEqual({ option: expected })
        continue
      }
      throw new Error('expected assertEventOptions to throw')
    }
  })
})
