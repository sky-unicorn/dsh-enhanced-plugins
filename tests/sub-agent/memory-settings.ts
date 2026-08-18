import type { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** Small real settings provider used to verify the plugin against the public seam. */
export class MemorySettings extends SettingsProvider {
  readonly persisted: Array<{ ns: SettingsNamespace; section: Record<string, unknown> }> = []
  private storedDocument: Record<string, unknown>

  constructor(ctx: Context, options?: { document?: Record<string, unknown> }) {
    super(ctx)
    this.storedDocument = structuredClone(options?.document ?? {})
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.storedDocument))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    const detached = structuredClone(section)
    this.persisted.push({ ns, section: detached })
    this.storedDocument[String(ns)] = detached
    return Promise.resolve()
  }
}
