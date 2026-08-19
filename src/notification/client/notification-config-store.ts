/** Reactive browser mirror over the notification plugin's private settings Remote. */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  NotificationConfigView,
  NotificationMutateOutcome,
  NotificationSettings,
  NotificationSoundEvent,
} from '../shared.ts'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../shared.ts'

const LOADING: SettingsScopeSnapshot<NotificationSettings> = {
  status: 'loading',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
  mode: 'host',
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Narrow one untrusted wire section to the plugin's public settings contract. */
export function decodeNotificationSettings(value: unknown): NotificationSettings | undefined {
  if (!isPlainObject(value)) return undefined
  if ((value['completionSound'] !== 'off' && value['completionSound'] !== 'subtle'
      && value['completionSound'] !== 'prominent' && value['completionSound'] !== 'custom')
    || (value['confirmationSound'] !== 'off' && value['confirmationSound'] !== 'subtle'
      && value['confirmationSound'] !== 'prominent' && value['confirmationSound'] !== 'custom')
    || typeof value['completionCustomSoundFile'] !== 'string'
    || typeof value['completionCustomSoundName'] !== 'string'
    || typeof value['confirmationCustomSoundFile'] !== 'string'
    || typeof value['confirmationCustomSoundName'] !== 'string'
    || typeof value['petEnabled'] !== 'boolean'
    || (value['petSize'] !== 80 && value['petSize'] !== 112
      && value['petSize'] !== 144 && value['petSize'] !== 176)
    || (value['petPosition'] !== 'top-left' && value['petPosition'] !== 'top-right'
      && value['petPosition'] !== 'bottom-left' && value['petPosition'] !== 'bottom-right')) {
    return undefined
  }
  return value as unknown as NotificationSettings
}

function decodeLayer(value: unknown): Partial<NotificationSettings> | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) return undefined
  const decoded: Partial<NotificationSettings> = {}
  for (const [field, fieldValue] of Object.entries(value)) {
    const single = decodeNotificationSettings({
      ...DEFAULT_NOTIFICATION_SETTINGS,
      [field]: fieldValue,
    })
    if (single === undefined || !Object.hasOwn(single, field)) return undefined
    if (field === 'completionSound') decoded.completionSound = single.completionSound
    else if (field === 'confirmationSound') decoded.confirmationSound = single.confirmationSound
    else if (field === 'petEnabled') decoded.petEnabled = single.petEnabled
    else if (field === 'petSize') decoded.petSize = single.petSize
    else if (field === 'petPosition') decoded.petPosition = single.petPosition
    else if (field === 'completionCustomSoundFile') decoded.completionCustomSoundFile = single.completionCustomSoundFile
    else if (field === 'completionCustomSoundName') decoded.completionCustomSoundName = single.completionCustomSoundName
    else if (field === 'confirmationCustomSoundFile') decoded.confirmationCustomSoundFile = single.confirmationCustomSoundFile
    else if (field === 'confirmationCustomSoundName') decoded.confirmationCustomSoundName = single.confirmationCustomSoundName
    else return undefined
  }
  return decoded
}

function decodeView(value: unknown): NotificationConfigView | undefined {
  if (!isPlainObject(value) || typeof value['registered'] !== 'boolean') return undefined
  if (!value['registered']) return { registered: false }
  const settings = decodeNotificationSettings(value['value'])
  const base = decodeLayer(value['base'])
  const user = decodeLayer(value['user'])
  if (settings === undefined
    || typeof value['writable'] !== 'boolean'
    || typeof value['revision'] !== 'number'
    || !Number.isInteger(value['revision'])
    || value['revision'] < 0
    || (value['base'] !== undefined && base === undefined)
    || (value['user'] !== undefined && user === undefined)) {
    return undefined
  }
  return {
    registered: true,
    writable: value['writable'],
    value: settings,
    ...(base === undefined ? {} : { base }),
    ...(user === undefined ? {} : { user }),
    revision: value['revision'],
  }
}

function decodeOutcome(value: unknown): NotificationMutateOutcome | undefined {
  if (!isPlainObject(value) || (value['kind'] !== 'ok' && value['kind'] !== 'conflict')) return undefined
  const view = decodeView(value['view'])
  return view === undefined ? undefined : { kind: value['kind'], view }
}

/** SettingsScope-compatible source with ordered writes and revision-conflict recovery. */
export class NotificationConfigStore implements SettingsScope<NotificationSettings> {
  private snapshot = LOADING
  private readonly listeners = new Set<() => void>()
  private writeTail: Promise<void> = Promise.resolve()

  constructor(private readonly rpc: ClientConnectionRpc) {}

  getSnapshot(): SettingsScopeSnapshot<NotificationSettings> {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Re-read after startup, reconnect, external edits, and every write settlement. */
  async refresh(): Promise<void> {
    try {
      const result = await this.rpc.call('/api', 'notificationConfig/describe', { args: {} })
      if (!result.ok) {
        this.unavailable()
        return
      }
      const view = decodeView(result.value)
      if (view === undefined) throw new Error('notificationConfig/describe: invalid response')
      this.applyView(view)
    } catch {
      // Keep an already rendered last-good view during a transient reconnect.
      if (this.snapshot.status !== 'ready') this.unavailable()
    }
  }

  set(field: string, value: unknown): Promise<void> {
    return this.enqueue({ op: 'set', path: [field], value })
  }

  unset(field: string): Promise<void> {
    return this.enqueue({ op: 'unset', path: [field] })
  }

  /** Upload and select a browser-provided WAV through the Host owner. */
  uploadSound(
    kind: NotificationSoundEvent,
    fileName: string,
    dataBase64: string,
  ): Promise<void> {
    const run = this.writeTail.then(async () => {
      const expectedRevision = this.snapshot.revision
      try {
        const result = await this.rpc.call('/api', 'notificationConfig/upload', {
          args: { request: { kind, fileName, dataBase64, expectedRevision } },
        })
        const outcome = result.ok ? decodeOutcome(result.value) : undefined
        if (outcome !== undefined) {
          this.applyView(outcome.view)
          if (outcome.kind === 'conflict') throw new Error('notification settings changed; latest values were reloaded')
          return
        }
      } catch (error: unknown) {
        await this.refresh()
        throw error
      }
      await this.refresh()
      throw new Error('custom sound upload was rejected')
    })
    this.writeTail = run.catch(() => {})
    return run
  }

  private enqueue(op: { op: 'set' | 'unset'; path: string[]; value?: unknown }): Promise<void> {
    const run = this.writeTail.then(async () => {
      const expectedRevision = this.snapshot.revision
      try {
        const result = await this.rpc.call('/api', 'notificationConfig/mutate', {
          args: { request: { op, expectedRevision } },
        })
        const outcome = result.ok ? decodeOutcome(result.value) : undefined
        if (outcome !== undefined) {
          this.applyView(outcome.view)
          return
        }
      } catch {
        // The authoritative read below reconciles transport failures as well.
      }
      await this.refresh()
    })
    this.writeTail = run.catch(() => {})
    return run
  }

  private applyView(view: NotificationConfigView): void {
    if (!view.registered) {
      this.unavailable()
      return
    }
    // A late read may not replace a newer write response or external refresh.
    if (this.snapshot.revision !== undefined && view.revision < this.snapshot.revision) return
    this.snapshot = {
      status: 'ready',
      value: view.value,
      base: view.base,
      user: view.user,
      revision: view.revision,
      writable: view.writable,
      mode: 'host',
    }
    this.publish()
  }

  private unavailable(): void {
    this.snapshot = {
      status: 'unavailable',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      mode: 'host',
    }
    this.publish()
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}
