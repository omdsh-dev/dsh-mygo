/**
 * Fake-env test surface: a faithful-in-shape `PluginEnv` implementation with
 * recording and trigger helpers, so plugin authors can unit-test a
 * `definePlugin` without importing Cordis.
 * @module @deepseek-ai/dsh-mygo-api/src/fake
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { PluginError, formatPluginError } from './error.ts'
import type {
  Disposable,
  Logger,
  PluginEnv,
  PluginEventArgs,
  PluginEventName,
  PluginEventListener,
  PluginFs,
  PluginHandleInfo,
  PluginPromptSection,
  PluginToolDefinition,
} from './types.ts'

/** Options accepted by {@link createFakeEnv}. */
export interface FakePluginEnvOptions {
  /** Capabilities the fixture plugin declares in `requires`; everything else resolves as `undefined`. */
  readonly requires?: readonly string[]
  /** Values `get` returns for declared capabilities. */
  readonly services?: Readonly<Record<string, unknown>>
  /** View returned by `plugins()`. */
  readonly plugins?: readonly PluginHandleInfo[]
  /** Seed store for `env.fs`; `write` updates it and `read` falls back to an empty buffer. */
  readonly files?: ReadonlyMap<string, Uint8Array>
  /** Response returned by every `env.fetch` call. */
  readonly fetchResponse?: Response
  /** Scope label set by `scope()` on the derived env. */
  readonly scopedTo?: SessionId
}

/** One recorded logger call. */
export interface FakeLogRecord {
  /** Severity level of the call. */
  readonly level: 'error' | 'info' | 'warn' | 'debug'
  /** Arguments passed to the logger method. */
  readonly args: readonly unknown[]
}

/** One recorded listener registration. */
export interface FakeListenerRecord {
  /** Event name the listener registered for. */
  readonly event: string
  /** Registered listener; heterogeneous signatures are stored lossily, typed at the `on` front door. */
  // The explicit any is deliberate: records hold listeners of many event
  // signatures at once, and no single parameter type can describe all of them.
  // oxlint-disable-next-line typescript/no-explicit-any -- erased-heterogeneous store; see comment above.
  readonly listener: (...args: any[]) => unknown
}

/** One recorded service provision. */
export interface FakeProvidedRecord {
  /** Capability id provided. */
  readonly capability: string
  /** Provided value. */
  readonly value: unknown
  /** False after the disposer ran; mutable because disposal flips it in place. */
  active: boolean
}

/** One recorded filesystem write. */
export interface FakeFsWriteRecord {
  /** Path written. */
  readonly path: string
  /** Normalized bytes written. */
  readonly data: Uint8Array
}

/** One recorded fetch call. */
export interface FakeFetchCallRecord {
  /** URL requested. */
  readonly url: string
  /** Fetch options passed by the caller, when any. */
  readonly init?: RequestInit
}

/**
 * Recording `PluginEnv` implementation for plugin unit tests. It implements
 * the env semantics this package owns: `get` returns `undefined` for
 * capabilities outside `requires`, and `on`/`registerTool`/`provide` throw
 * `setup-registration` while `phase` is `'setup'`. It performs no validation —
 * mount-time validation belongs to the plugin manager.
 */
export interface FakePluginEnv extends PluginEnv {
  /** Current registration phase; set to `'setup'` to exercise the setup guard. */
  phase: 'setup' | 'activate'
  /** Scope label of this env, set by `scope()` on the derived env. */
  readonly scopedTo: SessionId | undefined
  /** Derive an agent-scoped fake with its own independent records. */
  scope(agentId: SessionId): FakePluginEnv
  /** Recorded listener registrations, in registration order. */
  readonly listeners: readonly FakeListenerRecord[]
  /** Recorded tool registrations, in registration order. */
  readonly tools: readonly PluginToolDefinition[]
  /** Recorded prompt-section registrations, in registration order. */
  readonly promptSections: readonly PluginPromptSection[]
  /** Recorded service provisions, in registration order. */
  readonly provided: readonly FakeProvidedRecord[]
  /** Recorded `updateConfig` patches. */
  readonly updateConfigCalls: readonly unknown[]
  /** Agent ids passed to `scope()`. */
  readonly scopeCalls: readonly string[]
  /** Paths passed to `fs.read`. */
  readonly fsReads: readonly string[]
  /** Recorded `fs.write` calls. */
  readonly fsWrites: readonly FakeFsWriteRecord[]
  /** Recorded `fetch` calls. */
  readonly fetchCalls: readonly FakeFetchCallRecord[]
  /** Recorded logger calls. */
  readonly logs: readonly FakeLogRecord[]
  /**
   * Invoke every registered listener for one event in registration order,
   * awaiting each result. This helper performs no mode-specific dispatch:
   * return values and `next` arguments are forwarded verbatim and never
   * composed into bail/waterfall behavior.
   * @param event - event to dispatch.
   * @param args - dispatch arguments for the event.
   * @returns a promise settling after every listener.
   */
  trigger<E extends PluginEventName>(event: E, ...args: PluginEventArgs<E>): Promise<void>
}

/** Options plus the internal mutable record arrays of one fake env. */
interface FakeEnvState {
  readonly listeners: FakeListenerRecord[]
  readonly tools: PluginToolDefinition[]
  readonly promptSections: PluginPromptSection[]
  readonly provided: FakeProvidedRecord[]
  readonly updateConfigCalls: unknown[]
  readonly scopeCalls: string[]
  readonly fsReads: string[]
  readonly fsWrites: FakeFsWriteRecord[]
  readonly fetchCalls: FakeFetchCallRecord[]
  readonly logs: FakeLogRecord[]
}

