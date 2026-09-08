/** Load the actual Electron Host with a fixed plugin snapshot, without changing the DSH checkout. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dsh = resolve(root, '../deepseek-harness')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.ok(existsSync(join(dsh, 'apps/desktop-host/lib/index.js')), 'Build the required DSH checkout first')

if (process.argv[2] !== '--child') {
  const scratch = join(root, '.verify-dsh-home')
  mkdirSync(scratch, { recursive: true })
  const directory = mkdtempSync(join(scratch, 'desktop-host-'))
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }))
  const result = spawnSync(process.execPath, [
    '--import', pathToFileURL(join(dsh, 'node_modules/tsx/dist/esm/index.mjs')).href,
    fileURLToPath(import.meta.url), '--child', directory,
  ], {
    cwd: root, windowsHide: true, stdio: 'inherit', timeout: 90_000,
    env: { ...process.env, TSX_TSCONFIG_PATH: join(directory, 'tsconfig.json'), DSH_HOME: join(directory, 'home'), DSH_TELEMETRY_MODE: 'DISABLED',
      DEEPSEEK_API_KEY: 'local-fixture', DEEPSEEK_BASE_URL: 'http://127.0.0.1:1/v1' },
  })
  assert.equal(result.status, 0, result.error?.message ?? 'Desktop Host verification failed')
} else {
  const directory = resolve(process.argv[3])
  const { prepareDevelopmentProject } = await import(pathToFileURL(join(dsh, 'apps/desktop/scripts/development-project.ts')).href)
  const { runDesktopHost } = await import(pathToFileURL(join(dsh, 'apps/desktop-host/lib/index.js')).href)
  const { DESKTOP_HOST_PROTOCOL_VERSION } = await import(pathToFileURL(join(dsh, 'apps/desktop/src/host-protocol.ts')).href)
  const project = prepareDevelopmentProject({
    projectDir: join(directory, 'project'), cliDir: join(dsh, 'apps/cli'),
    hostDir: join(dsh, 'apps/desktop-host'), dependencyDir: join(dsh, 'node_modules/.pnpm/node_modules'),
    release: { schemaVersion: 1, version: manifest.dshEnhanced.compatibility.dshVersion,
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, nodeVersion: process.versions.node,
      pnpmVersion: JSON.parse(readFileSync(join(dsh, 'apps/desktop/node_modules/pnpm/package.json'), 'utf8')).version },
  })
  const snapshot = join(project, 'node_modules', manifest.name)
  mkdirSync(snapshot)
  for (const name of ['package.json', 'cordis.patch.yml', 'lib', 'assets']) {
    cpSync(join(root, name), join(snapshot, name), { recursive: true })
  }
  // The development graph supplies official peers; this snapshot supplies its own ordinary dependencies.
  for (const name of Object.keys(manifest.dependencies)) {
    const target = join(snapshot, 'node_modules', name)
    mkdirSync(resolve(target, '..'), { recursive: true })
    symlinkSync(join(root, 'node_modules', name), target, process.platform === 'win32' ? 'junction' : 'dir')
  }
  const metadataPath = join(project, 'package.json')
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  metadata.dependencies[manifest.name] = manifest.version
  metadata.dsh.profile.bundles.push(manifest.name)
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2))
  const chunks = []
  const host = await runDesktopHost(project, async bytes => { chunks.push(Buffer.from(bytes)) }, { allowLinkedPackages: true })
  try {
    assert.equal(host.dshVersion, manifest.dshEnhanced.compatibility.dshVersion)
    await host.fetch({ streamId: 1, request: { url: 'dsh-app://app/', method: 'GET', headers: [] } }, null)
    const response = Buffer.concat(chunks).toString('utf8')
    assert.ok(response.includes('"status":200'), 'Desktop index did not return 200')
    assert.ok(response.includes('__DSH_BOOT__'), 'Desktop did not assemble Client modules')
    assert.ok(response.includes(manifest.name), 'Desktop boot graph is missing the enhanced Client')
    const report = { dsh: host.dshVersion, plugin: manifest.version, host: 'ready', clientIndex: 'ready' }
    writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2))
    console.log(`Desktop Host and Client index verified: ${join(directory, 'report.json')}`)
  } finally { await host.dispose() }
}
