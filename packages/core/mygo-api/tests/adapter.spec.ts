/**
 * §23.1 adapters: the self-adoption shape delegates to the manager, and the
 * migration bridge runs a raw cordis apply against a restricted facade that
 * rejects direct EventOptions.
 */

import { describe, expect, it, vi } from 'vitest'
import z from 'schemastery'
import { createFakeEnv, fromCordisPlugin, PluginError, toCordisPlugin } from '@deepseek-ai/dsh-mygo-api'
import type { PluginDefinition } from '@deepseek-ai/dsh-mygo-api'

function fixture(id: string): PluginDefinition {
  return {
    id,
    version: '1.0.0',
    kinds: ['fixture'],
    requires: ['svc'],
    provides: ['other'],
    permissions: { observe: [], transform: [], intercept: [], position: 'derived', claims: [] },
    stateful: false,
    swapPolicy: 'immediate',
    config: z.object({ step: z.number().default(1) }),
    hooks: { activate: () => {} },
  }
}

describe('toCordisPlugin', () => {
  it('wraps a definition as a Loader plugin that only self-adopts', async () => {
    const definition = fixture('managed')
    const shape = toCordisPlugin(definition)
    expect(shape.name).toBe('managed')
    expect(shape.inject).toEqual(['pluginManager'])
    expect(shape.Config).toBe(definition.config)
    const adopt = vi.fn(async () => {})
    shape.apply({ pluginManager: { adopt } }, { step: 2 })
    // The adapter hands the definition and the row config to the manager.
    expect(adopt).toHaveBeenCalledWith(definition, { step: 2 })
  })
})

