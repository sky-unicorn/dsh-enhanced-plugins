import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ProductToggleSettings } from '../shared.ts'

export type ToggleError =
  | { kind: 'conflict' }
  | { kind: 'message'; message: string }

export interface ToggleState extends ProductToggleSettings {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'unavailable' | 'error'
  error: ToggleError | null
  writable: boolean
  revision: number
}

interface DescribeView {
  registered?: unknown
  writable?: unknown
  value?: unknown
  revision?: unknown
}

type SetView =
  | { kind: 'ok'; revision: number }
  | { kind: 'conflict'; revision: number }

function decodeSettings(value: unknown): ProductToggleSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('subagentProducts/describe returned an invalid settings value')
  }
  const candidate = value as Partial<Record<keyof ProductToggleSettings, unknown>>
  if (typeof candidate.claudeCode !== 'boolean' || typeof candidate.codex !== 'boolean') {
    throw new TypeError('subagentProducts/describe returned non-boolean product settings')
  }
  return { claudeCode: candidate.claudeCode, codex: candidate.codex }
}

function decodeRevision(value: unknown, endpoint: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${endpoint} returned an invalid revision`)
  }
  return value as number
}

function decodeSetView(value: unknown): SetView {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('subagentProducts/set returned an invalid response')
  }
  const candidate = value as { kind?: unknown; revision?: unknown }
  if (candidate.kind !== 'ok' && candidate.kind !== 'conflict') {
    throw new TypeError('subagentProducts/set returned an unknown result kind')
  }
  return { kind: candidate.kind, revision: decodeRevision(candidate.revision, 'subagentProducts/set') }
}

function message(error: unknown): ToggleError {
  return { kind: 'message', message: error instanceof Error ? error.message : String(error) }
}

export class ToggleController {
  readonly store: SnapshotStore<ToggleState> = createSnapshotStore({
    claudeCode: false, codex: false, status: 'idle', error: null, writable: false, revision: 0,
  })
  private generation = 0

  constructor(private readonly rpc: ClientConnectionRpc) {}

  async load(): Promise<void> {
    await this.refresh(null)
  }

  private async refresh(notice: ToggleError | null): Promise<void> {
    const generation = ++this.generation
    this.store.update(state => { state.status = 'loading'; state.error = null })
    try {
      const response = await this.rpc.call('/api', 'subagentProducts/describe', { args: {} })
      if (!response.ok) throw new Error(response.error.message)
      if (generation !== this.generation) return
      const view = response.value as DescribeView
      if (view.registered !== true || view.value === undefined) {
        this.store.update(state => { state.status = 'unavailable'; state.error = notice; state.writable = false })
        return
      }
      this.accept(
        decodeSettings(view.value),
        view.writable === true,
        decodeRevision(view.revision, 'subagentProducts/describe'),
        notice,
      )
    } catch (error) {
      if (generation === this.generation) this.fail(error)
    }
  }

  async set(product: keyof ProductToggleSettings, enabled: boolean): Promise<void> {
    const state = this.store.getSnapshot()
    if (!state.writable) return
    const generation = ++this.generation
    this.store.update(state => { state.status = 'saving'; state.error = null })
    try {
      const response = await this.rpc.call('/api', 'subagentProducts/set', { args: { request: { product, enabled, expectedRevision: state.revision } } })
      if (!response.ok) throw new Error(response.error.message)
      if (generation !== this.generation) return
      const result = decodeSetView(response.value)
      await this.refresh(result.kind === 'conflict' ? { kind: 'conflict' } : null)
    } catch (error) {
      if (generation !== this.generation) return
      // A failed or rejected write may have raced another editor. Re-read the
      // authoritative section before allowing another click with this revision.
      await this.refresh(message(error))
    }
  }

  dispose(): void { this.generation += 1 }

  private accept(value: ProductToggleSettings, writable: boolean, revision: number, error: ToggleError | null): void {
    this.store.update(state => {
      state.claudeCode = value.claudeCode
      state.codex = value.codex
      state.status = 'ready'; state.error = error; state.writable = writable; state.revision = revision
    })
  }

  private fail(error: unknown): void {
    this.store.update(state => { state.status = 'error'; state.error = message(error); state.writable = false })
  }
}
