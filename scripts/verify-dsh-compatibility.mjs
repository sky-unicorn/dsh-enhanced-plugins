/** Exercise real source-checkout profiles without touching the user's DSH home. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProject } from '../packages/windows-launcher/src/toolchain.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const dsh = resolve(process.env.DSH_VERIFY_CHECKOUT ?? resolve(root, '../deepseek-harness'))
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const dshVersion = JSON.parse(readFileSync(resolve(dsh, 'package.json'), 'utf8')).version
const cliArgs = resolveProject({ sourceDirectory: dsh }).args
const cli = cliArgs[0]
if (process.platform !== 'win32') throw new Error('This installer integration gate requires Windows PowerShell 5.1.')
if (!existsSync(cli)) throw new Error('Build the required sibling DSH checkout before running this gate.')
const packages = readdirSync(resolve(root, 'packages'))
  .map(name => resolve(root, 'packages', name, 'package.json')).filter(existsSync)
  .map(path => JSON.parse(readFileSync(path, 'utf8')))
  .filter(value => value.dshEnhanced.kind === 'bundle')
const supports = value => value.dshEnhanced.manager?.compatibility?.dsh?.includes(dshVersion) ?? true
const compatible = packages.filter(supports)
const incompatible = packages.filter(value => !supports(value))
const allNames = [manifest.name, ...packages.map(value => value.name)]
const scratch = resolve(root, '.verify-dsh-home')
mkdirSync(scratch, { recursive: true })
const home = mkdtempSync(resolve(scratch, 'selection-412-'))
const env = { ...process.env, DSH_HOME: home,
  DEEPSEEK_HARNESS_LAUNCHER_HOME: resolve(home, 'launcher'),
  DSH_TELEMETRY_MODE: 'DISABLED',
  DEEPSEEK_API_KEY: 'compatibility-fixture', DEEPSEEK_BASE_URL: 'http://127.0.0.1:1/v1' }
const redact = text => text.replace(/token=[^\s"'&]+/g, 'token=[redacted]')
const report = []

function command(executable, args, label, cwd = root) {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  const output = redact(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  writeFileSync(resolve(home, `${label}.log`), output)
  assert.equal(result.status, 0, `${label}: ${result.error?.message ?? ''}\n${output}`)
}

function install(features, label, skipLauncher) {
  command('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', resolve(root, 'scripts/migrate-to-enhanced-plugin.ps1'), '-DshCheckout', dsh,
    '-Features', features.join(','), '-SkipBuild', '-SkipLauncherSystemIntegration',
    ...(skipLauncher ? ['-SkipLauncherInstall'] : []),
  ], label)
}

function expectRejected(features, label) {
  const profilePath = resolve(home, 'profiles/web/package.json')
  const before = existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : null
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', resolve(root, 'scripts/migrate-to-enhanced-plugin.ps1'), '-DshCheckout', dsh,
    '-Features', features.join(','), '-SkipBuild', '-SkipLauncherSystemIntegration', '-SkipLauncherInstall'],
  { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  const output = redact(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  writeFileSync(resolve(home, `${label}.log`), output)
  assert.notEqual(result.status, 0, `${label}: unsupported feature was installed`)
  assert.match(output, /Incompatible DSH feature/)
  assert.equal(existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : null, before,
    `${label}: rejected install changed the profile`)
  report.push({ label, rejected: features, profile: 'unchanged' })
  console.log(`${label}: incompatible feature rejected without changing profile`)
}

async function verify(expected, label) {
  const profile = JSON.parse(readFileSync(resolve(home, 'profiles/web/package.json'), 'utf8'))
  assert.deepEqual(Object.keys(profile.dependencies ?? {}).filter(name => allNames.includes(name)).sort(), [...expected].sort())
  assert.deepEqual(profile.dsh.profile.bundles.filter(name => allNames.includes(name)).sort(), [...expected].sort())
  assert.ok(!Object.hasOwn(profile.dependencies ?? {}, 'dsh-enhanced-model-input-types'), 'Retired model bundle remains installed')
  assert.ok(!profile.dsh.profile.bundles.includes('dsh-enhanced-model-input-types'), 'Retired model bundle remains active')
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((done, reject) => reservation.close(error => error ? reject(error) : done()))
  // Exercise the same compiled CLI entry selected by Launcher.
  const child = spawn(process.execPath, [...cliArgs, 'web', '--port', String(port), '--no-open'], {
    cwd: dsh, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const exited = once(child, 'exit')
  try {
    const url = await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`Web startup timed out: ${redact(output)}`)), 90_000)
      const accept = chunk => {
        output += chunk.toString()
        const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)
        if (match) { clearTimeout(timer); done(match[1]) }
      }
      child.stdout.on('data', accept)
      child.stderr.on('data', accept)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Web exited ${code}: ${redact(output)}`)) })
    })
    // Complete the normal token exchange; credentials are kept in memory and never logged.
    const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    assert.equal(login.status, 303)
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
    assert.ok(cookie, 'DSH did not issue a local browser session')
    const origin = new URL(url).origin
    const fetchLocal = path => fetch(new URL(path, origin), { headers: { cookie }, signal: AbortSignal.timeout(15_000) })
    const response = await fetchLocal('/')
    assert.equal(response.status, 200)
    const html = await response.text()
    const wire = html.match(/<script>globalThis\["__DSH_BOOT__"\] = ([\s\S]*?)<\/script>/)?.[1]
    assert.ok(wire, 'Assembled Web page has no Client boot graph')
    const graph = JSON.parse(wire)
    const selected = graph.entries.filter(row => allNames.includes(row.id))
    assert.deepEqual(selected.map(row => row.id).sort(), [...expected].sort())
    for (const row of selected) {
      const bundle = await fetchLocal(row.url)
      assert.equal(bundle.status, 200, `Missing Client artifact: ${row.id}`)
      assert.ok((await bundle.text()).includes(row.id), `Client bundle does not register ${row.id}`)
    }
    report.push({ label, packages: expected, host: 'ready', clientArtifacts: 'ready' })
    writeFileSync(resolve(home, 'report.json'), JSON.stringify(report, null, 2))
    console.log(`${label}: profile, Host and Client artifacts ready (${expected.join(', ') || 'no enhanced features'})`)
  } finally {
    if (child.exitCode === null) child.kill()
    await exited
    writeFileSync(resolve(home, `${label}-web.log`), redact(output))
  }
}

console.log(`Isolated verification home: ${home}`)
for (const [index, value] of compatible.entries()) {
  const label = `single-${value.dshEnhanced.feature}`
  install([value.dshEnhanced.feature], label, index > 0)
  await verify([value.name], label)
}
for (const value of incompatible) expectRejected([value.dshEnhanced.feature], `rejected-${value.dshEnhanced.feature}`)
if (incompatible.length === 0) {
  install(['all'], 'all', true)
  await verify(packages.map(value => value.name), 'all')
} else {
  expectRejected(['all'], 'rejected-all')
  install(compatible.map(value => value.dshEnhanced.feature), 'selected-compatible', true)
  await verify(compatible.map(value => value.name), 'selected-compatible')
}
if (compatible.length >= 2) {
  install(compatible.slice(0, 2).map(value => value.dshEnhanced.feature), 'reselect-two', true)
  await verify(compatible.slice(0, 2).map(value => value.name), 'reselect-two')
}
install(['none'], 'none', true)
await verify([], 'none')
// Exercise migration from a real, previously installed bundle in this isolated profile.
const retiredModel = resolve(home, 'retired-model-input-types')
mkdirSync(retiredModel)
writeFileSync(resolve(retiredModel, 'package.json'), JSON.stringify({
  name: 'dsh-enhanced-model-input-types', version: '7.2.1', type: 'module',
  main: './index.js', exports: { '.': './index.js' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}))
writeFileSync(resolve(retiredModel, 'index.js'), 'export const name = "retired-model-anchor"; export function apply() {}\n')
writeFileSync(resolve(retiredModel, 'cordis.patch.yml'), '- insert:\n    - id: model-input-types\n      name: dsh-enhanced-model-input-types\n')
command(process.execPath, [...cliArgs, 'plugin', '--profile', 'web', 'add', retiredModel, '--yes'], 'retired-model-install', dsh)
install(['none'], 'retired-model-cleanup', true)
await verify([], 'retired-model-cleanup')
if (incompatible.length === 0) {
  const aggregatePack = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json',
    '--pack-destination', home, root], { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.equal(aggregatePack.status, 0, aggregatePack.stderr)
  const aggregateArchive = resolve(home, JSON.parse(aggregatePack.stdout)[0].filename)
  command(process.execPath, [...cliArgs, 'plugin', '--profile', 'web', 'add', aggregateArchive, '--yes'], 'aggregate-install', dsh)
  await verify([manifest.name], 'aggregate')
}
console.log(`Compatibility selection gate passed; report: ${resolve(home, 'report.json')}`)
