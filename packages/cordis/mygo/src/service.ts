/**
 * The `ctx.pluginManager` Cordis service (#18 factory integration): opens
 * the per-profile registry persistence, owns the dispatch machine and
 * lifecycle engine, runs boot recovery, and exposes the §15.3 operation
 * surface. The two deferred wirings close here — `onAutoDisable` runs the
 * engine's disable protocol (SEC:148) and dispatch violations flow into the
 * audit stream (T5 classes) — and the composition teardown disposes the
 * engine and closes the domain.
 * @module @deepseek-ai/dsh-mygo/src/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from 'schemastery'
import type Schema from 'schemastery'
import { fromCordisPlugin, PluginError, formatPluginError } from '@deepseek-ai/dsh-mygo-api'
import type {
  InstallOptions,
  PluginDefinition,
  PluginEntrypointsDeclaration,
  PluginExecRequest,
  PluginExecResult,
  PluginHandleInfo,
  PluginModelRequest,
  PluginModelResponse,
  RawCordisFunctionPlugin,
  PluginSource,
} from '@deepseek-ai/dsh-mygo-api'
import { PluginManagerConfigSchema, resolvePluginManagerConfig } from './config.ts'
import {
  buildBom,
  checkBom,
  checkTarget,
  loadBomTarget,
  renderBomMarkdown,
  type BomCheckReport,
  type BomCurrentMember,
  type BomDocument,
} from './bom.ts'
import { BundleRail } from './bundle-rail.ts'
import { DispatchMachine } from './dispatch.ts'
import type { DispatchViolation } from './dispatch.ts'
import { EVENT_VOCABULARY } from './event-vocabulary.ts'
import { EntrypointsTable } from './entrypoints.ts'
import { LifecycleEngine, MYGO_MANAGER_CAPABILITY, MYGO_MANAGER_ID, MYGO_MANAGER_VERSION } from './lifecycle.ts'
import { RegistryPersistence } from './persistence.ts'
import { extractPlugin, loadPluginEntry, PluginPackageManager, resolveCoreVersion, resolveMygoPaths } from './package/index.ts'
import type { PluginManifestV2 } from './package/index.ts'
import type { AuditClass } from './audit.ts'
import type { RegistryStore } from './store.ts'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { dshHomePath } from '@deepseek-ai/dsh-paths'
import type {
  PluginManager,
  PluginManagerConfig,
  PluginOperation,
  PluginOperationPlan,
  PluginSupportCheck,
} from './types.ts'

/** Schemastery Config for the dsh-mygo row: the §15.6/§17 surface plus the profile name. */
export const PluginManagerServiceConfig = z.intersect([
  PluginManagerConfigSchema,
  z.object({
    profile: z.string().required(),
    // npm 源 registry 基址；缺省官方 registry（测试注入本地桩，P-0 离线确定）。
    registry: z.string().required(false),
    // Internally: mana. Five empty casts and you're benched.
    cpuBudgetMs: z.number().min(0).default(100),
  }),
]) as unknown as Schema<PluginManagerServiceConfigValue>

/** Resolved row config: the §15.6/§17 surface plus the profile name. */
export type PluginManagerServiceConfigValue = PluginManagerConfig & {
  readonly profile: string
  readonly registry?: string
  readonly cpuBudgetMs: number
}

/**
 * The manager service. `install`/`replace`/`adopt` are async through the
 * engine's staging; `plugins()` and `plan()` are synchronous pure reads.
 */
export class PluginManagerService extends Service implements PluginManager {
  static inject = ['storage', 'storageDomain']
  static Config: Schema<PluginManagerServiceConfigValue> = PluginManagerServiceConfig

  private readonly resolved: PluginManagerConfig
  private engine: LifecycleEngine | undefined
  private persistence: RegistryPersistence | undefined
  private readonly packageManager: PluginPackageManager

