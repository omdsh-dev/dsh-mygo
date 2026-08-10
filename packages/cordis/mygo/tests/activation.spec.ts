/**
 * P2 activation solver: required-by closure enables, autoResolve installs,
 * disable downstream guard + force cascade, capability provider selection,
 * breaks minimal resolution, and determinism.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import z from 'schemastery'
import type { PluginCompatibility, PluginDefinition, PluginSource } from '@deepseek-ai/dsh-mygo-api'
import {
  DispatchMachine,
  InMemoryRegistryStore,
  LifecycleEngine,
  resolvePluginManagerConfig,
  solveActivation,
  type ActivationPlugin,
} from '@deepseek-ai/dsh-mygo'

function plugin(
  id: string,
  overrides: {
    readonly version?: string
    readonly compatibility?: PluginCompatibility
    readonly provides?: readonly string[]
  } = {},
): PluginDefinition {
  return {
    id,
    version: overrides.version ?? '1.0.0',
    kinds: ['fixture'],
    requires: [],
    provides: overrides.provides ?? [],
    permissions: { observe: [], transform: [], intercept: [], position: 'derived', claims: [] },
    stateful: false,
    swapPolicy: 'immediate',
    config: z.object({}),
    ...(overrides.compatibility === undefined ? {} : { compatibility: overrides.compatibility }),
    hooks: { activate: () => {} },
  }
}

function source(id: string): PluginSource {
  return { type: 'inline', code: id }
}

function harness(): { readonly engine: LifecycleEngine; readonly definitions: Map<string, PluginDefinition> } {
  const ctx = new Context()
  const store = new InMemoryRegistryStore()
  const definitions = new Map<string, PluginDefinition>()
  const machine = new DispatchMachine(ctx, { vocabulary: new Map() })
  machine.start()
  const engine = new LifecycleEngine({
    ctx,
    dispatch: machine,
    store,
    config: resolvePluginManagerConfig({ swapTimeoutMs: 40, historyKeep: 2 }),
    resolveSource: async (source: PluginSource) => {
      const key = source.type === 'inline' ? source.code : source.package
      const definition = definitions.get(key)
      if (definition === undefined) throw new Error(`source ${key} not resolvable`)
      return definition
    },
  })
  return { engine, definitions }
}

function activation(
  id: string,
  overrides: {
    readonly version?: string
    readonly compatibility?: PluginCompatibility
    readonly provides?: readonly string[]
    readonly enabled?: boolean
  } = {},
): ActivationPlugin {
  return {
    id,
    ...(overrides.version === undefined ? {} : { version: overrides.version }),
    ...(overrides.compatibility === undefined ? {} : { compatibility: overrides.compatibility }),
    ...(overrides.provides === undefined ? {} : { provides: overrides.provides }),
    enabled: overrides.enabled ?? true,
  }
}

describe('activation solver engine integration', () => {
  it('autoResolve install enables a disabled dependency', async () => {
    const { engine, definitions } = harness()
    definitions.set('beta', plugin('beta', { version: '1.0.0' }))
    definitions.set('alpha', plugin('alpha', { compatibility: { depends: { beta: '>=1.0.0' } } }))
    await engine.install(source('beta'))
    await engine.disable('beta')
    await engine.install(source('alpha'), { autoResolve: true })
    expect(engine.plugins().find(handle => handle.id === 'alpha')?.status).toBe('enabled')
    expect(engine.plugins().find(handle => handle.id === 'beta')?.status).toBe('enabled')
  })

  it('autoResolve install still rejects an unresolvable missing dependency', async () => {
    const { engine, definitions } = harness()
    definitions.set('alpha', plugin('alpha', { compatibility: { depends: { missing: '>=1.0.0' } } }))
    await expect(engine.install(source('alpha'), { autoResolve: true })).rejects.toMatchObject({
      code: 'compatibility-conflict',
    })
  })

  it('disable is blocked by a package-closure dependent and force cascades', async () => {
    const { engine, definitions } = harness()
    definitions.set('gamma', plugin('gamma', { version: '2.0.0' }))
    definitions.set('beta', plugin('beta', { version: '1.0.0', compatibility: { depends: { gamma: '>=1.0.0' } } }))
    definitions.set('alpha', plugin('alpha', { version: '1.0.0', compatibility: { depends: { beta: '>=1.0.0' } } }))
    await engine.install(source('gamma'))
    await engine.install(source('beta'))
    await engine.install(source('alpha'))
    await expect(engine.disable('gamma')).rejects.toMatchObject({
      code: 'dependent-exists',
      details: { dependents: ['alpha', 'beta'] },
    })
    await engine.disable('gamma', undefined, true)
    expect(engine.plugins().find(handle => handle.id === 'gamma')?.status).toBe('disabled')
    expect(engine.plugins().find(handle => handle.id === 'beta')?.status).toBe('disabled')
    expect(engine.plugins().find(handle => handle.id === 'alpha')?.status).toBe('disabled')
  })

  it('capability depends resolve to the first installed provider on autoResolve', async () => {
    const { engine, definitions } = harness()
    definitions.set('sp-1', plugin('sp-1', { version: '1.0.0', provides: ['service:sp'] }))
    definitions.set('sp-2', plugin('sp-2', { version: '1.0.0', provides: ['service:sp'] }))
    definitions.set('cap-alpha', plugin('cap-alpha', {
      version: '1.0.0',
      compatibility: { depends: { 'service:sp': '>=1.0.0' } },
    }))
    await engine.install(source('sp-1'))
    await engine.install(source('sp-2'))
    await engine.disable('sp-1')
    await engine.disable('sp-2')
    await engine.install(source('cap-alpha'), { autoResolve: true })
    expect(engine.plugins().find(handle => handle.id === 'sp-1')?.status).toBe('enabled')
    expect(engine.plugins().find(handle => handle.id === 'sp-2')?.status).toBe('disabled')
  })

  it('capability depends with no provider rejects with advisory install action', async () => {
    const { engine, definitions } = harness()
    definitions.set('cap-alpha', plugin('cap-alpha', {
      version: '1.0.0',
      compatibility: { depends: { 'service:nope': '>=1.0.0' } },
    }))
    const plan = await engine.plan({ op: 'install', source: source('cap-alpha') })
    expect(plan.accepted).toBe(false)
    expect(plan.actions?.some(action => action.op === 'install' && action.id === 'service:nope' && action.kind === 'advisory'))
      .toBe(true)
  })

  it('uninstalling a capability provider is blocked while a dependent is enabled', async () => {
    const { engine, definitions } = harness()
    definitions.set('sp-1', plugin('sp-1', { version: '1.0.0', provides: ['service:sp'] }))
    definitions.set('cap-alpha', plugin('cap-alpha', {
      version: '1.0.0',
      compatibility: { depends: { 'service:sp': '>=1.0.0' } },
    }))
    await engine.install(source('sp-1'))
    await engine.install(source('cap-alpha'))
    await expect(engine.uninstall('sp-1')).rejects.toMatchObject({
      code: 'compatibility-conflict',
    })
    const plan = await engine.plan({ op: 'uninstall', id: 'sp-1' })
    expect(plan.accepted).toBe(false)
    expect(plan.error?.message).toContain('提供者 sp-1 将被卸载（由 cap-alpha 声明）')
  })

  it('planInstall previews required-by enables for a declarative install', async () => {
    const { engine, definitions } = harness()
    definitions.set('beta', plugin('beta', { version: '1.0.0' }))
    definitions.set('alpha', plugin('alpha', { compatibility: { depends: { beta: '>=1.0.0' } } }))
    await engine.install(source('beta'))
    await engine.disable('beta')
    const plan = await engine.planInstall({
      id: 'alpha',
      version: '1.0.0',
      compatibility: { depends: { beta: '>=1.0.0' } },
    })
    expect(plan.accepted).toBe(true)
    expect(plan.actions?.some(action => action.op === 'enable' && action.id === 'beta' && action.kind === 'required-by'))
      .toBe(true)
  })
})

describe('activation solver pure semantics', () => {
  it('resolves breaks by minimal disablement when the declarer is not user-requested', () => {
    const state = [
      activation('alpha', { compatibility: { breaks: { beta: '>=1.0.0' } } }),
      activation('beta', { version: '1.2.0' }),
      activation('consumer', { compatibility: { depends: { beta: '>=1.0.0' } }, enabled: false }),
    ]
    const plan = solveActivation(state, { op: 'enable', id: 'consumer' })
    expect(plan.accepted).toBe(true)
    const disable = plan.actions.find(action => action.op === 'disable')
    expect(disable).toMatchObject({ id: 'alpha', kind: 'conflict-resolution' })
    expect(disable?.chain?.[0]).toMatchObject({ declarer: 'alpha', target: 'beta', kind: 'breaks' })
  })

  it('refuses a user-requested enable that participates in a breaks pair', () => {
    const state = [
      activation('beta', { version: '1.2.0' }),
      activation('alpha', { compatibility: { breaks: { beta: '>=1.0.0' } }, enabled: false }),
    ]
    const plan = solveActivation(state, { op: 'enable', id: 'alpha' })
    expect(plan.accepted).toBe(false)
    expect(plan.error?.code).toBe('compatibility-conflict')
  })

  it('is deterministic for the same input', () => {
    const state = [
      activation('beta', { version: '1.0.0' }),
      activation('alpha', { compatibility: { depends: { beta: '>=1.0.0' } }, enabled: false }),
    ]
    const first = solveActivation(state, { op: 'enable', id: 'alpha' })
    const second = solveActivation(state, { op: 'enable', id: 'alpha' })
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })
})
