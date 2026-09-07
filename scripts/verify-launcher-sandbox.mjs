import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { inspectToolchain } from '../packages/windows-launcher/src/toolchain.mjs'

// Opt-in integration against a read-only DSH checkout, with a disposable Harness home.
if (process.platform !== 'win32' || !process.argv[2]) throw new Error('Usage: node scripts/verify-launcher-sandbox.mjs <DSH checkout> [artifact directory] (Windows)')
const source = path.resolve(process.argv[2])
const output = path.resolve(process.argv[3] || '.verify-dsh-home/sandbox-artifacts')
fs.mkdirSync(output, { recursive: true })
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-launcher-sandbox-'))
const launcherHome = path.join(temporary, 'launcher')
fs.mkdirSync(launcherHome)
const executable = path.resolve('packages/windows-launcher/lib/DSH-Launcher.exe')
const shim = path.join(temporary, 'dsh-checkout-invoker.ps1')
// Sandbox launch must bypass this legacy shim, which deliberately fails.
fs.writeFileSync(shim, 'throw "The legacy shim must not run when NVM is available."')
const server = createServer()
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await new Promise(resolve => server.close(resolve))
const env = { ...process.env, DSH_HOME: path.join(temporary, 'dsh-home'), DEEPSEEK_HARNESS_LAUNCHER_HOME: launcherHome }
fs.writeFileSync(path.join(launcherHome, 'settings.json'), JSON.stringify({ Port: port, NoOpen: true,
  DshCommand: shim, DshSourceDirectory: source, WorkingDirectory: temporary }))
const run = (file, args, overrides = {}) => {
  const result = spawnSync(file, args, { env, encoding: 'utf8', windowsHide: true, timeout: 60000, ...overrides })
  assert.equal(result.status, 0, result.error?.message || result.stderr)
  return result.stdout
}
const automation = action => {
  const resultPath = path.join(temporary, `${action}.json`)
  run(executable, ['--automation', action, resultPath])
  const result = JSON.parse(fs.readFileSync(resultPath))
  assert.equal(result.success, true, result.message)
  return result
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let started = false
try {
  automation('start'); started = true
  const deadline = Date.now() + 240000
  let snapshot
  while (Date.now() < deadline) {
    const stateFile = path.join(launcherHome, 'run/web-toolchain.json')
    if (fs.existsSync(stateFile)) snapshot = JSON.parse(fs.readFileSync(stateFile))
    if (snapshot?.phase === 'error') throw new Error(snapshot.message)
    const access = path.join(launcherHome, 'run/web-access.json')
    if (snapshot?.phase === 'ready' && fs.existsSync(access)) break
    const webState = path.join(launcherHome, 'run/web-state.json')
    if (fs.existsSync(webState) && JSON.parse(fs.readFileSync(webState)).status === 'stopped') {
      throw new Error(`DSH stopped before readiness. Log: ${path.join(launcherHome, 'logs/dsh-web.log')}`)
    }
    await delay(500)
  }
  assert.ok(fs.existsSync(path.join(launcherHome, 'run/web-access.json')), 'DSH readiness timeout')
  assert.equal(snapshot.mode, 'sandbox')
  const probe = inspectToolchain({ sourceDirectory: source, dshCommand: shim,
    sandboxHome: path.join(launcherHome, 'sandbox') }, env)
  assert.equal(probe.summary.phase, 'ready', probe.summary.message)
  assert.equal(snapshot.nodeVersion, probe.summary.nodeVersion)
  assert.equal(snapshot.managerVersion, probe.summary.managerVersion)
  const managerShim = path.join(probe.environment.PATH.split(path.delimiter)[0], `${snapshot.manager}.ps1`)
  const version = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', managerShim, '--version'],
    { env: { ...env, ...probe.environment, NVM_SANDBOX_NODE_EXE: snapshot.nodePath,
      [`NVM_SANDBOX_${snapshot.manager.toUpperCase()}_CLI`]: path.join(probe.managerRoot,
        JSON.parse(fs.readFileSync(path.join(probe.managerRoot, 'package.json'))).bin[snapshot.manager]) } }).trim()
  assert.equal(version, snapshot.managerVersion)
  const access = JSON.parse(fs.readFileSync(path.join(launcherHome, 'run/web-access.json')))
  const response = await fetch(`http://127.0.0.1:${port}/?token=${access.token}`, { redirect: 'manual' })
  assert.ok(response.ok || response.status === 302 || response.status === 303, `Web HTTP ${response.status}`)
  run(executable, ['--screenshot', path.join(output, 'sandbox-overview.png'), 'overview', 'runtime'])
  automation('stop-and-wait'); started = false
  automation('start'); started = true
  const restartDeadline = Date.now() + 60000
  while (!fs.existsSync(path.join(launcherHome, 'run/web-access.json')) && Date.now() < restartDeadline) await delay(500)
  assert.ok(fs.existsSync(path.join(launcherHome, 'run/web-access.json')), 'cached restart timeout')
  automation('stop-and-wait'); started = false
  fs.writeFileSync(path.join(output, 'verified-runtime.json'), JSON.stringify({
    node: snapshot.nodeVersion, manager: snapshot.manager, managerVersion: snapshot.managerVersion,
    source, webReady: true, cachedRestart: true, stopped: true,
  }, null, 2))
  console.log(`Sandbox verified: Node ${snapshot.nodeVersion}, ${snapshot.manager} ${snapshot.managerVersion}; Web ready, cached restart and stop passed.`)
} catch (error) {
  const log = path.join(launcherHome, 'logs/dsh-web.log')
  if (fs.existsSync(log)) fs.copyFileSync(log, path.join(output, 'failed-web.log'))
  throw error
} finally {
  if (started) automation('stop-and-wait')
  fs.rmSync(temporary, { recursive: true, force: true })
}
