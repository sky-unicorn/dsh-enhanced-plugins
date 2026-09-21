import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type ModelRouter from '../../src/model-router/host/service.ts'
import { installSelectionBridge, type SelectionBridge } from '../../src/model-router/host/selection-bridge.ts'

function fixture() {
  let released = false
  const writes: string[] = [], selections: string[] = []
  let managed = true, gate: Promise<void> = Promise.resolve()
  const defaults = { currentSelection: () => ({ provider: 'p', model: 'default' }), async saveSelection(selection: { model: string }) { writes.push(selection.model) } }
  const controller = { async selectModel(request: { sessionId: string; provider: string; model: string }) { await gate; selections.push(request.model); await defaults.saveSelection(request); return { selected: request } } }
  const router = { selectionBridge: undefined as SelectionBridge | undefined, async serializeSelection<T>(_id: string, action: () => Promise<T>) { return action() }, async managesSelection() { return managed } }
  const ctx = { sessionController: controller, agentDefaultModel: defaults, agents: { get: () => undefined }, sessionProjections: {}, sessionQuery: { async observeSession() { return { projections: { values: { modelSelection: { next: { provider: 'p', model: 'persisted', reasoningEffort: 'high' }, lastUsed: null } } }, events: [], [Symbol.dispose]() { released = true } } } } } as unknown as Context
  const originalSelect = controller.selectModel, originalSave = defaults.saveSelection
  const dispose = installSelectionBridge(ctx, router as unknown as ModelRouter)
  return { released: () => released, controller, defaults, router, writes, selections, originalSelect, originalSave, dispose, setManaged(value: boolean) { managed = value }, waitOn(promise: Promise<void>) { gate = promise } }
}

it('rejects managed ordinary selections before session and default side effects', async () => {
  const f = fixture()
  await expect(f.controller.selectModel({ sessionId: 'one', provider: 'p', model: 'unwanted' })).rejects.toThrow('Turn off')
  expect(f.writes).toEqual([]); expect(f.selections).toEqual([])
  await f.dispose()
  expect(f.controller.selectModel).toBe(f.originalSelect); expect(f.defaults.saveSelection).toBe(f.originalSave)
})

it('suppresses only the trusted restore default write, including overlapping ordinary sessions', async () => {
  const f = fixture()
  f.setManaged(false)
  await Promise.all([f.router.selectionBridge!.restore('one', { provider: 'p', model: 'restored' }), f.controller.selectModel({ sessionId: 'two', provider: 'p', model: 'new-default' })])
  expect(f.writes).toEqual(['new-default']); expect(f.selections).toEqual(['restored', 'new-default'])
  await f.dispose()
})

it('drains a restore before uninstalling the default-write suppression', async () => {
  const f = fixture(); let release!: () => void
  f.waitOn(new Promise<void>(resolve => { release = resolve }))
  const restoration = f.router.selectionBridge!.restore('one', { provider: 'p', model: 'restored' })
  const disposal = f.dispose()
  release(); await restoration; await disposal
  expect(f.writes).toEqual([])
  expect(f.defaults.saveSelection).toBe(f.originalSave)
})

it('captures a cold session projection and releases its observation without changing defaults', async () => {
  const f = fixture()
  expect(await f.router.selectionBridge!.capture('cold')).toEqual({ provider: 'p', model: 'persisted', reasoningEffort: 'high' })
  expect(f.released()).toBe(true); expect(f.writes).toEqual([])
  await f.dispose()
})
