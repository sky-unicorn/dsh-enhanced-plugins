import { SETTINGS_NAMESPACE_KEY } from './shared.js'

/** Validated Host-side settings namespace literal shared by the owner and Consumer. */
export const SETTINGS_NAMESPACE = SETTINGS_NAMESPACE_KEY

/** Copy a Loader config snapshot, unwrapping DSH 0.1.7 volatile references. */
export function snapshotProductToggleSettings(value: unknown): import('./shared.js').ProductToggleSettings {
  const visit = (item: unknown): unknown => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)
      && typeof (item as { get?: unknown }).get === 'function') return visit((item as { get: () => unknown }).get())
    if (Array.isArray(item)) return item.map(visit)
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]))
    return item
  }
  return visit(value) as import('./shared.js').ProductToggleSettings
}
