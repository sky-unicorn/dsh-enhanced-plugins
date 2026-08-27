import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {
  ToolWorkflowRunStartData, ToolWorkflowAgentStartData, ToolWorkflowAgentEndData, ToolWorkflowRunEndData,
} from '@deepseek-ai/dsh-tool-workflow/types'
import type { WorkflowActivity, WorkflowMember, WorkflowRun } from '../shared.js'

type RecordData = ToolWorkflowRunStartData | ToolWorkflowAgentStartData | ToolWorkflowAgentEndData | ToolWorkflowRunEndData
interface RunState {
  view: WorkflowRun
  turn?: number
  step?: number
  closed: boolean
  ended: boolean
  historical: boolean
}

const RUN_LIMIT = 100
const MEMBER_LIMIT = 256
const fail = (): never => { throw new TypeError('Invalid workflow monitor record') }

/** Validate the public durable extension boundary; never include raw records in errors. */
function dataRecord(value: RecordData): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail()
  const data = value as unknown as Record<string, unknown>
  if (typeof data.runId !== 'string' || data.runId.length === 0) return fail()
  return data
}
function memberSequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail()
  return value
}

/**
 * Read one session's own workflow suffix using the tool's public event vocabulary.
 * No script evaluation, child enumeration, Agent activation, or inferred future phases.
 */
export function describeWorkflows(
  meta: SessionHeader, events: readonly SessionEvent[], agent: (id: SessionId) => Agent | undefined,
): WorkflowActivity | undefined {
  const runs = new Map<string, RunState>()
  let turn: number | undefined
  let step: number | undefined
  let last: SessionEvent | undefined
  for (const event of events.slice(meta.seedLength ?? 0)) {
    if (event.type === 'session/end-seed') {
      // A new activation of the parent cannot attest a previous workflow's
      // liveness. Keep unmatched seeded records unknown, never completed.
      for (const run of runs.values()) if (!run.ended) run.historical = true
    }
    if (event.type === 'turn/start') { turn = event.data.turn; step = undefined }
    if (event.type === 'step/start') { turn = event.data.turn; step = event.data.step }
    if (event.type === 'step/end' || event.type === 'turn/end') {
      for (const run of runs.values()) {
        if (!run.ended && run.turn === event.data.turn
          && (event.type === 'turn/end' || run.step === event.data.step)) {
          run.closed = true
          last = event
        }
      }
    }
    if (!event.type.startsWith('tool-workflow/')) continue
    switch (event.type) {
      case 'tool-workflow/run-start': {
        const data = dataRecord(event.data)
        if (typeof data.name !== 'string' || runs.has(String(data.runId))) return fail()
        runs.set(String(data.runId), { view: { id: String(data.runId), name: data.name, status: 'running', memberCount: 0, members: [] }, turn, step, closed: false, ended: false, historical: false })
        break
      }
      case 'tool-workflow/agent-start': {
        const data = dataRecord(event.data)
        const seq = memberSequence(data.seq)
        const run = runs.get(String(data.runId))
        if (run === undefined || run.ended || run.closed || run.view.members.some(member => member.seq === seq)
          || typeof data.label !== 'string' || typeof data.childId !== 'string' || data.childId.length === 0
          || (data.phase !== undefined && typeof data.phase !== 'string')) return fail()
        run.view.members.push({ seq, id: data.childId, name: data.label, status: 'running',
          ...(data.phase === undefined ? {} : { phase: data.phase as string }) })
        run.view.memberCount++
        break
      }
      case 'tool-workflow/agent-end': {
        const data = dataRecord(event.data)
        const run = runs.get(String(data.runId))
        const member = run?.view.members.find(item => item.seq === memberSequence(data.seq))
        if (run === undefined || run.ended || run.closed || member === undefined || member.status !== 'running'
          || typeof data.outcome !== 'string' || !['completed', 'failed', 'cancelled'].includes(data.outcome)) return fail()
        member.status = data.outcome as 'completed' | 'failed' | 'cancelled'
        break
      }
      case 'tool-workflow/run-end': {
        const data = dataRecord(event.data)
        const run = runs.get(String(data.runId))
        if (run === undefined || run.ended || run.closed || typeof data.stopReason !== 'string'
          || !['completed', 'error', 'cancelled'].includes(data.stopReason)) return fail()
        run.ended = true
        run.view.status = data.stopReason === 'error' ? 'failed' : data.stopReason as 'completed' | 'cancelled'
        break
      }
      default:
        // A future workflow event requires an explicit compatible reader.
        return fail()
    }
    last = event
  }
  if (runs.size === 0 || last === undefined) return undefined
  const parent = agent(meta.id)
  const counts = { runs: runs.size, members: 0, running: 0, completed: 0 }
  for (const run of runs.values()) {
    if (!run.ended) run.view.status = run.closed ? 'interrupted' : !run.historical && parent?.status === 'running' ? 'running' : 'inactive'
    for (const member of run.view.members) {
      if (member.status === 'running') {
        // A run ending does not prove an unacknowledged child completed.
        if (run.closed || run.ended) member.status = 'interrupted'
        else if (run.view.status !== 'running') member.status = 'inactive'
      }
      const live = agent(member.id as SessionId)
      if (live?.options.model !== undefined) member.model = live.options.model
      counts.members++
      if (member.status === 'running') counts.running++
      if (member.status === 'completed') counts.completed++
    }
  }
  // Newest runs first; cap the total member rows across runs, not per run.
  let remaining = MEMBER_LIMIT
  const views = [...runs.values()].reverse().slice(0, RUN_LIMIT).map(({ view }) => {
    const members: WorkflowMember[] = view.members.slice(0, remaining)
    remaining -= members.length
    return { ...view, members }
  })
  return { runs: views, counts, lastEventSeq: last.seq, lastActivityAt: last.time,
    truncated: runs.size > RUN_LIMIT || counts.members > MEMBER_LIMIT }
}
