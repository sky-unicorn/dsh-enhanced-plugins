/** Reactive browser mirror over the notification plugin's private settings Remote. */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  NotificationConfigView,
  NotificationCustomSound,
  NotificationMutateOutcome,
  NotificationSettings,
  NotificationSoundChoice,
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
    || (value['blockedSound'] !== 'off' && value['blockedSound'] !== 'subtle'
      && value['blockedSound'] !== 'prominent' && value['blockedSound'] !== 'custom')
    || typeof value['completionCustomSoundFile'] !== 'string'
    || typeof value['completionCustomSoundName'] !== 'string'
    || typeof value['confirmationCustomSoundFile'] !== 'string'
    || typeof value['confirmationCustomSoundName'] !== 'string'
    || typeof value['blockedCustomSoundFile'] !== 'string'
    || typeof value['blockedCustomSoundName'] !== 'string'
    || typeof value['soundGain'] !== 'number'
    || !Number.isInteger(value['soundGain'])
    || value['soundGain'] < 0
    || value['soundGain'] > 100
    || typeof value['petEnabled'] !== 'boolean'
    || typeof value['petIdleTopmost'] !== 'boolean'
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
    else if (field === 'blockedSound') decoded.blockedSound = single.blockedSound
    else if (field === 'soundGain') decoded.soundGain = single.soundGain
    else if (field === 'petEnabled') decoded.petEnabled = single.petEnabled
    else if (field === 'petIdleTopmost') decoded.petIdleTopmost = single.petIdleTopmost
    else if (field === 'petSize') decoded.petSize = single.petSize
    else if (field === 'petPosition') decoded.petPosition = single.petPosition
    else if (field === 'completionCustomSoundFile') decoded.completionCustomSoundFile = single.completionCustomSoundFile
    else if (field === 'completionCustomSoundName') decoded.completionCustomSoundName = single.completionCustomSoundName
    else if (field === 'confirmationCustomSoundFile') decoded.confirmationCustomSoundFile = single.confirmationCustomSoundFile
    else if (field === 'confirmationCustomSoundName') decoded.confirmationCustomSoundName = single.confirmationCustomSoundName
    else if (field === 'blockedCustomSoundFile') decoded.blockedCustomSoundFile = single.blockedCustomSoundFile
    else if (field === 'blockedCustomSoundName') decoded.blockedCustomSoundName = single.blockedCustomSoundName
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
  const customSounds = decodeCustomSounds(value['customSounds'])
  if (settings === undefined
    || customSounds === undefined
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
    customSounds,
    revision: value['revision'],
  }
}

const CUSTOM_SOUND_FILE = /^(?:sound|completion|confirmation|blocked)-[0-9a-f-]{36}\.wav$/

function decodeCustomSounds(value: unknown): NotificationCustomSound[] | undefined {
  if (!Array.isArray(value) || value.length > 64) return undefined
  const seen = new Set<string>()
  const sounds: NotificationCustomSound[] = []
  for (const entry of value) {
    if (!isPlainObject(entry)
      || typeof entry['fileId'] !== 'string'
      || !CUSTOM_SOUND_FILE.test(entry['fileId'])
      || seen.has(entry['fileId'])
      || typeof entry['name'] !== 'string'
      || entry['name'].length === 0
      || entry['name'].length > 120
      || !entry['name'].toLowerCase().endsWith('.wav')) {
      return undefined
    }
    seen.add(entry['fileId'])
    sounds.push({ fileId: entry['fileId'], name: entry['name'] })
  }
  return sounds
}

function decodeOutcome(value: unknown): NotificationMutateOutcome | undefined {
  if (!isPlainObject(value) || (value['kind'] !== 'ok' && value['kind'] !== 'conflict')) return undefined
  const view = decodeView(value['view'])
  return view === undefined ? undefined : { kind: value['kind'], view }
}

/** SettingsScope-compatible source with ordered writes and revision-conflict recovery. */
export class NotificationConfigStore implements SettingsScope<NotificationSettings> {
  private snapshot = LOADING
  private customSounds: NotificationCustomSound[] = []
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

  getSoundLibrarySnapshot(): NotificationCustomSound[] {
    return this.customSounds
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

  /** Commit a sound choice and report failure so automatic preview never plays a stale selection. */
  setSound(kind: NotificationSoundEvent, choice: NotificationSoundChoice): Promise<void> {
    const custom = choice.startsWith('custom:') ? choice.slice('custom:'.length) : undefined
    const request = {
      kind,
      sound: custom === undefined ? choice : 'custom',
      ...(custom === undefined ? {} : { customSoundFile: custom }),
    }
    return this.enqueueRemote('notificationConfig/selectSound', request, 'sound selection was rejected')
  }

  unset(field: string): Promise<void> {
    return this.enqueue({ op: 'unset', path: [field] })
  }

  /** Ask the Host to play the currently committed sound selection. */
  async previewSound(kind: NotificationSoundEvent): Promise<void> {
    const result = await this.rpc.call('/api', 'notificationConfig/preview', {
      args: { request: { kind } },
    })
    if (!result.ok) throw new Error('sound preview was rejected')
  }

  /** Upload a browser-provided WAV into the Host-owned shared library. */
  uploadSound(
    fileName: string,
    dataBase64: string,
  ): Promise<void> {
    return this.enqueueRemote('notificationConfig/upload', { fileName, dataBase64 }, 'custom sound upload was rejected')
  }

  private enqueueRemote(method: string, request: Record<string, unknown>, rejected: string): Promise<void> {
    const run = this.writeTail.then(async () => {
      const expectedRevision = this.snapshot.revision
      try {
        const result = await this.rpc.call('/api', method, {
          args: { request: { ...request, expectedRevision } },
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
      throw new Error(rejected)
    })
    this.writeTail = run.catch(() => {})
    return run
  }

  private enqueue(
    op: { op: 'set' | 'unset'; path: string[]; value?: unknown },
    reportFailure = false,
  ): Promise<void> {
    const run = this.writeTail.then(async () => {
      const expectedRevision = this.snapshot.revision
      let failure: unknown
      try {
        const result = await this.rpc.call('/api', 'notificationConfig/mutate', {
          args: { request: { op, expectedRevision } },
        })
        const outcome = result.ok ? decodeOutcome(result.value) : undefined
        if (outcome !== undefined) {
          this.applyView(outcome.view)
          if (outcome.kind === 'conflict' && reportFailure) {
            throw new Error('notification settings changed; latest values were reloaded')
          }
          return
        }
      } catch (error: unknown) {
        failure = error
        // The authoritative read below reconciles transport failures as well.
      }
      await this.refresh()
      if (reportFailure) {
        throw failure instanceof Error ? failure : new Error('notification setting update was rejected')
      }
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
    this.customSounds = view.customSounds
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
    this.customSounds = []
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
