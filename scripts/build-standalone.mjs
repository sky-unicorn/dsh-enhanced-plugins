/** Rebuild a standalone feature from its packaged source, or use the repository target. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import * as esbuild from 'esbuild'
import { buildClient } from './build-client.mjs'

export async function buildStandalone(root) {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const feature = manifest.dshEnhanced.feature
  if (!/^[a-z0-9-]+$/.test(feature)) throw new Error('Invalid standalone feature identity')
  const repository = resolve(root, '../..')
  const parentManifest = resolve(repository, 'package.json')
  if (existsSync(parentManifest) && JSON.parse(await readFile(parentManifest, 'utf8')).name === 'dsh-enhanced-plugins') {
    const result = spawnSync(process.execPath, [resolve(repository, 'build.mjs'), '--feature', feature], {
      cwd: repository, stdio: 'inherit', windowsHide: true,
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Standalone build exited ${result.status}`)
    return
  }
  const config = JSON.parse(await readFile(resolve(root, 'build-config.json'), 'utf8'))
  for (const entry of [...config.hostEntries, config.clientEntry]) {
    const path = relative(root, resolve(root, entry))
    if (isAbsolute(path) || path.startsWith('..') || !entry.startsWith(`src/${feature}/`)) {
      throw new Error('Standalone source entry leaves its feature directory')
    }
  }
  // Only this package's fixed build-output directory is replaced.
  const lib = resolve(root, 'lib')
  await rm(lib, { recursive: true, force: true })
  await mkdir(lib, { recursive: true })
  await esbuild.build({ entryPoints: config.hostEntries.map(entry => resolve(root, entry)),
    outbase: resolve(root, 'src'), outdir: lib, bundle: false, packages: 'external',
    platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning' })
  await buildClient({ root, packageName: manifest.name, clientEntry: config.clientEntry, lib })
}
