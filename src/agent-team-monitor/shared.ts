/** Read-only wire contract. Overview metadata and explicitly requested node payloads are separate. */
export const MONITOR_PROTOCOL = 4 as const
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
  execution?: ExecutionTrace
}

/** Recorded execution, independent of Team task-board state. IDs are session-local event sequences. */
export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'blocked' | 'limited' | 'unknown'
export interface ExecutionNode {
  seq: number
  kind: 'turn' | 'step' | 'tool' | 'attempt' | 'dispatch'
  turn: number
  step?: number
  name?: string
  childId?: string
  status: ExecutionStatus
  startedAt: number
  endedAt?: number
  callId?: string
}
export interface ExecutionTrace {
  nodes: ExecutionNode[]
  total: number
  truncated: boolean
  progress?: ExecutionProgress
}
/** Latest own turn, counted before the display window is truncated; no estimated total. */
export interface ExecutionProgress {
  turn: number
  status: ExecutionStatus
  startedAt: number
  endedAt?: number
  steps: number
  completedSteps: number
  failedSteps: number
  tools: number
  completedTools: number
  failedTools: number
  current?: { seq: number; kind: 'step' | 'tool'; name?: string }
}
/** Cross-session evidence; receipt means recorded by the recipient, not semantic acceptance. */
export interface CooperationEvent {
  id: string
  kind: 'dispatch' | 'return' | 'message'
  source: 'catalog' | 'workflow' | 'settlement' | 'agent' | 'team'
  fromId: string
  toId: string
  sessionId: string
  seq: number
  time: number
  delivery: 'queued' | 'recorded'
  phase?: string
  outcome?: ExecutionStatus
}
export interface CooperationActivity {
  events: CooperationEvent[]
  total: number
  truncated: boolean
}
/** Payloads are loaded only for the selected event, never copied into overview polling. */
export interface ExecutionDetail {
  protocol: typeof MONITOR_PROTOCOL
  sessionId: string
  seq: number
  input: string
  output: string
  truncated: boolean
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
  execution?: ExecutionTrace
  cooperation?: CooperationActivity
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
