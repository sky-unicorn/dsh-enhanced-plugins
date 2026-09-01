import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionHeader, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {
  TeamMemberSnapshot,
  TeamMessageId,
  TeamMessageSnapshot,
  TeamService,
  TeamTaskSnapshot,
} from '@deepseek-ai/dsh-experimental-agent-team'
import { MONITOR_PROTOCOL, type MonitorMember, type MonitorSnapshot, type MonitorTask } from '../shared.js'
import { describeWorkflows } from './workflow.js'

type Inspection = { readonly meta: SessionHeader; readonly events: readonly SessionEvent[] }

/** Host-only state produced by the official registered `agentTeam` projection. */
export interface TeamProjectionState {
  readonly id: string
  readonly members: readonly TeamMemberSnapshot[]
  readonly tasks: readonly TeamTaskSnapshot[]
  readonly messages: readonly TeamMessageSnapshot[]
  readonly delivered: readonly TeamMessageId[]
  readonly nextTaskNumber: number
  readonly failure?: string
}

/** Narrow one public projection checkpoint value before this plugin consumes it. */
export function teamProjectionState(value: unknown): TeamProjectionState | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Partial<TeamProjectionState>
  if (typeof candidate.id !== 'string'
    || !Array.isArray(candidate.members)
    || !Array.isArray(candidate.tasks)
    || !Array.isArray(candidate.messages)
    || !Array.isArray(candidate.delivered)
    || !Number.isSafeInteger(candidate.nextTaskNumber)
    || (candidate.failure !== undefined && typeof candidate.failure !== 'string')) return undefined
  return candidate as TeamProjectionState
}

/** Public DSH read seams; kept injectable for lifecycle and side-effect tests. */
export interface MonitorReads {
  agent(id: SessionId): Agent | undefined
  inspect(id: SessionId, signal: AbortSignal): Promise<Inspection | undefined>
  teamService(agent?: Agent): TeamService | undefined
  project(meta: SessionHeader, events: readonly SessionEvent[]): TeamProjectionState | undefined
}

const MEMBER_LIMIT = 256
const TASK_LIMIT = 1000
const TEAM_EVENTS = new Set(['team/member', 'team/task', 'team/message/queued', 'team/message/delivered'])

