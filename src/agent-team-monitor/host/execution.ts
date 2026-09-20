import { TOOL_OUTCOME_UNKNOWN, TOOL_NOT_STARTED, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ExecutionNode, ExecutionStatus, ExecutionTrace } from '../shared.js'

/** End reasons are extensible in DSH; unknown reasons never become successful outcomes. */
export function executionOutcome(reason: TurnEndReason): ExecutionStatus {
  switch (reason.kind) {
    case 'completed': return 'completed'
    case 'error': return 'failed'
    case 'aborted': return 'cancelled'
    case 'interrupted': return 'interrupted'
    case 'blocked': return 'blocked'
    case 'max-tokens': return 'limited'
    default: return 'unknown'
  }
}

/** Fold only the session's own events. Open cold records and previous activations stay unknown. */
export function describeExecution(events: readonly SessionEvent[], inherited: number, running: boolean): ExecutionTrace {
  const nodes: ExecutionNode[] = []
  const turns = new Map<number, ExecutionNode>()
  const steps = new Map<string, ExecutionNode>()
  const calls = new Map<string, ExecutionNode>()
  const failedSteps = new Set<string>()
  const open = new Set<ExecutionNode>()
  let currentTurn = 0
  let currentStep: number | undefined
  const add = (event: SessionEvent, kind: ExecutionNode['kind'], turn: number, step?: number): ExecutionNode => {
    const node: ExecutionNode = { seq: event.seq, kind, turn, status: 'running', startedAt: event.time,
      ...(step === undefined ? {} : { step }) }
    nodes.push(node); open.add(node)
    return node
  }
  const close = (node: ExecutionNode | undefined, time: number, status: ExecutionStatus) => {
    if (!node || !open.has(node)) return
    node.endedAt = Math.max(node.startedAt, time); node.status = status; open.delete(node)
  }
  for (const event of events.slice(inherited)) {
    switch (event.type) {
      case 'session/end-seed':
        for (const node of open) node.status = 'unknown'
        open.clear()
        break
      case 'turn/start':
        currentTurn = event.data.turn; currentStep = undefined
        turns.set(currentTurn, add(event, 'turn', currentTurn))
        break
      case 'step/start':
        currentTurn = event.data.turn; currentStep = event.data.step
        steps.set(`${currentTurn}:${currentStep}`, add(event, 'step', currentTurn, currentStep))
        break
      case 'tool/call': {
        const node = add(event, 'tool', event.data.turn, event.data.step)
        node.name = event.data.name; node.callId = event.data.callId
        calls.set(`${node.turn}:${node.step}:${node.callId}`, node)
        break
      }
      case 'tool/result': {
        const result = event.data.message.content[0]
        const node = calls.get(`${event.data.turn}:${event.data.step}:${result.toolCallId}`)
        const code = event.data.error?.code
        const status = code === TOOL_OUTCOME_UNKNOWN || code === TOOL_NOT_STARTED ? 'interrupted' : result.isError ? 'failed' : 'completed'
        close(node, event.time, status)
        if (status === 'failed') failedSteps.add(`${event.data.turn}:${event.data.step}`)
        break
      }
      case 'assistant/attempt': {
        // An attempt record is a settlement without a committed message. Its
        // existence alone does not prove error vs cancellation or a later retry.
        const node = add(event, 'attempt', event.data.turn, event.data.step)
        close(node, event.time, 'unknown')
        break
      }
      case 'tool-workflow/agent-start': {
        const node = add(event, 'dispatch', currentTurn, currentStep)
        node.childId = event.data.childId; node.name = event.data.label
        close(node, event.time, 'completed') // Dispatch recorded, not child completion.
        break
      }
      case 'step/end': {
        const step = steps.get(`${event.data.turn}:${event.data.step}`)
        const failed = failedSteps.has(`${event.data.turn}:${event.data.step}`)
        const unresolved = [...open].some(node => node.kind === 'tool' && node.turn === event.data.turn && node.step === event.data.step)
        close(step, event.time, failed ? 'failed' : unresolved ? 'unknown' : 'completed')
        // A missing result cannot be made successful by a step boundary.
        for (const node of open) if (node.kind !== 'turn' && node.turn === event.data.turn && node.step === event.data.step) close(node, event.time, 'unknown')
        break
      }
      case 'turn/end': {
        const status = executionOutcome(event.data.reason)
        close(turns.get(event.data.turn), event.time, status)
        for (const node of open) if (node.turn === event.data.turn) close(node, event.time, status === 'completed' ? 'unknown' : status)
        // step/end is structural, including on a cancelled/failed model request.
        const lastStep = [...steps.values()].reverse().find(node => node.turn === event.data.turn)
        if (lastStep && status !== 'completed' && lastStep.status === 'completed') lastStep.status = status
        break
      }
      default: break // Other events are not execution boundaries.
    }
  }
  if (!running) for (const node of open) node.status = 'unknown'
  const latestTurn = [...turns.values()].at(-1)
  const currentNodes = latestTurn ? nodes.filter(node => node.turn === latestTurn.turn) : []
  const current = [...currentNodes].reverse().find(node => node.status === 'running' && (node.kind === 'tool' || node.kind === 'step'))
  const count = (kind: ExecutionNode['kind'], status?: ExecutionStatus) => currentNodes.filter(node => node.kind === kind && (status === undefined || node.status === status)).length
  const progress = latestTurn === undefined ? undefined : {
    turn: latestTurn.turn, status: latestTurn.status, startedAt: latestTurn.startedAt,
    ...(latestTurn.endedAt === undefined ? {} : { endedAt: latestTurn.endedAt }),
    steps: count('step'), completedSteps: count('step', 'completed'), failedSteps: count('step', 'failed'),
    tools: count('tool'), completedTools: count('tool', 'completed'), failedTools: count('tool', 'failed'),
    ...(current === undefined ? {} : { current: { seq: current.seq, kind: current.kind as 'step' | 'tool', ...(current.name === undefined ? {} : { name: current.name }) } }),
  }
  // Keep ongoing nodes even in long runs, then the most recent settled nodes.
  const limit = 120
  const active = nodes.filter(node => node.status === 'running')
  const selected = new Set(active.slice(-limit))
  for (let index = nodes.length - 1; index >= 0 && selected.size < limit; index--) selected.add(nodes[index]!)
  return { nodes: nodes.filter(node => selected.has(node)), total: nodes.length, truncated: nodes.length > limit, ...(progress ? { progress } : {}) }
}
