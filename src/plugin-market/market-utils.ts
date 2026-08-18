/** Pure catalog and install-source helpers shared by the Host implementation and tests. */

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
  if (typeof patch !== 'string' || patch.trim().length === 0) return undefined
  return { packageName: manifest.name, bundlePatch: patch }
}

function packageNameFromRegistrySpec(spec: string): string | undefined {
  if (validPackageName(spec)) return spec
  const versionSeparator = spec.startsWith('@')
    ? spec.indexOf('@', spec.indexOf('/') + 1)
    : spec.indexOf('@')
  if (versionSeparator <= 0) return undefined
  const packageName = spec.slice(0, versionSeparator)
  return isPackageName(packageName) ? packageName : undefined
}

function packageNameFromDshAdd(command: string): string | undefined {
  const match = /^(?:pnpm\s+)?dsh\s+plugin\s+--profile\s+\S+\s+add\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(command.trim())
  const spec = match?.[1] ?? match?.[2] ?? match?.[3]
  return spec === undefined ? undefined : packageNameFromRegistrySpec(spec)
}

/**
 * Read only simple registry package specs from catalog install guidance.
 * Arbitrary README commands, flags, paths, URLs, and shell syntax are ignored.
 */
export function npmPackageCandidates(commands: readonly string[], declaredName?: unknown): string[] {
  const candidates = commands.map(packageNameFromDshAdd)
  if (isPackageName(declaredName)) candidates.push(declaredName)
  return [...new Set(candidates.filter((value): value is string => value !== undefined))]
}

function repositoryUrl(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const url = (value as { readonly url?: unknown }).url
  return typeof url === 'string' ? url : undefined
}

/** Require npm metadata to point back to the catalog's GitHub repository. */
export function npmRepositoryMatches(value: unknown, fullName: string): boolean {
  const url = repositoryUrl(value)?.trim()
  if (url === undefined) return false
  const shorthand = /^github:([^/\s]+\/[^#\s]+?)(?:\.git)?(?:#.*)?$/i.exec(url)
  if (shorthand?.[1]?.toLocaleLowerCase() === fullName.toLocaleLowerCase()) return true
  const github = /github\.com[/:]([^/\s]+)\/([^/#\s]+?)(?:\.git)?(?:[#/]|$)/i.exec(url)
  return github !== null
    && `${github[1]}/${github[2]}`.toLocaleLowerCase() === fullName.toLocaleLowerCase()
}

/** Minimal installed manifest shape used to correlate npm packages with catalog repositories. */
export interface InstalledPackageManifest {
  readonly repository?: unknown
}

/**
 * Find the installed dependency that represents one catalog repository.
 * Accept caller-vetted catalog package names, while retaining GitHub-spec
 * and package-manifest correlation for repositories whose package name differs.
 */
export function findInstalledPackageName(
  fullName: string,
  unambiguousPackageCandidates: readonly string[],
  dependencies: Readonly<Record<string, string>>,
  manifests: ReadonlyMap<string, InstalledPackageManifest>,
): string | undefined {
  const normalizedCandidates = new Set(unambiguousPackageCandidates.map(value => value.toLocaleLowerCase()))
  const normalizedFullName = fullName.toLocaleLowerCase()
  return Object.entries(dependencies).find(([name, spec]) =>
    normalizedCandidates.has(name.toLocaleLowerCase())
    || spec.toLocaleLowerCase().includes(normalizedFullName)
    || npmRepositoryMatches(manifests.get(name)?.repository, fullName))?.[0]
}
