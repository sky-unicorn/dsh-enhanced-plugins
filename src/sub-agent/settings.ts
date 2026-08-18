import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SETTINGS_NAMESPACE_KEY } from './shared.js'

/** Branded Host-side settings namespace shared by the owner and Consumer. */
export const SETTINGS_NAMESPACE = settingsNamespace(SETTINGS_NAMESPACE_KEY)
