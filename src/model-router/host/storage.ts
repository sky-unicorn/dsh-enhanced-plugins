import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { RunRecord, SessionControl } from '../shared.js'
import { controlSchema, runSchema } from '../schema.js'
import { z } from 'zod'
/** One aggregate is the transaction boundary for request and delegation admission. */
export const legacyDomainSpec = defineDomain({ name: 'enhanced_model_router', version: 1, tables: {
  'session_controls': domainTable<string, SessionControl>(controlSchema), runs: domainTable<string, RunRecord>(runSchema),
} })
/** Isolated V2 format: V1 cannot silently strip V2 execution/evidence history. */
export const v2DomainSpec = defineDomain({ name: 'enhanced_model_router_v2', version: 2,
  global: { schema: z.object({ migrated: z.boolean() }).strict(), initial: { migrated: false } },
  tables: legacyDomainSpec.tables,
})

/** V3 keeps older plugin versions from silently overwriting reservations. */
export const v3DomainSpec = defineDomain({ name: 'enhanced_model_router_v3', version: 3,
  global: { schema: z.object({ migrated: z.boolean() }).strict(), initial: { migrated: false } }, tables: legacyDomainSpec.tables,
})

/** UI selection intent is separate from V3 run accounting and cannot rewrite it. */
export const selectionDomainSpec = defineDomain({ name: 'enhanced_model_router_selection', version: 1, tables: {
  sessions: domainTable<string, { baseline: { provider: string; model: string; reasoningEffort?: string } }>(z.object({ baseline: z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional() }).strict() }).strict()),
} })

/** Isolate richer acceptance records from older writers; import V3 without modifying it. */
export const v4DomainSpec = defineDomain({ name: 'enhanced_model_router_v4', version: 4,
  global: { schema: z.object({ migrated: z.boolean() }).strict(), initial: { migrated: false } }, tables: legacyDomainSpec.tables,
})

/** Decisions now carry enforced workflow identity; older writers retain their own history. */
export const domainSpec = defineDomain({ name: 'enhanced_model_router_v5', version: 5,
  global: { schema: z.object({ migrated: z.boolean() }).strict(), initial: { migrated: false } }, tables: legacyDomainSpec.tables,
})
