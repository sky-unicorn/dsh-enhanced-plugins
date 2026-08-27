import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { MonitorSnapshot } from '../shared.ts'
import { parseSnapshot } from './parse.ts'

export interface MonitorState {
  sessionId?: string
  snapshot?: MonitorSnapshot
  open: boolean
  loading: boolean
  failed: boolean
  online: boolean
  detected: boolean
}

/** One current-session read model, with cancellation, stale-response fencing and visibility-aware polling. */
export class MonitorController {
  readonly store = createSnapshotStore<MonitorState>({ open: false, loading: false, failed: false, online: true, detected: false })
  private timer: ReturnType<typeof setTimeout> | undefined
  private request: AbortController | undefined
  private generation = 0
  private disposed = false
  private visible = true
  private failures = 0

  constructor(private readonly rpc: ClientConnectionRpc) {}

  select(sessionId: string | undefined): void {
    if (this.disposed || sessionId === this.store.getSnapshot().sessionId) return
    this.cancel()
    this.failures = 0
    this.store.set({ sessionId, open: false, loading: false, failed: false, online: this.store.getSnapshot().online, detected: false })
    void this.refresh()
  }

  setOpen(open: boolean): void {
    if (this.disposed || (open && !this.store.getSnapshot().detected)) return
    this.store.update(state => { state.open = open })
    if (this.request === undefined) void this.refresh()
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.cancel()
    this.store.update(state => { state.loading = false })
    if (visible) void this.refresh()
  }

  setOnline(online: boolean): void {
    if (this.disposed || this.store.getSnapshot().online === online) return
    this.cancel()
    this.store.update(state => { state.online = online; state.snapshot = undefined; state.loading = false })
    if (online) void this.refresh()
  }

  /** Refresh uses only the read-only Remote; no Agent activation is hidden in navigation or polling. */
  async refresh(): Promise<void> {
    const current = this.store.getSnapshot()
    if (this.disposed || !this.visible || !current.online || current.sessionId === undefined || this.request !== undefined) return
    clearTimeout(this.timer)
    const sessionId = current.sessionId
    const generation = this.generation
    const request = new AbortController()
    this.request = request
    const timeout = setTimeout(() => request.abort(), 15_000)
    this.store.update(state => { state.loading = true })
    try {
      const result = await this.rpc.call('/api', 'agentTeamMonitor/describe', { args: { request: { sessionId } } }, request.signal)
      if (this.disposed || generation !== this.generation) return
      if (!result.ok) throw new Error('Monitor RPC failed')
      const snapshot = parseSnapshot(result.value, sessionId)
      this.failures = 0
      this.store.update(state => {
        state.snapshot = snapshot
        state.failed = false
        if (snapshot.kind !== 'unavailable' || (snapshot.catalog?.sessions.length ?? 0) > 0) state.detected = true
        else if (snapshot.reason === 'not-team' || snapshot.reason === 'no-session') {
          state.detected = false
          state.open = false
        }
      })
    } catch {
      if (this.disposed || generation !== this.generation) return
      this.failures++
      // Never leave stale rows looking live after transport/protocol failure.
      this.store.update(state => { state.failed = true; state.snapshot = undefined })
    } finally {
      clearTimeout(timeout)
      if (generation === this.generation && !this.disposed) {
        this.request = undefined
        this.store.update(state => { state.loading = false })
        const delay = this.failures > 0 ? Math.min(30_000, 2000 * 2 ** Math.min(this.failures, 4)) : this.store.getSnapshot().open ? 1500 : 5000
        this.timer = setTimeout(() => { void this.refresh() }, delay)
      }
    }
  }

  private cancel(): void {
    this.generation++
    clearTimeout(this.timer)
    this.request?.abort()
    this.request = undefined
  }

  dispose(): void { this.disposed = true; this.cancel() }
}
