import type { CooperationEvent, MonitorChildSession, MonitorSnapshot } from '../shared.ts'

/** Current execution and its recorded cross-session traffic, without estimating future work. */
export function memberCooperation(member: MonitorChildSession, events: readonly CooperationEvent[]) {
  const progress = member.execution?.progress
  const dispatches = events.filter(event => event.fromId === member.parentId && event.toId === member.id
    && (event.kind === 'dispatch' || event.kind === 'message'))
  const dispatch = dispatches.at(-1)
  const callbacks = events.filter(event => event.fromId === member.id && event.toId === member.parentId)
  // Prior activations' callbacks must not finish a newly running turn.
  const current = callbacks.filter(event => progress === undefined || event.time >= progress.startedAt)
  const result = current.filter(event => event.kind === 'return').at(-1)
  const messages = current.filter(event => event.kind === 'message')
  const received = result?.delivery === 'recorded'
  const status = progress?.status ?? member.status
  return { member, progress, dispatch, result, received, messages, callbacks, status,
    phase: dispatch?.phase,
    // A callback can arrive before child teardown. The running turn is still shown.
    finished: progress?.endedAt !== undefined,
  }
}

/** Group by the real direct parent so nested delegation remains a separate branch. */
export function cooperationGroups(snapshot: MonitorSnapshot) {
  const events = snapshot.cooperation?.events ?? []
  const groups = new Map<string, ReturnType<typeof memberCooperation>[]>()
  const children = [...(snapshot.catalog?.sessions ?? [])].sort((a, b) => a.depth - b.depth || (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id))
  for (const child of children) {
    const rows = groups.get(child.parentId) ?? []
    rows.push(memberCooperation(child, events)); groups.set(child.parentId, rows)
  }
  return [...groups].map(([parentId, members]) => ({ parentId, members }))
}
