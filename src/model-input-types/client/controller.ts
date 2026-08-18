/**
 * Browser controller for the official `llm-pi-ai` settings namespace.
 *
 * The controller owns no configuration. It reads the Host-owned, redacted
 * descriptor and changes only one complete `models` array through
 * `settings.mutate`, carrying the descriptor revision. Rebuilding the array is
 * intentional: a pi-ai profile defines `models` as an array-replace field, and
 * every unedited model object is retained verbatim.
 */

import type { IApiClient, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Official pi-ai adapter settings namespace. */
export const PI_AI_SETTINGS_NS = 'llm-pi-ai'

/** Curated request capability exposed by this plugin. */
export type ModelType = 'default' | 'text' | 'multimodal'

/** One configured model row rendered by the card. */
export interface ModelRequestTypeRow {
  /** Stable array identity checked again before a write. */
  id: string
  /** Human label, falling back to {@link id}. */
  name: string
  /** Curated projection of the profile's `input` modalities. */
  type: ModelType
}

/** Configured model rows belonging to one pi-ai route. */
export interface ProviderRequestTypeRows {
  /** Route key and settings-path segment. */
  provider: string
  /** Route display name from its profile, or the route key. */
  displayName: string
  /** Models explicitly present in the resolved profile. */
  models: readonly ModelRequestTypeRow[]
}

/** Value-free write failure kind rendered by localized UI copy. */
export type ModelInputTypesError =
  | { kind: 'conflict' }
  | { kind: 'message'; message: string }

/** Reactive card snapshot. */
export interface ModelInputTypesState {
  /** False when the official namespace is not composed. */
  available: boolean
  /** Whether the Host settings provider accepts writes. */
  writable: boolean
  /** A describe refresh is in flight. */
  loading: boolean
  /** Row identity crossing the wire, or null while idle. */
  saving: string | null
  /** Last write/read failure. */
  error: ModelInputTypesError | null
  /** Whether the most recent user write landed. */
  saved: boolean
  /** Current configured providers that have an explicit model array. */
  providers: readonly ProviderRequestTypeRows[]
}

/** Slot injection face consumed by {@link ModelInputTypesCard}. */
export interface ModelInputTypesFace {
  hooks: {
    /** Card snapshot bound by the slot renderer as `useModelInputTypes`. */
    modelInputTypes: SnapshotStore<ModelInputTypesState>
  }
  /** Persist one model's request capability. */
  selectModelType: (provider: string, index: number, modelId: string, type: ModelType) => void
}

/** Whether a wire value is a plain JSON object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow a DOM or caller value to a supported curated choice. */
export function isModelType(value: unknown): value is ModelType {
  return value === 'default' || value === 'text' || value === 'multimodal'
}

/** Read a profile's modalities as the curated request-type choice. */
export function modelTypeOf(model: Readonly<Record<string, unknown>>): ModelType {
  const input = model['input']
  if (input === undefined || (Array.isArray(input) && input.length === 0)) return 'default'
  if (!Array.isArray(input) || input.some(modality => modality !== 'text' && modality !== 'image')) {
    throw new Error('llm-pi-ai model input must contain only text or image modalities')
  }
  return input.includes('image') ? 'multimodal' : 'text'
}

/** Translate one curated choice to the official profile field. */
export function inputFor(type: ModelType): readonly string[] | undefined {
  if (type === 'default') return undefined
  return type === 'multimodal' ? ['text', 'image'] : ['text']
}

/** Read one provider's raw model array from a descriptor layer. */
function modelsInLayer(layer: unknown, provider: string): Record<string, unknown>[] | undefined {
  if (!isPlainObject(layer)) return undefined
  const providers = layer['providers']
  if (!isPlainObject(providers)) return undefined
  const profile = providers[provider]
  if (profile === undefined) return undefined
  if (!isPlainObject(profile)) throw new Error(`llm-pi-ai provider "${provider}" is not an object`)
  const models = profile['models']
  if (models === undefined) return undefined
  if (!Array.isArray(models) || models.some(model => !isPlainObject(model))) {
    throw new Error(`llm-pi-ai provider "${provider}" models must be an object array`)
  }
  return models as Record<string, unknown>[]
}

/**
 * Resolve one provider's complete model array without materializing schema
 * defaults into the user document. An explicit user array wins, then the
 * composition base; the resolved value is only the final compatibility
 * fallback for descriptors that predate separated layers.
 */
function modelsOf(view: SettingsNamespaceView, provider: string): Record<string, unknown>[] {
  return modelsInLayer(view.user, provider)
    ?? modelsInLayer(view.base, provider)
    ?? modelsInLayer(view.value, provider)
    ?? []
}

/**
 * Project the redacted namespace view into rows without dropping unknown model
 * fields from the private write source.
 */
export function projectModelInputTypes(view: SettingsNamespaceView): ProviderRequestTypeRows[] {
  if (!isPlainObject(view.value) || !isPlainObject(view.value['providers'])) {
    throw new Error('llm-pi-ai settings value must contain a providers record')
  }
  return Object.entries(view.value['providers']).flatMap(([provider, profile]) => {
    if (!isPlainObject(profile)) throw new Error(`llm-pi-ai provider "${provider}" is not an object`)
    const models = modelsOf(view, provider)
    if (models.length === 0) return []
    const rows = models.map((model, index): ModelRequestTypeRow => {
      const id = model['id']
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(`llm-pi-ai provider "${provider}" model ${String(index + 1)} has no id`)
      }
      const name = model['name']
      return {
        id,
        name: typeof name === 'string' && name.length > 0 ? name : id,
        type: modelTypeOf(model),
      }
    })
    const displayName = profile['displayName']
    return [{
      provider,
      displayName: typeof displayName === 'string' && displayName.length > 0 ? displayName : provider,
      models: rows,
    }]
  })
}

