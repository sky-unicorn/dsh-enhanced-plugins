/** Public collaboration vocabulary. Model identities always include their provider route. */
export const NAMESPACE = 'enhanced-model-router'
export const DELEGATE_TOOL = 'model_router_delegate_task'
export const REVIEW_TOOL = 'model_router_review_task'
export const TASK_TOOL = 'model_router_task'
export const TIERS = ['light', 'normal', 'strong'] as const
export type Tier = typeof TIERS[number]
export type Role = 'search' | 'execute' | 'expert'
export interface ModelRef { provider: string; model: string }
/** Empty provider or model IDs make a role unconfigured; catalog outages do not erase it. */
export function missingModelTiers(models?: Record<Tier, ModelRef>): Tier[] {
  return TIERS.filter(tier => !models?.[tier].provider.trim() || !models[tier].model.trim())
}
export interface RouterConfig {
  enabled: boolean
  models: Record<Tier, ModelRef>
  /** Cumulative maxRequests/maxChildExecutions are deprecated and ignored; zero in new runs. */
  limits: { maxConcurrentChildren: number; maxChildExecutions: number; maxRequests: number; maxAdditionalDepth: 1 }
  /** @deprecated Retained for stored settings/history compatibility; ignored by routing. */
  budget: { tokenLimitEnabled: boolean; maxTotalTokens: number }
  /** @deprecated Legacy price data; new calls do not snapshot or calculate prices. */
  prices: PriceRecord[]
  retry: { maxRetries: number }
  storage: { maxRunRecordBytes: number }
  routing: {
    autoUpgrade: boolean; repairFailuresBeforeUpgrade: number; maxEscalations: number; phaseSwitch: boolean
    /** @deprecated Retained for saved configuration/history; never used for model selection. */
    fallbacks: Record<Tier, ModelRef[]>
  }
}
/** Explicit, versioned prices per million disjoint DSH tokens. No currency conversion. */
export interface PriceRecord extends ModelRef {
  currency: string; input: number; output: number; cacheRead?: number; cacheWrite?: number
  source: string; version: string; updatedAt: number; expiresAt: number
}
export interface BudgetChange { operationId: string; time: number; requests: number; tokens: number }
export type FailureKind = 'capability' | 'environment' | 'permission' | 'network' | 'context' | 'cancelled' | 'protocol' | 'unknown'
export type ReviewDecision = 'manual_override' | 'insufficient_evidence' | 'upgrade_limit' | 'workspace_changed' | 'handoff_limit' | 'uncertain_side_effect'
export type RouteReason = 'role_default' | 'complexity_direct' | 'capability_upgrade' | 'manual_fixed' | 'service_fallback' | 'phase_planning' | 'phase_executing'
/** Host-issued references; raw tool arguments and outputs remain in the child session. */
export interface Evidence {
  id: string; executionId: string; sessionId: string; callId: string; tool: string; order: number
  model: ModelRef; actionHash: string; outcomeHash: string; failed: boolean; failureCode?: string; time?: number
}
export interface RepairReview {
  acceptanceId: string; category: FailureKind; baseline: string; action: string; verification: string; explanation: string
}
export interface ExecutionRecord {
  id: string; tier: Tier; reason: RouteReason; status: ChildTask['status']; selectedModel: ModelRef
  actualModel?: ModelRef; childSessionId?: string; result?: string; workspaceHash?: string
  handoff?: string; overridden?: boolean
  report?: TaskReport
}
export type Mode = 'auto' | 'fixed' | 'off'
export type RunStatus = 'running' | 'pausing' | 'paused' | 'cancelled' | 'interrupted' | 'completed'
export interface SessionControl {
  revision: number; mode: Mode; fixedModel?: ModelRef; activeRunId?: string; operationId?: string
}
export interface ChildTask {
  id: string; executionId: string; role: Role; title: string; objective: string
  scope: string[]; acceptance: string[]; constraints: string[]; context: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  childSessionId?: string; selectedModel: ModelRef; result?: string
  reviewDecision?: ReviewDecision; tier?: Tier; escalations?: number; executions?: ExecutionRecord[]; evidence?: Evidence[]; reviews?: RepairReview[]
  reason?: string; report?: TaskReport; freshness?: 'current' | 'stale' | 'unverifiable'
}
/** Model-authored acceptance, with Host-resolved evidence; execution status stays separate. */
export interface TaskReport {
  summary: string; changes: string[]; remaining: string[]
  acceptance: { id: string; condition: string; status: 'passed' | 'failed' | 'unverified'; method: 'tool' | 'reasoning'; evidence: string[]; explanation: string }[]
  reviewedBy: string; time: number; workspaceHash?: string
}
export type WorkType = 'answer' | 'small_change' | 'research' | 'implementation' | 'diagnosis' | 'analysis'
export interface WorkDecision {
  strategy: 'direct' | 'delegate'; reason: string; time: number
  workType?: WorkType; turn?: number; taskOffset?: number
}
export interface RequestRecord {
  id: string; executionId: string; sessionId: string; turn: number; step: number
  selectedModel: ModelRef; actualModel?: ModelRef; policyRevision: number
  status: 'proposed' | 'applied' | 'settled'; time: number
  reason?: RouteReason; failureKind?: FailureKind; failureCode?: string
  purpose?: 'compaction'
  attemptId?: string; streamSettled?: boolean
  reservedTokens?: number; usageState?: 'reported' | 'unknown'; settledAt?: number; price?: PriceRecord
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }
}
export interface RunRecord {
  id: string; sessionId: string; workspaceId: string; revision: number; createdAt: number
  status: RunStatus; config: RouterConfig; policyRevision: number; originalModel: ModelRef; blockedReason?: string
  additions?: BudgetChange[]
  tasks: ChildTask[]; requests: RequestRecord[]; childExecutions: number
  decision?: WorkDecision; report?: TaskReport; evidence?: Evidence[]
}
export interface RouterSnapshot { control: SessionControl; run?: RunRecord; enabled: boolean; phaseAvailable?: boolean; requiresRestoreSelection?: boolean }
export const roleTier: Record<Role, Tier> = { search: 'light', execute: 'normal', expert: 'strong' }

export interface RunQuery { sessionId: string; cursor?: string; status?: RunStatus; role?: Role | 'main'; model?: string; runId?: string }
export interface RunPage { runs: RunRecord[]; nextCursor?: string }
