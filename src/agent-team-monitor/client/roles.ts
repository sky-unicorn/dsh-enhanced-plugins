import type { MonitorChildSession, MonitorSnapshot } from '../shared.ts'

export interface RoleSession extends MonitorChildSession {
  workflow?: string
  phase?: string
}
export interface RoleGroup {
  key: string
  name?: string
  sessions: RoleSession[]
  running: number
}

/** Group exact recorded labels, not inferred personas; session IDs remain the identity key. */
export function groupRoleSessions(snapshot: MonitorSnapshot): RoleGroup[] {
  const names = new Map<string, string>()
  const workflows = new Map<string, { workflow: string; phase?: string }>()
  if (snapshot.kind === 'team' || snapshot.kind === 'workflow') {
    for (const run of snapshot.workflows?.runs ?? []) for (const member of run.members) {
      if (!names.has(member.id) && member.name.trim() !== '') names.set(member.id, member.name)
      if (!workflows.has(member.id)) workflows.set(member.id, { workflow: run.name, ...(member.phase === undefined ? {} : { phase: member.phase }) })
    }
  }
  if (snapshot.kind === 'team') for (const member of snapshot.members) {
    if (member.role === 'teammate') names.set(member.id, member.name)
  }
  const groups = new Map<string, RoleGroup>()
  for (const session of snapshot.catalog?.sessions ?? []) {
    const label = names.get(session.id) ?? session.label
    const name = label?.trim() === '' ? undefined : label
    const key = JSON.stringify(name === undefined ? [] : [name])
    let group = groups.get(key)
    if (group === undefined) { group = { key, ...(name === undefined ? {} : { name }), sessions: [], running: 0 }; groups.set(key, group) }
    group.sessions.push({ ...session, ...workflows.get(session.id) })
    if (session.status === 'running') group.running++
  }
  return [...groups.values()].sort((a, b) => Number(b.running > 0) - Number(a.running > 0)
    || (b.sessions[0]?.createdAt ?? 0) - (a.sessions[0]?.createdAt ?? 0) || a.key.localeCompare(b.key))
}
