import { z } from 'zod'
const text = z.string().trim().min(1).max(2000)
export const reportInputSchema = z.object({
  summary: text, changes: z.array(text).max(32), remaining: z.array(text).max(20),
  acceptance: z.array(z.object({ id: z.string().regex(/^A[1-9]\d*$/), condition: text,
    status: z.enum(['passed', 'failed', 'unverified']), method: z.enum(['tool', 'reasoning']),
    evidence: z.array(z.string().min(1).max(512)).max(20), explanation: text,
  }).strict()).min(1).max(20),
}).strict()
const report = reportInputSchema.extend({ reviewedBy: z.string(), time: z.number(), workspaceHash: z.string().optional() }).strict()
export const workTypeSchema = z.enum(['answer', 'small_change', 'research', 'implementation', 'diagnosis', 'analysis'])
const decision = z.object({ strategy: z.enum(['direct', 'delegate']), reason: text, time: z.number(), workType: workTypeSchema.optional(), turn: z.number().int().optional(), taskOffset: z.number().int().nonnegative().optional() }).strict()
const model = z.object({ provider: z.string(), model: z.string() }).strict()
export const controlSchema = z.object({ revision: z.number().int().nonnegative(), mode: z.enum(['auto', 'fixed', 'off']),
  fixedModel: model.optional(), activeRunId: z.string().optional(), operationId: z.string().optional() }).strict()
const reason = z.enum(['role_default', 'complexity_direct', 'capability_upgrade', 'manual_fixed', 'service_fallback', 'phase_planning', 'phase_executing'])
const failure = z.enum(['capability', 'environment', 'permission', 'network', 'context', 'cancelled', 'protocol', 'unknown'])
const status = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'])
export const reviewSchema = z.object({ acceptanceId: z.string().min(1).max(64), category: failure, baseline: z.string().min(1).max(128), action: z.string().min(1).max(128), verification: z.string().min(1).max(128), explanation: z.string().min(1).max(2000) }).strict()
const evidence = z.object({ id: z.string(), executionId: z.string(), sessionId: z.string(), callId: z.string(), tool: z.string(), order: z.number().int(), model, actionHash: z.string(), outcomeHash: z.string(), failed: z.boolean(), failureCode: z.string().optional(), time: z.number().optional() }).strict()
const execution = z.object({ id: z.string(), tier: z.enum(['light', 'normal', 'strong']), reason, status, selectedModel: model, actualModel: model.optional(), childSessionId: z.string().optional(), result: z.string().optional(), workspaceHash: z.string().optional(), handoff: z.string().optional(), overridden: z.boolean().optional(), report: report.optional() }).strict()
const routing = z.object({ autoUpgrade: z.boolean(), repairFailuresBeforeUpgrade: z.number().int().min(1).max(3), maxEscalations: z.number().int().min(0).max(2), phaseSwitch: z.boolean(), fallbacks: z.object({ light: z.array(model).max(2), normal: z.array(model).max(2), strong: z.array(model).max(2) }) })
export const priceSchema = z.object({ provider: z.string().min(1).max(512), model: z.string().min(1).max(512), currency: z.string().regex(/^[A-Z]{3}$/), input: z.number().finite().nonnegative(), output: z.number().finite().nonnegative(), cacheRead: z.number().finite().nonnegative().optional(), cacheWrite: z.number().finite().nonnegative().optional(), source: z.string().max(2048).url().regex(/^https?:/), version: z.string().min(1).max(200), updatedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive() }).strict().refine(p => p.expiresAt > p.updatedAt, 'Price expiration must follow its update')
const config = z.object({ enabled: z.boolean(), models: z.object({ light: model, normal: model, strong: model }),
  limits: z.object({ maxConcurrentChildren: z.number().int().min(1).max(4), maxChildExecutions: z.number().int().min(0).max(100), maxRequests: z.number().int().min(0).max(1000), maxAdditionalDepth: z.literal(1) }),
  budget: z.object({ tokenLimitEnabled: z.boolean(), maxTotalTokens: z.number().int().min(1).max(10000000) }).default({ tokenLimitEnabled: false, maxTotalTokens: 200000 }),
  prices: z.array(priceSchema).max(100).default([]),
  routing: routing.default({ autoUpgrade: false, repairFailuresBeforeUpgrade: 2, maxEscalations: 2, phaseSwitch: false, fallbacks: { light: [], normal: [], strong: [] } }),
  retry: z.object({ maxRetries: z.number().int().min(0).max(3) }), storage: z.object({ maxRunRecordBytes: z.number().int().min(65536).max(16777216) }) })
