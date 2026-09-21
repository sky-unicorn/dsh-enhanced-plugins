import { expect, it } from 'vitest'
import { fingerprint, nextTier, thresholdReached, verifiedReviews, permitsTransientRetry } from '../../src/model-router/host/policy.ts'
import { Config } from '../../src/model-router/host/config.ts'
import { runSchema } from '../../src/model-router/schema.ts'
import type { ChildTask, Evidence, RepairReview } from '../../src/model-router/shared.ts'

const config = Config({ models: { light: { provider: 'p', model: 'small' }, normal: { provider: 'p', model: 'medium' }, strong: { provider: 'p', model: 'large' } } })
function fixture() {
  const evidence: Evidence[] = [0, 1, 2, 3, 4].map(order => ({ id: `e${order}`, order, executionId: 'x', sessionId: 's', callId: `c${order}`, tool: order % 2 ? 'write' : 'bash', model: config.models.normal, actionHash: order % 2 ? `patch${order}` : 'test', outcomeHash: 'result', failed: false }))
  const task: ChildTask = { id: 't', executionId: 'x', role: 'execute', title: 'task', objective: 'objective', scope: ['file'], constraints: ['rule'], context: '', acceptance: ['one', 'two'], status: 'completed', selectedModel: config.models.normal, tier: 'normal', evidence, reviews: [] }
  const reviews: RepairReview[] = [1, 3].map(n => ({ acceptanceId: 'A1', category: 'capability', baseline: 'e0', action: `e${n}`, verification: `e${n + 1}`, explanation: 'Actual repair still fails task-owned assertion' }))
  return { task, reviews }
}
it('counts two distinct repairs for the same acceptance, deduplicates replay and refuses test-only attempts', () => {
  const { task, reviews } = fixture()
  task.reviews = verifiedReviews(task, reviews)
  expect(thresholdReached(task, config)).toBe(true)
  expect(verifiedReviews(task, reviews)).toHaveLength(2)
  expect(() => verifiedReviews({ ...task, reviews: [] }, [{ ...reviews[0]!, action: 'e2', verification: 'e4' }])).toThrow('actual edit')
})
it('does not combine unrelated acceptance failures or identical repair patches', () => {
  const { task, reviews } = fixture()
  task.reviews = verifiedReviews(task, [reviews[0]!, { ...reviews[1]!, acceptanceId: 'A2' }])
  expect(thresholdReached(task, config)).toBe(false)
  task.evidence![3]!.actionHash = task.evidence![1]!.actionHash
  expect(verifiedReviews({ ...task, reviews: [] }, reviews)).toHaveLength(1)
})
it('rejects foreign, failed, out-of-order and unknown-acceptance evidence', () => {
  const { task, reviews } = fixture()
  expect(() => verifiedReviews(task, [{ ...reviews[0]!, baseline: 'foreign' }])).toThrow('belong')
  expect(() => verifiedReviews(task, [{ ...reviews[0]!, baseline: 'e4' }])).toThrow('order')
  expect(() => verifiedReviews(task, [{ ...reviews[0]!, acceptanceId: 'A3' }])).toThrow('identity')
  task.evidence![2]!.failed = true
  expect(() => verifiedReviews(task, reviews)).toThrow('Failed dispatch')
})
it('skips duplicate effective models and respects the maximum without downgrading', () => {
  const { task } = fixture()
  expect(nextTier(task, config)).toBe('strong')
  expect(nextTier({ ...task, escalations: 2 }, config)).toBeUndefined()
  expect(nextTier({ ...task, tier: 'strong' }, config)).toBeUndefined()
  const same = structuredClone(config); same.models.strong = same.models.normal
  expect(nextTier(task, same)).toBeUndefined()
  same.models.normal = same.models.light
  expect(nextTier({ ...task, tier: 'light', selectedModel: same.models.light }, same)).toBe('strong')
})
it('canonicalizes argument fingerprints and admits only transient same-model retries', () => {
  expect(fingerprint({ x: 1, y: 2 })).toBe(fingerprint({ y: 2, x: 1 }))
  for (const code of ['AUTH', 'RATE_LIMIT', 'PERMISSION_DENIED', 'ABORTED', 'CONTEXT_WINDOW_EXCEEDED', 'UNKNOWN']) expect(permitsTransientRetry({ code, message: '' })).toBe(false)
  expect(permitsTransientRetry({ code: 'SERVER', status: 503, message: '' })).toBe(true)
  expect(permitsTransientRetry({ code: 'SERVER', status: 429, message: '' })).toBe(false)
})
it('reads V1 policy snapshots conservatively without retroactively enabling V2 routing', () => {
  const { routing: _routing, ...oldConfig } = config
  const old = { id: 'old', sessionId: 's', workspaceId: 'w', revision: 0, createdAt: 1, status: 'completed', config: oldConfig, originalModel: config.models.normal, policyRevision: 0, tasks: [], requests: [], childExecutions: 0 }
  expect(runSchema.parse(old).config.routing.autoUpgrade).toBe(false)
})