  /**
   * @param ctx - the plugin context (`storage` and `storageDomain` injected).
   * @param config - the schemastery-resolved row config.
   */
  constructor(
    ctx: Context,
    public readonly config: PluginManagerServiceConfigValue,
  ) {
    super(ctx, 'pluginManager')
    const { profile: _profile, ...rest } = config
    this.resolved = resolvePluginManagerConfig(rest)
    const paths = resolveMygoPaths(config.profile)
    const coreVersion = resolveCoreVersion(process.env)
    this.packageManager = new PluginPackageManager({
      paths,
      profile: config.profile,
      ...(config.registry === undefined ? {} : { registry: config.registry }),
      ...(coreVersion === undefined ? {} : { coreVersion }),
      managerVersion: MYGO_MANAGER_VERSION,
    })
  }

  /** Open persistence, build the machine/engine, wire the two deferred sinks, and recover. */
  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const entrypoints = new EntrypointsTable(ctx)
    const externalStore = ctx.get('mygoRegistryStore') as RegistryStore | undefined
    if (externalStore !== undefined) {
      ctx.logger.info('[dsh-mygo] 使用外部注册表存储（mygoRegistryStore）')
    }
    const persistence = await RegistryPersistence.open(ctx.storageDomain, {
      profile: this.config.profile,
      stateRoot: this.resolved.stateRoot,
      auditMaxBytes: this.resolved.auditMaxBytes,
      auditKeepFiles: this.resolved.auditKeepFiles,
    }, externalStore)
    // 加载时校验（不重新求解）：lockfile 与磁盘（版本+哈希）不一致 MUST 硬阻断。
    const bootVerify = await this.packageManager.verifyAtBoot()
    if (!bootVerify.ok) {
      throw new PluginError(
        'package-not-resolvable',
        formatPluginError('package-not-resolvable', {
          package: 'lockfile',
          anchors: bootVerify.report.summary,
        }),
        { package: 'lockfile', report: bootVerify.report },
      )
    }
    const mountOrderResult = await this.packageManager.mountOrder()
    if (!mountOrderResult.ok) {
      throw new PluginError(
        'ordering-cycle',
        formatPluginError('ordering-cycle', {
          cycle: mountOrderResult.report.cycles[0]?.cycle.join(' → ') ?? 'unknown',
        }),
        { cycle: mountOrderResult.report.cycles[0]?.cycle, report: mountOrderResult.report },
      )
    }
    const holder: { engine?: LifecycleEngine } = {}
    const hostLlm = ctx.get('llm') as
      | { stream(options: unknown): AsyncIterable<unknown> }
      | undefined
    const llm = hostLlm === undefined
      ? undefined
      : async (request: PluginModelRequest): Promise<PluginModelResponse> => {
          let text = ''
          let promptTokens: number | undefined
          let completionTokens: number | undefined
          for await (const chunk of hostLlm.stream({
            provider: 'managed-plugin',
            model: request.model,
            messages: request.messages.map(message => ({ role: message.role, content: message.content })),
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
          })) {
            if (typeof chunk !== 'object' || chunk === null) continue
            const record = chunk as { type?: unknown; text?: unknown; usage?: { promptTokens?: number; completionTokens?: number } }
            if (record.type === 'text-delta' && typeof record.text === 'string') text += record.text
            if (record.type === 'usage' && record.usage !== undefined) {
              promptTokens = record.usage.promptTokens
              completionTokens = record.usage.completionTokens
            }
          }
          return {
            content: text,
            model: request.model,
            ...(promptTokens !== undefined || completionTokens !== undefined
              ? {
                  usage: {
                    ...(promptTokens === undefined ? {} : { promptTokens }),
                    ...(completionTokens === undefined ? {} : { completionTokens }),
                  },
                }
              : {}),
          }
        }
    const hostSubprocess = ctx.get('subprocess') as
      | {
          spawn(spec: {
            argv: readonly string[]
            cwd: string
            stdio: { stdin: unknown; stdout: unknown; stderr: unknown }
            graceMs: number
            signal?: AbortSignal
          }): {
            done: Promise<{ exitCode: number | null; signal: string | null }>
            stdout?: { on(event: 'data', listener: (chunk: Buffer) => void): void }
            stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): void }
          }
        }
      | undefined
    const exec = hostSubprocess === undefined
      ? undefined
      : async (request: PluginExecRequest): Promise<PluginExecResult> => {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 30_000)
          try {
            const handle = hostSubprocess.spawn({
              argv: [request.command, ...(request.args ?? [])],
              cwd: request.cwd ?? process.cwd(),
              stdio: {
                stdin: request.stdin === undefined ? 'ignore' : { data: request.stdin },
                stdout: 'pipe',
                stderr: 'pipe',
              },
              graceMs: 2_000,
              signal: request.signal ?? controller.signal,
            })
            const stdoutChunks: Buffer[] = []
            const stderrChunks: Buffer[] = []
            let stdoutBytes = 0
            let stderrBytes = 0
            const MAX_CAPTURE_BYTES = 8 * 1024 * 1024
            handle.stdout?.on('data', (chunk: Buffer) => {
              if (stdoutBytes >= MAX_CAPTURE_BYTES) return
              stdoutChunks.push(chunk)
              stdoutBytes += chunk.length
            })
            handle.stderr?.on('data', (chunk: Buffer) => {
              if (stderrBytes >= MAX_CAPTURE_BYTES) return
              stderrChunks.push(chunk)
              stderrBytes += chunk.length
            })
            const outcome = await handle.done
            const stdoutRaw = Buffer.concat(stdoutChunks)
            const stderrRaw = Buffer.concat(stderrChunks)
            return {
              stdout: stdoutRaw.toString('utf8'),
              stderr: stderrRaw.toString('utf8'),
              code: outcome.exitCode ?? -1,
              stdoutBytes: new Uint8Array(stdoutRaw),
              stderrBytes: new Uint8Array(stderrRaw),
            }
          } finally {
            clearTimeout(timeout)
          }
        }
    const hostHttpServer = ctx.get('httpServer') as
      | { register(route: unknown): () => void }
      | undefined
    const hostSkills = ctx.get('skills') as
      | { registerProvider(create: (control: unknown) => unknown): () => void }
      | undefined
    const hostCommands = ctx.get('commands') as
      | { register(definition: unknown): () => void }
      | undefined
    const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const dshBin = resolveDshBin()
    const dshInstallDir = resolveDshInstallDir()
    const sourceCheckout = resolveSourceCheckout()
    const bundleRail = new BundleRail({
      dshHome,
      profile: this.config.profile,
      ...(dshBin === undefined ? {} : { dshBin }),
      ...(dshInstallDir === undefined ? {} : { dshInstallDir }),
      ...(sourceCheckout === undefined ? {} : { checkout: sourceCheckout }),
    })
    const machine = new DispatchMachine(ctx, {
      vocabulary: new Map(EVENT_VOCABULARY.map(entry => [entry.name, entry.mode])),
      cpuBudgetMs: this.config.cpuBudgetMs,
      onAutoDisable: (pluginId) => {
        // SEC:148 closure: five consecutive CPU-quota violations disable the plugin.
        void holder.engine?.disable(pluginId, 'cpu-quota').catch((error: unknown) => {
          ctx.logger.warn(`plugin ${pluginId} auto-disable failed: ${String(error)}`)
        })
      },
      onViolation: (violation) => {
        ctx.logger.warn(violation.message)
        void persistence.audit.append({
          class: auditClassOf(violation.code),
          actor: 'system',
          reason: violation.code,
          details: violation.details,
        }).catch((error: unknown) => { ctx.logger.warn(`plugin registry violation audit failed: ${String(error)}`) })
      },
    })
    machine.start()
    const engine = new LifecycleEngine({
      ctx,
      dispatch: machine,
      store: persistence.store,
      config: this.resolved,
      entrypoints,
      eventVocabulary: EVENT_VOCABULARY,
      persistence,
      ...(llm === undefined ? {} : { llm }),
      ...(exec === undefined ? {} : { exec }),
      ...(hostHttpServer === undefined ? {} : { httpServer: hostHttpServer }),
      ...(hostSkills === undefined ? {} : { skillService: hostSkills }),
      ...(hostCommands === undefined ? {} : { commandService: hostCommands }),
      bundleRail,
      hostService: (capability: string) => ctx.get(capability),
      hostProvide: (name: string, value: unknown) => ctx.provide(name, value),
      resolveSource: (source) => {
        if (source.type === 'npm') {
          return this.resolveNpmSource(source.package)
        }
        return Promise.resolve(evaluateInlineDefinition(source.code))
      },
      resolveSourcePreview: (source) => {
        if (source.type === 'npm') {
          return this.previewNpmSource(source.package)
        }
        return Promise.resolve(evaluateInlineDefinition(source.code))
      },
      ...(mountOrderResult.ok ? { recoverOrder: mountOrderResult.order } : {}),
    })
    holder.engine = engine
    await engine.recover()
    // DG-2（修复批次 3）：把 lockfile 的 entry 级哈希/字节数灌入运行时 record
    // （恢复路径写入点；BOM 对账输出消费）。readLock 形状校验失败在此前
    // verifyAtBoot 已硬阻断，这里只可能 undefined（无 lockfile）或合法载荷。
    try {
      const lockfile = await this.packageManager.readLock()
      if (lockfile !== undefined) {
        const facts = new Map<string, { readonly entrySha512: string; readonly entryFileSize?: number }>()
        for (const [id, lock] of Object.entries(lockfile.plugins)) {
          facts.set(id, {
            entrySha512: lock.entrySha512,
            ...(lock.entryFileSize === undefined ? {} : { entryFileSize: lock.entryFileSize }),
          })
        }
        engine.attachBomFacts(facts)
      }
    } catch (error) {
      throw new PluginError(
        'package-not-resolvable',
        formatPluginError('package-not-resolvable', {
          package: 'lockfile',
          anchors: error instanceof Error ? error.message : String(error),
        }),
        { package: 'lockfile' },
      )
    }
    this.engine = engine
    this.persistence = persistence
    // Publish the aggregation service so host-shaped raw plugins can own
    // (`define`) and consume (`get`) extension-point keys without mygo code.
    const entrypointsDisposer = ctx.provide('entrypoints', entrypoints)
    // Zero-intrusion unknown-tool attribution: the harness wraps every tool
    // dispatch in the `tools/execute` waterfall, so intercepting there lets a
    // call to an uninstalled plugin's old tool return a friendly failure
    // without any harness modification.
    ctx.on('tools/execute' as never, ((exec: { readonly name?: unknown }, next: () => Promise<unknown>) => {
      const name = typeof exec?.name === 'string' ? exec.name : ''
      const tombstone = holder.engine?.resolveUnknownTool(name)
      if (tombstone === undefined) return next()
      const message = `工具 ${name} 已不可用：插件 ${tombstone.pluginId} 已被卸载`
      return {
        isError: true,
        error: { message, info: { name: 'ToolUnavailableError', code: 'TOOL_UNAVAILABLE' } },
        content: [{ type: 'text', text: `Error: ${message}` }],
      }
    }) as never)
    ctx.effect(() => () => {
      holder.engine?.dispose()
      entrypointsDisposer()
      void persistence.close()
    }, 'pluginManager.teardown')
  }

  /** Resolve an npm plugin source: locked store first, registry install second. */
  private async resolveNpmSource(packageName: string): Promise<PluginDefinition> {
    try {
      const loaded = await this.packageManager.loadEntry(packageName)
      if (loaded !== undefined) {
        return this.definitionFromManifest(loaded.plugin, loaded.installed.manifest)
      }
      const outcome = await this.packageManager.resolveInstall({ package: packageName })
      if (!outcome.ok) {
        throw new PluginError(
          'package-not-resolvable',
          formatPluginError('package-not-resolvable', {
            package: packageName,
            anchors: outcome.report.summary,
          }),
          { package: packageName, report: outcome.report },
        )
      }
      const module = await loadPluginEntry(outcome.installed.dir, outcome.installed.entry)
      const plugin = extractPlugin(module)
      if (plugin === undefined) {
        throw new PluginError(
          'package-not-resolvable',
          formatPluginError('package-not-resolvable', {
            package: packageName,
            anchors: `入口 ${outcome.installed.entry} 未导出可挂载插件`,
          }),
          { package: packageName },
        )
      }
      return this.definitionFromManifest(plugin, outcome.installed.manifest)
    } catch (error) {
      if (error instanceof PluginError) throw error
      throw new PluginError(
        'package-not-resolvable',
        formatPluginError('package-not-resolvable', {
          package: packageName,
          anchors: error instanceof Error ? error.message : String(error),
        }),
        { package: packageName },
      )
    }
  }

  /** Pure npm preview for plan(): metadata + resolve only, no install. */
  private async previewNpmSource(packageName: string): Promise<PluginDefinition> {
    try {
      const outcome = await this.packageManager.preview({ package: packageName })
      if (!outcome.ok) {
        throw new PluginError(
          'package-not-resolvable',
          formatPluginError('package-not-resolvable', {
            package: packageName,
            anchors: outcome.report.summary,
          }),
          { package: packageName, report: outcome.report },
        )
      }
      return this.definitionFromManifestOnly(outcome.manifest)
    } catch (error) {
      if (error instanceof PluginError) throw error
      throw new PluginError(
        'package-not-resolvable',
        formatPluginError('package-not-resolvable', {
          package: packageName,
          anchors: error instanceof Error ? error.message : String(error),
        }),
        { package: packageName },
      )
    }
  }

  /** Build an inert (never-mounted) PluginDefinition from a v2 manifest. */
  private definitionFromManifestOnly(manifest: PluginManifestV2): PluginDefinition {
    return {
      id: manifest.id,
      version: manifest.version,
      kinds: [],
      events: [],
      requires: [],
      serviceRequires: manifest.requires,
      ...(Object.keys(manifest.symbolAliases ?? {}).length === 0
        ? {}
        : { symbolAliases: manifest.symbolAliases }),
      provides: manifest.provides,
      permissions: {
        observe: [],
        transform: [],
        intercept: [],
        position: 'derived',
        claims: [],
      },
      stateful: false,
      swapPolicy: 'immediate',
      config: z.object({}),
      hooks: {
        activate: async () => {
          throw new Error(`preview definition 不可挂载：${manifest.id}`)
        },
      },
      ...(Object.keys(manifest.entrypoints).length === 0
        ? {}
        : { entrypoints: manifest.entrypoints as unknown as PluginEntrypointsDeclaration }),
      ...(Object.keys(manifest.depends).length === 0 && Object.keys(manifest.breaks).length === 0
        ? {}
        : {
            compatibility: {
              ...(Object.keys(manifest.depends).length === 0 ? {} : { requires: manifest.depends }),
              ...(Object.keys(manifest.breaks).length === 0 ? {} : { breaks: manifest.breaks }),
            },
          }),
    }
  }

  /** Convert a loaded plugin entry + v2 manifest into a runtime PluginDefinition. */
  private definitionFromManifest(plugin: unknown, manifest: PluginManifestV2): PluginDefinition {
    return fromCordisPlugin(plugin as RawCordisFunctionPlugin, {
      id: manifest.id,
      version: manifest.version,
      kinds: [],
      events: [],
      requires: [],
      serviceRequires: manifest.requires,
      ...(Object.keys(manifest.symbolAliases ?? {}).length === 0
        ? {}
        : { symbolAliases: manifest.symbolAliases }),
      provides: manifest.provides,
      permissions: {
        observe: [],
        transform: [],
        intercept: [],
        position: 'derived',
        claims: [],
      },
      stateful: false,
      swapPolicy: 'immediate',
      config: z.object({}),
      ...(Object.keys(manifest.entrypoints).length === 0
        ? {}
        : { entrypoints: manifest.entrypoints as unknown as PluginEntrypointsDeclaration }),
      ...(Object.keys(manifest.depends).length === 0 && Object.keys(manifest.breaks).length === 0
        ? {}
        : {
            compatibility: {
              ...(Object.keys(manifest.depends).length === 0 ? {} : { requires: manifest.depends }),
              ...(Object.keys(manifest.breaks).length === 0 ? {} : { breaks: manifest.breaks }),
            },
          }),
    })
  }

  install(source: PluginSource, options?: InstallOptions): Promise<PluginHandleInfo> {
    return this.requireEngine().install(source, options)
  }

  uninstall(id: string): Promise<void> {
    return this.requireEngine().uninstall(id)
  }

  enable(id: string): Promise<void> {
    return this.requireEngine().enable(id)
  }

  disable(id: string, reason?: string, force?: boolean): Promise<void> {
    return this.requireEngine().disable(id, reason, force)
  }

  replace(
    id: string,
    source: PluginSource,
    options?: { readonly force?: boolean; readonly config?: unknown },
  ): Promise<PluginHandleInfo> {
    return this.requireEngine().replace(id, source, options)
  }

  updateConfig(id: string, patch: unknown): Promise<void> {
    return this.requireEngine().updateConfig(id, patch)
  }

  plugins(): readonly PluginHandleInfo[] {
    return this.requireEngine().plugins()
  }

  configOf(id: string): unknown | undefined {
    return this.requireEngine().configOf(id)
  }

  async plan(operation: PluginOperation): Promise<PluginOperationPlan> {
    return this.requireEngine().plan(operation)
  }

  planInstall(declaration: {
    readonly id: string
    readonly version?: string
    readonly compatibility?: import('@deepseek-ai/dsh-mygo-api').PluginCompatibility
    readonly provides?: readonly string[]
  }): Promise<PluginOperationPlan> {
    return this.requireEngine().planInstall(declaration)
  }

  bundleList(): readonly import('./bundle-rail.ts').BundleMember[] {
    return this.requireEngine().bundleList()
  }

  /**
   * P4 BOM：把统一依赖图导出为 `dsh.bom/v1`（JSON + Markdown），
   * 原子写并保留上一次文件。
   */
  async bomExport(): Promise<{ readonly bom: BomDocument; readonly jsonPath: string; readonly mdPath: string }> {
    const engine = this.requireEngine()
    const bom = buildBom({
      profile: this.config.profile,
      bridgePlugins: engine.plugins().filter(plugin => plugin.status === 'enabled'),
      bundles: this.bundleList().filter(member => member.enabled),
    })
    const dir = join(dshHomePath('mygo-boms'), this.config.profile)
    await mkdir(dir, { recursive: true })
    const jsonPath = join(dir, 'dsh.bom.json')
    const mdPath = join(dir, 'dsh.bom.md')
    const tmpJson = `${jsonPath}.tmp`
    const tmpMd = `${mdPath}.tmp`
    await writeFile(tmpJson, JSON.stringify(bom, null, 2))
    await writeFile(tmpMd, renderBomMarkdown(bom))
    await rename(tmpJson, jsonPath)
    await rename(tmpMd, mdPath)
    return { bom, jsonPath, mdPath }
  }

  /**
   * P4 BOM：只读对账。无 `target` 时对比 BOM lock 与当前 profile 集合
   * （missing / extra / drift / 约束违例链）；带 `target` 时校验一个
   * 新插件目录的 package.json 声明是否落在 BOM 生态带内。零修改。
   */
  async bomCheck(options: { readonly target?: string } = {}): Promise<BomCheckReport> {
    const bom = await this.readBom()
    if (options.target !== undefined) {
      const target = await loadBomTarget(options.target)
      return checkTarget(bom, target)
    }
    const current: BomCurrentMember[] = [
      ...this.requireEngine().plugins().map((plugin): BomCurrentMember => ({
        id: plugin.id,
        version: plugin.version,
        status: plugin.status,
        ...(plugin.provides.length === 0 ? {} : { provides: plugin.provides }),
        ...(plugin.compatibility === undefined ? {} : { compatibility: plugin.compatibility }),
      })),
      ...this.bundleList().map((member): BomCurrentMember => ({
        id: member.id,
        version: member.version ?? '*',
        status: member.enabled ? 'enabled' : 'disabled',
        ...(member.provides === undefined ? {} : { provides: member.provides }),
        ...(member.compatibility === undefined ? {} : { compatibility: member.compatibility }),
      })),
      {
        id: MYGO_MANAGER_ID,
        version: MYGO_MANAGER_VERSION,
        status: 'enabled',
        provides: [MYGO_MANAGER_CAPABILITY],
      },
    ]
    return checkBom(bom, current)
  }

  private async readBom(): Promise<BomDocument> {
    const path = join(dshHomePath('mygo-boms'), this.config.profile, 'dsh.bom.json')
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      throw new Error(`未找到 BOM（先执行导出）: ${path}（${String(error)}）`)
    }
    const bom = parsed as BomDocument
    if (bom.format !== 'dsh.bom/v1') throw new Error(`不是有效的 dsh.bom/v1 文件: ${path}`)
    return bom
  }

  bundleInstall(spec: string): Promise<import('./bundle-rail.ts').BundleInstallResult> {
    return this.requireEngine().bundleInstall(spec)
  }

  bundleUninstall(id: string): Promise<void> {
    return this.requireEngine().bundleUninstall(id)
  }

  bundleSetEnabled(id: string, enabled: boolean, force?: boolean): Promise<void> {
    return this.requireEngine().bundleSetEnabled(id, enabled, force)
  }

  /**
   * Audit entries since a timestamp (T5-4 host-side read; oldest first).
   * @param since - lower timestamp bound (inclusive, epoch millis).
   * @returns matching entries in chronological order.
   */
  async auditSince(since: number): Promise<readonly import('./audit.ts').AuditEntry[]> {
    return this.requirePersistence().audit.since(since)
  }

  /**
   * Audit entries naming one plugin (T5-4 host-side read).
   * @param id - plugin id to filter by.
   * @returns matching entries in chronological order.
   */
  async auditByPlugin(id: string): Promise<readonly import('./audit.ts').AuditEntry[]> {
    return this.requirePersistence().audit.byPlugin(id)
  }

  /**
   * The last `count` audit entries (T5-4 host-side read).
   * @param count - number of most recent entries to return.
   * @returns the tail slice in chronological order.
   */
  async auditTail(count: number): Promise<readonly import('./audit.ts').AuditEntry[]> {
    return this.requirePersistence().audit.tail(count)
  }

  async adopt(definition: PluginDefinition, config: unknown): Promise<void> {
    await this.requireEngine().adoptStatic(definition, config)
  }

  /** Zero-intrusion static adoption of a raw Cordis plugin (see {@link PluginManager.adoptRaw}). */
  async adoptRaw(
    raw: RawCordisFunctionPlugin,
    config: unknown,
    id?: string,
    declaration?: import('@deepseek-ai/dsh-mygo-api').RawPluginDeclaration,
  ): Promise<PluginHandleInfo> {
    return this.requireEngine().adoptRaw(raw, config, id, declaration)
  }

  /** Live-update an adopted raw plugin through the HMR replace protocol. */
  updateRaw(
    raw: RawCordisFunctionPlugin,
    config: unknown,
    id: string,
    declaration?: import('@deepseek-ai/dsh-mygo-api').RawPluginDeclaration,
  ): Promise<PluginHandleInfo> {
    return this.requireEngine().updateRaw(raw, config, id, declaration)
  }

  /** Pre-mount support check (see {@link PluginManager.checkSupport}). */
  checkSupport(
    raw: RawCordisFunctionPlugin,
    id?: string,
    declaration?: import('@deepseek-ai/dsh-mygo-api').RawPluginDeclaration,
  ): Promise<PluginSupportCheck> {
    return this.requireEngine().checkSupport(raw, id, declaration)
  }

  /** Pure compatibility preflight (see {@link PluginManager.checkCompatibility}). */
  checkCompatibility(declaration: {
    readonly id: string
    readonly version?: string
    readonly compatibility?: import('@deepseek-ai/dsh-mygo-api').PluginCompatibility
  }): import('@deepseek-ai/dsh-mygo-api').CompatibilityReport {
    return this.requireEngine().checkCompatibility(declaration)
  }

  /** Remove an uninstall tombstone (see {@link PluginManager.clearUninstallTombstone}). */
  clearUninstallTombstone(id: string): Promise<void> {
    return this.requireEngine().clearUninstallTombstone(id)
  }

  private requireEngine(): LifecycleEngine {
    if (this.engine === undefined) {
      throw new Error('plugin manager service is not initialized')
    }
    return this.engine
  }

  private requirePersistence(): RegistryPersistence {
    if (this.persistence === undefined) {
      throw new Error('plugin manager service is not initialized')
    }
    return this.persistence
  }
}