/** Build the complete array-replace value for one request-type edit. */
export function modelsWithType(
  view: SettingsNamespaceView,
  provider: string,
  index: number,
  modelId: string,
  type: ModelType,
): Record<string, unknown>[] {
  const models = modelsOf(view, provider)
  const selected = models[index]
  if (selected === undefined || selected['id'] !== modelId) {
    throw new Error(`llm-pi-ai model "${modelId}" moved before its request type was saved`)
  }
  return models.map((model, at) => {
    if (at !== index) return model
    const next = { ...model }
    const input = inputFor(type)
    if (input === undefined) delete next['input']
    else next['input'] = [...input]
    return next
  })
}

/** Human-safe message for unknown transport rejection values. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Map an API rejection into localized or server-supplied presentation. */
function writeError(code: string, message: string): ModelInputTypesError {
  return code === 'settings-conflict' ? { kind: 'conflict' } : { kind: 'message', message }
}

/** Controller joining Settings reads, writes, invalidations, and disposal. */
export class ModelInputTypesController {
  /** Snapshot consumed through the slot renderer's bound selector hook. */
  readonly store: SnapshotStore<ModelInputTypesState> = createSnapshotStore<ModelInputTypesState>({
    available: false,
    writable: false,
    loading: false,
    saving: null,
    error: null,
    saved: false,
    providers: [],
  })

  private generation = 0
  private view: SettingsNamespaceView | undefined

  /** @param api - public Settings wire face. */
  constructor(private readonly api: Pick<IApiClient, 'settings'>) {}

  /** Stable slot injection face for this controller. */
  inject(): ModelInputTypesFace {
    return {
      hooks: { modelInputTypes: this.store },
      selectModelType: (provider, index, modelId, type) => {
        void this.selectModelType(provider, index, modelId, type)
      },
    }
  }

