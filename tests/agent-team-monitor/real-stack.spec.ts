import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { dshCheckout } from '../dsh-aliases.ts'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Teams from '@deepseek-ai/dsh-experimental-agent-team'
import * as Monitor from '../../src/agent-team-monitor/host/index.ts'
import * as Edit from '../../src/edit-last-message/host/index.ts'
import { editLastMessageSource } from '../../src/edit-last-message/shared.ts'

class KeylessAdapter extends LlmAdapter {
  async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Fixture work complete.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture work complete.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function storedBytes(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const pairs = await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
    const path = join(entry.parentPath, entry.name)
    return [path, createHash('sha256').update(await readFile(path)).digest('hex')] as const
  }))
  return Object.fromEntries(pairs)
}

async function stack(root: string) {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(resolve(dshCheckout, 'examples/package.json')).href
  await mountAgentLoopTestDependencies(ctx)
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
    const before = lead.session.seq
    const view = await remote.describe({ sessionId: lead.id }, new AbortController().signal)
    expect(view).toMatchObject({ kind: 'team', source: 'live', counts: { members: 2, tasks: 1 } })
    expect(lead.session.seq).toBe(before)
    if (view.kind !== 'team') throw new Error('Expected real Team view')
    expect(view.members[1]).toMatchObject({ name: 'researcher', status: 'inactive' })
    expect(view.catalog).toMatchObject({ state: 'ready', total: 1, sessions: [{ id: created.member.id, status: 'completed', navigable: true }] })
    await monitorFiber.dispose()
    expect(ctx.agents.get(lead.id)).toBe(lead)
    expect(ctx.agentTeams.listTasks(lead)[0]?.status).toBe('in_progress')
    expect(lead.session.seq).toBe(before)
    expect(ctx.get('agentTeamMonitor')).toBeUndefined()
    await ctx.fiber.dispose(); contexts.pop()
    const { ctx: cold } = await stack(root); contexts.push(cold)
    const persistedBefore = await storedBytes(root)
    const observe = vi.spyOn(cold.sessionQuery, 'observeSession')
    const restored = await (cold.get('agentTeamMonitor') as Monitor.AgentTeamMonitorRemote).describe({ sessionId: lead.id }, new AbortController().signal)
    expect(restored).toMatchObject({ kind: 'team', source: 'persisted', counts: { members: 2, tasks: 1 } })
    expect(cold.agents.list()).toHaveLength(0)
    expect(restored.catalog).toMatchObject({ state: 'ready', total: 1, sessions: [{ id: created.member.id, status: 'completed', navigable: true }] })
    expect(observe).toHaveBeenCalledWith(lead.id, { signal: expect.any(AbortSignal), projectionMode: 'none' })
    expect(await storedBytes(root)).toEqual(persistedBefore)
  } finally {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

it('edits with the real loop and preserves replacement intent after a durable inbox reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-edit-admission-'))
  const contexts: Context[] = []
  try {
    const { ctx } = await stack(join(root, 'original')); contexts.push(ctx)
    const plugin = await ctx.plugin(Edit)
    const { agent } = await ctx.agents.create({ sessionId: SessionId('edit-original'), agentOptions: { provider: 'monitor-fixture', model: 'fixture' } })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'original prompt' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const original = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source.kind === 'user')!
    const first = await Edit.rewriteLastMessage(agent, { messageSeq: original.seq, text: 'first revision' })
    await agent.whenIdle()
    expect(agent.session.surface.nodes).not.toContain(original.seq)
    expect(agent.session.eventAt(first.replacementSeq as never)?.surfaceOp).toMatchObject({ op: 'replace' })
    const admitted = agent.session.eventAt(first.replacementSeq as never)!
    if (admitted.type !== 'user/message') throw new Error('replacement not admitted')
    agent.send(createUserMessage({ content: [{ type: 'text', text: 'recovered revision' }], source: admitted.data.source }), 'next-turn', false)
    await ctx.sessionPersistence.flush()
    const reader = await ctx.sessionPersistence.open(agent.id, 'read')
    let seed: readonly SessionEvent[]
    try {
      // Reload the flushed JSONL prefix, with no process-local admission closure.
      const stored = await reader.read()
      seed = structuredClone(stored.events)
    } finally { await reader.close() }
    await plugin.dispose()
    expect(Object.hasOwn(agent.session, 'append')).toBe(false)
    await ctx.fiber.dispose(); contexts.pop()

    const { ctx: recovered } = await stack(join(root, 'recovered')); contexts.push(recovered)
    await recovered.plugin(Edit)
    const { agent: restored } = await recovered.agents.create({ sessionId: SessionId('edit-restored'), seed, agentOptions: { provider: 'monitor-fixture', model: 'fixture' } })
    expect(restored.inbox.nextTurn).toHaveLength(1)
    restored.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await restored.whenIdle()
    const edits = restored.session.snapshotEvents().filter(event => event.type === 'user/message' && editLastMessageSource(event.data.source) !== undefined)
    expect(edits).toHaveLength(2)
    expect(edits[1]?.surfaceOp).toMatchObject({ op: 'replace', start: first.replacementSeq })
    expect(restored.session.surface.nodes).not.toContain(first.replacementSeq)
    expect(restored.inbox.nextTurn).toHaveLength(0)
  } finally {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
