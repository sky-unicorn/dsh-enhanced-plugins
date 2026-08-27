// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RoleSessions } from '../../src/agent-team-monitor/client/RoleSessions.tsx'
import { groupRoleSessions } from '../../src/agent-team-monitor/client/roles.ts'
import { MONITOR_PROTOCOL, type MonitorSnapshot } from '../../src/agent-team-monitor/shared.ts'
import { en } from '../../src/agent-team-monitor/client/locales.ts'

afterEach(cleanup)
const view: MonitorSnapshot = {
  protocol: MONITOR_PROTOCOL, sessionId: 'parent', kind: 'agents', enabled: false, source: 'live', catalog: {
    scopeId: 'parent', state: 'ready', total: 4, truncated: false, sessions: [
      { id: 'current', parentId: 'parent', depth: 1, mode: 'one-shot', label: 'Architect', title: 'Implementation review', status: 'running', navigable: true },
      { id: 'past', parentId: 'parent', depth: 1, mode: 'one-shot', label: 'Architect', title: 'Initial design', status: 'completed', navigable: true },
      { id: 'failed', parentId: 'current', depth: 2, mode: 'continuable', label: 'Reviewer', title: 'Second review', status: 'failed', navigable: true },
      { id: 'unnamed', parentId: 'parent', depth: 1, status: 'unknown', diagnostic: 'unavailable', navigable: false },
    ],
  },
}
const t = (key: string) => en[key as keyof typeof en]

it('groups one role with multiple sessions without conflating identities or unknown labels', () => {
  const groups = groupRoleSessions(view)
  expect(groups).toHaveLength(3)
  expect(groups[0]).toMatchObject({ name: 'Architect', running: 1, sessions: [{ id: 'current' }, { id: 'past' }] })
  expect(groups.find(group => group.name === undefined)?.sessions[0]?.id).toBe('unnamed')
})
it('filters ongoing and past sessions and opens the exact native child address for each', async () => {
  const openMember = vi.fn(async () => {})
  render(<RoleSessions snapshot={view} openMember={openMember} t={t} />)
  expect(screen.getByText('Architect')).toBeTruthy()
  expect(screen.getByText(en.unknownRole)).toBeTruthy()
  expect(openMember).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /Open session details: Implementation review/ }))
  await waitFor(() => expect(openMember).toHaveBeenCalledWith('parent', 'current'))
  fireEvent.click(within(screen.getByRole('group', { name: en.sessionFilter })).getByRole('button', { name: /History/ }))
  expect(screen.queryByText('Implementation review')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Open session details: Initial design/ }))
  await waitFor(() => expect(openMember).toHaveBeenCalledWith('parent', 'past'))
  fireEvent.click(screen.getByRole('button', { name: /Open session details: Second review/ }))
  await waitFor(() => expect(openMember).toHaveBeenCalledWith('current', 'failed'))
  expect(screen.getByText(en.failed)).toBeTruthy()
  expect(screen.getByRole('button', { name: /Open session details: unnamed/ }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(within(screen.getByRole('group', { name: en.sessionFilter })).getByRole('button', { name: /Running/ }))
  expect(screen.getByText('Implementation review')).toBeTruthy()
  expect(screen.queryByText('Initial design')).toBeNull()
})
it('updates filters after a running session finishes and shows a failed navigation without hiding rows', async () => {
  const openMember = vi.fn(async () => { throw new Error('unavailable') })
  const rendered = render(<RoleSessions snapshot={view} openMember={openMember} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: /Open session details: Implementation review/ }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(en.navigationError))
  fireEvent.click(within(screen.getByRole('group', { name: en.sessionFilter })).getByRole('button', { name: /Running/ }))
  const completed = { ...view, catalog: { ...view.catalog!, sessions: view.catalog!.sessions.map(row => row.id === 'current' ? { ...row, status: 'completed' as const } : row) } }
  rendered.rerender(<RoleSessions snapshot={completed} openMember={openMember} t={t} />)
  expect(screen.getByText(en.noMatchingSessions)).toBeTruthy()
})
