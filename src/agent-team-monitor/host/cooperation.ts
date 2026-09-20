import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tool-workflow/types'
import type { CooperationActivity, CooperationEvent } from '../shared.js'

/** A verified session's own suffix; inherited messages cannot create new delegation edges. */
export interface CooperationLog { sessionId: string; events: readonly SessionEvent[]; inherited: number }

/** Reconstruct only durable publication, settlement and delivery facts. Never parse model prose for IDs. */
export function describeCooperation(logs: readonly CooperationLog[], allowedIds: ReadonlySet<string>): CooperationActivity {
  const transfers = new Map<string, CooperationEvent>()
  for (const log of logs) {
    const workflowMembers = new Map<string, { childId: string; phase?: string }>()
    const messages = new Map<string, { fromId: string; toId: string }>()
    const add = (event: SessionEvent, data: Omit<CooperationEvent, 'id' | 'sessionId' | 'seq' | 'time'>, key = String(event.seq)) => {
      if (data.fromId === data.toId || !allowedIds.has(data.fromId) || !allowedIds.has(data.toId)) return
      const id = `${log.sessionId}:${key}`
      transfers.set(id, { id, sessionId: log.sessionId, seq: event.seq, time: event.time, ...data })
    }
    for (const event of log.events.slice(log.inherited)) {
      switch (event.type) {
        case 'subagent/catalog':
          if (event.data.version === 0) add(event, { kind: 'dispatch', source: 'catalog', fromId: log.sessionId, toId: event.data.childId, delivery: 'recorded' })
          break
        case 'tool-workflow/agent-start': {
          const data = event.data
          workflowMembers.set(`${data.runId}:${data.seq}`, { childId: data.childId, ...(data.phase === undefined ? {} : { phase: data.phase }) })
          add(event, { kind: 'dispatch', source: 'workflow', fromId: log.sessionId, toId: data.childId, delivery: 'recorded', ...(data.phase === undefined ? {} : { phase: data.phase }) })
          break
        }
        case 'tool-workflow/agent-end': {
          const member = workflowMembers.get(`${event.data.runId}:${event.data.seq}`)
          if (member) add(event, { kind: 'return', source: 'workflow', fromId: member.childId, toId: log.sessionId, delivery: 'recorded', outcome: event.data.outcome,
            ...(member.phase === undefined ? {} : { phase: member.phase }) })
          break
        }
        case 'user/message': {
          const source = event.data.source
          if (source.kind === 'subagent-settled' || source.kind === 'agent-message') {
            add(event, { kind: source.kind === 'subagent-settled' ? 'return' : 'message', source: source.kind === 'subagent-settled' ? 'settlement' : 'agent',
              fromId: source.senderSessionId, toId: log.sessionId, delivery: 'recorded' })
          }
          break
        }
        case 'team/message/queued': {
          if (event.data.version !== 2 || event.data.teamId !== log.sessionId) break
          const message = event.data.message
          const route = { fromId: message.senderId, toId: message.targetId }
          messages.set(message.id, route)
          add(event, { ...route, kind: 'message', source: 'team', delivery: 'queued' }, `message:${message.id}`)
          break
        }
        case 'team/message/delivered': {
          const route = messages.get(event.data.messageId)
          if (route && event.data.version === 2 && event.data.teamId === log.sessionId && event.data.targetId === route.toId) {
            add(event, { ...route, kind: 'message', source: 'team', delivery: 'recorded' }, `message:${event.data.messageId}`)
          }
          break
        }
        default: break // No return is inferred from a child's completed turn or assistant prose.
      }
    }
  }
  const events = [...transfers.values()].sort((a, b) => a.time - b.time || a.sessionId.localeCompare(b.sessionId) || a.seq - b.seq)
  return { events: events.slice(-1000), total: events.length, truncated: events.length > 1000 }
}