describe('fromCordisPlugin', () => {
  it('runs the raw apply against the restricted facade', () => {
    const env = createFakeEnv(fixture('bridged'))
    const calls: string[] = []
    const raw = {
      name: 'raw-plugin',
      inject: ['anything'],
      Config: z.object({ step: z.number().default(7) }),
      apply(ctx: {
        on(event: string, listener: (...args: unknown[]) => unknown): () => void
        get(key: string): unknown
        provide(key: string, value: unknown): () => void
        logger: { info(message: unknown): void }
      }) {
        calls.push('apply')
        ctx.on('agent/created', () => {})
        void ctx.get('svc')
        ctx.provide('other', 1)
        ctx.logger.info('hello')
      },
    }
    const bridged = fromCordisPlugin(raw, fixture('bridged'))
    void bridged.hooks.activate?.(env)
    expect(calls).toEqual(['apply'])
    expect(env.listeners).toHaveLength(1)
    expect(env.provided.find(record => record.capability === 'other')?.value).toBe(1)
    expect(env.logs.some(log => log.args[0] === 'hello')).toBe(true)
  })

  it('rejects direct EventOptions with unsupported-event-option', () => {
    const env = createFakeEnv(fixture('strict'))
    const raw = {
      name: 'raw',
      apply(ctx: { on(event: string, listener: () => void, options: { prepend: boolean }): void }) {
        ctx.on('agent/created', () => {}, { prepend: true })
      },
    }
    const bridged = fromCordisPlugin(raw, fixture('strict'))
    expect(() => { void bridged.hooks.activate?.(env) }).toThrow(PluginError)
    try {
      void bridged.hooks.activate?.(env)
    } catch (error) {
      expect((error as PluginError).code).toBe('unsupported-event-option')
      expect((error as PluginError).pluginId).toBe('strict')
    }
  })

  it('fills the raw config through its schemastery schema with empty input', () => {
    const env = createFakeEnv(fixture('configured'))
    let seen: unknown
    const raw = {
      name: 'raw',
      Config: z.object({ step: z.number().default(3) }),
      apply(_ctx: unknown, config: unknown) {
        seen = config
      },
    }
    void fromCordisPlugin(raw, fixture('configured')).hooks.activate?.(env)
    expect(seen).toEqual({ step: 3 })
  })

  it('maps ctx.tools.register onto the managed tool surface (Proposal A bridge)', () => {
    const env = createFakeEnv(fixture('tool-bridge'))
    const calls: string[] = []
    const raw = {
      name: 'calculator',
      apply(ctx: { tools: { register(tool: unknown): () => void } }) {
        calls.push('apply')
        const disposer = ctx.tools.register({
          name: 'calculator',
          description: 'Safe math',
          parameters: { type: 'object', properties: { expression: { type: 'string' } } },
          output: { schema: { type: 'number' }, render: () => [{ type: 'text', text: '0' }] },
          execute: async (args: { expression: string }) => args.expression.length,
        })
        calls.push(typeof disposer)
      },
    }
    const bridged = fromCordisPlugin(raw, fixture('tool-bridge'))
    void bridged.hooks.activate?.(env)
    expect(calls).toEqual(['apply', 'function'])
    expect(env.tools).toHaveLength(1)
    expect(env.tools[0]).toMatchObject({
      name: 'calculator',
      description: 'Safe math',
      input: { type: 'object', properties: { expression: { type: 'string' } } },
      output: { type: 'number' },
      renderIntent: { card: 'generic' },
    })
    expect(typeof env.tools[0]?.execute).toBe('function')
    const mapped = env.tools.find(tool => tool.name === 'calculator')
    void expect(mapped?.execute({ expression: '1+1' }, { signal: new AbortController().signal })).resolves.toBe(3)
  })

  it('defaults missing parameters and output schema to empty objects in the tools.register bridge', () => {
    const env = createFakeEnv(fixture('tool-minimal'))
    const raw = {
      name: 'minimal',
      apply(ctx: { tools: { register(tool: unknown): () => void } }) {
        ctx.tools.register({ name: 'minimal_tool', description: 'd', execute: async () => 'x' })
      },
    }
    void fromCordisPlugin(raw, fixture('tool-minimal')).hooks.activate?.(env)
    expect(env.tools[0]).toMatchObject({
      name: 'minimal_tool',
      input: {},
      output: {},
      renderIntent: { card: 'generic' },
    })
  })

  it('rejects a malformed ctx.tools.register with manifest-invalid naming the plugin', () => {
    const env = createFakeEnv(fixture('tool-malformed'))
    const raw = {
      name: 'broken',
      apply(ctx: { tools: { register(tool: unknown): () => void } }) {
        ctx.tools.register({ name: 'broken_tool' })
      },
    }
    const bridged = fromCordisPlugin(raw, fixture('tool-malformed'))
    expect(() => { void bridged.hooks.activate?.(env) }).toThrow(PluginError)
    try {
      void bridged.hooks.activate?.(env)
    } catch (error) {
      expect((error as PluginError).code).toBe('manifest-invalid')
      expect((error as PluginError).pluginId).toBe('tool-malformed')
    }
  })

  it('maps ctx.systemPrompt.section onto the managed prompt-section surface (Proposal B)', () => {
    const env = createFakeEnv(fixture('prompt-bridge'))
    const calls: string[] = []
    const raw = {
      name: 'prompt-plugin',
      apply(ctx: { systemPrompt: { section(section: unknown): () => void } }) {
        calls.push('apply')
        const disposer = ctx.systemPrompt.section({ name: 'tool:prompt', order: 114, text: 'guidance' })
        ctx.systemPrompt.section({ name: 'tool:dynamic', order: 115, text: () => 'dynamic' })
        calls.push(typeof disposer)
      },
    }
    void fromCordisPlugin(raw, fixture('prompt-bridge')).hooks.activate?.(env)
    expect(calls).toEqual(['apply', 'function'])
    expect(env.promptSections).toHaveLength(2)
    expect(env.promptSections[0]).toEqual({ name: 'tool:prompt', order: 114, text: 'guidance' })
    expect(env.promptSections[1]?.name).toBe('tool:dynamic')
    expect(env.promptSections[1]?.order).toBe(115)
    expect(typeof env.promptSections[1]?.text).toBe('function')
  })

  it('rejects a malformed ctx.systemPrompt.section with manifest-invalid naming the plugin', () => {
    const env = createFakeEnv(fixture('prompt-malformed'))
    const raw = {
      name: 'broken-prompt',
      apply(ctx: { systemPrompt: { section(section: unknown): () => void } }) {
        ctx.systemPrompt.section({ name: 'x' })
      },
    }
    const bridged = fromCordisPlugin(raw, fixture('prompt-malformed'))
    expect(() => { void bridged.hooks.activate?.(env) }).toThrow(PluginError)
    try {
      void bridged.hooks.activate?.(env)
    } catch (error) {
      expect((error as PluginError).code).toBe('manifest-invalid')
      expect((error as PluginError).pluginId).toBe('prompt-malformed')
    }
  })

  it('forwards ctx.sessionPersistence through env.get with the declaration gate (SEC:86)', () => {
    const service = { listSnapshots: async () => [{ id: 's1' }] }
    const env = createFakeEnv({
      ...fixture('session-bridge'),
      requires: ['sessionPersistence'],
    })
    const seeded = createFakeEnv({
      ...fixture('session-bridge'),
      requires: ['sessionPersistence'],
      services: { sessionPersistence: service },
    })
    let seen: unknown = 'unset'
    const raw = {
      name: 'session-plugin',
      apply(ctx: { sessionPersistence: unknown }) {
        seen = ctx.sessionPersistence
      },
    }
    void fromCordisPlugin(raw, fixture('session-bridge')).hooks.activate?.(env)
    expect(seen).toBeUndefined()
    void fromCordisPlugin(raw, { ...fixture('session-bridge'), requires: ['sessionPersistence'] })
      .hooks.activate?.(seeded)
    expect(seen).toBe(service)
  })
})
