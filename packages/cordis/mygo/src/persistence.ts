/**
 * Registry persistence facade (#17): opens the per-profile
 * `plugin_registry_<profile>` domain over the storage hub, plus the snapshot
 * file store and the audit JSONL for the same profile. The engine receives
 * this facade (or runs in-memory without it); the factory composition wiring
 * lands with #18.
 * @module @deepseek-ai/dsh-mygo/src/persistence
 */

import type { Context } from 'cordis'
import type { Domain, DomainFacility, DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { AuditLog } from './audit.ts'
import { pluginRegistryDomainSpec } from './registry-domain.ts'
import { SnapshotStore } from './snapshots.ts'
import { SqliteRegistryStore } from './sqlite-store.ts'

/** Options for opening one profile's persistence. */
export interface RegistryPersistenceOptions {
  /** Profile name; sanitized into the domain unit name. */
  readonly profile: string
  /** Base state directory (`stateRoot` from the manager Config). */
  readonly stateRoot: string
  /** Audit rotation threshold per file. */
  readonly auditMaxBytes: number
  /** Audit rotated files retained. */
  readonly auditKeepFiles: number
  /** Names already claimed on the medium (profile sanitization collisions). */
  readonly taken?: ReadonlySet<string>
}

/**
 * The sqlite registry domain, snapshot files, and audit log of one profile.
 * The owner closes the facade (which closes the domain handle).
 */
export class RegistryPersistence {
  private constructor(
    readonly store: SqliteRegistryStore,
    readonly snapshots: SnapshotStore,
    readonly audit: AuditLog,
    readonly profile: string,
    private readonly domain: Domain<DomainSpec>,
  ) {}

  /**
   * Open the profile's registry domain, snapshot store, and audit log, and
   * subscribe `domain/reset` into the audit stream (T4-5 medium-reset).
   * @param ctx - context for the reset event subscription.
   * @param facility - the mounted domain facility.
   * @param options - profile and policy knobs.
   * @returns the composed persistence facade.
   */
  static async open(
    ctx: Context,
    facility: DomainFacility,
    options: RegistryPersistenceOptions,
  ): Promise<RegistryPersistence> {
    const spec = pluginRegistryDomainSpec(options.profile, options.taken)
    const snapshots = new SnapshotStore(joinStateRoot(options.stateRoot, options.profile))
    const audit = new AuditLog(
      joinStateRoot(options.stateRoot, options.profile),
      options.profile,
      options.auditMaxBytes,
      options.auditKeepFiles,
    )
    // Subscribe before open so the medium-reset event of this open is audited.
    ctx.on('domain/reset', (reset) => {
      if (reset.domain === spec.name) {
        void audit.append({ class: 'medium-reset', actor: 'system', details: { code: reset.code } })
          .catch((error: unknown) => { ctx.logger.warn(`plugin registry medium-reset audit failed: ${String(error)}`) })
      }
    })
    const domain = await facility.open(spec)
    const store = new SqliteRegistryStore(domain)
    return new RegistryPersistence(store, snapshots, audit, options.profile, domain)
  }

  /** Close the domain handle (idempotent); the store becomes unusable. */
  async close(): Promise<void> {
    await this.domain.close()
  }
}

function joinStateRoot(stateRoot: string, profile: string): string {
  return `${stateRoot.replace(/\/+$/, '')}/${profile}`
}
