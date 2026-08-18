/**
 * Minimal stub of the runtime client store engine the card controller
 * imports: `createSnapshotStore` returns a tiny external-store with
 * get/set/subscribe so tests can read controller state and step actions.
 */

export interface SnapshotStore<T> {
  get(): T
  set(value: T): void
  subscribe(listener: () => void): () => void
}

export function createSnapshotStore<T>(init: T): SnapshotStore<T> {
  let current = init
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set: (value) => {
      current = value
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