/** Display-only overlap relation; never a file lock or an execution permission. */
function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/** Construct one bounded snapshot without waking Agents, repairing logs, or changing Team state. */
export async function describeTeam(reads: MonitorReads, sessionId: SessionId, signal: AbortSignal): Promise<MonitorSnapshot> {
  signal.throwIfAborted()
  let enabled = reads.teamService(reads.agent(sessionId)) !== undefined
  const unavailable = (reason: Extract<MonitorSnapshot, { kind: 'unavailable' }>['reason']): MonitorSnapshot =>
    ({ protocol: MONITOR_PROTOCOL, sessionId, enabled, kind: 'unavailable', reason })
  let selected: Inspection | undefined
  try { selected = await reads.inspect(sessionId, signal) } catch {
    signal.throwIfAborted()
    return unavailable('storage-unavailable')
  }
  if (selected === undefined) return unavailable('no-session')
  let workflows: ReturnType<typeof describeWorkflows>
  try { workflows = describeWorkflows(selected.meta, selected.events, id => reads.agent(id)) } catch { return unavailable('incompatible') }
  const withoutTeam = (reason: 'not-team' | 'incompatible' = 'not-team'): MonitorSnapshot => workflows === undefined
    ? unavailable(reason)
    : { protocol: MONITOR_PROTOCOL, sessionId, enabled, kind: 'workflow',
      source: reads.agent(sessionId) === undefined ? 'persisted' : 'live', workflows }
  // Only a root or its exact roster child is a Team address. An ordinary fork
  // keeps its own identity; inherited Team events never turn it into the old Team.
  let root = selected
  if (selected.meta.origin === 'subagent') {
    const parentId = selected.meta.parentSession
    if (parentId === undefined) return withoutTeam()
    try {
      const parent = await reads.inspect(parentId, signal)
      if (parent === undefined || parent.meta.origin === 'subagent') return withoutTeam()
      root = parent
    } catch { signal.throwIfAborted(); return unavailable('storage-unavailable') }
  }
  signal.throwIfAborted()
  const agent = reads.agent(root.meta.id)
  const service = reads.teamService(agent)
  enabled = service !== undefined
  const events = root.events
  if (!events.some(event => TEAM_EVENTS.has(event.type))) return withoutTeam()
  const owned = events.filter(event => TEAM_EVENTS.has(event.type)
    && typeof event.data === 'object' && event.data !== null
    && 'teamId' in event.data && String(event.data.teamId) === String(root.meta.id))
  let state: TeamProjectionState | undefined
  try { state = reads.project(root.meta, events) } catch { return unavailable('incompatible') }
  if (state === undefined || state.failure !== undefined || state.id !== root.meta.id) return unavailable('incompatible')
  // Validate even inherited/corrupt Team records before deciding there is no
  // Team. A malformed selector must not be disguised as an ordinary session.
  if (owned.length === 0) return withoutTeam()
  if (selected.meta.origin === 'subagent' && !state.members.some(member => member.id === selected.meta.id)) return withoutTeam()
  const pending = new Map<string, number>()
  const delivered = new Set(state.delivered)
  for (const message of state.messages) {
    if (!delivered.has(message.id)) pending.set(message.targetId, (pending.get(message.targetId) ?? 0) + 1)
  }
  let liveMembers: ReturnType<TeamService['listMembers']> | undefined
  if (agent !== undefined && service !== undefined) {
    try {
      if (service.tryMembership(agent)?.role === 'lead') liveMembers = service.listMembers(agent)
    } catch { return unavailable('incompatible') }
  }
  const members: MonitorMember[] = liveMembers === undefined ? [
    { id: root.meta.id, name: 'lead', role: 'lead', status: 'inactive', description: '', pendingMessages: pending.get(root.meta.id) ?? 0, diagnosticCount: 0 },
    ...state.members.map((member): MonitorMember => ({
      id: member.id, name: member.name, role: 'teammate',
      status: member.phase === 'active' ? 'inactive' : member.phase,
      description: member.description, context: member.context,
      pendingMessages: pending.get(member.id) ?? 0, diagnosticCount: member.error === undefined ? 0 : 1,
    })),
  ] : liveMembers.map(member => {
    // The official roster falls back to the Lead's current model for an
    // inactive child. That is not evidence of the child's last route.
    const model = reads.agent(member.id)?.options.model
    return {
      id: member.id, name: member.name, role: member.role, status: member.status,
      description: member.description ?? '', ...(model === undefined ? {} : { model }),
      ...(member.context === undefined ? {} : { context: member.context }),
      pendingMessages: pending.get(member.id) ?? 0, diagnosticCount: member.diagnostics.length,
    }
  })
  const names = new Map(members.map(member => [member.id, member.name]))
  const taskById = new Map(state.tasks.map(task => [task.id, task]))
  const active = state.tasks.filter(task => task.status === 'in_progress')
  const tasks: MonitorTask[] = []
  for (const task of state.tasks) {
    if (task.status === 'deleted') continue
    const ownerName = task.ownerId === undefined ? undefined : names.get(task.ownerId)
    tasks.push({
      id: task.id, revision: task.revision, subject: task.subject, description: task.description,
      status: task.status, ...(ownerName === undefined ? {} : { ownerName }),
      blockedBy: [...task.blockedBy], writeScopes: [...task.writeScopes],
      ready: task.status === 'pending' && task.blockedBy.every(id => taskById.get(id)?.status === 'completed'),
      overlappingTaskIds: active.filter(other => other.id !== task.id
        && task.writeScopes.some(scope => other.writeScopes.some(candidate => overlaps(scope, candidate)))).map(other => other.id),
    })
  }
  const last = owned[owned.length - 1]!
  return {
    protocol: MONITOR_PROTOCOL, sessionId, enabled, kind: 'team', teamId: root.meta.id,
    source: liveMembers === undefined ? 'persisted' : 'live',
    lastEventSeq: last.seq, lastActivityAt: last.time,
    counts: { members: members.length, tasks: tasks.length,
      completed: tasks.filter(task => task.status === 'completed').length,
      blocked: tasks.filter(task => task.status === 'pending' && !task.ready).length,
      pendingMessages: [...pending.values()].reduce((sum, count) => sum + count, 0) },
    members: members.slice(0, MEMBER_LIMIT), tasks: tasks.slice(0, TASK_LIMIT),
    truncated: members.length > MEMBER_LIMIT || tasks.length > TASK_LIMIT,
    ...(workflows === undefined ? {} : { workflows }),
  }
}
