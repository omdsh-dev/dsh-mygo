import type {
  InstallIntent,
  InstallReceipt,
  InstallTarget,
  LoaderAdapter,
  RegistryEntry,
} from '@r05en1cu/dsh-mygo-api'
import type { HubEntry, HubRegistry } from './registry.ts'
import { pickHubRelease } from './assess.ts'

export interface HubLoaderAdapter extends LoaderAdapter {
  readonly id: 'hub'
  /** 构造时绑定的 registry（适配器不可变；刷新 = 重新构造注册）。 */
  readonly registry: HubRegistry
  /** 按 id 取条目。 */
  entry(id: string): HubEntry | undefined
}

const HUB_SPEC_RE = /^hub:([a-z0-9][a-z0-9._-]*)(?:@(\S+))?$/

export interface CreateHubLoaderAdapterOptions {
  readonly registry: HubRegistry
  /**
   * pnpm intent 的最终执行面（profile adapter 的 install 签名子集）。
   * 不提供时 install 一律拒绝（只读检索面）。
   */
  readonly execute?: (intent: InstallIntent, target: InstallTarget) => Promise<InstallReceipt>
}

/** 构造 hub LoaderAdapter（registry 预先加载并校验后再构造，sync 契约）。 */
export function createHubLoaderAdapter(options: CreateHubLoaderAdapterOptions): HubLoaderAdapter {
  const byId = new Map(options.registry.entries.map(entry => [entry.id, entry]))
  return {
    id: 'hub',
    registry: options.registry,
    entry: (id: string) => byId.get(id),
    resolve(spec: string): InstallIntent | null {
      const match = HUB_SPEC_RE.exec(spec)
      if (match === null) return null
      const entry = byId.get(match[1] ?? '')
      if (entry === undefined) return null
      const release = pickHubRelease(entry, match[2])
      if (release === undefined) {
        return { kind: 'display', reason: `hub 条目 ${entry.id} 没有 release ${match[2] ?? entry.latestRelease}` }
      }
      const install = release.install
      if (install.mode === 'profile-bundle'
        && typeof install.packageName === 'string'
        && typeof install.spec === 'string') {
        return {
          kind: 'pnpm',
          spec: /^(?:v)?\d+\.\d+\.\d+/.test(install.spec) ? `${install.packageName}@${install.spec}` : install.spec,
        }
      }
      return { kind: 'display', reason: 'hub 条目没有可执行安装意图' }
    },
    async install(intent: InstallIntent, target: InstallTarget): Promise<InstallReceipt> {
      if (options.execute === undefined) {
        return {
          ok: false,
          error: { code: 'package-not-resolvable', message: 'hub adapter 未绑定执行面（只读检索模式）' },
        }
      }
      if (intent.kind !== 'pnpm') {
        const reason = intent.kind === 'display' ? intent.reason : 'pack intent 不经 hub adapter'
        return { ok: false, error: { code: 'package-not-resolvable', message: reason } }
      }
      return options.execute(intent, target)
    },
    list(query?: string): Promise<readonly RegistryEntry[]> {
      const needle = query?.toLowerCase()
      const entries = options.registry.entries
        .filter(entry => needle === undefined || needle === ''
          || entry.id.includes(needle)
          || entry.displayName.toLowerCase().includes(needle)
          || entry.description.toLowerCase().includes(needle)
          || entry.tags.some(tag => tag.includes(needle)))
        .map(entry => ({
          name: entry.id,
          ...(entry.version === null ? {} : { version: entry.version }),
          description: entry.description,
        }))
      return Promise.resolve(entries)
    },
  }
}
