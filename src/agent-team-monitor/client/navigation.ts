import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

type Sessions = Pick<ClientContext['sessions'], 'list' | 'refreshProjections'>
type Navigation = Pick<ClientContext['uiWorkspace'], 'openSession'>

/** Select the main Conversation owner, excluding independently retained sidebar chats. */
export function mainSessionId(sessions: Pick<Sessions, 'list'>): SessionId | undefined {
  return Object.values(sessions.list.getSnapshot().byId)
    .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}

/** Native catalog owns mode/identity. Revalidate at click time and fence away-and-back navigation. */
export async function openMemberSession(sessions: Sessions, navigation: Navigation, parentId: string, memberId: string, current: () => boolean): Promise<void> {
  if (!current()) return
  const parent = parentId as SessionId
  await sessions.refreshProjections(parent)
  if (!current()) return
  const catalog = sessions.list.getSnapshot().projectionsBySession[parent]?.values.subagentCatalog
  const child = catalog?.find(entry => entry.id === memberId)
  if (child === undefined) throw new Error('Member transcript unavailable')
  navigation.openSession({ parentSessionId: parent, childSessionId: child.id, mode: child.mode })
}
