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
  NotificationSoundUploadRequest,
} from '../shared.js'
import { SETTINGS_NAMESPACE } from './config.js'
import { removeCustomSound, saveCustomSound } from './sound-files.js'

const FIELDS = new Set<keyof NotificationSettings>([
  'completionSound', 'confirmationSound', 'petEnabled', 'petIdleTopmost', 'petSize', 'petPosition',
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
      return value === 'off' || value === 'subtle' || value === 'prominent' || value === 'custom'
    case 'petEnabled':
    case 'petIdleTopmost':
      return typeof value === 'boolean'
    case 'petSize':
      return value === 80 || value === 112 || value === 144 || value === 176
    case 'petPosition':
      return value === 'top-left' || value === 'top-right'
        || value === 'bottom-left' || value === 'bottom-right'
    case 'completionCustomSoundFile':
    case 'completionCustomSoundName':
    case 'confirmationCustomSoundFile':
    case 'confirmationCustomSoundName':
      return false
    default:
      return assertNever(field)
  }
}

function assertUploadRequest(value: unknown): NotificationSoundUploadRequest {
  if (!isPlainObject(value)
    || (value['kind'] !== 'completion' && value['kind'] !== 'confirmation')
    || typeof value['fileName'] !== 'string'
    || typeof value['dataBase64'] !== 'string') {
    throw new TypeError('notificationConfig/upload: request must contain kind, fileName, and dataBase64')
  }
  const expectedRevision = value['expectedRevision']
  if (expectedRevision !== undefined && (
    typeof expectedRevision !== 'number'
    || !Number.isInteger(expectedRevision)
    || expectedRevision < 0
  )) {
    throw new TypeError('notificationConfig/upload: expectedRevision must be a non-negative integer')
  }
  return {
    kind: value['kind'],
    fileName: value['fileName'],
    dataBase64: value['dataBase64'],
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  }
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
  const expectedRevision = value['expectedRevision']
  if (expectedRevision !== undefined && (
    typeof expectedRevision !== 'number'
    || !Number.isInteger(expectedRevision)
    || expectedRevision < 0
  )) {
    throw new TypeError('notificationConfig/mutate: expectedRevision must be a non-negative integer')
  }
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

  constructor(ctx: Context) {
    super(ctx, 'notificationConfig')
  }

  private view(): NotificationConfigView {
    const descriptor = this.ctx.settings.describe()
      .find(entry => entry.ns === SETTINGS_NAMESPACE)
    if (descriptor === undefined) return { registered: false }
    return {
      registered: true,
      writable: this.ctx.settings.writable,
      value: descriptor.value as NotificationSettings,
      ...(descriptor.base === undefined ? {} : {
        base: descriptor.base as Partial<NotificationSettings>,
      }),
      ...(descriptor.user === undefined ? {} : {
        user: descriptor.user as Partial<NotificationSettings>,
      }),
      revision: descriptor.revision,
    }
  }

  /** Read the authoritative layered section without exposing the document path. */
  @Remote('describe')
  describe(): NotificationConfigView {
    return this.view()
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
      if (error instanceof SettingsConflictError) return { kind: 'conflict', view: this.view() }
      throw error
    }
    return { kind: 'ok', view: this.view() }
  }

  /** Store one validated custom WAV and atomically select it for its event kind. */
  @Remote('upload')
  async upload(request: NotificationSoundUploadRequest): Promise<NotificationMutateOutcome> {
    const valid = assertUploadRequest(request)
    const before = this.view()
    if (!before.registered) throw new Error('notificationConfig/upload: settings namespace is not registered')
    const stored = await saveCustomSound(this.ctx, valid.kind, valid.fileName, valid.dataBase64)
    const fileField = `${valid.kind}CustomSoundFile` as const
    const nameField = `${valid.kind}CustomSoundName` as const
    const previousFile = before.value[fileField]
    try {
      await this.ctx.settings.mutate(SETTINGS_NAMESPACE, [
        { op: 'set', path: [fileField], value: stored.fileId },
        { op: 'set', path: [nameField], value: stored.name },
        { op: 'set', path: [`${valid.kind}Sound`], value: 'custom' },
      ], valid.expectedRevision)
    } catch (error: unknown) {
      await removeCustomSound(this.ctx, stored.fileId)
      if (error instanceof SettingsConflictError) return { kind: 'conflict', view: this.view() }
      throw error
    }
    if (previousFile !== '' && previousFile !== stored.fileId) {
      await removeCustomSound(this.ctx, previousFile).catch((error: unknown) => {
        this.ctx.logger.warn(`desktop notifications: unable to remove replaced custom sound: ${String(error)}`)
      })
    }
    return { kind: 'ok', view: this.view() }
  }
}
