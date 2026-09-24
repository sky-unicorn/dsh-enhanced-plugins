/** Exercise one-time MCP and subagent settings migration in a disposable rc.1 profile. */
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
import { resolveProject } from '../packages/windows-launcher/src/toolchain.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const dsh = resolve(process.env.DSH_VERIFY_CHECKOUT ?? resolve(root, '../deepseek-harness'))
const scratch = resolve(root, '.verify-dsh-home')
mkdirSync(scratch, { recursive: true })
const home = mkdtempSync(resolve(scratch, 'legacy-settings-'))
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
  DEEPSEEK_API_KEY: 'local-fixture', DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
  DEEPSEEK_HARNESS_LAUNCHER_HOME: resolve(home, 'launcher') }
const cliArgs = resolveProject({ sourceDirectory: dsh }).args
const patchPath = resolve(home, 'profiles/web/cordis.patch.yml')
const markerMcp = resolve(home, '.dsh-enhanced-mcp-settings-migrated')
const markerSubagent = resolve(home, '.dsh-enhanced-subagent-settings-migrated')
const legacyServer = 'legacy-fixture'

const install = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', resolve(root, 'scripts/migrate-to-enhanced-plugin.ps1'), '-DshCheckout', dsh,
  '-Features', 'mcp-server-manager,sub-agent', '-SkipBuild', '-SkipLauncherSystemIntegration'],
{ cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
writeFileSync(resolve(home, 'install.log'), `${install.stdout}\n${install.stderr}`)
assert.equal(install.status, 0, `Install failed; see ${home}/install.log`)
assert.ok(existsSync(resolve(home, 'profiles/web/node_modules/dsh-enhanced-mcp-server-manager')))
assert.ok(existsSync(resolve(home, 'profiles/web/node_modules/dsh-enhanced-sub-agent')))
writeFileSync(resolve(home, 'settings.yaml'), stringify({
  mcp: { servers: { [legacyServer]: {
    transport: 'stdio', command: process.execPath, args: ['-e', 'process.stdin.resume()'],
    env: { LEGACY_TOKEN: 'fixture-secret' },
  } } },
  'subagent-products': { claudeCode: true, codex: false },
}))

async function startWeb() {
  const probe = createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(done => probe.close(done))
  const child = spawn(process.execPath, [...cliArgs, 'web', '--port', String(port), '--no-open'],
    { cwd: dsh, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const accept = chunk => { output += chunk.toString() }
  child.stdout.on('data', accept)
  child.stderr.on('data', accept)
  const deadline = Date.now() + 90_000
  while (!/dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(output)) {
    if (child.exitCode !== null) throw new Error(`Host exited ${child.exitCode}: ${output}`)
    if (Date.now() > deadline) throw new Error(`Startup timed out: ${output}`)
    await new Promise(done => setTimeout(done, 200))
  }
  return { child, output: () => output }
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 30_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise(done => setTimeout(done, 200))
  }
}

const settings = () => parse(readFileSync(patchPath, 'utf8'))
const entry = (id) => settings().find(row => row.id === id)
let running
try {
  running = await startWeb()
  assert.doesNotMatch(running.output(), /(?:entry|entries) did not activate/,
    'selected feature Loader entries failed to activate')
  await waitFor(() => existsSync(markerMcp) && existsSync(markerSubagent), 'migration markers')
  const mcp = entry('mcp-manager')?.config?.servers?.[legacyServer]
  assert.equal(mcp?.env?.LEGACY_TOKEN, 'fixture-secret')
  assert.equal(entry('subagent-product-toggles')?.config?.claudeCode, true)
  assert.equal(entry('subagent-product-toggles')?.config?.codex, false)
  assert.ok(existsSync(resolve(home, 'settings.yaml.imported')), 'legacy backup missing')
  running.child.kill()
  await once(running.child, 'exit')
  running = undefined

  const rows = settings()
  const mcpRow = rows.find(row => row.id === 'mcp-manager')
  mcpRow.config.servers = {}
  writeFileSync(patchPath, stringify(rows))
  running = await startWeb()
  assert.doesNotMatch(running.output(), /(?:entry|entries) did not activate/,
    'selected feature Loader entries failed after restart')
  await new Promise(done => setTimeout(done, 2_000))
  assert.equal(entry('mcp-manager')?.config?.servers?.[legacyServer], undefined,
    'a deleted server was imported again after restart')
  console.log(`Legacy settings migration verification passed: ${home}`)
} finally {
  if (running?.child.exitCode === null) {
    running.child.kill()
    await once(running.child, 'exit')
  }
}
