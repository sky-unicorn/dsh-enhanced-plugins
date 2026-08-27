import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'
import * as Host from '../../src/agent-team-monitor/host/index.ts'
import { meta } from './fixtures.ts'

describe('monitor Host fiber', () => {
  it('registers only one read-only method, rejects invalid wire data, and unloads cleanly', async () => {
    const ctx = new Context()
    const dependencies = ctx.plugin({ apply(scope: Context) {
      scope.reflect.provide('agents', { get: () => undefined })
      scope.reflect.provide('sessions', { get: () => ({ header: meta, events: [] }) })
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
