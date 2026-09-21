import { reportedTotal } from '../accounting.ts'
import type { ModelRef, Role, RunRecord } from '../shared.ts'

export interface ModelCallSummary {
  key: string
  model: ModelRef
  calls: number
  reported: number
  unknownUsage: number
  roles: (Role | 'main' | 'compaction')[]
}

/** Count only calls confirmed by the Host request header, including earlier upgrade executions. */
export function summarizeModelCalls(run: RunRecord): ModelCallSummary[] {
  const roleByExecution = new Map<string, Role>()
  for (const task of run.tasks) {
    roleByExecution.set(task.executionId, task.role)
    for (const execution of task.executions ?? []) roleByExecution.set(execution.id, task.role)
  }
  const summaries = new Map<string, ModelCallSummary>()
  for (const request of run.requests) {
    const model = request.actualModel
    if (!model) continue
    const key = JSON.stringify([model.provider, model.model])
    const role = request.purpose === 'compaction'
      ? 'compaction'
      : request.sessionId === run.sessionId
        ? 'main'
        : roleByExecution.get(request.executionId)
    const current = summaries.get(key) ?? { key, model, calls: 0, reported: 0, unknownUsage: 0, roles: [] }
    current.calls += 1
    const usage = reportedTotal(request)
    if (usage === undefined) current.unknownUsage += 1
    else current.reported += usage
    if (role && !current.roles.includes(role)) current.roles.push(role)
    summaries.set(key, current)
  }
  return [...summaries.values()].sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key))
}
