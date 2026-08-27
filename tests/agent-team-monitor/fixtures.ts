import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { TeamId, TeamTaskId, TeamMessageId, type TeamMemberSnapshot, type TeamTaskSnapshot } from '@deepseek-ai/dsh-experimental-agent-team'
import { MONITOR_PROTOCOL, type TeamSnapshot, type MonitorSnapshot } from '../../src/agent-team-monitor/shared.ts'

export const rootId = SessionId('team-root')
export const memberId = SessionId('team-researcher')
export const meta = { id: rootId, version: 1, createdAt: 1000 } as SessionHeader
export const member: TeamMemberSnapshot = { id: memberId, name: 'researcher', description: 'Research the ABI', provider: 'spawn', context: 'fresh', phase: 'provisioning' }

/** Valid version-one domain log, checked by the official replay function in tests. */
export function teamEvents(): SessionEvent[] {
  const task: TeamTaskSnapshot = { id: TeamTaskId('task-1'), revision: 1, subject: 'Inspect interfaces', description: 'Check public contracts', status: 'pending', blockedBy: [], writeScopes: ['src'] }
  const teamId = TeamId(rootId)
  const values = [
    { type: 'team/member', data: { version: 1, teamId, member } },
    { type: 'team/member', data: { version: 1, teamId, member: { ...member, phase: 'active' } } },
    { type: 'team/task', data: { version: 1, teamId, task } },
    { type: 'team/task', data: { version: 1, teamId, task: { ...task, revision: 2, status: 'in_progress', ownerId: memberId } } },
    { type: 'team/task', data: { version: 1, teamId, task: { ...task, id: TeamTaskId('task-2'), subject: 'Build monitor', blockedBy: [TeamTaskId('task-1')], writeScopes: ['src/client'] } } },
    { type: 'team/message/queued', data: { version: 1, teamId, message: { id: TeamMessageId('mail-1'), senderId: rootId, senderName: 'lead', targetId: memberId, delivery: 'quiet', content: [{ type: 'text', text: 'PRIVATE_MAILBOX_BODY' }] } } },
  ]
  return values.map((value, seq) => ({ ...value, seq, time: 1000 + seq })) as SessionEvent[]
}

export const wireTeam: TeamSnapshot = {
  protocol: MONITOR_PROTOCOL, kind: 'team', sessionId: 'team-root', teamId: 'team-root', enabled: true, source: 'live', lastEventSeq: 5, lastActivityAt: 1005, truncated: false,
  members: [
    { id: 'team-root', name: 'lead', role: 'lead', status: 'idle', description: '', pendingMessages: 0, diagnosticCount: 0 },
    { id: 'team-researcher', name: 'researcher', role: 'teammate', status: 'running', description: 'Research the ABI', model: 'fixture', context: 'fresh', pendingMessages: 1, diagnosticCount: 0 },
  ],
  tasks: [
    { id: 'task-1', revision: 2, subject: 'Inspect interfaces', description: 'Check public contracts', status: 'in_progress', ownerName: 'researcher', blockedBy: [], writeScopes: ['src'], ready: false, overlappingTaskIds: [] },
    { id: 'task-2', revision: 1, subject: 'Build monitor', description: 'Use public slots', status: 'pending', blockedBy: ['task-1'], writeScopes: ['src/client'], ready: false, overlappingTaskIds: ['task-1'] },
  ],
  counts: { members: 2, tasks: 2, completed: 0, blocked: 1, pendingMessages: 1 },
}

export const wireWorkflow: Extract<MonitorSnapshot, { kind: 'workflow' }> = {
  protocol: MONITOR_PROTOCOL, kind: 'workflow', sessionId: 'workflow-parent', enabled: false, source: 'live',
  workflows: {
    runs: [{ id: 'workflow-1', name: 'gomoku-team-build', status: 'running', memberCount: 1,
      members: [{ seq: 1, id: 'architect-child', name: '整体架构师', phase: '1-总体架构设计', status: 'running' }] }],
    counts: { runs: 1, members: 1, running: 1, completed: 0 }, lastEventSeq: 3, lastActivityAt: 1003, truncated: false,
  },
}
