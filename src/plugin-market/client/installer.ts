import type { Context } from '@deepseek-ai/cordis'
import type {
  ChangeResult,
  InstallBundleOptions,
  PluginInstallRequestId,
} from '@deepseek-ai/dsh-api-remotes/client'

/** Presentation of a DSH-owned installation; never persists profile or approval state. */
export interface InstallSnapshot {
  readonly spec?: string
  readonly pending: boolean
  readonly cancelling: boolean
  readonly result?: ChangeResult
  /** A transport failure leaves the Host outcome unknown until cancellation is acknowledged. */
  readonly error?: string
}

/** Optional web transport used to apply the Windows install-only proxy scope in the Host. */
export interface MarketInstallTransport {
  readonly install: (spec: string, options: InstallBundleOptions) => Promise<{
    readonly ok: boolean
    readonly value?: ChangeResult
    readonly error?: { readonly message: string }
  }>
  readonly cancel: (requestId: PluginInstallRequestId) => Promise<{
    readonly ok: boolean
    readonly value?: { readonly status: 'cancelled' | 'too-late' | 'not-running' }
    readonly error?: { readonly message: string }
  }>
}

/** Thin current-profile install adapter. The Web client uses the market Host endpoint; tests and non-Web callers may use DSH's Remote directly. */
export class MarketInstaller {
  private snapshot: InstallSnapshot = { pending: false, cancelling: false }
  private listeners = new Set<() => void>()
  private requestId: PluginInstallRequestId | undefined
  private disposed = false

  private readonly transport: MarketInstallTransport

  constructor(manager: Context['remote']['pluginManager'], transport?: MarketInstallTransport) {
    this.transport = transport ?? {
      install: (spec, options) => manager.installBundle(spec, options),
      cancel: requestId => manager.cancelInstall(requestId),
    }
  }

  readonly getSnapshot = (): InstallSnapshot => this.snapshot
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(snapshot: InstallSnapshot): void {
    if (this.disposed) return
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }

  /** Start directly, without a marketplace or DSH inspect preflight. */
  readonly install = async (spec: string): Promise<void> => {
    await this.run(spec)
  }

  /** Called only by the explicit approval button; names come from DSH's failed result. */
  readonly approveAndRetry = async (): Promise<void> => {
    const { spec, result } = this.snapshot
    if (spec === undefined || result?.application !== 'failed' || !result.pendingBuilds?.length) return
    await this.run(spec, [...result.pendingBuilds])
  }

  private async run(spec: string, approvedBuilds?: string[]): Promise<void> {
    if (this.disposed || this.snapshot.pending) return
    // getRandomValues also works on non-secure LAN Web origins supported by DSH.
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('') as PluginInstallRequestId
    this.requestId = id
    this.publish({ spec, pending: true, cancelling: false })
    try {
      const response = await this.transport.install(spec, {
        requestId: id,
        ...(approvedBuilds === undefined ? {} : { approvedBuilds }),
      })
      if (this.requestId !== id) return
      if (!response.ok) throw new Error(response.error?.message ?? '插件安装请求失败。')
      if (response.value === undefined) throw new Error('插件安装没有返回结果。')
      this.requestId = undefined
      this.publish({ spec, pending: false, cancelling: false, result: response.value })
    } catch (error) {
      if (this.requestId !== id) return
      this.publish({ spec, pending: true, cancelling: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Only DSH's cancellation acknowledgement can settle an interrupted request. */
  readonly cancel = async (): Promise<void> => {
    const id = this.requestId
    if (id === undefined || this.snapshot.cancelling) return
    this.publish({ ...this.snapshot, cancelling: true })
    try {
      const response = await this.transport.cancel(id)
      if (this.requestId !== id) return
      if (!response.ok) throw new Error(response.error?.message ?? '取消插件安装请求失败。')
      if (response.value === undefined) throw new Error('取消插件安装没有返回结果。')
      if (response.value.status === 'cancelled') {
        this.requestId = undefined
        this.publish({ spec: this.snapshot.spec, pending: false, cancelling: false,
          result: { changed: false, application: 'cancelled', stage: 'install', target: this.snapshot.spec ?? '' } })
      } else if (response.value.status === 'not-running' && this.snapshot.error) {
        this.requestId = undefined
        this.publish({ ...this.snapshot, pending: false, cancelling: false })
      } else {
        // too-late waits for the original result; not-running after a disconnect
        // cannot prove whether an installation succeeded. Keep the uncertainty visible.
        this.publish({ ...this.snapshot, cancelling: false })
      }
    } catch (error) {
      if (this.requestId !== id) return
      this.publish({ ...this.snapshot, cancelling: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Unload asks the Host to stop its request; a lost connection does not imply rollback. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.listeners.clear()
    if (this.requestId !== undefined) {
      try { await this.transport.cancel(this.requestId) } catch { /* Host lifetime owns a disconnected request. */ }
    }
  }
}
