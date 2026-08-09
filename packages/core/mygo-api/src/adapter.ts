/**
 * §23.1 Cordis adapters, delivered as structural shapes so the plugin author
 * surface stays Cordis-free (HP:134): `toCordisPlugin` wraps a managed
 * definition as a Loader-mountable function plugin whose `apply` only calls
 * `ctx.pluginManager.adopt` (the `inject` declaration makes a missing manager
 * fail loud at mount); `fromCordisPlugin` bridges a raw Cordis plugin into a
 * managed definition whose hooks run against a restricted facade
 * (`on`/`get`/`provide`/`logger`), rejecting direct EventOptions with
 * `unsupported-event-option`.
 * @module @deepseek-ai/dsh-mygo-api/src/adapter
 */

import z from 'schemastery'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { PluginError, formatPluginError } from './error.ts'
import type {
  Logger,
  PluginCommandDefinition,
  PluginDefinition,
  PluginEnv,
  PluginHttpRequest,
  PluginHttpResponse,
  PluginPromptSection,
  Schemastery,
  PluginSkillDefinition,
  PluginToolDefinition,
} from './types.ts'

/** The minimal Context surface the self-adoption adapter needs. */
export interface AdapterContext {
  readonly pluginManager: {
    adopt(definition: PluginDefinition, config: unknown): Promise<void>
  }
}

/** Structural Cordis function-plugin shape returned by {@link toCordisPlugin}. */
export interface CordisFunctionPluginShape {
  readonly name: string
  readonly inject: readonly string[]
  readonly Config: unknown
  apply(ctx: AdapterContext, config: unknown): void
}

/**
 * Structural shape of a raw Cordis plugin consumed by {@link fromCordisPlugin}:
 * either a function/`apply`-object plugin, or a Service-style constructor
 * class (the token-meter / compact-basic pattern) whose static `inject` and
 * `Config` are read the same way.
 */
export type RawCordisFunctionPlugin =
  | {
    readonly name?: string
    readonly inject?: readonly string[]
    readonly Config?: unknown
    apply(ctx: unknown, config: unknown): unknown
  }
  | {
    readonly name?: string
    readonly inject?: readonly string[]
    readonly Config?: unknown
    new (ctx: unknown, config?: unknown): unknown
  }

/**
 * Wrap one managed definition as a Loader-mountable function plugin
 * (decision #12): bundle rows referencing a `definePlugin` package keep their
 * ordinary Loader row shape, and the manager's absence fails loud through the
 * `pluginManager` inject declaration.
 * @param definition - the managed manifest and hooks.
 * @returns the cordis plugin shape the Loader mounts.
 */
export function toCordisPlugin(definition: PluginDefinition): CordisFunctionPluginShape {
  return {
    name: definition.id,
    inject: ['pluginManager'],
    Config: definition.config,
    apply(ctx, config) {
      // Activation is async through the manager's staging; the Loader treats
      // the adapter fiber as settled and the manager publishes the static
      // handle when adoption completes.
      void ctx.pluginManager.adopt(definition, config)
    },
  }
}

/** Restricted facade a raw plugin's `apply` runs against (§23.1 migration bridge). */
export interface CordisFacade {
  /** Register a listener; direct EventOptions are rejected. */
  on(event: string, listener: (...args: unknown[]) => unknown, options?: Record<string, unknown>): () => void
  /** Resolve one capability; undeclared capabilities are `undefined` (SEC:86). */
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T is the caller-chosen service type at each call site.
  get<T>(capability: string): T | undefined
  /** Provide one service value through the manager-held table. */
  provide(capability: string, value: unknown): () => void
  /**
   * Register one tool through the manager-held tool table. Accepts the
   * structural `defineTool` output (compiled `parameters`, `output.schema`,
   * `execute`) and maps it to the managed `PluginToolDefinition`; the raw
   * shape's render/presentation functions are not representable and fall
   * back to the generic card.
   */
  tools: {
    register(tool: unknown): () => void
  }
  /**
   * Prompt-section contribution surface (Proposal B): `section` maps onto the
   * manager-held prompt-section table.
   */
  systemPrompt: {
    section(section: unknown): () => void
  }
  /**
   * The declared `sessionPersistence` capability: the manager's read-only
   * projection, or `undefined` when undeclared (SEC:86).
   */
  readonly sessionPersistence: unknown
  readonly logger: Logger
}

