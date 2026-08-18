/**
 * Minimal stub of the dsh-settings imports the tested host modules evaluate.
 * Only the value exports used at module load are provided; type-only surface
 * is irrelevant to tests.
 */

/** SettingsNamespace: a branded string key. */
export type SettingsNamespace = string & { readonly __ns: unique symbol }

export function settingsNamespace(value: string): SettingsNamespace {
  return value as SettingsNamespace
}

export function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export class SettingsConflictError extends Error {
  constructor(message: string, readonly actual: number) {
    super(message)
  }
}

/** Path-op shape the settings mutate seam accepts. */
export interface SettingsPathOp {
  op: 'set' | 'unset'
  path: readonly string[]
  value?: unknown
}

/** Install hook contract (tested modules only call it via apply, not directly). */
export interface SettingsSectionHooks<T> {
  setSource?: (source: () => T) => void
  onChange?: () => void
}

export function installSettingsSection<T>(
  _ctx: unknown,
  _ns: SettingsNamespace,
  _schema: unknown,
  _entry: T,
  _hooks: SettingsSectionHooks<T>,
): void {
  // No-op: the install seam is exercised through the manager's reconcile path,
  // not by direct unit tests of this stub.
}
