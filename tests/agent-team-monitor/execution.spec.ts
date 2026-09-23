import { expect, it, vi } from 'vitest'
import { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describeExecution } from '../../src/agent-team-monitor/host/execution.ts'
import { describeExecutionDetail } from '../../src/agent-team-monitor/host/detail.ts'
import { describeMonitor, type CatalogReads } from '../../src/agent-team-monitor/host/catalog.ts'
import { parseSnapshot } from '../../src/agent-team-monitor/client/parse.ts'
import { meta } from './fixtures.ts'

function events(rows: { type: string; data: unknown }[]): SessionEvent[] {
  return rows.map((row, seq) => ({ ...row, seq, time: 1000 + seq * 100 })) as SessionEvent[]
}
const start = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'step/start', data: { turn: 1, step: 1 } }]
const call = (id: string, step = 1) => ({ type: 'tool/call', data: { turn: 1, step, callId: id, name: 'read', arguments: '{"path":"app.ts","apiKey":"sensitive"}' } })
const result = (id: string, isError = false, step = 1) => ({ type: 'tool/result', data: { turn: 1, step, message: {
  id: `result-${id}`,
  role: 'tool',
  source: { kind: 'tool', callId: id },
  toolCallId: id,
  isError,
  content: [{ type: 'text', text: 'read complete' }],
} } })

it('keeps concurrent calls distinct, failure/retry history and final turn outcome', () => {
  const trace = describeExecution(events([...start, call('a'), call('b'), result('b'), result('a', true),
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'step/start', data: { turn: 1, step: 2 } }, call('retry', 2), result('retry', false, 2),
    { type: 'step/end', data: { turn: 1, step: 2 } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]), 0, false)
  expect(trace.nodes.map(node => [node.kind, node.status])).toEqual([
    ['turn', 'completed'], ['step', 'failed'], ['tool', 'failed'], ['tool', 'completed'], ['step', 'completed'], ['tool', 'completed'],
  ])
  expect(trace.nodes[2]!.endedAt).toBe(1500)
})

it('excludes fork history, does not call cold or seeded open work live, and honors cancellation', () => {
  const log = events([...start, { type: 'session/end-seed', data: {} },
    { type: 'turn/start', data: { turn: 2 } }, { type: 'step/start', data: { turn: 2, step: 1 } }])
  expect(describeExecution(log, 3, true).nodes.map(node => node.turn)).toEqual([2, 2])
  expect(describeExecution(log, 0, true).nodes.map(node => node.status)).toEqual(['unknown', 'unknown', 'running', 'running'])
  expect(describeExecution(log, 0, false).nodes.every(node => node.status === 'unknown')).toBe(true)
  const cancelled = describeExecution(events([...start, { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } }]), 0, false)
  expect(cancelled.nodes.every(node => node.status === 'cancelled')).toBe(true)
})

it('retains running work in a bounded snapshot and rejects malformed wire nodes', () => {
  const log = events([...start, ...Array.from({ length: 160 }, (_, i) => ({ type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [] } }))])
  const trace = describeExecution(log, 0, true)
  expect(trace).toMatchObject({ total: 162, truncated: true })
  expect(trace.nodes).toHaveLength(120)
  expect(trace.nodes.slice(0, 2).every(node => node.status === 'running')).toBe(true)
  expect(() => parseSnapshot({ protocol: 4, sessionId: 'x', enabled: false, kind: 'agents', source: 'live', execution: { ...trace, nodes: [trace.nodes[0], trace.nodes[0]] } }, 'x')).toThrow()
})

it('does not turn missing or repaired tool outcomes into successful steps', () => {
  const missing = describeExecution(events([...start, call('a'), { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }]), 0, false)
  expect(missing.nodes.map(node => node.status)).toEqual(['completed', 'unknown', 'unknown'])
  const repaired = result('a', true)
  const log = events([...start, call('a'), { ...repaired, data: { ...repaired.data, error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' } } },
    { type: 'step/end', data: { turn: 1, step: 1 } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } }])
  expect(describeExecution(log, 0, false).nodes.map(node => node.status)).toEqual(['interrupted', 'interrupted', 'interrupted'])
})

function reads(log: SessionEvent[]): CatalogReads {
  return { agent: () => undefined, teamService: () => undefined, project: () => undefined, descendants: async () => [],
    inspect: vi.fn(async () => ({ meta, inheritedEventCount: SessionLogOffset(0), events: log })) }
}
it('opens a dispatch prompt only from its verified child own suffix', async () => {
  const childId = SessionId('child')
  const source = reads(events([{ type: 'subagent/catalog', data: { version: 0, childId } }]))
  const original = source.inspect
  source.descendants = async () => [{ id: childId, parentId: meta.id, depth: 1, kind: 'child', mode: 'one-shot', activity: 'inactive', hasChildren: false }]
  source.inspect = async (id, signal) => id === meta.id ? original(id, signal) : {
    meta: { ...meta, id: childId, origin: 'subagent', parentSession: meta.id }, inheritedEventCount: SessionLogOffset(1),
    events: events(['INHERITED_PRIVATE', 'Inspect app.ts'].map(text => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }))),
  }
  expect((await describeExecutionDetail(source, { rootId: meta.id, sessionId: meta.id, seq: 0 }, new AbortController().signal)).input).toBe('Inspect app.ts')
  source.descendants = async () => []
  await expect(describeExecutionDetail(source, { rootId: meta.id, sessionId: meta.id, seq: 0 }, new AbortController().signal)).rejects.toThrow('Dispatch child unavailable')
})
it('monitors an ordinary agent without Teams and shares one observation per request', async () => {
  const source = reads(events(start))
  const snapshot = await describeMonitor(source, meta.id, new AbortController().signal)
  expect(snapshot.kind).toBe('agents')
  expect(snapshot.execution?.nodes).toHaveLength(2)
  expect(source.inspect).toHaveBeenCalledTimes(1)
  expect(parseSnapshot(snapshot, meta.id)).toEqual(snapshot)
})

it('loads addressed tool details on demand, redacts secret keys and rejects unrelated/inherited events', async () => {
  const source = reads(events([...start, call('a'), result('a')]))
  const signal = new AbortController().signal
  const detail = await describeExecutionDetail(source, { rootId: meta.id, sessionId: meta.id, seq: 2 }, signal)
  expect(detail.input).toContain('app.ts')
  expect(detail.input).not.toContain('sensitive')
  expect(detail.output).toBe('read complete')
  await expect(describeExecutionDetail(source, { rootId: meta.id, sessionId: 'stranger', seq: 2 }, signal)).rejects.toThrow(/catalog/)
  source.inspect = async () => ({ meta, inheritedEventCount: SessionLogOffset(3), events: events([...start, call('a'), result('a')]) })
  await expect(describeExecutionDetail(source, { rootId: meta.id, sessionId: meta.id, seq: 2 }, signal)).rejects.toThrow(/event unavailable/)
  const aborted = new AbortController(); aborted.abort()
  await expect(describeExecutionDetail(source, { rootId: SessionId('x'), sessionId: 'x', seq: 0 }, aborted.signal)).rejects.toThrow()
})
