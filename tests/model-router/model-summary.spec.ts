import { expect, it } from 'vitest'
import { summarizeModelCalls } from '../../src/model-router/client/model-summary.ts'
import { Config } from '../../src/model-router/host/config.ts'
import type { RequestRecord, RunRecord } from '../../src/model-router/shared.ts'

const base = { provider: 'fixture', model: 'normal' }
const request = (overrides: Partial<RequestRecord> = {}): RequestRecord => ({
  id: 'main', executionId: 'root-execution', sessionId: 'root', turn: 1, step: 1,
  selectedModel: base, actualModel: base, policyRevision: 1, status: 'settled', time: 1,
  usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 }, ...overrides,
})
const run = (requests: RunRecord['requests']): RunRecord => ({
  id: 'run', sessionId: 'root', workspaceId: 'workspace', revision: 1, createdAt: 1,
  status: 'completed', config: Config({}), originalModel: base, policyRevision: 0,
  tasks: [{ id: 'task', executionId: 'upgraded', role: 'execute', title: 'Implement', objective: '', scope: [], acceptance: [], constraints: [], context: '', status: 'completed', selectedModel: { provider: 'fixture', model: 'strong' }, executions: [
    { id: 'child-execution', tier: 'normal', reason: 'role_default', status: 'failed', selectedModel: base },
    { id: 'upgraded', tier: 'strong', reason: 'capability_upgrade', status: 'completed', selectedModel: { provider: 'fixture', model: 'strong' } },
  ] }], requests, childExecutions: 2,
})

it('merges shared model calls, including roles from earlier upgrade executions', () => {
  const result = summarizeModelCalls(run([
    request(),
    request({ id: 'child', executionId: 'child-execution', sessionId: 'child' }),
    request({ id: 'compact', purpose: 'compaction', usage: undefined, status: 'applied' }),
    request({ id: 'upgraded', executionId: 'upgraded', sessionId: 'expert-child', actualModel: { provider: 'fixture', model: 'strong' } }),
  ]))
  expect(result).toEqual([
    { key: '["fixture","normal"]', model: base, calls: 3, reported: 20, unknownUsage: 1, roles: ['main', 'execute', 'compaction'] },
    { key: '["fixture","strong"]', model: { provider: 'fixture', model: 'strong' }, calls: 1, reported: 10, unknownUsage: 0, roles: ['execute'] },
  ])
})

it('never counts proposed or failed-before-header routes as actual calls', () => {
  expect(summarizeModelCalls(run([
    request({ actualModel: undefined, status: 'proposed', usage: undefined }),
    request({ actualModel: undefined, status: 'settled', failureKind: 'network', usage: undefined }),
  ]))).toEqual([])
})

it('uses actual identity and keeps ambiguous slash-separated routes distinct', () => {
  const result = summarizeModelCalls(run([
    request({ actualModel: { provider: 'a/b', model: 'c' } }),
    request({ actualModel: { provider: 'a', model: 'b/c' } }),
  ]))
  expect(result).toHaveLength(2)
  expect(result.every(item => item.calls === 1)).toBe(true)
})

it('does not silently count invalid or missing usage as known zero', () => {
  const result = summarizeModelCalls(run([
    request({ usage: undefined }),
    request({ usage: { inputTokens: 2, outputTokens: 3, totalTokens: 1 } }),
  ]))
  expect(result[0]).toMatchObject({ reported: 0, unknownUsage: 2, calls: 2 })
})
