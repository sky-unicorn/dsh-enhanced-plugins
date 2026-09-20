import { MONITOR_PROTOCOL, type MonitorSnapshot, type ExecutionDetail } from '../shared.ts'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function integer(value: unknown, minimum = 0): boolean { return Number.isSafeInteger(value) && (value as number) >= minimum }
function strings(value: unknown): boolean { return Array.isArray(value) && value.every(item => typeof item === 'string') }
function oneOf(value: unknown, values: readonly string[]): boolean { return typeof value === 'string' && values.includes(value) }
function execution(value: unknown): boolean {
  if (!record(value) || !Array.isArray(value.nodes) || value.nodes.length > 120 || !integer(value.total)
    || (value.total as number) < value.nodes.length || typeof value.truncated !== 'boolean') return false
  let lastSeq = -1
  for (const node of value.nodes) {
    if (!record(node) || !integer(node.seq) || (node.seq as number) <= lastSeq || !integer(node.turn)
      || !oneOf(node.kind, ['turn', 'step', 'tool', 'attempt', 'dispatch'])
      || !oneOf(node.status, ['running', 'completed', 'failed', 'cancelled', 'interrupted', 'blocked', 'limited', 'unknown'])
      || !integer(node.startedAt) || (node.endedAt !== undefined && !integer(node.endedAt, node.startedAt as number))
      || (node.step !== undefined && !integer(node.step))
      || ['name', 'childId', 'callId'].some(key => node[key] !== undefined && typeof node[key] !== 'string')) return false
    lastSeq = node.seq as number
  }
  if (value.progress !== undefined) {
    const p = value.progress
    if (!record(p) || !integer(p.turn) || !integer(p.startedAt)
      || !oneOf(p.status, ['running', 'completed', 'failed', 'cancelled', 'interrupted', 'blocked', 'limited', 'unknown'])
      || (p.endedAt !== undefined && !integer(p.endedAt, p.startedAt as number))
      || !['steps', 'completedSteps', 'failedSteps', 'tools', 'completedTools', 'failedTools'].every(key => integer(p[key]))
      || (p.completedSteps as number) + (p.failedSteps as number) > (p.steps as number)
      || (p.completedTools as number) + (p.failedTools as number) > (p.tools as number)) return false
    if (p.current !== undefined && (!record(p.current) || !integer(p.current.seq) || !oneOf(p.current.kind, ['step', 'tool'])
      || (p.current.name !== undefined && typeof p.current.name !== 'string'))) return false
  }
  return true
}

function cooperation(value: unknown, ids: ReadonlySet<string>): boolean {
  if (!record(value) || !integer(value.total) || !Array.isArray(value.events) || value.events.length > 1000
    || (value.total as number) < value.events.length || typeof value.truncated !== 'boolean') return false
  const keys = new Set<string>()
  for (const row of value.events) {
    if (!record(row) || typeof row.id !== 'string' || keys.has(row.id) || !integer(row.seq) || !integer(row.time)
      || !['sessionId', 'fromId', 'toId'].every(key => typeof row[key] === 'string' && ids.has(row[key] as string))
      || row.fromId === row.toId || !oneOf(row.kind, ['dispatch', 'return', 'message'])
      || !oneOf(row.source, ['catalog', 'workflow', 'settlement', 'agent', 'team']) || !oneOf(row.delivery, ['queued', 'recorded'])
      || (row.phase !== undefined && typeof row.phase !== 'string')
      || (row.outcome !== undefined && !oneOf(row.outcome, ['running', 'completed', 'failed', 'cancelled', 'interrupted', 'blocked', 'limited', 'unknown']))) return false
    keys.add(row.id)
  }
  return true
}

