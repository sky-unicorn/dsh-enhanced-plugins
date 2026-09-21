import { evaluate } from '../../src/model-router/evaluation.ts'
import { expect, it } from 'vitest'
import { ledger, reportedTotal } from '../../src/model-router/accounting.ts'
import { Config } from '../../src/model-router/host/config.ts'
import { priceSchema } from '../../src/model-router/schema.ts'
import type { RequestRecord, RunRecord, PriceRecord } from '../../src/model-router/shared.ts'
const price: PriceRecord = { provider: 'p', model: 'm', currency: 'USD', input: 2, output: 4, cacheRead: 1, cacheWrite: 3, source: 'https://example.com/pricing', version: 'fixture-only', updatedAt: 1, expiresAt: 100 }
const request = (override: Partial<RequestRecord> = {}): RequestRecord => ({ id: 'r', executionId: 'e', sessionId: 's', turn: 1, step: 1, selectedModel: { provider: 'p', model: 'm' }, policyRevision: 0, status: 'settled', time: 10, reservedTokens: 100, ...override })
const run = (requests: RequestRecord[]): RunRecord => ({ id: 'root', sessionId: 's', workspaceId: 'w', revision: 0, createdAt: 0, status: 'paused', config: Config({}), originalModel: { provider: 'p', model: 'm' }, policyRevision: 0, tasks: [], requests, childExecutions: 0 })

it('counts disjoint DSH cache buckets once and never adds reasoning twice', () => {
  const row = request({ usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, reasoningTokens: 15, totalTokens: 100 }, price })
  expect(reportedTotal(row)).toBe(100)
  expect(ledger(run([row])).reported).toBe(100)
})
it('preserves incomplete, inconsistent and missing usage as unknown occupancy', () => {
  for (const usage of [undefined, { inputTokens: 1, outputTokens: 2 }, { inputTokens: 5, outputTokens: 2, totalTokens: 1 }, { inputTokens: NaN, outputTokens: 2, totalTokens: 3 }, { inputTokens: 1, outputTokens: 2, reasoningTokens: 5, totalTokens: 3 }]) {
    expect(reportedTotal(request({ usage }))).toBeUndefined()
    expect(ledger(run([request({ usage })]))).toMatchObject({ uncertain: 100, reported: 0, unknownRequests: 1 })
  }
})
it('separates outstanding reservations from unknown settlements and allowance history', () => {
  const value = run([request({ status: 'applied' }), request()])
  value.additions = [{ operationId: 'a', time: 1, requests: 2, tokens: 100 }]
  expect(ledger(value)).toMatchObject({ reserved: 100, uncertain: 100, occupied: 200 })
})
it('validates source URLs and quote validity when reading legacy records', () => {
  expect(priceSchema.safeParse({ ...price, source: 'javascript:alert(1)' }).success).toBe(false)
  expect(priceSchema.safeParse({ ...price, expiresAt: 1 }).success).toBe(false)
  expect(priceSchema.safeParse(price).success).toBe(true)
})

it('rejects incomplete or mismatched evaluation groups instead of reporting false comparisons', () => {
  const sample = { task: 't', repetition: 1, inputHash: 'h', workspaceHash: 'w', environment: 'same', elapsedMs: 1, passed: false, evidence: 'checked', run: run([]) }
  const input = { kind: 'deterministic-fixture', pluginRevision: 'p', dshRevision: 'd', samples: ['normal', 'strong', 'auto'].map(group => ({ ...sample, group })) }
  expect(evaluate(input).trials).toBe(1)
  expect(() => evaluate({ ...input, samples: [...input.samples, input.samples[0]] })).toThrow('Duplicate')
  expect(() => evaluate({ ...input, samples: input.samples.map((s, i) => i ? s : { ...s, workspaceHash: 'changed' }) })).toThrow('differ')
})

it('distinguishes an unknown unbounded legacy amount from zero token usage', () => {
  expect(ledger(run([request({ reservedTokens: undefined })]))).toMatchObject({ unknownRequests: 1, unboundedRequests: 1, reported: 0 })
})
