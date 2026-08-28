import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Teams from '@deepseek-ai/dsh-experimental-agent-team'
import * as Monitor from '../../src/agent-team-monitor/host/index.ts'

class KeylessAdapter extends LlmAdapter {
  async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Fixture work complete.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture work complete.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function stack(root: string) {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(resolve(import.meta.dirname, '../../../deepseek-harness/examples/package.json')).href
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(SessionQuery, { path: ':memory:', openAt: 'never' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(Teams)
  ctx.llm.registerAdapter(['monitor-fixture'], new KeylessAdapter())
  const monitorFiber = await ctx.plugin(Monitor)
  return { ctx, monitorFiber }
}

it('observes real continuable teammates, unloads without affecting them, and replays a cold persisted Team', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-monitor-stack-'))
  const contexts: Context[] = []
  try {
    const { ctx, monitorFiber } = await stack(root); contexts.push(ctx)
    const { agent: lead } = await ctx.agents.create({ sessionId: SessionId('monitor-live-lead'), agentOptions: { provider: 'monitor-fixture', model: 'fixture' } })
    const created = await ctx.agentTeams.spawnTeammate(lead, {
      name: 'researcher', description: 'Inspect public interfaces', prompt: [{ type: 'text', text: 'Check the ABI' }],
      provider: 'spawn', context: 'fresh', signal: new AbortController().signal,
    })
    // Current continuation ownership naturally releases a settled child;
    // the roster survives and remains distinguishable from task completion.
    await vi.waitFor(() => expect(ctx.agents.get(created.member.id)).toBeUndefined())
    const task = await ctx.agentTeams.createTask(lead, { subject: 'Read contracts', description: 'Inspect public ABI', writeScopes: ['src'] })
    await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: 'researcher' })
    const remote = ctx.get('agentTeamMonitor') as Monitor.AgentTeamMonitorRemote
    const before = lead.session.events.length
    const view = await remote.describe({ sessionId: lead.id }, new AbortController().signal)
    expect(view).toMatchObject({ kind: 'team', source: 'live', counts: { members: 2, tasks: 1 } })
    expect(lead.session.events.length).toBe(before)
    if (view.kind !== 'team') throw new Error('Expected real Team view')
    expect(view.members[1]).toMatchObject({ name: 'researcher', status: 'inactive' })
    expect(view.catalog).toMatchObject({ state: 'ready', total: 1, sessions: [{ id: created.member.id, status: 'completed', navigable: true }] })
    await monitorFiber.dispose()
    expect(ctx.agents.get(lead.id)).toBe(lead)
    expect(ctx.agentTeams.listTasks(lead)[0]?.status).toBe('in_progress')
    expect(lead.session.events.length).toBe(before)
    expect(ctx.get('agentTeamMonitor')).toBeUndefined()
    await ctx.fiber.dispose(); contexts.pop()
    const { ctx: cold } = await stack(root); contexts.push(cold)
    const restored = await (cold.get('agentTeamMonitor') as Monitor.AgentTeamMonitorRemote).describe({ sessionId: lead.id }, new AbortController().signal)
    expect(restored).toMatchObject({ kind: 'team', source: 'persisted', counts: { members: 2, tasks: 1 } })
    expect(cold.agents.list()).toHaveLength(0)
    expect(restored.catalog).toMatchObject({ state: 'ready', total: 1, sessions: [{ id: created.member.id, status: 'completed', navigable: true }] })
  } finally {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
