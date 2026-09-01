import { describe, expect, it, vi } from 'vitest'
import type { TeamService } from '@deepseek-ai/dsh-experimental-agent-team'
import {
  SessionId, SessionLogOffset, SessionSeq,
  type SessionEvent, type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describeTeam, type MonitorReads } from '../../src/agent-team-monitor/host/snapshot.ts'
import { meta, rootId, memberId, teamEvents, teamProjection } from './fixtures.ts'

const inspection = (
  header: SessionHeader,
  events: readonly SessionEvent[],
  inheritedEventCount = SessionLogOffset(0),
) => ({ meta: header, inheritedEventCount, events })

function reads(): MonitorReads {
  return { agent: () => undefined, teamService: () => undefined, project: teamProjection,
    inspect: async id => id === rootId ? inspection(meta, teamEvents()) : undefined }
}
const signal = () => new AbortController().signal

describe('official Team read model', () => {
  it('replays history with dependencies and mailbox counts without exposing message bodies', async () => {
    const result = await describeTeam(reads(), rootId, signal())
    expect(result).toMatchObject({ kind: 'team', enabled: false, source: 'persisted', counts: { members: 2, tasks: 2, blocked: 1, pendingMessages: 1 } })
    if (result.kind !== 'team') throw new Error('expected team')
    expect(result.members[1]).toMatchObject({ status: 'inactive', pendingMessages: 1 })
    expect(result.tasks[1]).toMatchObject({ ready: false, overlappingTaskIds: ['task-1'] })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_MAILBOX_BODY')
  })
  it('uses exact live Team members and strips provider diagnostics', async () => {
    const live = { id: rootId, options: { model: 'lead-model' } } as Agent
    const service = { tryMembership: () => ({ role: 'lead' }), listMembers: vi.fn(() => [
      { id: rootId, name: 'lead', role: 'lead', status: 'idle', diagnostics: [] },
      { id: memberId, name: 'researcher', role: 'teammate', status: 'running', model: 'fixture', diagnostics: ['SECRET_PROVIDER_ERROR'] },
    ]) } as unknown as TeamService
    const result = await describeTeam({ ...reads(), agent: id => id === rootId ? live : undefined, teamService: () => service }, rootId, signal())
    expect(result).toMatchObject({ kind: 'team', source: 'live', enabled: true })
    expect(service.listMembers).toHaveBeenCalledWith(live)
    expect(JSON.stringify(result)).not.toContain('SECRET_PROVIDER_ERROR')
    if (result.kind !== 'team') throw new Error('Expected team')
    expect(result.members[1]?.model).toBeUndefined()
  })
  it('does not mistake inherited events in a new root fork for the ancestor Team', async () => {
    const id = SessionId('fork')
    const result = await describeTeam({ ...reads(), inspect: async () => inspection(
      { ...meta, id, parentSession: rootId, isSeeded: true },
      teamEvents(),
      SessionLogOffset(teamEvents().length),
    ) }, id, signal())
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'not-team' })
  })
  it('accepts roster children but refuses ordinary subagents', async () => {
    const base = reads()
    const inspect: MonitorReads['inspect'] = async (id, signal) => id === rootId ? base.inspect(id, signal)
      : inspection({ ...meta, id, origin: 'subagent', parentSession: rootId }, [])
    expect(await describeTeam({ ...base, inspect }, memberId, signal())).toMatchObject({ kind: 'team', teamId: rootId, sessionId: memberId })
    expect(await describeTeam({ ...base, inspect }, SessionId('other'), signal())).toMatchObject({ kind: 'unavailable', reason: 'not-team' })
  })
  it('does not silently render corrupt or unsupported logs as empty', async () => {
    const project = () => { throw new Error('PRIVATE_BAD_EVENT') }
    const result = await describeTeam({ ...reads(), project }, rootId, signal())
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'incompatible' })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_BAD_EVENT')
    expect(await describeTeam({ ...reads(), project: () => undefined }, rootId, signal())).toMatchObject({ reason: 'incompatible' })
    const malformed = [{ type: 'team/member', seq: SessionSeq(0), time: 1000, data: { version: 1 } }] as SessionEvent[]
    expect(await describeTeam({ ...reads(), inspect: async () => inspection(meta, malformed) }, rootId, signal())).toMatchObject({ reason: 'incompatible' })
  })
  it('cancels before accessing the store and reports missing storage distinctly', async () => {
    const inspect = vi.fn(reads().inspect)
    await expect(describeTeam({ ...reads(), inspect }, rootId, AbortSignal.abort())).rejects.toThrow()
    expect(inspect).not.toHaveBeenCalled()
    expect(await describeTeam({ ...reads(), inspect: async () => { throw new Error('private path') } }, rootId, signal())).toMatchObject({ reason: 'storage-unavailable' })
  })
  it('unlocks downstream tasks after completion and counts only unacknowledged messages', async () => {
    const events = teamEvents()
    const taskEvent = events[3] as SessionEvent<'team/task'>
    events.push({ ...taskEvent, seq: SessionSeq(6), time: 1006, data: { ...taskEvent.data, task: { ...taskEvent.data.task, revision: 3, status: 'completed' } } })
    const queued = events[5] as SessionEvent<'team/message/queued'>
    events.push({ type: 'team/message/delivered', seq: SessionSeq(7), time: 1007, data: { version: 1, teamId: queued.data.teamId, messageId: queued.data.message.id, targetId: memberId } })
    const result = await describeTeam({ ...reads(), inspect: async () => inspection(meta, events) }, rootId, signal())
    expect(result).toMatchObject({ counts: { completed: 1, blocked: 0, pendingMessages: 0 } })
    if (result.kind !== 'team') throw new Error('Expected team')
    expect(result.tasks[1]).toMatchObject({ ready: true, overlappingTaskIds: [] })
  })
})
