import { createHash } from 'node:crypto'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import { TIERS, roleTier, type ChildTask, type FailureKind, type ModelRef, type RepairReview, type RouterConfig, type Tier } from '../shared.js'

export const sameModel = (a: ModelRef, b: ModelRef): boolean => a.provider === b.provider && a.model === b.model
/** Canonical fingerprints deduplicate arguments independent of JSON object key order. */
export function fingerprint(value: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normalize(x)])) : v
  return createHash('sha256').update(JSON.stringify(normalize(value)) ?? 'undefined').digest('hex')
}
/** Only machine-readable failure facts participate in routing. Unknown fails closed. */
export function classifyFailure(failure: Pick<LlmFailure, 'code' | 'status'>): FailureKind {
  if ([401, 402, 403].includes(failure.status ?? 0) || ['AUTH', 'INVALID_CREDENTIAL', 'PERMISSION_DENIED', 'APPROVAL_DENIED', 'BILLING'].includes(failure.code)) return 'permission'
  if (failure.status === 429 || failure.code === 'RATE_LIMIT') return 'network'
  if (['ABORTED', 'CANCELLED', 'ABORT_ERR'].includes(failure.code)) return 'cancelled'
  if (['CONTEXT_WINDOW_EXCEEDED', 'IMAGE_OFFLOAD_REQUIRED'].includes(failure.code)) return 'context'
  if (['ENOENT', 'DEPENDENCY_MISSING'].includes(failure.code)) return 'environment'
  if (['INVALID_TOOL_INPUT', 'INVALID_TOOL_OUTPUT', 'UNKNOWN_TOOL', 'VALIDATION_ERROR'].includes(failure.code)) return 'protocol'
  if (['SERVER', 'TIMEOUT', 'TRANSPORT', 'NETWORK', 'ECONNRESET', 'ETIMEDOUT'].includes(failure.code) || [500, 502, 503, 504].includes(failure.status ?? 0)) return 'network'
  return 'unknown'
}
export function permitsTransientRetry(failure: LlmFailure): boolean {
  return classifyFailure(failure) === 'network' && failure.status !== 429 && failure.code !== 'RATE_LIMIT'
}
export function nextTier(task: ChildTask, config: RouterConfig): Tier | undefined {
  if (!config.routing.autoUpgrade || (task.escalations ?? 0) >= config.routing.maxEscalations) return
  const tier = task.tier ?? roleTier[task.role]
  return TIERS.slice(TIERS.indexOf(tier) + 1).find(candidate => !sameModel(config.models[candidate], task.selectedModel))
}
/** The main assistant supplies semantic acceptance; Host checks provenance, order and distinct actions. */
export function verifiedReviews(task: ChildTask, supplied: RepairReview[]): RepairReview[] {
  const evidence = task.evidence ?? []
  const accepted = [...(task.reviews ?? [])]
  for (const review of supplied) {
    if (!/^A[1-9]\d*$/.test(review.acceptanceId) || Number(review.acceptanceId.slice(1)) > task.acceptance.length) throw new Error('Unknown acceptance identity.')
    if (accepted.some(r => r.verification === review.verification)) continue
    const baseline = evidence.find(e => e.id === review.baseline)
    const action = evidence.find(e => e.id === review.action)
    const verification = evidence.find(e => e.id === review.verification)
    if (!baseline || !action || !verification || [baseline, action, verification].some(e => e.executionId !== task.executionId)) throw new Error('Evidence must belong to this task execution.')
    if (!(baseline.order < action.order && action.order < verification.order)) throw new Error('Repair evidence is out of order.')
    if ([baseline, action, verification].some(e => !sameModel(e.model, task.selectedModel))) throw new Error('Repairs from different effective models cannot be combined.')
    if (review.category !== 'capability') { accepted.push(review); continue }
    // Failed tool dispatches cannot prove a valid acceptance test. A nonzero test
    // exit inside a successful bash result can, after the main assistant reviews it.
    if (baseline.failed || action.failed || verification.failed || [baseline, action, verification].some(e => e.failureCode)) throw new Error('Failed dispatch is not capability evidence.')
    if (!['edit', 'write', 'read', 'grep', 'glob'].includes(action.tool)) throw new Error('A repair needs an actual edit or a distinct diagnostic action, not a repeated test command.')
    if (action.actionHash === baseline.actionHash || action.actionHash === verification.actionHash) throw new Error('Repeated verification is not a repair.')
    if (accepted.some(r => evidence.find(e => e.id === r.action)?.actionHash === action.actionHash)) continue
    accepted.push(review)
  }
  return accepted
}
export function thresholdReached(task: ChildTask, config: RouterConfig): boolean {
  return task.acceptance.some((_, index) => (task.reviews ?? []).filter(r => r.category === 'capability' && r.acceptanceId === `A${index + 1}` && task.evidence?.some(e => e.id === r.action && e.executionId === task.executionId && sameModel(e.model, task.selectedModel))).length >= config.routing.repairFailuresBeforeUpgrade)
}
