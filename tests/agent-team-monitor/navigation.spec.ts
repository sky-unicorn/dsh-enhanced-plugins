import { expect, it, vi } from 'vitest'
import { openMemberSession } from '../../src/agent-team-monitor/client/navigation.ts'

it('uses the native address and mode for running, historical and nested member clicks', async () => {
  for (const mode of ['one-shot', 'continuable']) {
    const sessions = { refreshSubagents: vi.fn(async () => {}), openSubagent: vi.fn(), list: {
      getSnapshot: () => ({ subagentsByParent: { nestedParent: { entries: [{ kind: 'child', id: 'member', mode }] } } }),
    } }
    await openMemberSession(sessions as never, 'nestedParent', 'member', () => true)
    expect(sessions.refreshSubagents).toHaveBeenCalledWith('nestedParent')
    expect(sessions.openSubagent).toHaveBeenCalledWith({ parentSessionId: 'nestedParent', childSessionId: 'member', mode })
  }
})
it('refuses unavailable children and fences delayed navigation after a selection change', async () => {
  let current = true
  const sessions = { refreshSubagents: vi.fn(async () => { current = false }), openSubagent: vi.fn(), list: { getSnapshot: () => ({ subagentsByParent: {} }) } }
  await openMemberSession(sessions as never, 'parent', 'member', () => current)
  expect(sessions.openSubagent).not.toHaveBeenCalled()
  await expect(openMemberSession(sessions as never, 'parent', 'member', () => true)).rejects.toThrow('unavailable')
})
