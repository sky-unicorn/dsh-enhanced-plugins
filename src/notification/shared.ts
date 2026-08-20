/** Shared settings contract for desktop task notifications. */

export const NOTIFICATION_SETTINGS_NAMESPACE = 'desktop-notifications'

export type NotificationSound = 'off' | 'subtle' | 'prominent' | 'custom'
export type NotificationBuiltInSound = Exclude<NotificationSound, 'custom'>
export type NotificationSoundChoice = NotificationBuiltInSound | `custom:${string}`
export type NotificationSoundEvent = 'completion' | 'confirmation' | 'blocked'
export type PetPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export type PetSize = 80 | 112 | 144 | 176
export type PetState = 'idle' | 'working' | 'confirmation'
/** Short-lived visual reactions layered over the persistent task state. */
export type PetOutcome = 'ready' | 'blocked'

export interface NotificationSettings {
  /** Sound played after a top-level turn completes. */
  completionSound: NotificationSound
  /** Sound played when an approval or explicit user question starts waiting. */
  confirmationSound: NotificationSound
  /** Sound played after an unsuccessful top-level turn ends. */
  blockedSound: NotificationSound
  /** Positive gain for built-in and custom notification sounds; 0 preserves the source level. */
  soundGain: number
  /** Host-owned file id selected from the shared custom sound library for completion. */
  completionCustomSoundFile: string
  /** Safe display name paired with the selected completion sound file. */
  completionCustomSoundName: string
  /** Host-owned file id selected from the shared custom sound library for confirmation. */
  confirmationCustomSoundFile: string
  /** Safe display name paired with the selected confirmation sound file. */
  confirmationCustomSoundName: string
  /** Host-owned file id selected from the shared custom sound library for blocked tasks. */
  blockedCustomSoundFile: string
  /** Safe display name paired with the selected blocked-task sound file. */
  blockedCustomSoundName: string
  /** Show the native DeepSeek fish pet outside the browser. */
  petEnabled: boolean
  /** Keep the pet above other windows while no task is active. */
  petIdleTopmost: boolean
  /** Width and height of the desktop pet window in device-independent pixels. */
  petSize: PetSize
  /** Fallback screen corner used until the pet has a remembered dragged position. */
  petPosition: PetPosition
}

/** Safe browser-visible metadata for one shared profile-local WAV. */
export interface NotificationCustomSound {
  fileId: string
  name: string
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
    customSounds: NotificationCustomSound[]
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
  fileName: string
  dataBase64: string
}

/** Select a built-in sound or one entry from the shared custom library. */
export interface NotificationSoundSelectionRequest {
  kind: NotificationSoundEvent
  sound: NotificationSound
  customSoundFile?: string
  expectedRevision?: number
}

/** Read-only request to play the Host's currently selected sound. */
export interface NotificationSoundPreviewRequest {
  kind: NotificationSoundEvent
}

/** Committed view, or the authoritative view returned after a stale write. */
export type NotificationMutateOutcome =
  | { kind: 'ok'; view: NotificationConfigView }
  | { kind: 'conflict'; view: NotificationConfigView }

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  completionSound: 'subtle',
  confirmationSound: 'prominent',
  blockedSound: 'prominent',
  soundGain: 0,
  completionCustomSoundFile: '',
  completionCustomSoundName: '',
  confirmationCustomSoundFile: '',
  confirmationCustomSoundName: '',
  blockedCustomSoundFile: '',
  blockedCustomSoundName: '',
  petEnabled: false,
  petIdleTopmost: true,
  petSize: 112,
  petPosition: 'bottom-right',
}
