import { expect, it } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describeTeam, type MonitorReads } from '../../src/agent-team-monitor/host/snapshot.ts'
import { describeWorkflows } from '../../src/agent-team-monitor/host/workflow.ts'
import { meta, teamEvents, teamProjection } from './fixtures.ts'

const event = (type: string, data: unknown, seq = 0): SessionEvent => ({ type, data, seq, time: 1000 + seq }) as SessionEvent
function events(): SessionEvent[] {
  return [
    event('turn/start', { turn: 1 }), event('step/start', { turn: 1, step: 1 }, 1),
    event('tool-workflow/run-start', { runId: 'w1', name: 'gomoku-team-build' }, 2),
    event('tool-workflow/agent-start', { runId: 'w1', seq: 1, label: '整体架构师', phase: '1-总体架构设计', childId: 'child1' }, 3),
  ]
}
const live = (id: string) => ({ id, status: 'running', options: { model: id === meta.id ? 'parent-model' : 'child-model' } }) as Agent
const agent: MonitorReads['agent'] = id => id === meta.id ? live(id) : undefined
const signal = () => new AbortController().signal
function reads(log = events()): MonitorReads {
  return { agent, teamService: () => undefined, project: () => undefined,
    inspect: async id => id === meta.id ? { meta, events: log } : undefined }
}

it('observes exactly the screenshot workflow without enabling experimental Agent Teams', async () => {
  const log = events()
  const before = JSON.stringify(log)
  const view = await describeTeam(reads(log), meta.id, signal())
  expect(view).toMatchObject({ kind: 'workflow', enabled: false, source: 'live', workflows: {
    counts: { runs: 1, members: 1, running: 1, completed: 0 },
    runs: [{ name: 'gomoku-team-build', members: [{ name: '整体架构师', phase: '1-总体架构设计', status: 'running' }] }],
  } })
  expect(JSON.stringify(log)).toBe(before)
  expect(JSON.stringify(view)).not.toContain('parent-model')
})
it('updates actual started members and their exact paired outcomes without inventing planned tasks', () => {
  const log = events()
  log.push(event('tool-workflow/agent-end', { runId: 'w1', seq: 1, outcome: 'completed' }, 4))
  for (const [seq, outcome] of [[2, 'failed'], [3, 'cancelled']] as const) {
    log.push(event('tool-workflow/agent-start', { runId: 'w1', seq, label: 'same-label', childId: `child${seq}` }, log.length))
    log.push(event('tool-workflow/agent-end', { runId: 'w1', seq, outcome }, log.length))
  }
  log.push(event('tool-workflow/run-end', { runId: 'w1', stopReason: 'completed' }, log.length))
  const view = describeWorkflows(meta, log, agent)!
  expect(view.counts).toEqual({ runs: 1, members: 3, running: 0, completed: 1 })
  expect(view.runs[0]?.members.map(member => member.status)).toEqual(['completed', 'failed', 'cancelled'])
  expect(view.runs[0]?.status).toBe('completed')
})
it('never labels cold, resumed or bracket-closed unfinished records as live/completed', () => {
  expect(describeWorkflows(meta, events(), () => undefined)?.runs[0]?.members[0]?.status).toBe('inactive')
  const seeded = [...events(), event('session/end-seed', {}, 4)]
  expect(describeWorkflows(meta, seeded, agent)?.runs[0]?.status).toBe('inactive')
  for (const boundary of [event('step/end', { turn: 1, step: 1 }, 4), event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4)]) {
    const view = describeWorkflows(meta, [...events(), boundary], agent)!
    expect(view.runs[0]).toMatchObject({ status: 'interrupted', members: [{ status: 'interrupted' }] })
  }
})
it('scopes workflow discovery to the exact session suffix and does not inherit parent runs', async () => {
  const forkMeta = { ...meta, id: SessionId('fork'), seedLength: events().length, parentSession: meta.id }
  expect(describeWorkflows(forkMeta, events(), agent)).toBeUndefined()
  expect(await describeTeam(reads(), SessionId('other'), signal())).toMatchObject({ kind: 'unavailable', reason: 'no-session' })
  const childReads = { ...reads(), inspect: async (id: ReturnType<typeof SessionId>) => id === meta.id
    ? { meta, events: events() } : { meta: { ...meta, id, origin: 'subagent' as const, parentSession: meta.id }, events: [] } }
  expect(await describeTeam(childReads, SessionId('child1'), signal())).toMatchObject({ kind: 'unavailable', reason: 'not-team' })
})
it('retains independent workflow information when a conversation also has an official task board', async () => {
  const log = [...events(), ...teamEvents().map((item, index) => ({ ...item, seq: index + 4 }))]
  expect(await describeTeam({ ...reads(log), project: teamProjection }, meta.id, signal())).toMatchObject({ kind: 'team', workflows: { counts: { members: 1 } }, counts: { tasks: 2 } })
})
it('rejects corrupt extension records and unknown outcomes without leaking raw payloads', async () => {
  const bad = [
    event('tool-workflow/agent-end', { runId: 'missing', seq: 1, outcome: 'completed' }),
    event('tool-workflow/agent-end', { runId: 'w1', seq: 1, outcome: ['completed'] }),
    event('tool-workflow/agent-start', { runId: 'w1', seq: 1, label: 'duplicate', childId: 'other' }),
    event('tool-workflow/future', { secret: 'PRIVATE_DATA' }),
  ]
  for (const item of bad) {
    const result = await describeTeam(reads([...events(), item]), meta.id, signal())
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'incompatible' })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_DATA')
  }
})
it('bounds member rows across runs but preserves complete totals and distinct run identities', () => {
  const log: SessionEvent[] = []
  for (let run = 0; run < 110; run++) {
    const runId = `run-${run}`
    log.push(event('tool-workflow/run-start', { runId, name: 'same-name' }, log.length))
    for (let seq = 0; seq < 3; seq++) log.push(event('tool-workflow/agent-start', { runId, seq, label: 'same-label', childId: `child-${run}-${seq}` }, log.length))
  }
  const view = describeWorkflows(meta, log, agent)!
  expect(view.counts.members).toBe(330)
  expect(view.counts.runs).toBe(110)
  expect(view.runs).toHaveLength(100)
  expect(view.runs.flatMap(run => run.members)).toHaveLength(256)
  expect(view.truncated).toBe(true)
})
