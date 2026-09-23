/** Settings forms use the stable Loader entry id in both bundle patches. */
export const SETTINGS_NAMESPACE_KEY = 'subagent-product-toggles'

export interface ProductToggleSettings {
  claudeCode: boolean
  codex: boolean
}
