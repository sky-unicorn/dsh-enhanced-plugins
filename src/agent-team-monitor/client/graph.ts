import type { MonitorTask } from '../shared.ts'

/** Deterministic dependency layout. A defensive cycle refusal prevents malformed wire data hanging the UI. */
export function layoutTasks(tasks: readonly MonitorTask[]) {
  const remaining = new Map(tasks.map(task => [task.id, task]))
  const levels = new Map<string, number>()
  while (remaining.size > 0) {
    let changed = false
    for (const [id, task] of remaining) {
      if (task.blockedBy.some(parent => remaining.has(parent))) continue
      levels.set(id, task.blockedBy.reduce((level, parent) => Math.max(level, (levels.get(parent) ?? -1) + 1), 0))
      remaining.delete(id)
      changed = true
    }
    if (!changed) throw new Error('Team task graph contains a cycle')
  }
  const rows = new Map<number, number>()
  const nodes = tasks.map(task => {
    const level = levels.get(task.id) ?? 0
    const row = rows.get(level) ?? 0
    rows.set(level, row + 1)
    return { task, x: 12 + level * 208, y: 12 + row * 90 }
  })
  const byId = new Map(nodes.map(node => [node.task.id, node]))
  const edges = nodes.flatMap(node => node.task.blockedBy.flatMap(parentId => {
    const parent = byId.get(parentId)
    if (parent === undefined) return []
    const x = parent.x + 172
    const y = parent.y + 34
    return [{ key: `${parentId}:${node.task.id}`, from: parentId, to: node.task.id,
      path: `M${x},${y} C${x + 18},${y} ${node.x - 18},${node.y + 34} ${node.x},${node.y + 34}` }]
  }))
  return { nodes, edges, width: Math.max(380, ...nodes.map(node => node.x + 184)), height: Math.max(92, ...nodes.map(node => node.y + 80)) }
}
