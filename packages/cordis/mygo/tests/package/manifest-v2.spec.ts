/**
 * manifest v2 测试：五字段、预发布版本、区间强制、裸包名拒绝、legacy 别名。
 */

import { describe, expect, it } from 'vitest'
import { parsePackageManifest } from '../../src/package/manifest-v2.ts'

describe('manifest v2', () => {
  it('parses the five required fields from dsh.mygo', () => {
    const result = parsePackageManifest({
      name: '@dsh-external/tool',
      version: '0.0.1-rc.1',
      main: 'lib/index.js',
      dsh: {
        mygo: {
          id: 'tool',
          version: '0.0.1-rc.2',
          entry: 'lib/index.js',
          depends: { base: '>=1.0.0' },
          breaks: { legacy: '<2.0.0' },
          core: '>=0.0.1-rc.1',
        },
      },
    })
    expect(result.problems).toEqual([])
    expect(result.value).toMatchObject({
      id: 'tool',
      version: '0.0.1-rc.2',
      entry: 'lib/index.js',
      depends: { base: '>=1.0.0' },
      breaks: { legacy: '<2.0.0' },
      core: '>=0.0.1-rc.1',
    })
  })

  it('defaults id/version/entry from package.json', () => {
    const result = parsePackageManifest({
      name: '@dsh-external/x',
      version: '1.2.3',
      main: 'main.js',
      dsh: { mygo: { core: '>=1.0.0' } },
    })
    expect(result.problems).toEqual([])
    expect(result.value).toMatchObject({ id: 'x', version: '1.2.3', entry: 'main.js', core: '>=1.0.0' })
  })

  it('rejects bare package names as depends values', () => {
    const result = parsePackageManifest({
      name: 'x',
      version: '1.0.0',
      dsh: { mygo: { depends: { B: 'just-a-name' } } },
    })
    expect(result.problems.some(problem => problem.path === 'dsh.mygo.depends.B')).toBe(true)
  })

  it('normalizes legacy compatibility requires/breaks', () => {
    const result = parsePackageManifest({
      name: 'x',
      version: '1.0.0',
      main: 'index.js',
      dsh: {
        mygo: {
          compatibility: {
            requires: { base: '>=2.0.0' },
            breaks: { old: '<2.0.0' },
          },
        },
      },
    })
    expect(result.problems).toEqual([])
    expect(result.value?.depends).toEqual({ base: '>=2.0.0' })
    expect(result.value?.breaks).toEqual({ old: '<2.0.0' })
  })

  it('warns (not blocks) when core is undeclared', () => {
    const result = parsePackageManifest({ name: 'x', version: '1.0.0', main: 'index.js' })
    expect(result.problems).toEqual([])
    expect(result.warnings.some(line => line.includes('core'))).toBe(true)
    expect(result.value?.core).toBe('*')
  })

  it('rejects an entry escaping the package directory', () => {
    const result = parsePackageManifest({
      name: 'x',
      version: '1.0.0',
      dsh: { mygo: { entry: '../outside.js' } },
    })
    expect(result.problems.some(problem => problem.path === 'dsh.mygo.entry')).toBe(true)
  })

  it('parses bundles, loader, patches and shared', () => {
    const result = parsePackageManifest({
      name: 'fabric',
      version: '0.0.2',
      main: 'lib/index.js',
      dsh: {
        mygo: {
          entry: 'lib/index.js',
          core: '*',
          shared: true,
          bundles: [{ id: 'transformer', version: '0.18.1', path: 'vendor/transformer' }],
          loader: { id: 'mixin', range: '>=1.0.0 <2.0.0' },
          patches: [{ id: 'p1', target: { module: 'dsh-core', symbol: 'Session.start', operation: 'before' } }],
        },
      },
    })
    expect(result.problems).toEqual([])
    expect(result.value?.bundles).toEqual([{ id: 'transformer', version: '0.18.1', path: 'vendor/transformer' }])
    expect(result.value?.loader).toEqual({ id: 'mixin', range: '>=1.0.0 <2.0.0' })
    expect(result.value?.patches?.[0]?.target.symbol).toBe('Session.start')
    expect(result.value?.shared).toBe(true)
  })

  it('rejects a bundle path escaping the package', () => {
    const result = parsePackageManifest({
      name: 'x',
      version: '1.0.0',
      main: 'index.js',
      dsh: { mygo: { bundles: [{ id: 'b', version: '1.0.0', path: '../outside' }] } },
    })
    expect(result.problems.some(problem => problem.path.includes('path'))).toBe(true)
  })
})
