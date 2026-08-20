/** Host-owned schema and namespace for desktop notifications. */

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_SETTINGS_NAMESPACE,
  type NotificationSettings,
  type NotificationSound,
  type PetPosition,
  type PetSize,
} from '../shared.js'

const Sound = z.union([
  z.const('off'),
  z.const('subtle'),
  z.const('prominent'),
  z.const('custom'),
]) as unknown as z<NotificationSound>

const Position = z.union([
  z.const('top-left'),
  z.const('top-right'),
  z.const('bottom-left'),
  z.const('bottom-right'),
]) as unknown as z<PetPosition>

const Size = z.union([
  z.const(80),
  z.const(112),
  z.const(144),
  z.const(176),
]) as unknown as z<PetSize>

export const SETTINGS_NAMESPACE = settingsNamespace(NOTIFICATION_SETTINGS_NAMESPACE)

export const Config: z<NotificationSettings> = z.object({
  completionSound: Sound.default(DEFAULT_NOTIFICATION_SETTINGS.completionSound)
    .description('Sound played when a top-level task completes.'),
  confirmationSound: Sound.default(DEFAULT_NOTIFICATION_SETTINGS.confirmationSound)
    .description('Sound played when a task needs approval or an answer.'),
  completionCustomSoundFile: z.string().default(DEFAULT_NOTIFICATION_SETTINGS.completionCustomSoundFile)
    .description('Host-owned file id for the uploaded completion WAV.'),
  completionCustomSoundName: z.string().default(DEFAULT_NOTIFICATION_SETTINGS.completionCustomSoundName)
    .description('Display name of the uploaded completion WAV.'),
  confirmationCustomSoundFile: z.string().default(DEFAULT_NOTIFICATION_SETTINGS.confirmationCustomSoundFile)
    .description('Host-owned file id for the uploaded confirmation WAV.'),
  confirmationCustomSoundName: z.string().default(DEFAULT_NOTIFICATION_SETTINGS.confirmationCustomSoundName)
    .description('Display name of the uploaded confirmation WAV.'),
  petEnabled: z.boolean().default(DEFAULT_NOTIFICATION_SETTINGS.petEnabled)
    .description('Show the native DeepSeek desktop pet outside the browser.'),
  petIdleTopmost: z.boolean().default(DEFAULT_NOTIFICATION_SETTINGS.petIdleTopmost)
    .description('Keep the desktop pet above other windows while it is idle.'),
  petSize: Size.default(DEFAULT_NOTIFICATION_SETTINGS.petSize)
    .description('Desktop pet size in device-independent pixels.'),
  petPosition: Position.default(DEFAULT_NOTIFICATION_SETTINGS.petPosition)
    .description('Fallback corner used before a dragged desktop-pet position is remembered.'),
})
