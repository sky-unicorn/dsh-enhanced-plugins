import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session-query'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type ModelRouter from './service.js'

export interface SingleSelection { provider: string; model: string; reasoningEffort?: string }
export interface SelectionBridge {
  capture(sessionId: string): Promise<SingleSelection>
  restore(sessionId: string, selection: SingleSelection): Promise<void>
}

/** Compatibility adapter over public methods; never reads private controller fields.
 * Calls from all clients enter the same per-session queue as routing controls.
 * A trusted async-local restore suppresses only its own global-default write.
 */
export function installSelectionBridge(ctx: Context, router: ModelRouter): () => Promise<void> {
  const controller = ctx.sessionController, defaults = ctx.agentDefaultModel
  const restoreScope = new AsyncLocalStorage<boolean>()
  const oldSelect = controller.selectModel, oldSave = defaults.saveSelection
  const selectDescriptor = Object.getOwnPropertyDescriptor(controller, 'selectModel')
  const saveDescriptor = Object.getOwnPropertyDescriptor(defaults, 'saveSelection')
  const restoring = new Set<Promise<unknown>>()
  let active = true
  const select = function(this: typeof controller, request: Parameters<typeof oldSelect>[0]) {
    if (!active) return oldSelect.call(this, request)
    return router.serializeSelection(request.sessionId, async () => {
      if (await router.managesSelection(request.sessionId)) throw new RemoteError('session/model-unavailable', 'Turn off model collaboration before changing the model.', { provider: request.provider, model: request.model })
      return oldSelect.call(this, request)
    })
  }
  const save = function(this: typeof defaults, selection: Parameters<typeof oldSave>[0]) {
    return restoreScope.getStore() ? Promise.resolve() : oldSave.call(this, selection)
  }
  Object.defineProperty(controller, 'selectModel', { configurable: true, writable: true, value: select })
  Object.defineProperty(defaults, 'saveSelection', { configurable: true, writable: true, value: save })
  const bridge: SelectionBridge = {
    async capture(sessionId) {
      const agent = ctx.agents.get(SessionId(sessionId))
      if (!agent) {
        using observed = await ctx.sessionQuery.observeSession(SessionId(sessionId))
        const projection = observed.projections?.values.modelSelection
        if (!projection) throw new Error('Session model selection projection unavailable.')
        const baseline = { ...(projection.next ?? defaults.currentSelection()) }
        const header = [...observed.events].reverse().find(event => event.type === 'request/header')
        const selected = [...observed.events].reverse().find(event => event.type === 'model/selection')
        const sameAsUsed = projection.next?.provider === projection.lastUsed?.provider && projection.next?.model === projection.lastUsed?.model && projection.next?.reasoningEffort === projection.lastUsed?.reasoningEffort
        if (sameAsUsed && header?.type === 'request/header' && (!selected || selected.seq < header.seq) && header.data.header.adapterDefaults?.reasoningEffort) delete baseline.reasoningEffort
        return baseline
      }
      const projected = agent && ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
      const baseline = { ...(projected?.pending ?? projected?.lastUsed ?? defaults.currentSelection()) }
      if (!projected?.pending && projected?.lastUsed && agent?.session.requestHeader()?.adapterDefaults?.reasoningEffort) delete baseline.reasoningEffort
      return baseline
    },
    async restore(sessionId, selection) {
      if (!active) throw new Error('Session selection bridge unavailable.')
      const operation = restoreScope.run(true, () => oldSelect.call(controller, { sessionId: SessionId(sessionId), ...selection }))
      restoring.add(operation)
      try { await operation } finally { restoring.delete(operation) }
    },
  }
  router.selectionBridge = bridge
  return async () => {
    active = false
    await Promise.allSettled([...restoring])
    if (router.selectionBridge === bridge) router.selectionBridge = undefined
    // Compare owned descriptors rather than Cordis's caller-bound method proxies.
    if (Object.getOwnPropertyDescriptor(controller, 'selectModel')?.value === select) {
      if (selectDescriptor) Object.defineProperty(controller, 'selectModel', selectDescriptor)
      else Reflect.deleteProperty(controller, 'selectModel')
    }
    if (Object.getOwnPropertyDescriptor(defaults, 'saveSelection')?.value === save) {
      if (saveDescriptor) Object.defineProperty(defaults, 'saveSelection', saveDescriptor)
      else Reflect.deleteProperty(defaults, 'saveSelection')
    }
  }
}