  /** Refresh the namespace descriptor; the latest operation wins. */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((state) => {
      state.loading = true
      state.error = null
      state.saved = false
    })
    try {
      const described = await this.api.settings.describe({})
      if (generation !== this.generation) return
      if (!described.result.ok) throw new Error(described.result.error.message)
      const view = described.result.value.namespaces.find(candidate => candidate.ns === PI_AI_SETTINGS_NS)
      if (view === undefined) {
        this.unavailable()
        return
      }
      this.accept(view, described.result.value.writable)
    } catch (error) {
      if (generation !== this.generation) return
      this.fail({ kind: 'message', message: messageOf(error) })
    }
  }

  /**
   * Converge a pushed settings invalidation unless the controller already
   * holds that revision or a write is settling with its authoritative answer.
   */
  invalidate(revision?: number): void {
    const current = this.store.getSnapshot()
    if (current.saving !== null) return
    if (revision !== undefined && this.view?.revision === revision) return
    void this.load()
  }

  /**
   * Persist one model's request type with a revision fence and write-after-read
   * recovery. A rejected write always re-describes the namespace before the
   * card becomes writable again.
   */
  async selectModelType(provider: string, index: number, modelId: string, type: ModelType): Promise<void> {
    const view = this.view
    const current = this.store.getSnapshot()
    if (view === undefined || !current.writable || current.saving !== null || !isModelType(type)) return

    let models: Record<string, unknown>[]
    try {
      models = modelsWithType(view, provider, index, modelId, type)
    } catch (error) {
      this.fail({ kind: 'message', message: messageOf(error) })
      return
    }

    const generation = ++this.generation
    this.store.update((state) => {
      state.loading = false
      state.saving = `${provider}:${modelId}`
      state.error = null
      state.saved = false
    })
    try {
      const response = await this.api.settings.mutate({
        ns: PI_AI_SETTINGS_NS,
        ops: [{ op: 'set', path: ['providers', provider, 'models'], value: models }],
        expectedRevision: view.revision,
      })
      if (generation !== this.generation) return
      if (!response.result.ok) {
        await this.recover(writeError(response.result.error.code, response.result.error.message), generation)
        return
      }
      this.accept(response.result.value, true)
      this.store.update((state) => { state.saved = true })
    } catch (error) {
      if (generation !== this.generation) return
      await this.recover({ kind: 'message', message: messageOf(error) }, generation)
    }
  }

  /** Suppress in-flight publication after the child fiber is disposed. */
  dispose(): void {
    this.generation += 1
    this.view = undefined
  }

  /** Re-read the winner after a rejected or failed write, retaining the failure. */
  private async recover(failure: ModelInputTypesError, generation: number): Promise<void> {
    try {
      const described = await this.api.settings.describe({})
      if (generation !== this.generation) return
      if (!described.result.ok) {
        this.fail(failure)
        return
      }
      const view = described.result.value.namespaces.find(candidate => candidate.ns === PI_AI_SETTINGS_NS)
      if (view === undefined) {
        this.unavailable()
        return
      }
      this.accept(view, described.result.value.writable)
      this.store.update((state) => {
        state.error = failure
        state.saved = false
      })
    } catch (_recoveryFailure) {
      if (generation !== this.generation) return
      this.fail(failure)
    }
  }

  /** Accept one schema-validated Host descriptor as the current authority. */
  private accept(view: SettingsNamespaceView, writable: boolean): void {
    const providers = projectModelInputTypes(view)
    this.view = view
    this.store.update((state) => {
      state.available = true
      state.writable = writable
      state.loading = false
      state.saving = null
      state.error = null
      state.providers = providers
    })
  }

  /** Remove the card when the owning adapter namespace is absent. */
  private unavailable(): void {
    this.view = undefined
    this.store.update((state) => {
      state.available = false
      state.writable = false
      state.loading = false
      state.saving = null
      state.error = null
      state.saved = false
      state.providers = []
    })
  }

  /** Fail closed: keep the last visible rows but disable stale writes. */
  private fail(error: ModelInputTypesError): void {
    this.store.update((state) => {
      state.writable = false
      state.loading = false
      state.saving = null
      state.error = error
      state.saved = false
    })
  }
}
