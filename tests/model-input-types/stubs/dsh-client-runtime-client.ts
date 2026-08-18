/** Minimal runtime snapshot store used by focused controller tests. */
export function createSnapshotStore<T extends object>(initial: T) {
  let snapshot = structuredClone(initial)
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update(mutator: (draft: T) => void) {
      const next = structuredClone(snapshot)
      mutator(next)
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}
