/** Read-only wire contract. No mailbox bodies or provider error payloads cross this boundary. */
export const MONITOR_PROTOCOL = 3 as const
export type MemberStatus = 'running' | 'idle' | 'inactive' | 'provisioning' | 'failed'
export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export interface MonitorMember {
  id: string
  name: string
  role: 'lead' | 'teammate'
  status: MemberStatus
  description: string
  model?: string
  context?: 'fresh' | 'fork'
  pendingMessages: number
  diagnosticCount: number
}

export interface MonitorTask {
  id: string
  revision: number
  subject: string
  description: string
  status: TaskStatus
  ownerName?: string
  blockedBy: string[]
  writeScopes: string[]
  ready: boolean
  overlappingTaskIds: string[]
}

/** Workflow records describe actual child runs, not an Agent Teams task board. */
export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'inactive'
export interface WorkflowMember {
  seq: number
  id: string
  name: string
  phase?: string
  status: WorkflowStatus
  model?: string
}
export interface WorkflowRun {
  id: string
  name: string
  status: WorkflowStatus
  memberCount: number
  members: WorkflowMember[]
}
export interface WorkflowActivity {
  runs: WorkflowRun[]
  counts: { runs: number; members: number; running: number; completed: number }
  lastEventSeq: number
  lastActivityAt: number
  truncated: boolean
}

/** Actual child-session identity, independent of a role label or workflow run. */
export type ChildSessionStatus = WorkflowStatus | 'idle' | 'blocked' | 'limited' | 'unknown'
export interface MonitorChildSession {
  id: string
  parentId: string
  depth: number
  label?: string
  title?: string
  mode?: 'one-shot' | 'continuable'
  status: ChildSessionStatus
  createdAt?: number
  updatedAt?: number
  navigable: boolean
  diagnostic?: 'corrupt' | 'unsupported' | 'unavailable'
}
export interface MonitorCatalog {
  scopeId: string
  state: 'ready' | 'unavailable'
  sessions: MonitorChildSession[]
  total: number
  truncated: boolean
}

export type UnavailableReason = 'no-session' | 'not-team' | 'incompatible' | 'storage-unavailable'

/** A response is addressed twice so stale replies cannot paint a different conversation. */
export type MonitorSnapshot = {
  protocol: typeof MONITOR_PROTOCOL
  sessionId: string
  enabled: boolean
  catalog?: MonitorCatalog
} & ({ kind: 'unavailable'; reason: UnavailableReason } | {
  kind: 'agents'
  source: 'live' | 'persisted'
} | {
  kind: 'workflow'
  source: 'live' | 'persisted'
  workflows: WorkflowActivity
} | {
  kind: 'team'
  teamId: string
  source: 'live' | 'persisted'
  lastEventSeq: number
  lastActivityAt: number
  members: MonitorMember[]
  tasks: MonitorTask[]
  counts: { members: number; tasks: number; completed: number; blocked: number; pendingMessages: number }
  truncated: boolean
  workflows?: WorkflowActivity
})

export type TeamSnapshot = Extract<MonitorSnapshot, { kind: 'team' }>
