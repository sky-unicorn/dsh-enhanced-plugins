import { expect, it } from 'vitest'
import { childPolicy, missingDivision, requiredRoles, taskPacket, validateReport } from '../../src/model-router/host/workflow.ts'
import { taskActionSchema } from '../../src/model-router/host/workflow.ts'
import type { ChildTask, Evidence, RunRecord } from '../../src/model-router/shared.ts'

const fact: Evidence = { id: 'evidence-1', callId: 'read-1', executionId: 'execution', sessionId: 'child', tool: 'read', order: 0, model: { provider: 'fixture', model: 'normal' }, failed: false, actionHash: 'a', outcomeHash: 'b' }
const report = { summary: 'Verified the requested condition', changes: [], remaining: [], acceptance: [{ id: 'A1', condition: 'Report evidence', status: 'passed' as const, method: 'tool' as const, evidence: ['read-1'], explanation: 'The actual read returned the expected content.' }] }

it('resolves actual call IDs and refuses invented, failed or cross-execution evidence', () => {
  expect(validateReport(report, [fact], ['Report evidence'], 'execution').acceptance[0]!.evidence).toEqual(['evidence-1'])
  expect(() => validateReport(report, [], ['Report evidence'])).toThrow('Evidence')
  expect(() => validateReport(report, [{ ...fact, failed: true }])).toThrow('successful')
  expect(() => validateReport(report, [fact], ['Report evidence'], 'other')).toThrow('another execution')
  expect(() => validateReport(report, [fact, { ...fact, id: 'another-id' }])).toThrow('ambiguous')
})

it('requires every original acceptance and distinguishes reasoning from unexecuted tests', () => {
  expect(() => validateReport(report, [fact], ['Report evidence', 'Preserve the file'])).toThrow('every original')
  expect(() => validateReport({ ...report, acceptance: [...report.acceptance, ...report.acceptance] }, [fact])).toThrow('Duplicate')
  expect(() => validateReport({ ...report, remaining: ['Required work unfinished'] }, [fact])).toThrow('Remaining')
  const missing = { ...report, acceptance: [{ ...report.acceptance[0]!, evidence: [] }] }
  expect(() => validateReport(missing, [fact])).toThrow('requires actual')
  expect(validateReport({ ...missing, acceptance: [{ ...missing.acceptance[0]!, status: 'unverified' }] }, []).acceptance[0]!.status).toBe('unverified')
  expect(validateReport({ ...missing, acceptance: [{ ...missing.acceptance[0]!, method: 'reasoning' }] }, []).acceptance[0]!.method).toBe('reasoning')
})

it('compacts execution history into inspectable references without trimming required context', () => {
  const task: ChildTask = { id: 'task', executionId: 'second', role: 'execute', title: 'Fix the boundary', objective: 'Keep the public API', scope: ['src'], acceptance: ['Report evidence'], constraints: ['Preserve existing user edits'], context: 'Necessary context {{literal}}', selectedModel: fact.model, status: 'completed',
    executions: [{ id: 'first', tier: 'normal', reason: 'role_default', status: 'completed', selectedModel: fact.model, childSessionId: 'child-1', result: 'Repeated optional history\n'.repeat(5000) }] }
  const packet = JSON.parse(taskPacket(task, 'A1 remains', 'Recorded summary of optional context'))
  expect(packet.constraints).toEqual(task.constraints)
  expect(packet.objective).toBe(task.objective)
  expect(packet.acceptance[0]).toEqual({ id: 'A1', condition: task.acceptance[0] })
  expect(packet.previousExecutions[0]).toMatchObject({ executionId: 'first', sessionId: 'child-1' })
  expect(packet.contextSummarized).toBe(true)
  expect(task.context).toBe('Necessary context {{literal}}')
  expect(task.executions![0]!.result!.length).toBeGreaterThan(48000)
  expect(() => taskPacket({ ...task, constraints: ['required '.repeat(10000)] })).toThrow('CONTEXT_TOO_LARGE')
})

it('rejects unsupported task controls and unbounded acceptance payloads', () => {
  expect(taskActionSchema.safeParse({ action: 'decision', strategy: 'strong', reason: 'Guess model from name' }).success).toBe(false)
  expect(taskActionSchema.parse({ action: 'decision', strategy: 'delegate', workType: 'implementation', reason: 'Use the executor.', taskId: 'descriptor-only' })).toEqual({ action: 'decision', strategy: 'delegate', workType: 'implementation', reason: 'Use the executor.' })
  expect(taskActionSchema.safeParse({ action: 'inspect', taskId: 't', executionId: 'old-execution' }).success).toBe(true)
  expect(taskActionSchema.safeParse({ action: 'report', report: { ...report, arbitraryPermission: true } }).success).toBe(false)
})

it('maps declared work types to the managed role that must execute them', () => {
  expect(requiredRoles('answer')).toEqual([])
  expect(requiredRoles('small_change')).toEqual([])
  expect(requiredRoles('research')).toEqual(['search'])
  expect(requiredRoles('implementation')).toEqual(['execute'])
  expect(requiredRoles('diagnosis')).toEqual(['expert'])
  expect(requiredRoles('analysis')).toEqual(['expert'])
})

it('tells managed children to execute immediately and never repeat the main decision', () => {
  const policy = childPolicy('execute')
  expect(policy).toContain('Do not call model_router_task action decision')
  expect(policy).toContain('Start the assigned work immediately')
  expect(policy).toContain('inspect (your own task) or the final report')
})

it('does not treat a failed child execution as permission for the main mutation', () => {
  const run = { decision: { strategy: 'delegate', workType: 'implementation', reason: 'Needs implementation.', time: 1, taskOffset: 0 }, tasks: [{ role: 'execute', childSessionId: 'child', status: 'failed' }] } as unknown as RunRecord
  expect(missingDivision(run)).toContain('old or failed tasks')
})
