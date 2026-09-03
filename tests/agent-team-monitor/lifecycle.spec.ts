import { Context } from '@deepseek-ai/cordis'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import * as Host from '../../src/agent-team-monitor/host/index.ts'
import { meta } from './fixtures.ts'

describe('monitor Host fiber', () => {
  it('uses cancellable query observations for cold sessions and releases each lease', async () => {
    const ctx = new Context()
    const release = vi.fn()
    const observe = vi.fn(async () => ({
      header: meta, inheritedEventCount: SessionLogOffset(0), events: [],
      [Symbol.dispose]: release,
    }))
    await ctx.plugin({ apply(scope: Context) {
      scope.reflect.provide('agents', { get: () => undefined })
      scope.reflect.provide('sessions', { get: () => undefined })
    } })
    const provider = await ctx.plugin({ apply(scope: Context) {
      scope.reflect.provide('sessionQuery', { observeSession: observe })
    } })
    const fiber = await ctx.plugin(Host)
    const remote = ctx.get('agentTeamMonitor') as Host.AgentTeamMonitorRemote
    try {
      await expect(remote.describe({ sessionId: meta.id }, new AbortController().signal))
        .resolves.toMatchObject({ reason: 'not-team' })
      expect(observe).toHaveBeenCalledWith(meta.id, { signal: expect.any(AbortSignal), projectionMode: 'none' })
      expect(release).toHaveBeenCalledTimes(1)
      // Optional query providers may disappear/reload without remounting the monitor.
      await provider.dispose()
      await expect(remote.describe({ sessionId: meta.id }, new AbortController().signal))
        .resolves.toMatchObject({ reason: 'storage-unavailable' })
      const replacement = vi.fn(async () => { throw new Error('read failed') })
      await ctx.plugin({ apply(scope: Context) {
        scope.reflect.provide('sessionQuery', { observeSession: replacement })
      } })
      expect(ctx.get('agentTeamMonitor') !== undefined).toBe(true)
      await expect(remote.describe({ sessionId: meta.id }, new AbortController().signal))
        .resolves.toMatchObject({ reason: 'storage-unavailable' })
      expect(replacement).toHaveBeenCalledTimes(1)
      expect(release).toHaveBeenCalledTimes(1)
      await fiber.dispose()
    } finally { await ctx.fiber.dispose() }
  })

  it('waits for an in-flight observation to release when unloaded', async () => {
    const ctx = new Context()
    const release = vi.fn()
    let readSignal: AbortSignal | undefined
    await ctx.plugin({ apply(scope: Context) {
      scope.reflect.provide('agents', { get: () => undefined })
      scope.reflect.provide('sessions', { get: () => undefined })
      scope.reflect.provide('sessionQuery', {
        async observeSession(_id: string, options: { signal: AbortSignal }) {
          readSignal = options.signal
          await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }))
          return { header: meta, inheritedEventCount: SessionLogOffset(0), events: [], [Symbol.dispose]: release }
        },
      })
    } })
    const fiber = await ctx.plugin(Host)
    try {
      const remote = ctx.get('agentTeamMonitor') as Host.AgentTeamMonitorRemote
      const outcome = remote.describe({ sessionId: meta.id }, new AbortController().signal)
        .then(() => 'resolved', () => 'cancelled')
      await vi.waitFor(() => expect(readSignal).toBeDefined())
      await fiber.dispose()
      expect(readSignal?.aborted).toBe(true)
      expect(release).toHaveBeenCalledTimes(1)
      expect(await outcome).toBe('cancelled')
    } finally { await ctx.fiber.dispose() }
  })

  it('registers only one read-only method, rejects invalid wire data, and unloads cleanly', async () => {
    const ctx = new Context()
    const dependencies = ctx.plugin({ apply(scope: Context) {
      scope.reflect.provide('agents', { get: () => undefined })
      scope.reflect.provide('sessions', { get: () => ({
        header: meta,
        inheritedEventCount: SessionLogOffset(0),
        snapshotEvents: () => [],
      }) })
    } })
    await dependencies.await()
    const fiber = ctx.plugin(Host)
    await fiber.await()
    const remote = ctx.get('agentTeamMonitor') as Host.AgentTeamMonitorRemote
    expect(remoteMethods(remote).map(method => method.method)).toEqual(['describe'])
    await expect(remote.describe({ sessionId: '' }, new AbortController().signal)).rejects.toThrow(/invalid sessionId/)
    await expect(remote.describe({ sessionId: meta.id }, new AbortController().signal)).resolves.toMatchObject({ enabled: false, reason: 'not-team' })
    await fiber.dispose()
    expect(ctx.get('agentTeamMonitor')).toBeUndefined()
    const reloaded = ctx.plugin(Host)
    await reloaded.await()
    expect(ctx.get('agentTeamMonitor')).not.toBe(remote)
    await ctx.fiber.dispose()
  })
})
