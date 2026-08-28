import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'
import { buildClient } from './scripts/build-client.mjs'
import { buildWindowsLauncher } from './packages/windows-launcher/build.mjs'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const AGGREGATE_HOST_ENTRIES = [
  'src/index.ts',
  'src/edit-last-message/shared.ts',
  'src/edit-last-message/host/index.ts',
  'src/edit-last-message/host/remote.ts',
  'src/edit-last-message/host/rewind.ts',
  'src/mcp-server-manager/host/importers.ts',
  'src/mcp-server-manager/host/index.ts',
  'src/mcp-server-manager/host/manager.ts',
  'src/mcp-server-manager/host/remote.ts',
  'src/mcp-server-manager/host/schema.ts',
  'src/mcp-server-manager/host/types.ts',
  'src/mcp-server-manager/host/validation.ts',
  'src/notification/shared.ts',
  'src/notification/host/config.ts',
  'src/notification/host/desktop.ts',
  'src/notification/host/index.ts',
  'src/notification/host/migration.ts',
  'src/notification/host/position-store.ts',
  'src/notification/host/remote.ts',
  'src/notification/host/sound-files.ts',
  'src/notification/host/sound-library.ts',
  'src/notification/host/state.ts',
  'src/plugin-market/contracts.ts',
  'src/plugin-market/index.ts',
  'src/plugin-market/market-utils.ts',
  'src/sub-agent/host.ts',
  'src/sub-agent/codex.ts',
  'src/sub-agent/claude-code.ts',
  'src/sub-agent/preset.ts',
  'src/sub-agent/settings.ts',
  'src/sub-agent/shared.ts',
]

const FEATURE_TARGETS = [
  {
    id: 'edit-last-message',
    directory: 'packages/edit-last-message',
    hostEntries: [
      'src/edit-last-message/shared.ts',
      'src/edit-last-message/host/index.ts',
      'src/edit-last-message/host/remote.ts',
      'src/edit-last-message/host/rewind.ts',
    ],
    clientEntry: 'src/edit-last-message/client/index.ts',
  },
  {
    id: 'mcp-server-manager',
    directory: 'packages/mcp-server-manager',
    hostEntries: [
      'src/mcp-server-manager/host/importers.ts',
      'src/mcp-server-manager/host/index.ts',
      'src/mcp-server-manager/host/manager.ts',
      'src/mcp-server-manager/host/remote.ts',
      'src/mcp-server-manager/host/schema.ts',
      'src/mcp-server-manager/host/types.ts',
      'src/mcp-server-manager/host/validation.ts',
    ],
    clientEntry: 'src/mcp-server-manager/client/index.ts',
  },
  {
    id: 'model-input-types',
    directory: 'packages/model-input-types',
    hostEntries: ['src/model-input-types/host/index.ts'],
    clientEntry: 'src/model-input-types/client/index.ts',
  },
  {
    id: 'notification',
    directory: 'packages/notification',
    hostEntries: [
      'src/notification/shared.ts',
      'src/notification/host/config.ts',
      'src/notification/host/desktop.ts',
      'src/notification/host/index.ts',
      'src/notification/host/migration.ts',
      'src/notification/host/position-store.ts',
      'src/notification/host/remote.ts',
      'src/notification/host/sound-files.ts',
      'src/notification/host/sound-library.ts',
      'src/notification/host/state.ts',
    ],
    clientEntry: 'src/notification/client/index.ts',
    assets: [{ source: 'assets/notification', destination: 'assets/notification' }],
  },
  {
    id: 'plugin-market',
    directory: 'packages/plugin-market',
    hostEntries: [
      'src/plugin-market/contracts.ts',
      'src/plugin-market/index.ts',
      'src/plugin-market/market-utils.ts',
    ],
    clientEntry: 'src/plugin-market/client/index.ts',
    assets: [{ source: 'assets/plugins-cache.json', destination: 'assets/plugins-cache.json' }],
  },
  {
    id: 'sub-agent',
    directory: 'packages/sub-agent',
    hostEntries: [
      'src/sub-agent/host.ts',
      'src/sub-agent/codex.ts',
      'src/sub-agent/claude-code.ts',
      'src/sub-agent/preset.ts',
      'src/sub-agent/settings.ts',
      'src/sub-agent/shared.ts',
    ],
    clientEntry: 'src/sub-agent/client/index.ts',
  },
]