/**
 * Evaluate one inline plugin source into a definition. Inline code is the
 * model channel's own source (cordis_mount's only accepted source); it runs
 * in-process with the same trust stance as the tool-cordis sandbox upstream.
 * The code must set `module.exports` to a `PluginDefinition`.
 * @param code - inline module source.
 * @returns the evaluated definition.
 */
function evaluateInlineDefinition(code: string): PluginDefinition {
  const module = { exports: undefined as unknown }
  // The inline source is model-authored code by contract; evaluation is the
  // manager's host power (reference-not-fetch, decision #11).
  // oxlint-disable-next-line typescript/no-implied-eval -- inline plugin source is the model channel's own code by contract (#11).
  const factory = new Function('module', 'exports', code)
  // oxlint-disable-next-line typescript/no-unsafe-call -- the receiver is the literal Function created above.
  factory(module, module.exports)
  const value = module.exports
  if (typeof value === 'object' && value !== null && typeof (value as PluginDefinition).id === 'string') {
    return value as PluginDefinition
  }
  throw new Error('inline plugin source did not export a PluginDefinition')
}

/**
 * Walk up from a module directory until the dsh checkout root is found.
 * The depth to `packages/cordis/mygo/src` (3) differs from the built
 * `packages/cordis/mygo/lib` (4), so a fixed `../../..` is wrong in lib.
 */
