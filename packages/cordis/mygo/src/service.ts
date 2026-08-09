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

import { Context, Service } from 'cordis'
import z from 'schemastery'
import { PluginError, formatPluginError } from '@deepseek-ai/dsh-mygo-api'
import type {
  InstallOptions,
  PluginDefinition,
  PluginExecRequest,
  PluginExecResult,
  PluginHandleInfo,
  PluginModelRequest,
  PluginModelResponse,
  RawCordisFunctionPlugin,
  PluginSource,
} from '@deepseek-ai/dsh-mygo-api'
import { PluginManagerConfigSchema, resolvePluginManagerConfig } from './config.ts'
import { DispatchMachine } from './dispatch.ts'
import type { DispatchViolation } from './dispatch.ts'
import { EVENT_VOCABULARY } from './event-vocabulary.ts'
import { LifecycleEngine } from './lifecycle.ts'
import { RegistryPersistence } from './persistence.ts'
import type { AuditClass } from './audit.ts'
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
    // Internally: mana. Five empty casts and you're benched.
    cpuBudgetMs: z.number().min(0).default(100),
  }),
])

/** Resolved row config: the §15.6/§17 surface plus the profile name. */
export type PluginManagerServiceConfigValue = PluginManagerConfig & {
  readonly profile: string
  readonly cpuBudgetMs: number
}

/**
 * The manager service. `install`/`replace`/`adopt` are async through the
 * engine's staging; `plugins()` and `plan()` are synchronous pure reads.
 */
export class PluginManagerService extends Service implements PluginManager {
  static inject = ['storage', 'storageDomain']
  static Config = PluginManagerServiceConfig

  private readonly resolved: PluginManagerConfig
  private engine: LifecycleEngine | undefined
  private persistence: RegistryPersistence | undefined

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
  }

  /** Open persistence, build the machine/engine, wire the two deferred sinks, and recover. */
  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const persistence = await RegistryPersistence.open(ctx.storageDomain, {
      profile: this.config.profile,
      stateRoot: this.resolved.stateRoot,
      auditMaxBytes: this.resolved.auditMaxBytes,
      auditKeepFiles: this.resolved.auditKeepFiles,
    })
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
      eventVocabulary: EVENT_VOCABULARY,
      persistence,
      ...(llm === undefined ? {} : { llm }),
      ...(exec === undefined ? {} : { exec }),
      ...(hostHttpServer === undefined ? {} : { httpServer: hostHttpServer }),
      ...(hostSkills === undefined ? {} : { skillService: hostSkills }),
      ...(hostCommands === undefined ? {} : { commandService: hostCommands }),
      hostService: (capability: string) => ctx.get(capability),
      hostProvide: (name: string, value: unknown) => ctx.provide(name, value),
      resolveSource: (source) => {
        if (source.type === 'npm') {
          return Promise.reject(new PluginError(
            'package-not-resolvable',
            formatPluginError('package-not-resolvable', {
              package: source.package,
              anchors: 'runtime profile anchors',
            }),
            { package: source.package, anchors: 'runtime profile anchors' },
          ))
        }
        return Promise.resolve(evaluateInlineDefinition(source.code))
      },
    })
    holder.engine = engine
    await engine.recover()
    this.engine = engine
    this.persistence = persistence
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
      void persistence.close()
    }, 'pluginManager.teardown')
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

  disable(id: string, reason?: string): Promise<void> {
    return this.requireEngine().disable(id, reason)
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

  async plan(operation: PluginOperation): Promise<PluginOperationPlan> {
    return this.requireEngine().plan(operation)
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
  async adoptRaw(raw: RawCordisFunctionPlugin, config: unknown, id?: string): Promise<PluginHandleInfo> {
    return this.requireEngine().adoptRaw(raw, config, id)
  }

  /** Live-update an adopted raw plugin through the HMR replace protocol. */
  updateRaw(raw: RawCordisFunctionPlugin, config: unknown, id: string): Promise<PluginHandleInfo> {
    return this.requireEngine().updateRaw(raw, config, id)
  }

  /** Pre-mount support check (see {@link PluginManager.checkSupport}). */
  checkSupport(raw: RawCordisFunctionPlugin, id?: string): Promise<PluginSupportCheck> {
    return this.requireEngine().checkSupport(raw, id)
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