/**
 * Bridge a raw Cordis function plugin into a managed definition (§23.1
 * migration bridge): the original `apply` runs against a host-shaped
 * transparent facade inside the managed `activate`. When no declaration is
 * supplied the manifest is derived from the plugin itself (`name`, `inject`,
 * `Config`), so a stock dsh-external Cordis plugin mounts with zero code
 * changes. Registration-facing surfaces (`on`, `tools`, `systemPrompt`,
 * `httpServer`, `skills`, `commands`, `provide`, `effect`, timer verbs) are
 * intercepted and tracked per generation; every other `ctx.*` property is
 * forwarded to the raw host context.
 * @param raw - the raw cordis plugin (its own inject list is not honored).
 * @param declaration - optional explicit managed manifest without hooks;
 * when omitted the manifest is auto-derived from the raw plugin shape.
 * @returns the managed definition.
 */
export function fromCordisPlugin(
  raw: RawCordisFunctionPlugin,
  declaration?: Omit<PluginDefinition, 'hooks'>,
): PluginDefinition {
  const id = declaration?.id ?? pluginIdOf(raw)
  const config = (raw.Config ?? z.object({})) as Schemastery
  let resolvedConfig: unknown = undefined
  return {
    ...(declaration ?? {
      id,
      version: '0.0.0-raw',
      kinds: [],
      events: [],
      requires: raw.inject ?? [],
      provides: [],
      permissions: {
        observe: [],
        transform: [],
        intercept: [],
        position: 'derived',
        claims: [],
      },
      stateful: false,
      swapPolicy: 'immediate',
    }),
    config,
    hooks: {
      async setup(_env, configValue) {
        resolvedConfig = configValue
        return Promise.resolve()
      },
      activate(env) {
        const facade = createFacade(env, id)
        const configValue = resolvedConfig === undefined
          ? (raw.Config === undefined ? {} : (raw.Config as (input?: unknown) => unknown)({}))
          : resolvedConfig
        if (isConstructor(raw)) {
          // Service-style plugins mount as classes (`new raw(ctx, config)`),
          // the token-meter / compact-basic pattern.
          new (raw as new (ctx: unknown, config?: unknown) => unknown)(facade, configValue)
          return undefined
        }
        // Return the apply result so async activations settle inside staging:
        // a rejection becomes a clean staging failure instead of an
        // unhandled rejection that can take the host process down.
        return raw.apply(facade, configValue)
      },
    },
  } as PluginDefinition
}

/** Whether a raw plugin entry is a class constructor rather than a function plugin. */
function isConstructor(
  value: RawCordisFunctionPlugin,
): value is RawCordisFunctionPlugin & { new (ctx: unknown, config?: unknown): unknown } {
  return typeof value === 'function'
    && /^class\s/.test(Function.prototype.toString.call(value))
}

/** Derive a manifest-safe plugin id from a raw Cordis plugin name. */
function pluginIdOf(raw: RawCordisFunctionPlugin): string {
  const name = raw.name ?? 'raw-plugin'
  const base = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
  const cleaned = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned : 'raw-plugin'
}

