// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { Config } from '../../src/model-router/host/config.ts'
import { useAutoSaveSettings } from '../../src/model-router/client/useAutoSaveSettings.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren() })
async function setup() {
  vi.useFakeTimers()
  type Scope = Parameters<typeof useAutoSaveSettings>[0]
  let snapshot: ReturnType<Scope['getSnapshot']> = { status: 'ready', value: Config({}), revision: 1, writable: true, mode: 'host', base: {}, user: {} }
  const listeners = new Set<() => void>()
  let reject = false
  const scope: Scope = {
    getSnapshot: () => snapshot,
    subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn) } },
    mutate: vi.fn(async (ops, revision) => {
      if (reject || revision !== snapshot.revision) return
      const value = structuredClone(snapshot.value!)
      for (const op of ops) if (op.op === 'set') Object.assign(value, { [String(op.path[0])]: op.value })
      snapshot = { ...snapshot, value, revision: snapshot.revision! + 1 }
      listeners.forEach(fn => fn())
    }),
  }
  let state!: ReturnType<typeof useAutoSaveSettings>
  function Editor() { state = useAutoSaveSettings(scope); return null }
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<Editor/>))
  return { scope, get state() { return state }, reject: () => { reject = true },
    edit: async (n: number) => act(async () => state.update(v => { v.limits.maxConcurrentChildren = n })),
    tick: async () => act(async () => { await vi.advanceTimersByTimeAsync(400) }),
    external: async (n: number) => act(async () => {
      const value = structuredClone(snapshot.value!); value.limits.maxConcurrentChildren = n
      snapshot = { ...snapshot, value, revision: snapshot.revision! + 1 }; listeners.forEach(fn => fn())
    }),
    close: async () => act(async () => root.unmount()),
  }
}
it('coalesces edits, persists only changed fields and flushes on leaving settings', async () => {
  const s = await setup()
  await s.edit(1); await s.edit(3)
  expect(s.scope.mutate).not.toHaveBeenCalled()
  await s.tick()
  expect(s.scope.mutate).toHaveBeenCalledTimes(1)
  expect(s.scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['limits'], value: s.state.draft!.limits }], 1)
  expect(s.state.message).toBe('saved')
  await s.edit(4); await s.close()
  expect(s.scope.getSnapshot().value!.limits.maxConcurrentChildren).toBe(4)
})
it('keeps a rejected draft without retry loops or false success', async () => {
  const s = await setup(); s.reject()
  await s.edit(0); await s.tick(); await s.tick()
  expect(s.state.message).toBe('saveError')
  expect(s.state.draft!.limits.maxConcurrentChildren).toBe(0)
  expect(s.scope.mutate).toHaveBeenCalledTimes(1)
  await s.close()
})
it('fences external changes, preserves local input and reloads explicitly', async () => {
  const s = await setup()
  await s.edit(1); await s.external(4); await s.tick()
  expect(s.scope.mutate).not.toHaveBeenCalled()
  expect(s.state.message).toBe('conflict')
  expect(s.state.draft!.limits.maxConcurrentChildren).toBe(1)
  await act(async () => s.state.reload())
  expect(s.state.draft!.limits.maxConcurrentChildren).toBe(4)
  await s.external(2)
  expect(s.state.draft!.limits.maxConcurrentChildren).toBe(2)
  await s.close()
})

it('retains separate changes made before React commits and cancels an edit reverted before saving', async () => {
  const s = await setup()
  await act(async () => {
    s.state.update(v => { v.limits.maxConcurrentChildren = 3 })
    s.state.update(v => { v.retry.maxRetries = 1 })
  })
  await s.tick()
  expect(s.scope.getSnapshot().value!.limits.maxConcurrentChildren).toBe(3)
  expect(s.scope.getSnapshot().value!.retry.maxRetries).toBe(1)
  await s.edit(4); await s.edit(3); await s.tick()
  expect(s.scope.mutate).toHaveBeenCalledTimes(1)
  expect(s.state.message).toBeUndefined()
  await s.close()
})
