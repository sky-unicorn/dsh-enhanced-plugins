import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { MonitorController } from './controller.ts'
import { MonitorControl, type MonitorInjected } from './Panel.tsx'
import { en, zh, NS, type MonitorKey } from './locales.ts'
import { openMemberSession } from './navigation.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'agent-team-monitor': MonitorKey }
}

export const inject = ['connection', 'sessions', 'slots', 'locale']

/** Add a session-owned composer control; all subscriptions and requests belong to this Client fiber. */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new MonitorController(connection.rpc)
  let selectionEpoch = 0
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'team monitor: dictionaries')
  ctx.effect(() => {
    const select = () => {
      const current = ctx.sessions.list.getSnapshot().current
      if (current !== controller.store.getSnapshot().sessionId) selectionEpoch++
      controller.select(current)
    }
    const visibility = () => controller.setVisible(!document.hidden)
    const online = () => controller.setOnline(connection.generation.getSnapshot() !== undefined)
    const off = ctx.sessions.list.subscribe(select)
    const disconnect = connection.generation.subscribe(online)
    document.addEventListener('visibilitychange', visibility)
    online(); visibility(); select()
    return () => { selectionEpoch++; off(); disconnect(); document.removeEventListener('visibilitychange', visibility); controller.dispose() }
  }, 'team monitor: current session and polling')
  const injected = (sessionId: SessionId): MonitorInjected => ({
    hooks: { teamMonitor: controller.store },
    setOpen: open => { if (controller.store.getSnapshot().sessionId === sessionId) controller.setOpen(open) },
    refresh: () => { if (controller.store.getSnapshot().sessionId === sessionId) void controller.refresh() },
    async openMember(teamId, memberId) {
      const epoch = selectionEpoch
      await openMemberSession(ctx.sessions, teamId, memberId,
        () => selectionEpoch === epoch && ctx.sessions.list.getSnapshot().current === sessionId)
    },
  })
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'agent-team-monitor', order: 35, locale: NS, inject: injected,
  }, MonitorControl))
}