function createFacade(env: PluginEnv, pluginId: string): CordisFacade {
  // The harness's raw-plugin idiom historically supports both `ctx.logger('name')`
  // (factory) and `ctx.logger.info(...)` (object). The facade logger is the
  // manager's rate-limited object; calling it as a function returns the same
  // object so both shapes mount without plugin-side edits.
  const loggerObject = env.logger
  const logger = ((_name: string) => logger) as unknown as Logger & ((name: string) => Logger)
  Object.assign(logger, loggerObject)

  const toolsService = {
    register(tool: unknown): () => void {
      const raw = tool as {
        readonly name?: unknown
        readonly description?: unknown
        readonly parameters?: Record<string, unknown>
        readonly output?: { readonly schema?: Record<string, unknown> }
        readonly execute?: (args: unknown, exec?: unknown) => unknown
      }
      if (typeof raw.name !== 'string' || typeof raw.description !== 'string'
        || typeof raw.execute !== 'function') {
        throw new PluginError(
          'manifest-invalid',
          formatPluginError('manifest-invalid', {
            field: 'tool',
            expected: 'name/description strings and an execute function',
          }),
          { field: 'tool', expected: 'name/description strings and an execute function' },
          pluginId,
        )
      }
      const definition: PluginToolDefinition = {
        name: raw.name,
        description: raw.description,
        input: raw.parameters ?? {},
        output: raw.output?.schema ?? {},
        execute: (args: unknown, exec) => Promise.resolve(raw.execute?.(args, exec)),
        renderIntent: { card: 'generic' },
      }
      return env.registerTool(definition)
    },
  }

  const promptService = {
    section(section: unknown): () => void {
      const raw = section as {
        readonly name?: unknown
        readonly order?: unknown
        readonly text?: unknown
      }
      if (typeof raw.name !== 'string' || typeof raw.order !== 'number' || !Number.isFinite(raw.order)
        || (typeof raw.text !== 'string' && typeof raw.text !== 'function')) {
        throw new PluginError(
          'manifest-invalid',
          formatPluginError('manifest-invalid', {
            field: 'prompt-section',
            expected: 'name string, finite order, and string-or-function text',
          }),
          { field: 'prompt-section', expected: 'name string, finite order, and string-or-function text' },
          pluginId,
        )
      }
      return env.registerPromptSection({
        name: raw.name,
        order: raw.order,
        text: raw.text as PluginPromptSection['text'],
      })
    },
  }

  const skillsService = {
    register(definition: PluginSkillDefinition): () => void {
      if (typeof definition?.name !== 'string' || typeof definition?.description !== 'string'
        || typeof definition?.content !== 'string') {
        throw new PluginError(
          'manifest-invalid',
          formatPluginError('manifest-invalid', {
            field: 'skill',
            expected: 'name/description/content strings',
          }),
          { field: 'skill', expected: 'name/description/content strings' },
          pluginId,
        )
      }
      return env.skills.register(definition)
    },
  }

  const commandsService = {
    register(definition: PluginCommandDefinition): () => void {
      if (typeof definition?.name !== 'string' || typeof definition?.description !== 'string'
        || typeof definition?.handler !== 'function') {
        throw new PluginError(
          'manifest-invalid',
          formatPluginError('manifest-invalid', {
            field: 'command',
            expected: 'name/description strings and a handler function',
          }),
          { field: 'command', expected: 'name/description strings and a handler function' },
          pluginId,
        )
      }
      return env.commands.register(definition)
    },
  }

  const httpServerService = new Proxy({
    register(route: unknown): () => void {
      const raw = route as {
        readonly kind?: unknown
        readonly path?: unknown
        readonly handler?: unknown
      }
      if (typeof raw?.path !== 'string' || typeof raw?.handler !== 'function') {
        throw new PluginError(
          'manifest-invalid',
          formatPluginError('manifest-invalid', {
            field: 'http-route',
            expected: 'path string and a node:http-style handler',
          }),
          { field: 'http-route', expected: 'path string and a node:http-style handler' },
          pluginId,
        )
      }
      return env.http.register({
        method: '*',
        path: raw.path,
        kind: raw.kind === 'prefix' ? 'prefix' : 'exact',
        handler: async (request: PluginHttpRequest): Promise<PluginHttpResponse> => {
          return await rawHttpBridge(request, raw.handler as (req: unknown, res: unknown) => unknown)
        },
      })
    },
  }, {
    // `register` stays manager-mediated; every other host httpServer member
    // (e.g. `tapIndex` for index.html transforms) forwards to the real host
    // service so host-shaped plugins keep working through the facade.
    get(target, prop, receiver) {
      if (prop === 'register') return Reflect.get(target, prop, receiver)
      const rawCtx = env.host as { get?(key: string): unknown } | undefined
      const host = rawCtx?.get?.('httpServer') as Record<string, unknown> | undefined
      const value = host?.[prop as string]
      return typeof value === 'function' ? value.bind(host) : value
    },
  })

  const trackedTimers = new Set<NodeJS.Timeout>()
  env.effect(() => {
    for (const handle of trackedTimers) clearTimeout(handle)
    trackedTimers.clear()
  }, `${pluginId}:timers`)

  const timerVerbs = {
    setTimeout(callback: () => void, ms?: number, ...args: unknown[]): NodeJS.Timeout {
      const handle = setTimeout(callback, ms, ...args) as unknown as NodeJS.Timeout
      trackedTimers.add(handle)
      return handle
    },
    setInterval(callback: () => void, ms?: number, ...args: unknown[]): NodeJS.Timeout {
      const handle = setInterval(callback, ms, ...args) as unknown as NodeJS.Timeout
      trackedTimers.add(handle)
      return handle
    },
    clearTimeout(handle: NodeJS.Timeout): void {
      trackedTimers.delete(handle)
      clearTimeout(handle)
    },
    clearInterval(handle: NodeJS.Timeout): void {
      trackedTimers.delete(handle)
      clearInterval(handle)
    },
  }

  const interceptGet = (capability: string): unknown => {
    switch (capability) {
      case 'tools': return toolsService
      case 'systemPrompt': return promptService
      case 'httpServer': return httpServerService
      case 'skills': return skillsService
      case 'commands': return commandsService
      default: return env.get(capability)
    }
  }

  const inject = (deps: unknown, callback: unknown): (() => void) => {
    if (typeof callback !== 'function') {
      throw new PluginError(
        'manifest-invalid',
        formatPluginError('manifest-invalid', {
          field: 'inject',
          expected: 'a callback function',
        }),
        { field: 'inject', expected: 'a callback function' },
        pluginId,
      )
    }
    void deps
    const scoped = createFacade(env, pluginId)
    const disposer = (callback as (ctx: unknown) => unknown)(scoped)
    if (typeof disposer === 'function') {
      env.effect(disposer as () => void, `${pluginId}:inject`)
    }
    return () => {}
  }

  const target: CordisFacade & Record<string, unknown> = {
    on(event, listener, _options) {
      return (env.on as (eventName: string, fn: (...args: unknown[]) => unknown) => () => void)(event, listener)
    },
    effect(callback: unknown, name?: string): void {
      if (typeof callback !== 'function') {
        throw new PluginError(
          'manifest-invalid',
          formatPluginError('manifest-invalid', {
            field: 'effect',
            expected: 'a callback function',
          }),
          { field: 'effect', expected: 'a callback function' },
          pluginId,
        )
      }
      // Cordis semantics: the effect callback runs NOW (it usually performs the
      // registration and returns a disposer); only the returned disposer is
      // collected for generation teardown.
      const disposer = (callback as () => unknown)()
      if (typeof disposer === 'function') {
        env.effect(() => { (disposer as () => void)() }, name)
      }
    },
    inject,
    get: <T>(capability: string): T | undefined => interceptGet(capability) as T | undefined,
    provide: (capability, value) => env.provide(capability, value),
    plugin(): never {
      throw new Error(
        'mygo 暂不支持插件在 apply 内通过 ctx.plugin 组合子插件（Service/工具子插件）；'
        + '请把子插件作为独立插件安装，或让插件作者改为直接注册',
      )
    },
    tools: toolsService,
    systemPrompt: promptService,
    httpServer: httpServerService,
    skills: skillsService,
    commands: commandsService,
    scope(agentId: string): CordisFacade {
      return createFacade(env.scope(agentId as SessionId), pluginId)
    },
    emit(event: string, payload?: unknown): void {
      env.emit(event, payload)
    },
    get sessionPersistence(): unknown {
      return env.get('sessionPersistence')
    },
    logger,
  }

  return new Proxy(target, {
    get(proxyTarget, prop, receiver) {
      if (typeof prop !== 'string') return undefined
      if (prop in proxyTarget) {
        if (prop === 'logger') return proxyTarget.logger
        const value = Reflect.get(proxyTarget, prop, receiver)
        return typeof value === 'function' ? value.bind(proxyTarget) : value
      }
      if (prop === 'setTimeout' || prop === 'setInterval' || prop === 'clearTimeout' || prop === 'clearInterval') {
        return timerVerbs[prop]
      }
      const host = env.host as Record<string, unknown> | undefined
      if (host !== undefined && prop in host) {
        const value = (host as Record<string, unknown>)[prop]
        return typeof value === 'function' ? value.bind(host) : value
      }
      return env.get(prop)
    },
  })
}

