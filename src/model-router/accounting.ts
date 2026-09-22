import type { RequestRecord, RunRecord } from './shared.js'

/** Only an authoritative full-call total permits releasing a reservation. DSH
 * cache buckets are disjoint; reasoning is already part of output. */
export function reportedTotal(request: RequestRecord): number | undefined {
  const u = request.usage
  if (!u || !Object.values(u).every(n => Number.isSafeInteger(n) && n >= 0)) return
  const parts = u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
  if (u.totalTokens === undefined || u.totalTokens < parts || (u.reasoningTokens ?? 0) > u.outputTokens) return
  return u.totalTokens
}

/** Derived from immutable attempts, never incremented on duplicate events. */
export function ledger(run: RunRecord) {
  let reported = 0, reserved = 0, uncertain = 0, unknownRequests = 0, unboundedRequests = 0
  for (const r of run.requests) {
    const total = reportedTotal(r)
    if (total === undefined && r.reservedTokens === undefined) unboundedRequests++
    if (total !== undefined) reported += total
    else if (r.status !== 'settled') reserved += r.reservedTokens ?? 0
    else { uncertain += r.reservedTokens ?? 0; unknownRequests++ }
  }
  return { reported, reserved, uncertain, unknownRequests, unboundedRequests, occupied: reported + reserved + uncertain }
}
