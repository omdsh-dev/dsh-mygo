/**
 * P3 bundle rail: patch parsing, companion blocks, atomic manifest writes,
 * `dsh plugin` forwarding through a fake CLI, and cross-rail solving.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'
import type { PluginDefinition, PluginSource } from '@deepseek-ai/dsh-mygo-api'
import {
  BundleRail,
  DispatchMachine,
  InMemoryRegistryStore,
  LifecycleEngine,
  resolvePluginManagerConfig,
} from '@deepseek-ai/dsh-mygo'

interface Fixture {
  readonly dshHome: string
  readonly checkout: string
  readonly profile: string
  readonly rail: BundleRail
  readonly cliCalls: string[][]
}

function fixture(): Fixture {
  const dshHome = mkdtempSync(join(tmpdir(), 'mygo-bundle-'))
  const checkout = mkdtempSync(join(tmpdir(), 'mygo-bundle-checkout-'))
  const profile = 'web'
  const profileDir = join(dshHome, 'profiles', profile)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, null, 2))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '# user layer\n')
  const binDir = join(checkout, 'bin')
  mkdirSync(binDir, { recursive: true })
  const cliCalls: string[][] = []
  writeFileSync(join(binDir, 'dsh'), [
    '#!/usr/bin/env node',
    "const calls = JSON.parse(process.env.MYGO_CLI_CALLS ?? '[]')",
    "calls.push(process.argv.slice(2))",
    "process.env.MYGO_CLI_CALLS = JSON.stringify(calls)",
    'const fs = require("node:fs")',
    'const path = require("node:path")',
    'const home = process.env.MYGO_DSH_HOME',
    'const manifest = path.join(home, "profiles", process.env.MYGO_PROFILE ?? "web", "package.json")',
    'const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"))',
    'const args = process.argv.slice(2)',
    'const addIdx = args.indexOf("add")',
    'if (addIdx !== -1) {',
    '  const spec = args[addIdx + 1]',
    '  const name = spec.replace(/^github:/, "").replace(/^git\\+/, "").split("#")[0].replace(/@[^@/]+$/, "")',
    '  pkg.dependencies = { ...pkg.dependencies, [name]: "1.0.0" }',
    '  if (!(pkg.dsh.profile.bundles || []).includes(name)) pkg.dsh.profile.bundles.push(name)',
    '}',
    'const rmIdx = args.indexOf("remove")',
    'if (rmIdx !== -1) {',
    '  const name = args[rmIdx + 1]',
    '  delete pkg.dependencies[name]',
    '  pkg.dsh.profile.bundles = (pkg.dsh.profile.bundles || []).filter((entry) => entry !== name)',
    '}',
    'fs.writeFileSync(manifest, JSON.stringify(pkg, null, 2))',
  ].join('\n'), { mode: 0o755 })
  const rail = new BundleRail({ dshHome, profile, checkout })
  return { dshHome, checkout, profile, rail, cliCalls }
}

function writeBundle(
  f: Fixture,
  packageName: string,
  overrides: {
    readonly version?: string
    readonly patch?: string
    readonly mygoCompat?: Record<string, Record<string, string>>
    readonly provides?: readonly string[]
  } = {},
): void {
  const dir = join(f.dshHome, 'profiles', f.profile, 'node_modules', packageName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: packageName,
    version: overrides.version ?? '1.0.0',
    main: 'index.js',
    dsh: {
      bundle: { patch: 'cordis.patch.yml' },
      ...(overrides.mygoCompat === undefined && overrides.provides === undefined
        ? {}
        : {
            mygo: {
              ...(overrides.mygoCompat === undefined ? {} : { compatibility: overrides.mygoCompat }),
              ...(overrides.provides === undefined ? {} : { provides: overrides.provides }),
            },
          }),
    },
  }, null, 2))
  writeFileSync(join(dir, 'cordis.patch.yml'), overrides.patch ?? `
- insert:
    - id: ${packageName.replace(/^@[^/]+\//, '')}-row
      name: 'placeholder'
`)
}

function declareInstalled(f: Fixture, packageName: string, listed = true): void {
  const path = join(f.dshHome, 'profiles', f.profile, 'package.json')
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  pkg.dependencies = { ...pkg.dependencies, [packageName]: '1.0.0' }
  if (listed) pkg.dsh.profile.bundles = [...(pkg.dsh.profile.bundles ?? []), packageName]
  writeFileSync(path, JSON.stringify(pkg, null, 2))
}

describe('bundle rail primitives', () => {
  it('parses insert / override / disable patch facts', () => {
    const f = fixture()
    writeBundle(f, '@dsh-external/test-bundle', {
      patch: `
- insert:
    - id: test-row
      name: 'x'
- id: host-row
  disabled: true
- id: host-config
  config: { a: 1 }
`,
    })
    const member = f.rail.readMember('@dsh-external/test-bundle', true)
    expect(member?.patchFacts).toEqual([
      { rowId: 'test-row', kind: 'insert' },
      { rowId: 'host-row', kind: 'disable' },
      { rowId: 'host-config', kind: 'override' },
    ])
    expect(member?.hostConflicts).toEqual(['禁用宿主行 host-row', '改写宿主行 host-config'])
  })

  it('writes and removes the companion block atomically', () => {
    const f = fixture()
    writeBundle(f, '@dsh-external/test-bundle')
    declareInstalled(f, '@dsh-external/test-bundle', true)
    const member = f.rail.members()[0]
    expect(member).toBeDefined()
    expect(f.rail.hasCompanion('test-bundle')).toBe(false)
    f.rail.disable('test-bundle')
    expect(f.rail.hasCompanion('test-bundle')).toBe(true)
    const text = readFileSync(join(f.dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    expect(text).toContain('- id: test-bundle-row\n  disabled: true')
    expect(f.rail.members()[0]?.enabled).toBe(false)
    f.rail.enable('test-bundle')
    expect(f.rail.hasCompanion('test-bundle')).toBe(false)
    expect(f.rail.members()[0]?.enabled).toBe(true)
  })

  it('forwards install/uninstall through the official CLI', () => {
    const f = fixture()
    writeBundle(f, '@dsh-external/test-bundle')
    const env = process.env
    process.env = { ...env, MYGO_DSH_HOME: f.dshHome, MYGO_PROFILE: f.profile, MYGO_CLI_CALLS: '[]' }
    try {
      const member = f.rail.install('@dsh-external/test-bundle@1.0.0')
      expect(member.packageName).toBe('@dsh-external/test-bundle')
      expect(f.rail.members().some(entry => entry.id === 'test-bundle')).toBe(true)
      f.rail.uninstall('test-bundle')
      expect(f.rail.members().some(entry => entry.id === 'test-bundle')).toBe(false)
    } finally {
      process.env = env
    }
  })

  it('merges dsh.bundle.requires/breaks into compatibility', () => {
    const f = fixture()
    writeBundle(f, '@dsh-external/compat-bundle', {
      mygoCompat: { depends: { alpha: '>=1.0.0' } },
    })
    declareInstalled(f, '@dsh-external/compat-bundle', true)
    const member = f.rail.members()[0]
    expect(member?.compatibility).toEqual({ depends: { alpha: '>=1.0.0' } })
  })

  it('enables opt-in rows (insert with disabled: true) via an enable block', () => {
    const f = fixture()
    writeBundle(f, '@dsh-external/opt-in-bundle', {
      patch: `
- insert:
    - id: opt-row-a
      name: 'a'
      disabled: true
    - id: opt-row-b
      name: 'b'
`,
    })
    declareInstalled(f, '@dsh-external/opt-in-bundle', true)
    const member = f.rail.members()[0]
    expect(member?.patchFacts).toEqual([
      { rowId: 'opt-row-a', kind: 'insert', disabled: true },
      { rowId: 'opt-row-b', kind: 'insert' },
    ])
    expect(member?.enabled).toBe(true)
    f.rail.disable('opt-in-bundle')
    expect(f.rail.members()[0]?.enabled).toBe(false)
    f.rail.enable('opt-in-bundle')
    expect(f.rail.members()[0]?.enabled).toBe(true)
    const text = readFileSync(join(f.dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    expect(text).toContain('- id: opt-row-a\n  disabled: false')
    expect(text).not.toContain('- id: opt-row-b\n  disabled: false')
    expect(text).not.toContain('mygo bundle disable block')
  })

  it('detects host replacements from defaults and declarations', () => {
    const f = fixture()
    writeBundle(f, '@dsh-external/rdb-like', {
      patch: `
- insert:
    - id: session-persistence-rdb
      name: 'x'
`,
      mygoCompat: {},
    })
    declareInstalled(f, '@dsh-external/rdb-like', true)
    const member = f.rail.members()[0]
    expect(member?.hostDisables).toEqual(['session-persistence-jsonl'])
    expect(member?.hostConflicts).toContain('替换宿主行 session-persistence-jsonl')
  })

  it('writes the host block on install, restores it on enable, removes it on disable/uninstall', () => {
    const f = fixture()
    writeBundle(f, '@dsh-external/rdb-like', {
      patch: `
- insert:
    - id: session-persistence-rdb
      name: 'x'
`,
    })
    const env = process.env
    process.env = { ...env, MYGO_DSH_HOME: f.dshHome, MYGO_PROFILE: f.profile, MYGO_CLI_CALLS: '[]' }
    try {
      f.rail.install('@dsh-external/rdb-like@1.0.0')
      let text = readFileSync(join(f.dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
      expect(text).toContain('mygo bundle host block')
      expect(text).toContain('- id: session-persistence-jsonl\n  disabled: true')
      f.rail.disable('rdb-like')
      text = readFileSync(join(f.dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
      expect(text).not.toContain('mygo bundle host block')
      expect(text).toContain('mygo bundle disable block')
      f.rail.enable('rdb-like')
      text = readFileSync(join(f.dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
      expect(text).toContain('mygo bundle host block')
      expect(text).not.toContain('mygo bundle disable block')
      f.rail.uninstall('rdb-like')
      text = readFileSync(join(f.dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
      expect(text).not.toContain('mygo bundle host block')
      expect(text).not.toContain('mygo bundle disable block')
    } finally {
      process.env = env
    }
  })
})

describe('bundle rail unified graph', () => {
  function plugin(id: string, compatibility?: Record<string, Record<string, string>>): PluginDefinition {
    return {
      id,
      version: '1.0.0',
      kinds: ['fixture'],
      requires: [],
      provides: [],
      permissions: { observe: [], transform: [], intercept: [], position: 'derived', claims: [] },
      stateful: false,
      swapPolicy: 'immediate',
      config: z.object({}),
      ...(compatibility === undefined ? {} : { compatibility }),
      hooks: { activate: () => {} },
    }
  }

  function source(id: string): PluginSource {
    return { type: 'inline', code: id }
  }

  it('solves required-by enable across rails and routes bundle enable', async () => {
    const f = fixture()
    writeBundle(f, '@dsh-external/test-bundle')
    declareInstalled(f, '@dsh-external/test-bundle', true)

    const ctx = new Context()
    const store = new InMemoryRegistryStore()
    const definitions = new Map<string, PluginDefinition>()
    definitions.set('alpha', plugin('alpha', { depends: { 'test-bundle': '>=1.0.0' } }))
    const machine = new DispatchMachine(ctx, { vocabulary: new Map() })
    machine.start()
    const engine = new LifecycleEngine({
      ctx,
      dispatch: machine,
      store,
      config: resolvePluginManagerConfig({ swapTimeoutMs: 40, historyKeep: 2 }),
      resolveSource: async (source: PluginSource) => {
        const definition = definitions.get(source.type === 'inline' ? source.code : source.package)
        if (definition === undefined) throw new Error('missing')
        return definition
      },
      bundleRail: f.rail,
    })
    await engine.install(source('alpha'))
    await engine.bundleSetEnabled('test-bundle', false, true)
    const plan = await engine.plan({ op: 'enable', id: 'alpha' })
    expect(plan.accepted).toBe(true)
    expect(plan.actions?.some(action => action.op === 'enable' && action.id === 'test-bundle' && action.kind === 'required-by'))
      .toBe(true)
    await engine.bundleSetEnabled('test-bundle', true)
    expect(f.rail.members()[0]?.enabled).toBe(true)
    await engine.enable('alpha')
    expect(engine.plugins().find(handle => handle.id === 'alpha')?.status).toBe('enabled')
    rmSync(f.dshHome, { recursive: true, force: true })
    rmSync(f.checkout, { recursive: true, force: true })
  })

  it('blocks disabling a bundle with an enabled bridge dependent and force cascades', async () => {
    const f = fixture()
    writeBundle(f, '@dsh-external/test-bundle')
    declareInstalled(f, '@dsh-external/test-bundle', true)

    const ctx = new Context()
    const store = new InMemoryRegistryStore()
    const definitions = new Map<string, PluginDefinition>()
    definitions.set('alpha', plugin('alpha', { depends: { 'test-bundle': '>=1.0.0' } }))
    const machine = new DispatchMachine(ctx, { vocabulary: new Map() })
    machine.start()
    const engine = new LifecycleEngine({
      ctx,
      dispatch: machine,
      store,
      config: resolvePluginManagerConfig({ swapTimeoutMs: 40, historyKeep: 2 }),
      resolveSource: async (source: PluginSource) => {
        const definition = definitions.get(source.type === 'inline' ? source.code : source.package)
        if (definition === undefined) throw new Error('missing')
        return definition
      },
      bundleRail: f.rail,
    })
    await engine.install(source('alpha'))
    await expect(engine.bundleSetEnabled('test-bundle', false)).rejects.toMatchObject({
      code: 'dependent-exists',
    })
    await engine.bundleSetEnabled('test-bundle', false, true)
    expect(f.rail.members()[0]?.enabled).toBe(false)
    expect(engine.plugins().find(handle => handle.id === 'alpha')?.status).toBe('disabled')
    rmSync(f.dshHome, { recursive: true, force: true })
    rmSync(f.checkout, { recursive: true, force: true })
  })

  it('rolls back a verified bundle install when its activation is rejected', async () => {
    const f = fixture()
    writeBundle(f, '@dsh-external/bad-bundle', {
      mygoCompat: { depends: { missing: '>=1.0.0' } },
    })
    const env = process.env
    process.env = { ...env, MYGO_DSH_HOME: f.dshHome, MYGO_PROFILE: f.profile, MYGO_CLI_CALLS: '[]' }
    const ctx = new Context()
    const store = new InMemoryRegistryStore()
    const machine = new DispatchMachine(ctx, { vocabulary: new Map() })
    machine.start()
    const engine = new LifecycleEngine({
      ctx,
      dispatch: machine,
      store,
      config: resolvePluginManagerConfig({ swapTimeoutMs: 40, historyKeep: 2 }),
      bundleRail: f.rail,
    })
    try {
      await expect(engine.bundleInstall('@dsh-external/bad-bundle@1.0.0')).rejects.toMatchObject({
        code: 'compatibility-conflict',
      })
      expect(f.rail.members().some(entry => entry.id === 'bad-bundle')).toBe(false)
    } finally {
      process.env = env
      rmSync(f.dshHome, { recursive: true, force: true })
      rmSync(f.checkout, { recursive: true, force: true })
    }
  })
})
