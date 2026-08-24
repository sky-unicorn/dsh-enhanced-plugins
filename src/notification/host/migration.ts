/** Compatibility migrations for settings written by older notification builds. */

import type { SettingsDescriptor, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { NotificationSettings } from '../shared.js'
import { replacementForRetiredPetCharacter, SETTINGS_NAMESPACE } from './config.js'

interface NotificationSettingsWriter {
  describe(): SettingsDescriptor[]
  mutate(
    namespace: typeof SETTINGS_NAMESPACE,
    ops: readonly SettingsPathOp[],
    expectedRevision?: number,
  ): Promise<void>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Replace a known retired character id through the authoritative settings
 * provider after the compatibility schema has made registration possible.
 */
export async function migrateRetiredPetCharacter(settings: NotificationSettingsWriter): Promise<boolean> {
  const descriptor = settings.describe().find(entry => entry.ns === SETTINGS_NAMESPACE)
  if (descriptor === undefined || !isPlainObject(descriptor.user)) return false
  const replacement = replacementForRetiredPetCharacter(descriptor.user['petCharacter'])
  if (replacement === undefined) return false
  const op: SettingsPathOp = { op: 'set', path: ['petCharacter'], value: replacement }
  await settings.mutate(SETTINGS_NAMESPACE, [op], descriptor.revision)
  return true
}

/** Normalize the raw user layer while its durable migration is still settling. */
export function normalizeNotificationUserLayer(value: unknown): Partial<NotificationSettings> | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) return undefined
  const replacement = replacementForRetiredPetCharacter(value['petCharacter'])
  return {
    ...value,
    ...(replacement === undefined ? {} : { petCharacter: replacement }),
  } as Partial<NotificationSettings>
}
