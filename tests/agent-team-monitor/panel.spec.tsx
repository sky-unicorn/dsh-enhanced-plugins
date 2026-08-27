// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MonitorPanel, MonitorControl, type MonitorPanelProps, type MonitorControlProps } from '../../src/agent-team-monitor/client/Panel.tsx'
import { en } from '../../src/agent-team-monitor/client/locales.ts'
import { wireTeam, wireWorkflow } from './fixtures.ts'

afterEach(cleanup)
function props(): MonitorPanelProps {
  return {
    useTeamMonitor: selector => selector({ sessionId: 'team-root', snapshot: wireTeam, detected: true, open: true, loading: false, failed: false, online: true }),
    sessionId: 'team-root',
    t: key => en[key as keyof typeof en], setOpen: vi.fn(), close: vi.fn(), refresh: vi.fn(), openMember: vi.fn(async () => {}),
  } as MonitorPanelProps
}
it('renders statuses and dependencies, and only navigates after an explicit click', () => {
  const p = props()
  render(<MonitorPanel {...p} />)
  expect(screen.getByText('Running')).toBeTruthy()
  expect(screen.getByText('Build monitor')).toBeTruthy()
  expect(p.openMember).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /Open member transcript: researcher/ }))
  expect(p.openMember).toHaveBeenCalledWith('team-root', 'team-researcher')
  fireEvent.click(screen.getByTitle('Build monitor'))
  expect(screen.getByText(/Overlaps in-progress tasks/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(p.close).toHaveBeenCalled()
})
it('never renders a previous session snapshot', () => {
  const p = props()
  p.sessionId = 'other'
  render(<MonitorPanel {...p} />)
  expect(screen.queryByText('Build monitor')).toBeNull()
})
it('renders workflow members without a false Agent Teams disabled message or invented task board', () => {
  const p = props()
  p.sessionId = wireWorkflow.sessionId
  p.useTeamMonitor = selector => selector({ sessionId: p.sessionId, snapshot: wireWorkflow, detected: true, open: true, loading: false, failed: false, online: true })
  render(<MonitorPanel {...p} />)
  expect(screen.getByText('gomoku-team-build')).toBeTruthy()
  expect(screen.getByText(/1-总体架构设计/)).toBeTruthy()
  expect(screen.queryByText(en.disabled)).toBeNull()
  expect(screen.queryByText(en.tasks)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /整体架构师/ }))
  expect(p.openMember).toHaveBeenCalledWith('workflow-parent', 'architect-child')
})
it('only renders the icon for discovered activity in this session, with click-only opening and local dismissal', () => {
  const p = props()
  const control = { ...p, sessionId: 'team-root' } as MonitorControlProps
  control.useTeamMonitor = selector => selector({ sessionId: 'team-root', detected: false, open: false, loading: false, failed: false, online: true })
  const view = render(<MonitorControl {...control} />)
  expect(screen.queryByRole('button', { name: en.open })).toBeNull()
  control.useTeamMonitor = selector => selector({ sessionId: 'team-root', snapshot: wireTeam, detected: true, open: false, loading: false, failed: false, online: true })
  view.rerender(<MonitorControl {...control} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  const button = screen.getByRole('button', { name: en.open })
  expect(button.textContent).toBe('')
  fireEvent.click(button)
  expect(p.setOpen).toHaveBeenCalledWith(true)
  control.useTeamMonitor = p.useTeamMonitor
  view.rerender(<MonitorControl {...control} />)
  expect(screen.getByRole('dialog').closest('[data-team-monitor-session]')).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(p.setOpen).toHaveBeenCalledWith(false)
  expect(document.activeElement).toBe(button)
  fireEvent.pointerDown(document.body)
  expect(p.setOpen).toHaveBeenCalledWith(false)
  view.rerender(<MonitorControl {...control} sessionId={'other' as never} />)
  expect(screen.queryByRole('button', { name: en.open })).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
})
