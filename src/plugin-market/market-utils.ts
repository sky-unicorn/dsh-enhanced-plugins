/** Pure catalog metadata helpers shared by the Host implementation and tests. */

const PACKAGE_PART_PATTERN = /^[a-z0-9._~-]+$/

function validPackagePart(value: string): boolean {
  return value !== '.' && value !== '..' && PACKAGE_PART_PATTERN.test(value)
}

function validPackageName(value: string): boolean {
  if (!value.startsWith('@')) return validPackagePart(value)
  const parts = value.slice(1).split('/')
  return parts.length === 2 && validPackagePart(parts[0] ?? '') && validPackagePart(parts[1] ?? '')
}

/** The repository fields needed to establish a stable popularity order. */
export interface PopularityEntry {
  readonly fullName: string
  readonly stars: number
  readonly updatedAt: string
}

/** Sort by stars descending, then recent update, then repository name. */
export function compareByStars(left: PopularityEntry, right: PopularityEntry): number {
  const stars = right.stars - left.stars
  if (stars !== 0) return stars
  const updated = right.updatedAt.localeCompare(left.updatedAt)
  if (updated !== 0) return updated
  const leftName = left.fullName.toLocaleLowerCase()
  const rightName = right.fullName.toLocaleLowerCase()
  return leftName < rightName ? -1 : leftName > rightName ? 1 : 0
}

/** Whether a value is a valid unscoped or scoped npm package name. */
export function isPackageName(value: unknown): value is string {
  return typeof value === 'string' && validPackageName(value)
}

/** Evidence from a package manifest that DSH can activate it as a profile bundle. */
export interface DshBundleEvidence {
  readonly packageName: string
  readonly bundlePatch: string
}

function safeBundlePatch(value: string): boolean {
  const normalized = value.trim().replaceAll('\\', '/')
  return normalized.length > 0
    && !normalized.startsWith('/')
    && !/^[A-Za-z]:/.test(normalized)
    && !normalized.split('/').includes('..')
}

/**
 * Read the installable DSH bundle identity from an untrusted package manifest.
 * A topic, repository name, or keyword is not plugin evidence: the DSH launcher
 * activates only packages that declare a non-empty `dsh.bundle.patch`.
 */
export function dshBundleEvidence(value: unknown): DshBundleEvidence | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const manifest = value as { readonly name?: unknown; readonly dsh?: unknown }
  if (!isPackageName(manifest.name)
    || manifest.dsh === null || typeof manifest.dsh !== 'object' || Array.isArray(manifest.dsh)) return undefined
  const bundle = (manifest.dsh as { readonly bundle?: unknown }).bundle
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) return undefined
  const patch = (bundle as { readonly patch?: unknown }).patch
  if (typeof patch !== 'string' || !safeBundlePatch(patch)) return undefined
  return { packageName: manifest.name, bundlePatch: patch.trim() }
}
