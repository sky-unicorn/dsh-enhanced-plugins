import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import type { ChildSessionStatus, MonitorCatalog, MonitorChildSession, MonitorSnapshot } from '../shared.js'
import { describeTeam, type MonitorReads } from './snapshot.js'
import { describeExecution } from './execution.js'
import { describeCooperation, type CooperationLog } from './cooperation.js'

/** Native discovery owns classification and ancestry; the monitor never scans arbitrary directories. */
export interface CatalogReads extends MonitorReads {
  descendants(id: SessionId, signal: AbortSignal): Promise<readonly SubagentDescendantListEntry[] | undefined>
}

const LIMIT = 256
const CONCURRENCY = 4

/** Only public turn boundaries determine a recorded outcome; unrecognized reasons stay unknown. */
function recordedStatus(events: readonly SessionEvent[], resident: boolean): ChildSessionStatus {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type === 'turn/start') return resident ? 'running' : 'inactive'
    if (event.type !== 'turn/end') continue
    switch (event.data.reason.kind) {
      case 'completed': return 'completed'
      case 'error': return 'failed'
      case 'aborted': return 'cancelled'
      case 'interrupted': return 'interrupted'
      case 'blocked': return 'blocked'
      case 'max-tokens': return 'limited'
      default: return 'unknown' // Core reason map is merge-extensible.
    }
  }
  return 'inactive'
}

/** Latest own title only: no prompt/body inspection, no inherited parent title. */
function ownTitle(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (String(event.type) !== 'session/title') continue
    const data: unknown = event.data
    if (data === null || typeof data !== 'object' || !('title' in data) || typeof data.title !== 'string') {
      throw new TypeError('Invalid child session title')
    }
    return data.title
  }
  return undefined
}

/** Bounded, cancellable reads; a broken child becomes one diagnostic, never a broken whole Team. */
export async function describeCatalog(reads: CatalogReads, scopeId: SessionId, signal: AbortSignal): Promise<MonitorCatalog | undefined> {
  signal.throwIfAborted()
  let entries: readonly SubagentDescendantListEntry[] | undefined
  try { entries = await reads.descendants(scopeId, signal) } catch {
    signal.throwIfAborted()
    return { scopeId, state: 'unavailable', sessions: [], total: 0, truncated: false }
  }
  signal.throwIfAborted()
  if (entries === undefined) return undefined
  // Active Agents take precedence over bounded historical rows. The native
  // catalog orders siblings oldest-first, so prefer the newer suffix next.
  const selected = [...entries].reverse().sort((a, b) => Number(reads.agent(b.id)?.status === 'running') - Number(reads.agent(a.id)?.status === 'running')).slice(0, LIMIT)
  const sessions: MonitorChildSession[] = Array.from({ length: selected.length })
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, async () => {
    while (cursor < selected.length) {
      signal.throwIfAborted()
      const index = cursor++
      const entry = selected[index]!
      const row: MonitorChildSession = { id: entry.id, parentId: entry.parentId, depth: entry.depth, status: 'unknown', navigable: false }
      sessions[index] = row
      if (entry.kind === 'diagnostic') { row.diagnostic = entry.reason; continue }
      row.mode = entry.mode
      if (entry.label !== undefined) row.label = entry.label
      try {
        const inspected = await reads.inspect(entry.id, signal)
        signal.throwIfAborted()
        if (inspected === undefined) { row.diagnostic = 'unavailable'; continue }
        if (inspected.meta.id !== entry.id || inspected.meta.origin !== 'subagent' || inspected.meta.parentSession !== entry.parentId) {
          row.diagnostic = 'corrupt'; continue
        }
        const own = inspected.events.slice(inspected.inheritedEventCount)
        const title = ownTitle(own)
        if (title !== undefined) row.title = title
        row.createdAt = inspected.meta.createdAt
        row.updatedAt = own.at(-1)?.time ?? row.createdAt
        // Exact Agent status takes precedence. Without one, an open own turn
        // in a resident Session can represent an external provider's execution;
        // residency alone never proves running, and cold outcomes come from logs.
        const live = reads.agent(entry.id)
        row.status = live?.status ?? recordedStatus(own, entry.activity === 'running')
        row.execution = describeExecution(inspected.events, inspected.inheritedEventCount, live === undefined ? entry.activity === 'running' : live.status === 'running')
        row.navigable = true
      } catch {
        signal.throwIfAborted()
        row.diagnostic = 'unavailable'
      }
    }
  }))
  signal.throwIfAborted()
  sessions.sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.id.localeCompare(b.id))
  return { scopeId, state: 'ready', sessions, total: entries.length, truncated: entries.length > LIMIT }
}

/** One selected conversation's Team/workflow view plus its native child-session catalog. */
export async function describeMonitor(reads: CatalogReads, sessionId: SessionId, signal: AbortSignal): Promise<MonitorSnapshot> {
  // A request-local cache shares the same observation between Team, catalog and
  // execution readers, without retaining sessions or payloads across requests.
  const cache = new Map<SessionId, ReturnType<MonitorReads['inspect']>>()
  const source = reads
  reads = { ...source, inspect: (id, abort) => {
    let read = cache.get(id)
    if (!read) { read = source.inspect(id, abort); cache.set(id, read) }
    return read
  } }
  let snapshot = await describeTeam(reads, sessionId, signal)
  if (snapshot.kind === 'unavailable' && snapshot.reason === 'no-session') return snapshot
  const scopeId = (snapshot.kind === 'team' ? snapshot.teamId : sessionId) as SessionId
  const catalog = await describeCatalog(reads, scopeId, signal)
  try {
    const root = await reads.inspect(scopeId, signal)
    if (root) snapshot = { ...snapshot, execution: describeExecution(root.events, root.inheritedEventCount, reads.agent(scopeId)?.status === 'running') }
  } catch { signal.throwIfAborted() }
  const allowedIds = new Set([scopeId, ...(catalog?.sessions.filter(row => row.navigable).map(row => row.id) ?? [])])
  const logs: CooperationLog[] = []
  for (const [id, pending] of cache) {
    if (!allowedIds.has(id)) continue
    try {
      const inspected = await pending
      if (inspected && inspected.meta.id === id) logs.push({ sessionId: id, events: inspected.events, inherited: inspected.inheritedEventCount })
    } catch { signal.throwIfAborted() }
  }
  snapshot = { ...snapshot, cooperation: describeCooperation(logs, allowedIds) }
  if (snapshot.kind === 'unavailable' && snapshot.reason === 'not-team' && ((catalog?.sessions.length ?? 0) > 0 || (snapshot.execution?.total ?? 0) > 0)) {
    return { ...snapshot, kind: 'agents', catalog,
      source: reads.agent(sessionId) === undefined ? 'persisted' : 'live' }
  }
  return { ...snapshot, catalog }
}
