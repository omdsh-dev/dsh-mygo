import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  InMemoryRegistryStore,
  RegistryPersistence,
} from '@r05en1cu/dsh-mygo'
import type { RegistryPersistenceOptions } from '@r05en1cu/dsh-mygo'

function persistenceOptions(root: string): RegistryPersistenceOptions {
  return {
    profile: 'web',
    stateRoot: join(root, 'state'),
    auditMaxBytes: 1_000_000,
    auditKeepFiles: 3,
  }
}

describe('registry store seam', () => {
  it('prefers an external registry store and runs its self-check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mygo-registry-seam-'))
    try {
      const external = new InMemoryRegistryStore()
      let checked = 0
      external.check = async () => { checked += 1 }
      const persistence = await RegistryPersistence.open({} as never, persistenceOptions(root), external)
      expect(persistence.store).toBe(external)
      expect(checked).toBe(1)
      await persistence.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails loudly when the external store self-check rejects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mygo-registry-seam-'))
    try {
      const external = new InMemoryRegistryStore()
      external.check = async () => { throw new Error('schema drift') }
      await expect(RegistryPersistence.open({} as never, persistenceOptions(root), external))
        .rejects.toThrow(/self-check failed: schema drift/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('migrates raw sqlite registry rows into an empty external store at open', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mygo-registry-seam-'))
    const imported: string[] = []
    let marked = false
    const external = {
      async check() {},
      async migrationMarked() { return false },
      async listIds() { return [] },
      async importRawStatus(key: string) { imported.push(`status:${key}`) },
      async importRawGeneration(key: string) { imported.push(`gens:${key}`) },
      async markMigrated() { marked = true },
    }
    const facility = {
      async open() {
        return {
          table(name: string) {
            const rows = name === 'gens'
              ? new Map([['legacy/1', '"gen"']])
              : new Map([['legacy', '"status"']])
            return { entries() { return rows.entries() } }
          },
          async close() {},
        }
      },
    }
    try {
      await RegistryPersistence.open(facility as never, persistenceOptions(root), external as never)
      expect(imported).toEqual(['gens:legacy/1', 'status:legacy'])
      expect(marked).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips migration when the external store already has rows', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mygo-registry-seam-'))
    const imported: string[] = []
    const external = {
      async check() {},
      async migrationMarked() { return false },
      async listIds() { return ['already'] },
      async importRawStatus(key: string) { imported.push(`status:${key}`) },
      async importRawGeneration(key: string) { imported.push(`gens:${key}`) },
      async markMigrated() {},
    }
    const facility = {
      async open() {
        return {
          table() { return { entries() { return new Map([['x/1', '"y"']]).entries() } } },
          async close() {},
        }
      },
    }
    try {
      await RegistryPersistence.open(facility as never, persistenceOptions(root), external as never)
      expect(imported).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('routes audit appends to the external store when it supports them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mygo-registry-seam-'))
    const appended: unknown[] = []
    const external = {
      async check() {},
      async migrationMarked() { return true },
      async appendAudit(entry: unknown) { appended.push(entry) },
    }
    try {
      const persistence = await RegistryPersistence.open({} as never, persistenceOptions(root), external as never)
      await persistence.audit.append({
        v: 1,
        ts: 1,
        profile: 'web',
        class: 'mount',
        actor: 'system',
      } as never)
      expect(appended).toHaveLength(1)
      await persistence.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
