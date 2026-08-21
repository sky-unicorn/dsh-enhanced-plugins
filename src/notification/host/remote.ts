/** Plugin-owned configuration Remote for the Host-private notification namespace. */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  NotificationConfigView,
  NotificationMutateOutcome,
  NotificationMutateRequest,
  NotificationSettings,
  NotificationSoundPreviewRequest,
  NotificationSoundSelectionRequest,
  NotificationSoundUploadRequest,
} from '../shared.js'
import { SETTINGS_NAMESPACE } from './config.js'
import type { DesktopCompanion } from './desktop.js'
import { CustomSoundLibrary } from './sound-library.js'

const FIELDS = new Set<keyof NotificationSettings>([
  'completionSound', 'confirmationSound', 'blockedSound', 'soundGain',
  'petEnabled', 'petCharacter', 'petIdleTopmost', 'petSize', 'petPosition',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isField(value: unknown): value is keyof NotificationSettings {
  return typeof value === 'string' && FIELDS.has(value as keyof NotificationSettings)
}

function validFieldValue(field: keyof NotificationSettings, value: unknown): boolean {
  switch (field) {
    case 'completionSound':
    case 'confirmationSound':
    case 'blockedSound':
      return value === 'off' || value === 'subtle' || value === 'prominent'
    case 'petEnabled':
    case 'petIdleTopmost':
      return typeof value === 'boolean'
    case 'petCharacter':
      return value === 'classic' || value === 'multiview'
    case 'soundGain':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
    case 'petSize':
      return value === 80 || value === 112 || value === 144 || value === 176
    case 'petPosition':
      return value === 'top-left' || value === 'top-right'
        || value === 'bottom-left' || value === 'bottom-right'
    case 'completionCustomSoundFile':
    case 'completionCustomSoundName':
    case 'confirmationCustomSoundFile':
    case 'confirmationCustomSoundName':
    case 'blockedCustomSoundFile':
    case 'blockedCustomSoundName':
      return false
    default:
      return assertNever(field)
  }
}

function assertUploadRequest(value: unknown): NotificationSoundUploadRequest {
  if (!isPlainObject(value)
    || typeof value['fileName'] !== 'string'
    || typeof value['dataBase64'] !== 'string') {
    throw new TypeError('notificationConfig/upload: request must contain fileName and dataBase64')
  }
  return { fileName: value['fileName'], dataBase64: value['dataBase64'] }
}

function validRevision(value: unknown, operation: string): number | undefined {
  const expectedRevision = value
  if (expectedRevision !== undefined && (
    typeof expectedRevision !== 'number'
    || !Number.isInteger(expectedRevision)
    || expectedRevision < 0
  )) {
    throw new TypeError(`${operation}: expectedRevision must be a non-negative integer`)
  }
  return expectedRevision
}

function assertSelectionRequest(value: unknown): NotificationSoundSelectionRequest {
  if (!isPlainObject(value)
    || (value['kind'] !== 'completion' && value['kind'] !== 'confirmation' && value['kind'] !== 'blocked')
    || (value['sound'] !== 'off' && value['sound'] !== 'subtle'
      && value['sound'] !== 'prominent' && value['sound'] !== 'custom')
    || (value['sound'] === 'custom' && typeof value['customSoundFile'] !== 'string')
    || (value['sound'] !== 'custom' && value['customSoundFile'] !== undefined)) {
    throw new TypeError('notificationConfig/selectSound: request must contain a valid sound selection')
  }
  const expectedRevision = validRevision(value['expectedRevision'], 'notificationConfig/selectSound')
  return {
    kind: value['kind'],
    sound: value['sound'],
    ...(value['sound'] === 'custom' ? { customSoundFile: value['customSoundFile'] as string } : {}),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  }
}

function assertPreviewRequest(value: unknown): NotificationSoundPreviewRequest {
  if (!isPlainObject(value)
    || (value['kind'] !== 'completion' && value['kind'] !== 'confirmation' && value['kind'] !== 'blocked')) {
    throw new TypeError('notificationConfig/preview: request must contain a known sound kind')
  }
  return { kind: value['kind'] }
}

function assertNever(value: never): never {
  throw new TypeError(`notificationConfig/mutate: unknown field ${String(value)}`)
}

/** Validate the untrusted Remote request before it reaches the settings seam. */
function assertMutateRequest(value: unknown): NotificationMutateRequest {
  if (!isPlainObject(value) || !isPlainObject(value['op'])) {
    throw new TypeError('notificationConfig/mutate: request must contain one path op')
  }
  const op = value['op']
  if ((op['op'] !== 'set' && op['op'] !== 'unset')
    || !Array.isArray(op['path'])
    || op['path'].length !== 1
    || !isField(op['path'][0])) {
    throw new TypeError('notificationConfig/mutate: op must target one known scalar field')
  }
  const field = op['path'][0]
  if (op['op'] === 'set' && !validFieldValue(field, op['value'])) {
    throw new TypeError(`notificationConfig/mutate: invalid value for ${field}`)
  }
  if (op['op'] === 'unset' && op['value'] !== undefined) {
    throw new TypeError('notificationConfig/mutate: unset must not carry a value')
  }
  const expectedRevision = validRevision(value['expectedRevision'], 'notificationConfig/mutate')
  return {
    op: op['op'] === 'set'
      ? { op: 'set', path: [field], value: op['value'] }
      : { op: 'unset', path: [field] },
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  }
}

/** Portable settings face used because DSH does not expose third-party namespaces over settings.*. */
export class NotificationConfigRemote extends TypertRemoteService {
  static inject = ['settings']

  constructor(
    ctx: Context,
    private readonly companion: Pick<DesktopCompanion, 'preview'>,
    private readonly soundLibrary = new CustomSoundLibrary(ctx),
  ) {
    super(ctx, 'notificationConfig')
  }

  private async view(): Promise<NotificationConfigView> {
    const descriptor = this.ctx.settings.describe()
      .find(entry => entry.ns === SETTINGS_NAMESPACE)
    if (descriptor === undefined) return { registered: false }
    const value = descriptor.value as NotificationSettings
    return {
      registered: true,
      writable: this.ctx.settings.writable,
      value,
      ...(descriptor.base === undefined ? {} : {
        base: descriptor.base as Partial<NotificationSettings>,
      }),
      ...(descriptor.user === undefined ? {} : {
        user: descriptor.user as Partial<NotificationSettings>,
      }),
      customSounds: await this.soundLibrary.list(value),
      revision: descriptor.revision,
    }
  }

  /** Read the authoritative layered section without exposing the document path. */
  @Remote('describe')
  describe(): Promise<NotificationConfigView> {
    return this.view()
  }

  /** Play the currently committed selection without exposing profile-local file paths. */
  @Remote('preview')
  async preview(request: NotificationSoundPreviewRequest): Promise<void> {
    const valid = assertPreviewRequest(request)
    const view = await this.view()
    if (!view.registered) throw new Error('notificationConfig/preview: settings namespace is not registered')
    if (view.value[`${valid.kind}Sound`] === 'off') return
    this.companion.preview(valid.kind, view.value)
  }

  /** Commit one field set/reset under the caller's last observed revision, then re-read. */
  @Remote('mutate')
  async mutate(request: NotificationMutateRequest): Promise<NotificationMutateOutcome> {
    const valid = assertMutateRequest(request)
    try {
      await this.ctx.settings.mutate(
        SETTINGS_NAMESPACE,
        [valid.op as SettingsPathOp],
        valid.expectedRevision,
      )
    } catch (error: unknown) {
      if (error instanceof SettingsConflictError) return { kind: 'conflict', view: await this.view() }
      throw error
    }
    return { kind: 'ok', view: await this.view() }
  }

  /** Atomically select a built-in sound or one shared custom-library entry. */
  @Remote('selectSound')
  async selectSound(request: NotificationSoundSelectionRequest): Promise<NotificationMutateOutcome> {
    const valid = assertSelectionRequest(request)
    const before = await this.view()
    if (!before.registered) throw new Error('notificationConfig/selectSound: settings namespace is not registered')
    const ops: SettingsPathOp[] = [{
      op: 'set', path: [`${valid.kind}Sound`], value: valid.sound,
    }]
    if (valid.sound === 'custom') {
      const selected = before.customSounds.find(entry => entry.fileId === valid.customSoundFile)
      if (selected === undefined) throw new TypeError('notificationConfig/selectSound: unknown custom sound')
      ops.push(
        { op: 'set', path: [`${valid.kind}CustomSoundFile`], value: selected.fileId },
        { op: 'set', path: [`${valid.kind}CustomSoundName`], value: selected.name },
      )
    }
    try {
      await this.ctx.settings.mutate(SETTINGS_NAMESPACE, ops, valid.expectedRevision)
    } catch (error: unknown) {
      if (error instanceof SettingsConflictError) return { kind: 'conflict', view: await this.view() }
      throw error
    }
    return { kind: 'ok', view: await this.view() }
  }

  /** Add one validated WAV to the common library without changing any event selection. */
  @Remote('upload')
  async upload(request: NotificationSoundUploadRequest): Promise<NotificationMutateOutcome> {
    const valid = assertUploadRequest(request)
    const before = await this.view()
    if (!before.registered) throw new Error('notificationConfig/upload: settings namespace is not registered')
    await this.soundLibrary.upload(before.value, valid.fileName, valid.dataBase64)
    return { kind: 'ok', view: await this.view() }
  }
}
