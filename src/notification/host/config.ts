/** Host-owned schema and namespace for desktop notifications. */

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_SETTINGS_NAMESPACE,
  type NotificationSettings,
  type NotificationSound,
  type PetCharacter,
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

const Character = z.union([
  z.const('classic'),
  z.const('multiview'),
  z.const('whale-girl'),
]) as unknown as z<PetCharacter>

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
  blockedSound: Sound.default(DEFAULT_NOTIFICATION_SETTINGS.blockedSound)
    .description('Sound played when a top-level task ends unsuccessfully.'),
  soundGain: z.number().step(1).min(0).max(100).default(DEFAULT_NOTIFICATION_SETTINGS.soundGain)
    .description('Positive gain for built-in and custom sounds; 0 preserves the source and 100 doubles its amplitude.'),
  completionCustomSoundFile: z.string().default(DEFAULT_NOTIFICATION_SETTINGS.completionCustomSoundFile)
    .description('Host-owned file id selected from the shared custom sound library for completion.'),
  completionCustomSoundName: z.string().default(DEFAULT_NOTIFICATION_SETTINGS.completionCustomSoundName)
    .description('Display name paired with the selected completion WAV.'),
  confirmationCustomSoundFile: z.string().default(DEFAULT_NOTIFICATION_SETTINGS.confirmationCustomSoundFile)
    .description('Host-owned file id selected from the shared custom sound library for confirmation.'),
  confirmationCustomSoundName: z.string().default(DEFAULT_NOTIFICATION_SETTINGS.confirmationCustomSoundName)
    .description('Display name paired with the selected confirmation WAV.'),
  blockedCustomSoundFile: z.string().default(DEFAULT_NOTIFICATION_SETTINGS.blockedCustomSoundFile)
    .description('Host-owned file id selected from the shared custom sound library for blocked tasks.'),
  blockedCustomSoundName: z.string().default(DEFAULT_NOTIFICATION_SETTINGS.blockedCustomSoundName)
    .description('Display name paired with the selected blocked-task WAV.'),
  petEnabled: z.boolean().default(DEFAULT_NOTIFICATION_SETTINGS.petEnabled)
    .description('Show the native DeepSeek desktop pet outside the browser.'),
  petCharacter: Character.default(DEFAULT_NOTIFICATION_SETTINGS.petCharacter)
    .description('Visual character used by the native desktop pet.'),
  petIdleTopmost: z.boolean().default(DEFAULT_NOTIFICATION_SETTINGS.petIdleTopmost)
    .description('Keep the desktop pet above other windows while it is idle.'),
  petSize: Size.default(DEFAULT_NOTIFICATION_SETTINGS.petSize)
    .description('Desktop pet size in device-independent pixels.'),
  petPosition: Position.default(DEFAULT_NOTIFICATION_SETTINGS.petPosition)
    .description('Fallback corner used before a dragged desktop-pet position is remembered.'),
})
