import { expect, it, vi } from 'vitest'
import {
  SessionId, SessionLogOffset, SessionSeq, type SessionEvent, type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describeCatalog, describeMonitor, type CatalogReads } from '../../src/agent-team-monitor/host/catalog.ts'
import { parseSnapshot } from '../../src/agent-team-monitor/client/parse.ts'
import { meta } from './fixtures.ts'

const signal = () => new AbortController().signal
const inspection = (
  header: SessionHeader,
  events: readonly SessionEvent[],
  inheritedEventCount = SessionLogOffset(0),
) => ({ meta: header, inheritedEventCount, events })
const end = (kind: string): SessionEvent => ({
  type: 'turn/end',
  seq: SessionSeq(0),
  time: 2000,
  data: { turn: 1, reason: { kind, error: { message: 'PRIVATE_PROVIDER_ERROR' } } },
}) as SessionEvent
const child = (id: string, parentId = meta.id, depth = 1) => ({ id: SessionId(id), parentId, depth, kind: 'child' as const, mode: 'one-shot' as const, activity: 'inactive' as const, label: 'architect', hasChildren: false })
function reads(): CatalogReads {
  return {
    fold: async () => undefined, teamService: () => undefined, agent: () => undefined,
    descendants: async () => [child('first'), child('second')],
    inspect: async id => id === meta.id
      ? inspection(meta, [])
      : inspection(
        { ...meta, id, origin: 'subagent', parentSession: meta.id },
        [end(id === 'first' ? 'completed' : 'error')],
      ),
  }
}
it('discovers ordinary child sessions and preserves same-role executions without enabling Teams', async () => {
  const view = await describeMonitor(reads(), meta.id, signal())
  expect(view).toMatchObject({ kind: 'agents', enabled: false, catalog: { state: 'ready', total: 2 } })
  expect(view.catalog?.sessions.map(row => row.status).sort()).toEqual(['completed', 'failed'])
  expect(new Set(view.catalog?.sessions.map(row => row.id)).size).toBe(2)
  expect(JSON.stringify(view)).not.toContain('PRIVATE_PROVIDER_ERROR')
  expect(parseSnapshot(view, meta.id)).toEqual(view)
})
it('distinguishes executing Agents from idle residency, and cold unfinished work from completion', async () => {
  const view = await describeCatalog({ ...reads(), agent: id => id === 'first' ? { status: 'running' } as Agent : { status: 'idle' } as Agent }, meta.id, signal())
  expect(view?.sessions.map(row => row.status)).toEqual(['running', 'idle'])
  const base = reads()
  const cold = await describeCatalog({ ...base, inspect: async (id, s) => ({
    ...(await base.inspect(id, s))!,
    events: [{ type: 'turn/start', seq: SessionSeq(0), time: 2000, data: { turn: 1 } }],
  }) }, meta.id, signal())
  expect(cold?.sessions.every(row => row.status === 'inactive')).toBe(true)
})
it('includes nested sessions with exact parents and ignores inherited titles/outcomes', async () => {
  const view = await describeCatalog({ ...reads(), descendants: async () => [child('nested', SessionId('first'), 2)],
    inspect: async id => inspection(
      { ...meta, id, origin: 'subagent', parentSession: SessionId('first'), isSeeded: true },
      [{ type: 'session/title', seq: SessionSeq(0), time: 1000, data: { title: 'PARENT_TITLE' } } as unknown as SessionEvent, end('completed')],
      SessionLogOffset(2),
    ),
  }, meta.id, signal())
  expect(view?.sessions[0]).toMatchObject({ parentId: 'first', depth: 2, status: 'inactive', navigable: true })
  expect(view?.sessions[0]?.title).toBeUndefined()
})
it('contains missing/corrupt children and rejects a changed parent without leaking another session title', async () => {
  const view = await describeCatalog({ ...reads(), inspect: async id => {
    if (id === 'first') throw new Error('PRIVATE_PATH')
    return inspection({ ...meta, id, origin: 'subagent', parentSession: SessionId('foreign') }, [])
  } }, meta.id, signal())
  expect(view?.sessions.every(row => !row.navigable)).toBe(true)
  expect(view?.sessions.map(row => row.diagnostic).sort()).toEqual(['corrupt', 'unavailable'])
  expect(JSON.stringify(view)).not.toContain('PRIVATE_PATH')
})
it('cancels before discovery and after asynchronous catalog reads; does not mask abort as an error', async () => {
  const descendants = vi.fn(reads().descendants)
  await expect(describeCatalog({ ...reads(), descendants }, meta.id, AbortSignal.abort())).rejects.toThrow()
  expect(descendants).not.toHaveBeenCalled()
  const abort = new AbortController()
  await expect(describeCatalog({ ...reads(), descendants: async () => { abort.abort(); throw new Error('cancelled') } }, meta.id, abort.signal)).rejects.toThrow()
  expect(await describeCatalog({ ...reads(), descendants: async () => { throw new Error('PRIVATE') } }, meta.id, signal())).toMatchObject({ state: 'unavailable' })
})
it('bounds inspections and keeps executing sessions ahead of history', async () => {
  const inspect = vi.fn(reads().inspect)
  const view = await describeCatalog({ ...reads(), inspect, descendants: async () => Array.from({ length: 300 }, (_, index) => child(`child-${index}`)),
    agent: id => id === 'child-0' ? { status: 'running' } as Agent : undefined }, meta.id, signal())
  expect(view).toMatchObject({ total: 300, truncated: true })
  expect(view?.sessions).toHaveLength(256)
  expect(view?.sessions[0]?.id).toBe('child-0')
  expect(inspect).toHaveBeenCalledTimes(256)
})
it('rejects duplicate/foreign catalog wire identities and invalid statuses', async () => {
  const view = await describeMonitor(reads(), meta.id, signal())
  const catalog = view.catalog!
  for (const invalid of [
    { ...catalog, scopeId: 'other' }, { ...catalog, sessions: [catalog.sessions[0], catalog.sessions[0]] },
    { ...catalog, sessions: [{ ...catalog.sessions[0], status: 'finished' }] },
    { ...catalog, sessions: [{ ...catalog.sessions[0], parentId: 'other' }] },
  ]) expect(() => parseSnapshot({ ...view, catalog: invalid }, meta.id)).toThrow()
})
