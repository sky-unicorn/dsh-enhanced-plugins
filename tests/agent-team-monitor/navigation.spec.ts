import { expect, it, vi } from 'vitest'
import { mainSessionId, openMemberSession } from '../../src/agent-team-monitor/client/navigation.ts'

it('uses the native address and mode for running, historical and nested member clicks', async () => {
  for (const mode of ['one-shot', 'continuable']) {
    const navigation = { openSession: vi.fn() }
    const sessions = { refreshSubagents: vi.fn(async () => {}), list: {
      getSnapshot: () => ({ subagentsByParent: { nestedParent: { entries: [{ kind: 'child', id: 'member', mode }] } } }),
    } }
    await openMemberSession(sessions as never, navigation, 'nestedParent', 'member', () => true)
    expect(sessions.refreshSubagents).toHaveBeenCalledWith('nestedParent')
    expect(navigation.openSession).toHaveBeenCalledWith({ parentSessionId: 'nestedParent', childSessionId: 'member', mode })
  }
})
it('refuses unavailable children and fences delayed navigation after a selection change', async () => {
  let current = true
  const navigation = { openSession: vi.fn() }
  const sessions = { refreshSubagents: vi.fn(async () => { current = false }), list: { getSnapshot: () => ({ subagentsByParent: {} }) } }
  await openMemberSession(sessions as never, navigation, 'parent', 'member', () => current)
  expect(navigation.openSession).not.toHaveBeenCalled()
  await expect(openMemberSession(sessions as never, navigation, 'parent', 'member', () => true)).rejects.toThrow('unavailable')
})

it('follows the main view while sidebar references and catalog entries remain independent', () => {
  const byId = {
    sidebar: { id: 'sidebar', retainedBy: { sidebar: 1 } },
    history: { id: 'history', retainedBy: {} },
    main: { id: 'main', retainedBy: { mainView: 1 } },
  }
  const sessions = { list: { getSnapshot: () => ({ byId }) } }
  expect(mainSessionId(sessions as never)).toBe('main')
  byId.main.retainedBy.mainView = 0
  expect(mainSessionId(sessions as never)).toBeUndefined()
})
