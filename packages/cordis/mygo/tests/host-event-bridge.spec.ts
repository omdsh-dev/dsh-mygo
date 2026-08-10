/**
 * Facade `ctx.on` host-event bridge: harness-vocabulary events keep flowing
 * through managed dispatch (emit/waterfall/scoped/carrier), while events the
 * manager does not claim are bridged to the raw host bus with real Cordis
 * semantics (`once`, `prepend`) and HMR-safe revocation.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { DispatchMachine, InMemoryRegistryStore, LifecycleEngine, resolvePluginManagerConfig } from '@deepseek-ai/dsh-mygo'

type RawApply = (ctx: {
  on(event: string, listener: (...args: unknown[]) => unknown, options?: { readonly prepend?: boolean }): () => void
  once(event: string, listener: (...args: unknown[]) => unknown): () => void
}) => void

function rawPlugin(apply: RawApply): { name: string; apply: RawApply } {
  return { name: 'host-events', apply }
}

async function harness(events: Array<{ name: string; mode: 'emit' | 'waterfall' }>): Promise<{
  ctx: Context
  engine: LifecycleEngine
}> {
  const ctx = new Context()
  const machine = new DispatchMachine(ctx, { vocabulary: new Map(events.map(entry => [entry.name, entry.mode])) })
  machine.start()
  const engine = new LifecycleEngine({
    ctx,
    dispatch: machine,
    store: new InMemoryRegistryStore(),
    config: resolvePluginManagerConfig({ swapTimeoutMs: 40, historyKeep: 2 }),
    eventVocabulary: events,
  })
  return { ctx, engine }
}

describe('raw facade ctx.on host event bridge', () => {
  it('receives host emits for harness-vocabulary events', async () => {
    const { ctx, engine } = await harness([{ name: 'session/created', mode: 'emit' }])
    const called: unknown[] = []
    await engine.adoptRaw(rawPlugin(ctx => {
      ctx.on('session/created', payload => { called.push(payload) })
    }) as never, {}, 'host-events')
    ctx.emit('session/created' as never, { id: 's1' })
    expect(called).toEqual([{ id: 's1' }])
  })

  it('receives host emits through a scoped child context', async () => {
    const { ctx, engine } = await harness([{ name: 'session/created', mode: 'emit' }])
    const called: unknown[] = []
    await engine.adoptRaw(rawPlugin(ctx => {
      ctx.on('session/created', payload => { called.push(payload) })
    }) as never, {}, 'host-events')
    const child = ctx.isolate('agent', 'agent-1')
    child.emit('session/created' as never, { id: 's2' })
    expect(called).toEqual([{ id: 's2' }])
  })

  it('receives host emits with a carrier thisArg (agentEvents style)', async () => {
    const { ctx, engine } = await harness([{ name: 'agent/status', mode: 'emit' }])
    const called: unknown[] = []
    await engine.adoptRaw(rawPlugin(ctx => {
      ctx.on('agent/status', payload => { called.push(payload) })
    }) as never, {}, 'host-events')
    const carrier = { kind: 'agent' }
    ctx.emit(carrier as never, 'agent/status' as never, { status: 'running' })
    expect(called).toEqual([{ status: 'running' }])
  })

  it('composes host waterfall events with next semantics', async () => {
    const { ctx, engine } = await harness([{ name: 'llm/stream', mode: 'waterfall' }])
    const called: string[] = []
    await engine.adoptRaw(rawPlugin(ctx => {
      ctx.on('llm/stream', async (_payload, next) => {
        called.push('before')
        await next()
        called.push('after')
      })
    }) as never, {}, 'host-events')
    await ctx.waterfall('llm/stream' as never, { delta: 'hi' }, () => {
      called.push('inner')
      return 'done'
    })
    expect(called).toEqual(['before', 'inner', 'after'])
  })

  it('bridges vocabulary-foreign host events to the raw host bus', async () => {
    const { ctx, engine } = await harness([])
    const called: unknown[] = []
    await engine.adoptRaw(rawPlugin(ctx => {
      ctx.on('connection/reset', payload => { called.push(payload) })
    }) as never, {}, 'host-events')
    ctx.emit('connection/reset' as never, { reason: 'socket' })
    expect(called).toEqual([{ reason: 'socket' }])
  })

  it('revokes bridged host listeners on disable', async () => {
    const { ctx, engine } = await harness([])
    const called: unknown[] = []
    await engine.adoptRaw(rawPlugin(ctx => {
      ctx.on('connection/reset', payload => { called.push(payload) })
    }) as never, {}, 'host-events')
    ctx.emit('connection/reset' as never, { reason: 'a' })
    await engine.disable('host-events')
    ctx.emit('connection/reset' as never, { reason: 'b' })
    expect(called).toEqual([{ reason: 'a' }])
  })

  it('revokes bridged host listeners on HMR replace', async () => {
    const { ctx, engine } = await harness([])
    const called: string[] = []
    await engine.adoptRaw(rawPlugin(ctx => {
      ctx.on('connection/reset', () => { called.push('v1') })
    }) as never, {}, 'host-events')
    await engine.updateRaw(rawPlugin(ctx => {
      ctx.on('connection/reset', () => { called.push('v2') })
    }) as never, {}, 'host-events')
    ctx.emit('connection/reset' as never, {})
    expect(called).toEqual(['v2'])
  })

  it('supports once listeners without host-fiber leaks', async () => {
    const { ctx, engine } = await harness([])
    const called: number[] = []
    await engine.adoptRaw(rawPlugin(ctx => {
      ctx.once('connection/reset', () => { called.push(called.length + 1) })
    }) as never, {}, 'host-events')
    ctx.emit('connection/reset' as never, {})
    ctx.emit('connection/reset' as never, {})
    await engine.disable('host-events')
    ctx.emit('connection/reset' as never, {})
    expect(called).toEqual([1])
  })

  it('honors prepend ordering on bridged host listeners', async () => {
    const { ctx, engine } = await harness([])
    const called: string[] = []
    await engine.adoptRaw(rawPlugin(ctx => {
      ctx.on('connection/reset', () => { called.push('first') })
      ctx.on('connection/reset', () => { called.push('prepended') }, { prepend: true })
    }) as never, {}, 'host-events')
    ctx.emit('connection/reset' as never, {})
    expect(called).toEqual(['prepended', 'first'])
  })
})
