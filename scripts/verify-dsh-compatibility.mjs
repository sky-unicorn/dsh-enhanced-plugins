/** Exercise real source-checkout profiles without touching the user's DSH home. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dsh = resolve(root, '../deepseek-harness')
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const cli = resolve(dsh, 'apps/cli/src/bin.ts')
const cliArgs = ['--import', pathToFileURL(resolve(dsh, 'node_modules/tsx/dist/esm/index.mjs')).href, cli]
if (process.platform !== 'win32') throw new Error('This installer integration gate requires Windows PowerShell 5.1.')
if (!existsSync(cli)) throw new Error('Build the required sibling DSH checkout before running this gate.')
const packages = readdirSync(resolve(root, 'packages'))
  .map(name => resolve(root, 'packages', name, 'package.json')).filter(existsSync)
  .map(path => JSON.parse(readFileSync(path, 'utf8')))
  .filter(value => value.dshEnhanced.kind === 'bundle')
const allNames = [manifest.name, ...packages.map(value => value.name)]
const scratch = resolve(root, '.verify-dsh-home')
mkdirSync(scratch, { recursive: true })
const home = mkdtempSync(resolve(scratch, 'selection-250-'))
const env = { ...process.env, DSH_HOME: home,
  DEEPSEEK_HARNESS_LAUNCHER_HOME: resolve(home, 'launcher'),
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

async function verify(expected, label) {
  const profile = JSON.parse(readFileSync(resolve(home, 'profiles/web/package.json'), 'utf8'))
  assert.deepEqual(Object.keys(profile.dependencies ?? {}).filter(name => allNames.includes(name)).sort(), [...expected].sort())
  assert.deepEqual(profile.dsh.profile.bundles.filter(name => allNames.includes(name)).sort(), [...expected].sort())
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((done, reject) => reservation.close(error => error ? reject(error) : done()))
  // Match the documented `pnpm dsh` source execution, including its workspace resolver.
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
for (const [index, value] of packages.entries()) {
  const label = `single-${value.dshEnhanced.feature}`
  install([value.dshEnhanced.feature], label, index > 0)
  await verify([value.name], label)
}
install(['all'], 'all', true)
await verify(packages.map(value => value.name), 'all')
install([packages[0].dshEnhanced.feature, packages[1].dshEnhanced.feature], 'reselect-two', true)
await verify([packages[0].name, packages[1].name], 'reselect-two')
install(['none'], 'none', true)
await verify([], 'none')
command(process.execPath, [...cliArgs, 'plugin', '--profile', 'web', 'add', root, '--yes'], 'aggregate-install', dsh)
await verify([manifest.name], 'aggregate')
console.log(`Compatibility selection gate passed; report: ${resolve(home, 'report.json')}`)
