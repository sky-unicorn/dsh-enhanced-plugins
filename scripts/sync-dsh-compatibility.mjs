/** Generate package-manager peer declarations from the compatibility authority.
 * Builds use the bundled document; the installer passes its resolved version list.
 * Only DSH peer values (and their root lockfile metadata) are changed.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const read = path => JSON.parse(readFileSync(path, 'utf8'))
const exactVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

/** Read exact supported versions for a build; an absent or revoked release fails. */
export function bundledDshVersions(root) {
  const manifest = read(resolve(root, 'package.json'))
  const document = read(resolve(root, 'dsh-compatibility.json'))
  if (document?.schemaVersion !== 1 || !Array.isArray(document.releases)) throw new Error('Invalid compatibility document')
  const plugins = new Set()
  for (const release of document.releases) {
    if (typeof release?.pluginVersion !== 'string' || !exactVersion.test(release.pluginVersion)
      || plugins.has(release.pluginVersion) || !Array.isArray(release.dsh)) throw new Error('Invalid compatibility release')
    plugins.add(release.pluginVersion)
    const versions = new Set()
    for (const target of release.dsh) {
      if (typeof target?.version !== 'string' || !exactVersion.test(target.version) || versions.has(target.version)) {
        throw new Error('Invalid compatibility target')
      }
      versions.add(target.version)
      if (!Array.isArray(target.commits) || target.commits.length === 0
        || target.commits.some(commit => typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit))
        || new Set(target.commits).size !== target.commits.length) throw new Error('Invalid compatibility commits')
    }
  }
  const releases = document.releases.filter(release => release?.pluginVersion === manifest.version)
  if (releases.length !== 1 || !Array.isArray(releases[0].dsh)) throw new Error(`Missing compatibility for plugin ${manifest.version}`)
  return releases[0].dsh.map(target => target.version)
}

/** Synchronize generated peers without changing package versions, boundaries or other dependencies. */
export function syncDshPeers(root, versions = bundledDshVersions(root)) {
  if (!Array.isArray(versions) || versions.length === 0 || new Set(versions).size !== versions.length
    || versions.some(version => typeof version !== 'string' || !exactVersion.test(version))) {
    throw new Error('Compatibility requires unique exact DSH versions')
  }
  const paths = [resolve(root, 'package.json'), ...readdirSync(resolve(root, 'packages'))
    .map(name => resolve(root, 'packages', name, 'package.json')).filter(existsSync)]
  const manifests = paths.map(path => ({ path, value: read(path) }))
  const pluginVersion = manifests[0].value.version
  for (const { value } of manifests) {
    if (value.version !== pluginVersion) throw new Error(`Mixed plugin release: ${value.name}`)
  }
  const lockPath = resolve(root, 'package-lock.json')
  if (existsSync(lockPath)) {
    const lock = read(lockPath)
    if (!lock.packages?.['']) throw new Error('Root package lock has no root metadata')
    manifests.push({ path: lockPath, value: lock, peerOwner: lock.packages[''] })
  }
  for (const { path, value, peerOwner = value } of manifests) {
    let changed = false
    for (const name of Object.keys(peerOwner.peerDependencies ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh-') && peerOwner.peerDependencies[name] !== versions.join(' || ')) {
        peerOwner.peerDependencies[name] = versions.join(' || ')
        changed = true
      }
    }
    if (changed) writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(process.argv[2] ?? '.')
  syncDshPeers(root, process.argv[3] === undefined ? undefined : process.argv[3].split(','))
}