/** Bridge a node:http-style raw route handler onto the managed request/response contract. */
async function rawHttpBridge(
  request: PluginHttpRequest,
  handler: (req: unknown, res: unknown) => unknown,
): Promise<PluginHttpResponse> {
  const body = request.body
  const req = {
    method: request.method,
    url: request.url ?? request.path,
    headers: request.headers,
    on(event: 'data' | 'end', listener: (...args: unknown[]) => void): void {
      if (event === 'data' && body.length > 0) listener(Buffer.from(body, 'utf8'))
      if (event === 'end') listener()
    },
  }
  const state: { statusCode: number; headers: Record<string, string> } = { statusCode: 200, headers: {} }
  const chunks: Buffer[] = []
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  let ended = false
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      listener(...args)
    }
  }
  const res = {
    get statusCode(): number {
      return state.statusCode
    },
    set statusCode(value: number) {
      state.statusCode = value
    },
    setHeader(name: string, value: string): void {
      state.headers[name] = value
    },
    getHeader(name: string): string | undefined {
      return state.headers[name]
    },
    writeHead(status: number, headers?: Record<string, string>): void {
      state.statusCode = status
      if (headers !== undefined) Object.assign(state.headers, headers)
    },
    write(chunk: string | Buffer): boolean {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      return true
    },
    end(chunk?: string | Buffer): void {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      ended = true
      emit('finish')
      emit('end')
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return res
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      const wrapper = (...args: unknown[]): void => {
        const list = listeners.get(event)
        if (list !== undefined) {
          const index = list.indexOf(wrapper)
          if (index >= 0) list.splice(index, 1)
        }
        listener(...args)
      }
      return this.on(event, wrapper)
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      const list = listeners.get(event)
      if (list !== undefined) {
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
      }
      return res
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      return this.removeListener(event, listener)
    },
    emit,
  }
  await handler(req, res)
  // A raw handler may pipe a stream into `res` (createReadStream(...).pipe(res));
  // wait for the stream to end before collecting the response.
  if (!ended) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 30_000)
      const onEnd = () => {
        clearTimeout(timer)
        resolve()
      }
      res.once('end', onEnd)
    })
  }
  const buffer = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)
  const contentType = state.headers['content-type'] ?? state.headers['Content-Type'] ?? ''
  const textLike = /^(?:text\/|application\/(?:json|javascript)|image\/svg\+xml)/i.test(contentType)
  return {
    status: state.statusCode,
    headers: state.headers,
    body: textLike ? buffer.toString('utf8') : new Uint8Array(buffer),
  }
}