export function parseExecutionDetail(value: unknown, sessionId: string, seq: number): ExecutionDetail {
  if (!record(value) || value.protocol !== MONITOR_PROTOCOL || value.sessionId !== sessionId || value.seq !== seq
    || typeof value.input !== 'string' || value.input.length > 6000 || typeof value.output !== 'string' || value.output.length > 6000
    || typeof value.truncated !== 'boolean') throw new TypeError('Invalid execution detail')
  return value as unknown as ExecutionDetail
}
function catalog(value: unknown, scopeId: string): boolean {
  if (!record(value) || value.scopeId !== scopeId || !oneOf(value.state, ['ready', 'unavailable'])
    || !integer(value.total) || typeof value.truncated !== 'boolean' || !Array.isArray(value.sessions)
    || value.sessions.length > 256 || (value.total as number) < value.sessions.length) return false
  const ids = new Set<string>()
  for (const row of value.sessions) {
    if (!record(row) || typeof row.id !== 'string' || row.id.length === 0 || row.id === scopeId || ids.has(row.id)
      || typeof row.parentId !== 'string' || row.parentId.length === 0 || row.parentId === row.id
      || !integer(row.depth, 1) || (row.depth === 1 && row.parentId !== scopeId)
      || !oneOf(row.status, ['running', 'completed', 'failed', 'cancelled', 'interrupted', 'inactive', 'idle', 'blocked', 'limited', 'unknown'])
      || typeof row.navigable !== 'boolean' || (row.navigable && row.mode === undefined)
      || (row.mode !== undefined && !oneOf(row.mode, ['one-shot', 'continuable']))
      || (row.diagnostic !== undefined && (!oneOf(row.diagnostic, ['corrupt', 'unsupported', 'unavailable']) || row.navigable))
      || (row.label !== undefined && typeof row.label !== 'string') || (row.title !== undefined && typeof row.title !== 'string')
      || (row.createdAt !== undefined && !integer(row.createdAt)) || (row.updatedAt !== undefined && !integer(row.updatedAt))
      || (row.execution !== undefined && !execution(row.execution))) return false
    ids.add(row.id)
  }
  return true
}
function workflow(value: unknown): boolean {
  if (!record(value) || !Array.isArray(value.runs) || value.runs.length > 100 || !record(value.counts)
    || !['runs', 'members', 'running', 'completed'].every(key => integer((value.counts as Record<string, unknown>)[key]))
    || !integer(value.lastEventSeq) || !integer(value.lastActivityAt) || typeof value.truncated !== 'boolean') return false
  const statuses = ['running', 'completed', 'failed', 'cancelled', 'interrupted', 'inactive']
  let members = 0
  const ids = new Set<string>()
  for (const run of value.runs) {
    if (!record(run) || typeof run.id !== 'string' || ids.has(run.id) || typeof run.name !== 'string'
      || !oneOf(run.status, statuses) || !integer(run.memberCount) || !Array.isArray(run.members)) return false
    ids.add(run.id)
    members += run.members.length
    const sequences = new Set<number>()
    for (const member of run.members) {
      if (!record(member) || !integer(member.seq) || sequences.has(member.seq as number)
        || typeof member.id !== 'string' || typeof member.name !== 'string' || !oneOf(member.status, statuses)
        || (member.phase !== undefined && typeof member.phase !== 'string')
        || (member.model !== undefined && typeof member.model !== 'string')) return false
      sequences.add(member.seq as number)
    }
  }
  return members <= 256
}

/** Validate the plugin-owned JSON boundary, including closed statuses and bounded row arrays. */
export function parseSnapshot(value: unknown, sessionId: string): MonitorSnapshot {
  const fail = (): never => { throw new TypeError('Invalid Agent Teams monitor response') }
  if (!record(value) || value.protocol !== MONITOR_PROTOCOL || value.sessionId !== sessionId
    || typeof value.enabled !== 'boolean') return fail()
  if (value.catalog !== undefined && !catalog(value.catalog, value.kind === 'team' && typeof value.teamId === 'string' ? value.teamId : sessionId)) return fail()
  if (value.execution !== undefined && !execution(value.execution)) return fail()
  const scopeId = value.kind === 'team' && typeof value.teamId === 'string' ? value.teamId : sessionId
  const ids = new Set([scopeId, ...((value.catalog as { sessions: { id: string }[] } | undefined)?.sessions.map(row => row.id) ?? [])])
  if (value.cooperation !== undefined && !cooperation(value.cooperation, ids)) return fail()
  if (value.kind === 'unavailable') {
    if (!oneOf(value.reason, ['no-session', 'not-team', 'incompatible', 'storage-unavailable'])) return fail()
  } else if (value.kind === 'agents') {
    if (!oneOf(value.source, ['live', 'persisted']) || (value.catalog === undefined && value.execution === undefined)) return fail()
  } else if (value.kind === 'workflow') {
    if (!oneOf(value.source, ['live', 'persisted']) || !workflow(value.workflows)) return fail()
  } else if (value.kind === 'team') {
    if (typeof value.teamId !== 'string' || !oneOf(value.source, ['live', 'persisted'])
      || !integer(value.lastEventSeq) || !integer(value.lastActivityAt) || typeof value.truncated !== 'boolean'
      || !record(value.counts) || !['members', 'tasks', 'completed', 'blocked', 'pendingMessages'].every(key => integer(value.counts && (value.counts as Record<string, unknown>)[key]))
      || !Array.isArray(value.members) || value.members.length > 256 || !Array.isArray(value.tasks) || value.tasks.length > 1000) return fail()
    for (const member of value.members) {
      if (!record(member) || typeof member.id !== 'string' || typeof member.name !== 'string'
        || typeof member.description !== 'string' || !oneOf(member.role, ['lead', 'teammate'])
        || !oneOf(member.status, ['running', 'idle', 'inactive', 'provisioning', 'failed'])
        || !integer(member.pendingMessages) || !integer(member.diagnosticCount)
        || (member.model !== undefined && typeof member.model !== 'string')
        || (member.context !== undefined && !oneOf(member.context, ['fresh', 'fork']))) return fail()
    }
    for (const task of value.tasks) {
      if (!record(task) || typeof task.id !== 'string' || typeof task.subject !== 'string' || typeof task.description !== 'string'
        || !integer(task.revision, 1) || !oneOf(task.status, ['pending', 'in_progress', 'completed'])
        || typeof task.ready !== 'boolean' || !strings(task.blockedBy) || !strings(task.writeScopes) || !strings(task.overlappingTaskIds)
        || (task.ownerName !== undefined && typeof task.ownerName !== 'string')) return fail()
    }
    if (new Set(value.members.map(member => member.id)).size !== value.members.length
      || new Set(value.tasks.map(task => task.id)).size !== value.tasks.length) return fail()
    if (value.workflows !== undefined && !workflow(value.workflows)) return fail()
  } else return fail()
  return value as unknown as MonitorSnapshot
}