async function packageNameAt(directory) {
  const manifest = JSON.parse(await readFile(resolve(ROOT, directory, 'package.json'), 'utf8'))
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    throw new Error(`${directory}/package.json must declare a non-empty package name`)
  }
  return manifest.name
}

async function buildTarget(target) {
  const outputRoot = resolve(ROOT, target.directory)
  const lib = resolve(outputRoot, 'lib')
  const packageName = await packageNameAt(target.directory)
  await rm(lib, { recursive: true, force: true })
  await mkdir(lib, { recursive: true })

  await esbuild.build({
    entryPoints: target.hostEntries.map(entry => resolve(ROOT, entry)),
    outbase: resolve(ROOT, 'src'),
    outdir: lib,
    bundle: false,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    logLevel: 'warning',
  })

  await buildClient({ root: ROOT, packageName, clientEntry: target.clientEntry, lib })

  if (target.directory !== '.') {
    // Publish the feature's own source and the shared build implementation, so
    // a tarball can prepare without this repository or a sibling DSH checkout.
    const source = resolve(outputRoot, 'src')
    await rm(source, { recursive: true, force: true })
    await cp(resolve(ROOT, 'src', target.id), resolve(source, target.id), { recursive: true })
    await cp(resolve(ROOT, 'scripts/build-client.mjs'), resolve(outputRoot, 'build-client.mjs'))
    await cp(resolve(ROOT, 'scripts/build-standalone.mjs'), resolve(outputRoot, 'build-support.mjs'))
    await writeFile(resolve(outputRoot, 'build-config.json'), JSON.stringify({
      hostEntries: target.hostEntries, clientEntry: target.clientEntry,
    }, null, 2) + '\n')
    const assetsRoot = resolve(outputRoot, 'assets')
    await rm(assetsRoot, { recursive: true, force: true })
    for (const asset of target.assets ?? []) {
      const destination = resolve(outputRoot, asset.destination)
      await mkdir(dirname(destination), { recursive: true })
      await cp(resolve(ROOT, asset.source), destination, { recursive: true })
    }
  }
}

async function main() {
  // New self-contained targets declare their build beside the authoritative
  // install identity. Installers/Launcher discover the same package manifest.
  const standalone = []
  for (const entry of await readdir(resolve(ROOT, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = resolve(ROOT, 'packages', entry.name)
    if (!existsSync(resolve(directory, 'package.json'))) continue
    const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
    if (manifest.dshEnhanced?.build !== undefined) standalone.push({ directory, ...manifest.dshEnhanced })
  }
  const aggregate = {
    id: 'all',
    directory: '.',
    hostEntries: [...AGGREGATE_HOST_ENTRIES, ...standalone.flatMap(target => target.build.hostEntries)],
    clientEntry: 'src/client/index.ts',
  }
  const featureFlag = process.argv.indexOf('--feature')
  if (featureFlag !== -1) {
    const id = process.argv[featureFlag + 1]
    const standaloneTarget = standalone.find(target => target.feature === id)
    if (standaloneTarget !== undefined) {
      await (await import(pathToFileURL(resolve(standaloneTarget.directory, standaloneTarget.build.script)).href)).build()
      return
    }
    if (id === 'windows-launcher') {
      await buildWindowsLauncher()
      return
    }
    const target = id === 'all' ? aggregate : FEATURE_TARGETS.find(feature => feature.id === id)
    if (target === undefined) throw new Error(`unknown feature ${JSON.stringify(id)}`)
    await buildTarget(target)
    return
  }
  await buildTarget(aggregate)
  for (const target of FEATURE_TARGETS) await buildTarget(target)
  for (const target of standalone) await (await import(pathToFileURL(resolve(target.directory, target.build.script)).href)).build()
  await buildWindowsLauncher()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
