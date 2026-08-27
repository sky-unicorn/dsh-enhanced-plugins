/** Test-only observable, matching the public runtime store contract. */
export function createSnapshotStore<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next: T) { value = next; for (const listener of listeners) listener() },
    update(change: (value: T) => void) { value = structuredClone(value); change(value); for (const listener of listeners) listener() },
  }
}
