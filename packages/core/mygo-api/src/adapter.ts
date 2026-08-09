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

import { PluginError, formatPluginError } from './error.ts'
import type { Logger, PluginDefinition, PluginEnv, PluginPromptSection } from './types.ts'

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

/** Structural shape of a raw Cordis function plugin consumed by {@link fromCordisPlugin}. */
export interface RawCordisFunctionPlugin {
  readonly name?: string
  readonly inject?: readonly string[]
  readonly Config?: unknown
  apply(ctx: unknown, config: unknown): unknown
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
 * migration bridge): the original `apply` runs against the restricted facade
 * inside the managed `activate`; permissions are supplied by the caller per
 * §5. Direct EventOptions fail with `unsupported-event-option`.
 * @param raw - the raw cordis plugin (its own inject list is not honored).
 * @param declaration - the managed manifest without hooks.
 * @returns the managed definition.
 */
export function fromCordisPlugin(
  raw: RawCordisFunctionPlugin,
  declaration: Omit<PluginDefinition, 'hooks'>,
): PluginDefinition {
  return {
    ...declaration,
    hooks: {
      activate(env) {
        const facade = createFacade(env, declaration.id)
        const config = raw.Config === undefined
          ? undefined
          : (raw.Config as (input?: unknown) => unknown)({})
        // Raw cordis activation is synchronous; async work runs through
        // listeners, so the managed activate settles immediately.
        void raw.apply(facade, config)
      },
    },
  }
}

function createFacade(env: PluginEnv, pluginId: string): CordisFacade {
  return {
    on(event, listener, options) {
      if (options !== undefined) {
        throw new PluginError(
          'unsupported-event-option',
          formatPluginError('unsupported-event-option', { option: Object.keys(options).join(', ') }),
          { option: Object.keys(options).join(', ') },
          pluginId,
        )
      }
      return (env.on as (eventName: string, fn: (...args: unknown[]) => unknown) => () => void)(event, listener)
    },
    get: capability => env.get(capability),
    provide: (capability, value) => env.provide(capability, value),
    tools: {
      register(tool: unknown): () => void {
        const raw = tool as {
          readonly name?: unknown
          readonly description?: unknown
          readonly parameters?: Record<string, unknown>
          readonly output?: { readonly schema?: Record<string, unknown> }
          readonly execute?: (args: unknown) => unknown
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
        return env.registerTool({
          name: raw.name,
          description: raw.description,
          input: raw.parameters ?? {},
          output: raw.output?.schema ?? {},
          execute: (args: unknown) => Promise.resolve(raw.execute?.(args)),
          renderIntent: { card: 'generic' },
        })
      },
    },
    systemPrompt: {
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
    },
    get sessionPersistence(): unknown {
      return env.get('sessionPersistence')
    },
    logger: env.logger,
  }
}
