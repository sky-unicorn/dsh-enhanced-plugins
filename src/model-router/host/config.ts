import Schema from '@deepseek-ai/schemastery'
import type { RouterConfig } from '../shared.js'
const model = Schema.object({ provider: Schema.string().default(''), model: Schema.string().default('') })
/** Host-owned defaults; no vendor credentials or model guesses are stored here. */
export const Config: Schema<RouterConfig> = Schema.object({
  enabled: Schema.boolean().default(false),
  models: Schema.object({ light: model, normal: model, strong: model }),
  limits: Schema.object({
    maxConcurrentChildren: Schema.natural().min(1).max(4).default(2),
    // Retired cumulative limits: zero in new snapshots; old values remain readable.
    maxChildExecutions: Schema.natural().max(100).default(0),
    maxRequests: Schema.natural().max(1000).default(0),
    maxAdditionalDepth: Schema.const(1).default(1),
  }),
  // Compatibility-only fields for existing settings; no routing or pricing behavior.
  budget: Schema.object({ tokenLimitEnabled: Schema.boolean().default(false), maxTotalTokens: Schema.natural().min(1).max(10000000).default(200000) }),
  prices: Schema.array(Schema.object({ provider: Schema.string().required(), model: Schema.string().required(), currency: Schema.string().required(),
    input: Schema.number().min(0).required(), output: Schema.number().min(0).required(), cacheRead: Schema.number().min(0), cacheWrite: Schema.number().min(0),
    source: Schema.string().required(), version: Schema.string().required(), updatedAt: Schema.natural().required(), expiresAt: Schema.natural().required(),
  })).max(100).default([]),
  retry: Schema.object({ maxRetries: Schema.natural().max(3).default(2) }),
  routing: Schema.object({
    autoUpgrade: Schema.boolean().default(true),
    repairFailuresBeforeUpgrade: Schema.natural().min(1).max(3).default(2),
    maxEscalations: Schema.natural().max(2).default(2),
    phaseSwitch: Schema.boolean().default(false),
    // Compatibility only: existing profiles remain readable; routing ignores these references.
    fallbacks: Schema.object({ light: Schema.array(model).max(2).default([]), normal: Schema.array(model).max(2).default([]), strong: Schema.array(model).max(2).default([]) }),
  }),
  storage: Schema.object({ maxRunRecordBytes: Schema.natural().min(65536).max(16777216).default(2097152) }),
})
