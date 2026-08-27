import { afterEach, describe, expect, it, vi } from 'vitest'
import { MonitorController } from '../../src/agent-team-monitor/client/controller.ts'
import { parseSnapshot } from '../../src/agent-team-monitor/client/parse.ts'
import { layoutTasks } from '../../src/agent-team-monitor/client/graph.ts'
import { wireTeam, wireWorkflow } from './fixtures.ts'

afterEach(() => vi.useRealTimers())
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

describe('monitor client lifecycle', () => {
  it('auto-discovers a Team, uses one read endpoint, and cancels all work on dispose', async () => {
    vi.useFakeTimers()
    const call = vi.fn(async () => ({ ok: true as const, value: wireTeam }))
    const controller = new MonitorController({ call })
    controller.select(wireTeam.sessionId)
    await flush()
    expect(controller.store.getSnapshot()).toMatchObject({ open: false, detected: true, snapshot: wireTeam, loading: false })
    expect(call.mock.calls[0]?.slice(0, 2)).toEqual(['/api', 'agentTeamMonitor/describe'])
    controller.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('fences late replies after switching session and stops hidden-page polling', async () => {
    vi.useFakeTimers()
    let resolve: (value: { ok: true; value: unknown }) => void = () => {}
    const call = vi.fn(() => new Promise<{ ok: true; value: unknown }>(done => { resolve = done }))
    const controller = new MonitorController({ call })
    controller.select('team-root')
    const first = resolve
    controller.select('other')
    first({ ok: true, value: wireTeam })
    await flush()
    expect(controller.store.getSnapshot().snapshot).toBeUndefined()
    expect(controller.store.getSnapshot().sessionId).toBe('other')
    controller.setVisible(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(call).toHaveBeenCalledTimes(2)
    controller.dispose()
  })
  it('hides stale live data on disconnect and repulls on reconnect', async () => {
    vi.useFakeTimers()
    const call = vi.fn(async () => ({ ok: true as const, value: wireTeam }))
    const controller = new MonitorController({ call })
    controller.select('team-root'); await flush()
    controller.setOnline(false)
    expect(controller.store.getSnapshot()).toMatchObject({ online: false, snapshot: undefined })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(call).toHaveBeenCalledTimes(1)
    controller.setOnline(true); await flush()
    expect(call).toHaveBeenCalledTimes(2)
    controller.dispose()
  })
  it('rejects malformed wire values, foreign-session data and cycles', () => {
    expect(parseSnapshot(wireTeam, 'team-root')).toEqual(wireTeam)
    expect(() => parseSnapshot(wireTeam, 'other')).toThrow()
    expect(() => parseSnapshot({ ...wireTeam, members: [{ ...wireTeam.members[0], status: 'done' }] }, 'team-root')).toThrow()
    expect(layoutTasks(wireTeam.tasks).edges).toHaveLength(1)
    expect(() => layoutTasks([{ ...wireTeam.tasks[0]!, blockedBy: ['task-1'] }])).toThrow(/cycle/)
  })
  it('discovers activity later in the same conversation but only opens on a click', async () => {
    vi.useFakeTimers()
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { protocol: wireTeam.protocol, sessionId: 'team-root', enabled: true, kind: 'unavailable', reason: 'not-team' } })
      .mockResolvedValue({ ok: true, value: wireTeam })
    const controller = new MonitorController({ call })
    controller.select('team-root'); await flush()
    expect(controller.store.getSnapshot().open).toBe(false)
    expect(controller.store.getSnapshot().detected).toBe(false)
    controller.setOpen(true)
    expect(controller.store.getSnapshot().open).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(controller.store.getSnapshot()).toMatchObject({ open: false, detected: true })
    controller.setOpen(true)
    expect(controller.store.getSnapshot().open).toBe(true)
    controller.setOpen(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(controller.store.getSnapshot().open).toBe(false)
    controller.dispose()
  })
  it('detects standard workflows with experimental Teams disabled and resets all discovery on session switch', async () => {
    vi.useFakeTimers()
    const call = vi.fn().mockResolvedValue({ ok: true, value: wireWorkflow })
    const controller = new MonitorController({ call })
    controller.select(wireWorkflow.sessionId); await flush()
    expect(controller.store.getSnapshot()).toMatchObject({ detected: true, open: false, snapshot: wireWorkflow })
    controller.setOpen(true); await flush()
    controller.select('ordinary')
    expect(controller.store.getSnapshot()).toMatchObject({ detected: false, open: false })
    expect(controller.store.getSnapshot().snapshot).toBeUndefined()
    controller.dispose()
  })
  it('validates workflow rows, duplicate member sequences and aggregate bounds', () => {
    expect(parseSnapshot(wireWorkflow, wireWorkflow.sessionId)).toEqual(wireWorkflow)
    const run = wireWorkflow.workflows.runs[0]!
    for (const members of [[{ ...run.members[0], status: ['running'] }], [...run.members, ...run.members], Array.from({ length: 257 }, (_, seq) => ({ ...run.members[0], seq }))]) {
      expect(() => parseSnapshot({ ...wireWorkflow, workflows: { ...wireWorkflow.workflows, runs: [{ ...run, members }] } }, wireWorkflow.sessionId)).toThrow()
    }
  })
})
