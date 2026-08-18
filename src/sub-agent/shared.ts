/** Client-safe spelling of the Host-owned settings namespace. */
export const SETTINGS_NAMESPACE_KEY = 'subagent-products'

export interface ProductToggleSettings {
  claudeCode: boolean
  codex: boolean
}
