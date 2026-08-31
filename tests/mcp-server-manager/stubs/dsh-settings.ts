/**
 * Minimal stub of the dsh-settings imports the tested host modules evaluate.
 * Only the value exports used at module load are provided; type-only surface
 * is irrelevant to tests.
 */

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
