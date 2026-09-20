// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ExecutionFlow } from '../../src/agent-team-monitor/client/ExecutionFlow.tsx'
import type { MonitorPanelProps } from '../../src/agent-team-monitor/client/Panel.tsx'
import { en } from '../../src/agent-team-monitor/client/locales.ts'
import { MONITOR_PROTOCOL, type ExecutionDetail, type MonitorSnapshot } from '../../src/agent-team-monitor/shared.ts'
afterEach(cleanup)
const t = ((key: keyof typeof en) => en[key]) as MonitorPanelProps['t']
const snapshot: MonitorSnapshot = { protocol: MONITOR_PROTOCOL, kind: 'agents', enabled: false, sessionId: 'root', source: 'live',
  execution: { total: 2, truncated: false, nodes: [
    { seq: 0, kind: 'step', turn: 1, step: 1, status: 'running', startedAt: 1000 },
    { seq: 1, kind: 'tool', turn: 1, step: 1, name: 'read_file', status: 'completed', startedAt: 1010, endedAt: 1020 },
  ] },
  catalog: { scopeId: 'root', state: 'ready', total: 1, truncated: false, sessions: [
    { id: 'child', parentId: 'root', depth: 1, label: 'Developer', mode: 'one-shot', status: 'running', navigable: true,
      execution: { total: 1, truncated: false, nodes: [{ seq: 0, kind: 'step', turn: 1, step: 1, status: 'running', startedAt: 1000 }] } },
  ] },
}
const detail = (sessionId: string, seq: number): ExecutionDetail => ({ protocol: MONITOR_PROTOCOL, sessionId, seq, input: 'app.ts', output: 'read complete', truncated: false })

it('opens the parent-recorded callback from the overview and drills into a member', async () => {
  const inspectNode = vi.fn(async (_root: string, id: string, seq: number) => detail(id, seq))
  const current: MonitorSnapshot = { ...snapshot, cooperation: { total: 2, truncated: false, events: [
    { id: 'dispatch', kind: 'dispatch', source: 'catalog', fromId: 'root', toId: 'child', sessionId: 'root', seq: 8, time: 1000, delivery: 'recorded' },
    { id: 'return', kind: 'return', source: 'settlement', fromId: 'child', toId: 'root', sessionId: 'root', seq: 9, time: 2000, delivery: 'recorded' },
  ] } }
  const { container } = render(<ExecutionFlow snapshot={current} t={t} inspectNode={inspectNode} openMember={vi.fn()} />)
  expect(container.querySelector('[data-cooperation-member="child"]')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.inspectCallback }))
  await screen.findByText('read complete')
  expect(inspectNode).toHaveBeenLastCalledWith('root', 'root', 9, expect.any(AbortSignal))
  fireEvent.click(screen.getByRole('button', { name: en.inspectExecution }))
  expect(container.querySelectorAll('[data-execution-lane]')).toHaveLength(1)
  expect(container.querySelector('[data-execution-lane="child"]')).not.toBeNull()
})

it('drills from a member step to its tool payload, focuses lanes and filters completed records', async () => {
  const inspectNode = vi.fn(async (_root: string, id: string, seq: number) => detail(id, seq))
  const openMember = vi.fn(async () => {})
  const { container } = render(<ExecutionFlow snapshot={snapshot} t={t} inspectNode={inspectNode} openMember={openMember} />)
  expect(inspectNode).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.internalView }))
  fireEvent.click(container.querySelector('[data-execution-node="root:0"]')!)
  await screen.findByText('read complete')
  fireEvent.click(screen.getByRole('button', { name: 'read_file · Completed' }))
  await waitFor(() => expect(inspectNode).toHaveBeenLastCalledWith('root', 'root', 1, expect.any(AbortSignal)))
  fireEvent.click(screen.getByRole('button', { name: en.detailedNodes }))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'completed' } })
  expect(container.querySelectorAll('[data-execution-node]')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Inspect member flow: Developer' }))
  expect(container.querySelectorAll('[data-execution-lane]')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: en.openSession }))
  expect(openMember).toHaveBeenCalledWith('root', 'child')
})

it('cancels the previous selection and never paints its late payload', async () => {
  const pending: { resolve(value: ExecutionDetail): void; signal: AbortSignal }[] = []
  const inspectNode = vi.fn((_root: string, _id: string, _seq: number, signal: AbortSignal) => new Promise<ExecutionDetail>(resolve => { pending.push({ resolve, signal }) }))
  const { container, unmount } = render(<ExecutionFlow snapshot={snapshot} t={t} inspectNode={inspectNode} openMember={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: en.internalView }))
  fireEvent.click(container.querySelector('[data-execution-node="root:0"]')!)
  fireEvent.click(container.querySelector('[data-execution-node="child:0"]')!)
  expect(pending[0]!.signal.aborted).toBe(true)
  pending[0]!.resolve({ ...detail('root', 0), output: 'STALE_OUTPUT' })
  pending[1]!.resolve(detail('child', 0))
  await screen.findByText('read complete')
  expect(screen.queryByText('STALE_OUTPUT')).toBeNull()
  unmount()
  expect(pending[1]!.signal.aborted).toBe(true)
})
