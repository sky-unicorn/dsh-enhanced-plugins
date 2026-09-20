import { expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describeCooperation } from '../../src/agent-team-monitor/host/cooperation.ts'
import { memberCooperation } from '../../src/agent-team-monitor/client/cooperation.ts'
import { describeExecution } from '../../src/agent-team-monitor/host/execution.ts'
import type { MonitorChildSession } from '../../src/agent-team-monitor/shared.ts'

const log = (rows: { type: string; data: unknown }[]) => rows.map((row, seq) => ({ ...row, seq, time: 1000 + seq * 100 })) as SessionEvent[]
const member: MonitorChildSession = { id: 'child', parentId: 'root', depth: 1, status: 'completed', navigable: true }
it('requires the matching Team delivery acknowledgement and keeps it a progress message', () => {
  const events = log([
    { type: 'team/message/queued', data: { version: 2, teamId: 'root', message: { id: 'm', senderId: 'child', targetId: 'root' } } },
    { type: 'team/message/delivered', data: { version: 2, teamId: 'root', messageId: 'm', targetId: 'wrong' } },
    { type: 'team/message/delivered', data: { version: 2, teamId: 'root', messageId: 'm', targetId: 'root' } },
  ])
  const read = (end: number) => describeCooperation([{ sessionId: 'root', events: events.slice(0, end), inherited: 0 }], new Set(['root', 'child']))
  expect(read(2).events[0]?.delivery).toBe('queued')
  expect(read(3).events).toHaveLength(1)
  expect(read(3).events[0]).toMatchObject({ delivery: 'recorded', seq: 2 })
  expect(memberCooperation(member, read(3).events).received).toBe(false)
})
it('distinguishes dispatch, progress messages and an explicit completion notice', () => {
  const events = log([
    { type: 'subagent/catalog', data: { version: 0, childId: 'child' } },
    { type: 'user/message', data: { source: { kind: 'agent-message', senderSessionId: 'child' } } },
    { type: 'user/message', data: { source: { kind: 'subagent-settled', senderSessionId: 'child' } } },
  ])
  const read = (end: number) => describeCooperation([{ sessionId: 'root', events: events.slice(0, end), inherited: 0 }], new Set(['root', 'child']))
  expect(memberCooperation(member, read(2).events)).toMatchObject({ received: false, result: undefined, messages: [{ kind: 'message' }] })
  expect(memberCooperation(member, read(3).events)).toMatchObject({ received: true, result: { source: 'settlement', sessionId: 'root', seq: 2 } })
  expect(describeCooperation([{ sessionId: 'root', events, inherited: 3 }], new Set(['root', 'child'])).total).toBe(0)
  expect(describeCooperation([{ sessionId: 'root', events, inherited: 0 }], new Set(['root'])).total).toBe(0)
})
it('pairs workflow callbacks by run and sequence, never by a child completion', () => {
  const events = log([
    { type: 'tool-workflow/agent-start', data: { runId: 'a', seq: 1, childId: 'child', phase: 'Review' } },
    { type: 'tool-workflow/agent-end', data: { runId: 'b', seq: 1, outcome: 'completed' } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'tool-workflow/agent-end', data: { runId: 'a', seq: 1, outcome: 'failed' } },
  ])
  const activity = describeCooperation([{ sessionId: 'root', events, inherited: 0 }], new Set(['root', 'child']))
  expect(activity.events).toHaveLength(2)
  expect(activity.events[1]).toMatchObject({ kind: 'return', outcome: 'failed', phase: 'Review', fromId: 'child', toId: 'root' })
  const newer = { ...member, execution: { nodes: [], total: 0, truncated: false, progress: { turn: 2, status: 'running' as const, startedAt: 2000, steps: 0, completedSteps: 0, failedSteps: 0, tools: 0, completedTools: 0, failedTools: 0 } } }
  expect(memberCooperation(newer, activity.events).received).toBe(false)
})
it('counts the whole latest turn before trimming its displayed node window', () => {
  const rows: { type: string; data: unknown }[] = [{ type: 'turn/start', data: { turn: 1 } }]
  for (let step = 1; step <= 150; step++) rows.push({ type: 'step/start', data: { turn: 1, step } }, { type: 'step/end', data: { turn: 1, step } })
  rows.push({ type: 'step/start', data: { turn: 1, step: 151 } })
  const trace = describeExecution(log(rows), 0, true)
  expect(trace.nodes).toHaveLength(120)
  expect(trace.progress).toMatchObject({ steps: 151, completedSteps: 150, status: 'running', current: { kind: 'step' } })
})