/**
 * Resolve the `dsh` executable for bundle-rail forwarding: explicit
 * `DSH_BIN` env wins, then the `@deepseek-ai/dsh` package's bin from mygo's
 * own module anchor (npm layout), else PATH lookup by the spawn default.
 */
function resolveDshBin(): string | undefined {
  const explicit = process.env.DSH_BIN
  if (typeof explicit === 'string' && explicit !== '') return explicit
  try {
    const anchor = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
    return join(dirname(anchor), 'lib', 'bin.js')
  } catch {
    return undefined
  }
}

/** dsh 安装目录：env 优先，其次 @deepseek-ai/dsh 包目录（npm 布局）。 */
function resolveDshInstallDir(): string | undefined {
  const explicit = process.env.DSH_INSTALL_DIR
  if (typeof explicit === 'string' && explicit !== '') return explicit
  try {
    const anchor = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
    return dirname(anchor)
  } catch {
    return undefined
  }
}

/** 源码 checkout（legacy）：向上找 checkout 标记，找不到返回 undefined。 */
function resolveSourceCheckout(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth++) {
    if (
      existsSync(join(dir, 'packages', 'client', 'tsdown.client.ts'))
      || existsSync(join(dir, 'apps', 'cli', 'src', 'bin.ts'))
    ) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** Map one dispatch violation code to the §22.3 audit class. */
const AUDIT_CLASS_BY_CODE: Readonly<Record<DispatchViolation['code'], AuditClass>> = {
  'next-missing': 'veto',
  'undeclared-veto': 'veto',
  'undeclared-branch': 'veto',
  'quota-cpu-exceeded': 'quota',
  'veto-suppressed': 'veto-suppressed',
  'intercept-skipped': 'intercept-skipped',
}

function auditClassOf(code: DispatchViolation['code']): AuditClass {
  return AUDIT_CLASS_BY_CODE[code]
}
