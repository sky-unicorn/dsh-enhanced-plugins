import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'

type Sessions = Pick<ClientContext['sessions'], 'list' | 'refreshSubagents' | 'openSubagent'>

/** Native catalog owns mode/identity. Revalidate at click time and fence away-and-back navigation. */
export async function openMemberSession(sessions: Sessions, parentId: string, memberId: string, current: () => boolean): Promise<void> {
  if (!current()) return
  const parent = parentId as SessionId
  await sessions.refreshSubagents(parent)
  if (!current()) return
  const catalog = sessions.list.getSnapshot().subagentsByParent[parent]
  const child = catalog?.entries.find(entry => entry.id === memberId)
  if (child?.kind !== 'child') throw new Error('Member transcript unavailable')
  sessions.openSubagent({ parentSessionId: parent, childSessionId: child.id, mode: child.mode })
}
