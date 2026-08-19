/** Shared settings contract for desktop task notifications. */

export const NOTIFICATION_SETTINGS_NAMESPACE = 'desktop-notifications'

export type NotificationSound = 'off' | 'subtle' | 'prominent' | 'custom'
export type NotificationSoundEvent = 'completion' | 'confirmation'
export type PetPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export type PetSize = 80 | 112 | 144 | 176
export type PetState = 'idle' | 'working' | 'confirmation'

export interface NotificationSettings {
  /** Sound played after a top-level turn completes. */
  completionSound: NotificationSound
  /** Sound played when an approval or explicit user question starts waiting. */
  confirmationSound: NotificationSound
  /** Host-owned file id for the uploaded completion WAV. */
  completionCustomSoundFile: string
  /** Safe display name of the uploaded completion WAV. */
  completionCustomSoundName: string
  /** Host-owned file id for the uploaded confirmation WAV. */
  confirmationCustomSoundFile: string
  /** Safe display name of the uploaded confirmation WAV. */
  confirmationCustomSoundName: string
  /** Show the native always-on-top DeepSeek fish pet. */
  petEnabled: boolean
  /** Width and height of the desktop pet window in device-independent pixels. */
  petSize: PetSize
  /** Screen corner used when the pet starts or its settings change. */
  petPosition: PetPosition
}

/** Redacted, revision-fenced settings view served to this plugin's browser half. */
export type NotificationConfigView =
  | { registered: false }
  | {
    registered: true
    writable: boolean
    value: NotificationSettings
    base?: Partial<NotificationSettings>
    user?: Partial<NotificationSettings>
    revision: number
  }

/** One path-addressed scalar edit accepted by the notification settings Remote. */
export interface NotificationMutateRequest {
  op: {
    op: 'set' | 'unset'
    path: readonly string[]
    value?: unknown
  }
  expectedRevision?: number
}

/** One browser-selected WAV uploaded into the owning DSH profile. */
export interface NotificationSoundUploadRequest {
  kind: NotificationSoundEvent
  fileName: string
  dataBase64: string
  expectedRevision?: number
}

/** Committed view, or the authoritative view returned after a stale write. */
export type NotificationMutateOutcome =
  | { kind: 'ok'; view: NotificationConfigView }
  | { kind: 'conflict'; view: NotificationConfigView }

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  completionSound: 'subtle',
  confirmationSound: 'prominent',
  completionCustomSoundFile: '',
  completionCustomSoundName: '',
  confirmationCustomSoundFile: '',
  confirmationCustomSoundName: '',
  petEnabled: false,
  petSize: 112,
  petPosition: 'bottom-right',
}