/** Internal implementation class behind the exported interface. */
class FakePluginEnvImpl implements FakePluginEnv {
  readonly logger: Logger
  readonly fs: PluginFs
  phase: 'setup' | 'activate' = 'activate'
  readonly scopedTo: SessionId | undefined

  private readonly state: FakeEnvState
  private readonly options: FakePluginEnvOptions
  private readonly files: Map<string, Uint8Array>
  private readonly fetchResponse: Response

  constructor(options: FakePluginEnvOptions) {
    this.options = options
    this.scopedTo = options.scopedTo
    this.files = new Map(options.files)
    this.fetchResponse = options.fetchResponse ?? new Response()
    this.state = {
      listeners: [],
      tools: [],
      promptSections: [],
      provided: [],
      updateConfigCalls: [],
      scopeCalls: [],
      fsReads: [],
      fsWrites: [],
      fetchCalls: [],
      logs: [],
    }
    this.logger = {
      error: (format, ...params) => this.state.logs.push({ level: 'error', args: [format, ...params] }),
      info: (format, ...params) => this.state.logs.push({ level: 'info', args: [format, ...params] }),
      warn: (format, ...params) => this.state.logs.push({ level: 'warn', args: [format, ...params] }),
      debug: (format, ...params) => this.state.logs.push({ level: 'debug', args: [format, ...params] }),
    }
    this.fs = {
      read: (path: string) => {
        this.state.fsReads.push(path)
        return Promise.resolve(this.files.get(path) ?? new Uint8Array())
      },
      write: (path: string, data: Uint8Array | string) => {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
        this.state.fsWrites.push({ path, data: bytes })
        this.files.set(path, bytes)
        return Promise.resolve()
      },
    }
  }

  get listeners(): readonly FakeListenerRecord[] {
    return this.state.listeners
  }

  get tools(): readonly PluginToolDefinition[] {
    return this.state.tools
  }

  get promptSections(): readonly PluginPromptSection[] {
    return this.state.promptSections
  }

  get provided(): readonly FakeProvidedRecord[] {
    return this.state.provided
  }

  get updateConfigCalls(): readonly unknown[] {
    return this.state.updateConfigCalls
  }

  get scopeCalls(): readonly string[] {
    return this.state.scopeCalls
  }

  get fsReads(): readonly string[] {
    return this.state.fsReads
  }

  get fsWrites(): readonly FakeFsWriteRecord[] {
    return this.state.fsWrites
  }

  get fetchCalls(): readonly FakeFetchCallRecord[] {
    return this.state.fetchCalls
  }

  get logs(): readonly FakeLogRecord[] {
    return this.state.logs
  }

  on<E extends PluginEventName>(event: E, listener: PluginEventListener<E>): Disposable {
    this.assertRegistrable('on')
    // oxlint-disable-next-line typescript/no-explicit-any -- same erased-heterogeneous store as FakeListenerRecord.listener.
    const record: FakeListenerRecord = { event, listener: listener as (...args: any[]) => unknown }
    this.state.listeners.push(record)
    return () => {
      const index = this.state.listeners.indexOf(record)
      if (index !== -1) this.state.listeners.splice(index, 1)
    }
  }

  scope(agentId: SessionId): FakePluginEnv {
    this.state.scopeCalls.push(agentId)
    return createFakeEnv({ ...this.options, scopedTo: agentId })
  }

  registerTool(definition: PluginToolDefinition): Disposable {
    this.assertRegistrable('registerTool')
    this.state.tools.push(definition)
    return () => {
      const index = this.state.tools.indexOf(definition)
      if (index !== -1) this.state.tools.splice(index, 1)
    }
  }

  registerPromptSection(section: PluginPromptSection): Disposable {
    this.assertRegistrable('registerPromptSection')
    this.state.promptSections.push(section)
    return () => {
      const index = this.state.promptSections.indexOf(section)
      if (index !== -1) this.state.promptSections.splice(index, 1)
    }
  }

  provide(capability: string, value: unknown): Disposable {
    this.assertRegistrable('provide')
    const record: FakeProvidedRecord = { capability, value, active: true }
    this.state.provided.push(record)
    return () => {
      record.active = false
    }
  }

  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T is the call-site service type, per the PluginEnv contract.
  get<T>(capability: string): T | undefined {
    const requires = this.options.requires ?? []
    if (!requires.includes(capability)) return undefined
    return this.options.services?.[capability] as T | undefined
  }

  plugins(): readonly PluginHandleInfo[] {
    return this.options.plugins ?? []
  }

  updateConfig(patch: unknown): Promise<void> {
    this.state.updateConfigCalls.push(patch)
    return Promise.resolve()
  }

  fetch(url: string, init?: RequestInit): Promise<Response> {
    this.state.fetchCalls.push(init === undefined ? { url } : { url, init })
    return Promise.resolve(this.fetchResponse)
  }

  async trigger<E extends PluginEventName>(event: E, ...args: PluginEventArgs<E>): Promise<void> {
    for (const record of this.state.listeners) {
      if (record.event === event) await record.listener(...args)
    }
  }

  private assertRegistrable(method: string): void {
    if (this.phase !== 'setup') return
    throw new PluginError(
      'setup-registration',
      formatPluginError('setup-registration', { method }),
      { method },
    )
  }
}

/**
 * Create a fake `PluginEnv` for unit-testing a plugin. Seed the fixture's
 * `requires` (and optional service values) so `get` returns declared services
 * and `undefined` for undeclared ones; use `phase` to exercise the setup
 * registration guard, and the record arrays plus `trigger` to drive and assert
 * listener behavior.
 * @param options - fixture declaration surface and seeded values.
 * @returns a recording fake env.
 */
export function createFakeEnv(options: FakePluginEnvOptions = {}): FakePluginEnv {
  return new FakePluginEnvImpl(options)
}