const task = z.object({ id: z.string(), executionId: z.string(), role: z.enum(['search', 'execute', 'expert']), title: z.string(), objective: z.string(),
  scope: z.array(z.string()), acceptance: z.array(z.string()), constraints: z.array(z.string()), context: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']), childSessionId: z.string().optional(), selectedModel: model, result: z.string().optional(), reviewDecision: z.enum(['manual_override', 'insufficient_evidence', 'upgrade_limit', 'workspace_changed', 'handoff_limit', 'uncertain_side_effect']).optional(), tier: z.enum(['light', 'normal', 'strong']).optional(), escalations: z.number().int().min(0).max(2).optional(), executions: z.array(execution).optional(), evidence: z.array(evidence).optional(), reviews: z.array(reviewSchema).optional(), reason: text.optional(), report: report.optional(), freshness: z.enum(['current', 'stale', 'unverifiable']).optional() }).strict()
const usageSchema = z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), totalTokens: z.number().nonnegative().optional(), cacheReadTokens: z.number().nonnegative().optional(), cacheWriteTokens: z.number().nonnegative().optional(), reasoningTokens: z.number().nonnegative().optional() })
const requestSchema = z.object({ id: z.string(), executionId: z.string(), sessionId: z.string(), turn: z.number().int(), step: z.number().int(), selectedModel: model, actualModel: model.optional(), policyRevision: z.number().int(), status: z.enum(['proposed', 'applied', 'settled']), time: z.number(), reason: reason.optional(), failureKind: failure.optional(), failureCode: z.string().optional(), purpose: z.literal('compaction').optional(), attemptId: z.string().optional(), streamSettled: z.boolean().optional(), reservedTokens: z.number().int().nonnegative().optional(), usageState: z.enum(['reported', 'unknown']).optional(), settledAt: z.number().optional(), price: priceSchema.optional(), usage: usageSchema.optional() })
export const runSchema = z.object({ id: z.string(), sessionId: z.string(), workspaceId: z.string(), revision: z.number().int(), createdAt: z.number(),
  status: z.enum(['running', 'pausing', 'paused', 'cancelled', 'interrupted', 'completed']), config, additions: z.array(z.object({ operationId: z.string(), time: z.number(), requests: z.number().int().nonnegative(), tokens: z.number().int().nonnegative() })).optional(), originalModel: model, blockedReason: z.string().optional(), policyRevision: z.number().int(), tasks: z.array(task), requests: z.array(requestSchema), decision: decision.optional(), report: report.optional(), evidence: z.array(evidence).optional(), childExecutions: z.number().int().nonnegative() })

export const snapshotSchema = z.object({ control: controlSchema, run: runSchema.optional(), enabled: z.boolean(), phaseAvailable: z.boolean().optional(), requiresRestoreSelection: z.boolean().optional() }).strict()

export const runQuerySchema = z.object({ sessionId: z.string().min(1).max(512), cursor: z.string().max(2000).optional(), status: z.enum(['running', 'pausing', 'paused', 'cancelled', 'interrupted', 'completed']).optional(), role: z.enum(['main', 'search', 'execute', 'expert']).optional(), model: z.string().max(512).optional(), runId: z.string().max(512).optional() }).strict()
export const runPageSchema = z.object({ runs: z.array(runSchema).max(10), nextCursor: z.string().optional() }).strict()
