/** Run the unchanged official start:desktop script through the compiled Launcher in an isolated source view. */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') throw new Error('Desktop source verification requires Windows')
const root = fileURLToPath(new URL('..', import.meta.url))
const dsh = resolve(root, '../deepseek-harness')
assert.ok(existsSync(join(dsh, 'apps/desktop/lib/main.js')), 'Build the required DSH checkout first')
const scratch = join(root, '.verify-dsh-home')
mkdirSync(scratch, { recursive: true })
const directory = mkdtempSync(join(scratch, 'desktop-source-'))
const source = join(directory, 'source')
const home = join(directory, 'launcher')
mkdirSync(source); mkdirSync(home); mkdirSync(join(source, 'apps'))
for (const name of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.base.json']) {
  cpSync(join(dsh, name), join(source, name))
}
const link = (from, to) => symlinkSync(from, to, 'junction')
link(join(dsh, 'node_modules'), join(source, 'node_modules'))
// Only the Desktop application writes its development tree; copy it instead of linking it.
mkdirSync(join(source, 'apps/desktop'))
for (const name of ['package.json', 'lib', 'src', 'scripts', 'renderer']) {
  cpSync(join(dsh, 'apps/desktop', name), join(source, 'apps/desktop', name), { recursive: true })
}
link(join(dsh, 'apps/desktop/node_modules'), join(source, 'apps/desktop/node_modules'))
for (const name of ['cli', 'desktop-host', 'web']) link(join(dsh, 'apps', name), join(source, 'apps', name))

async function freePort() {
  const server = createServer()
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise(done => server.close(done))
  return port
}
const mainPort = await freePort(), rendererPort = await freePort(), hostPort = await freePort()
const env = { ...process.env, DEEPSEEK_HARNESS_LAUNCHER_HOME: home,
  DSH_DESKTOP_MAIN_INSPECT_PORT: String(mainPort), DSH_DESKTOP_RENDERER_DEBUG_PORT: String(rendererPort),
  DSH_DESKTOP_HOST_INSPECT_PORT: String(hostPort), DSH_TELEMETRY_MODE: 'DISABLED',
  DEEPSEEK_API_KEY: 'local-fixture', DEEPSEEK_BASE_URL: 'http://127.0.0.1:1/v1' }
delete env.DSH_HOME // Verify the official default development data path, entirely within the copy.
delete env.DSH_DESKTOP_DEV_PROJECT_DIR
delete env.DSH_DESKTOP_OPEN_DEVTOOLS
writeFileSync(join(home, 'settings.json'), JSON.stringify({ Port: await freePort(), LaunchMode: 'desktop', DshSourceDirectory: source }))
const exe = join(root, 'packages/windows-launcher/lib/DSH-Launcher.exe')
let sequence = 0
function action(name) {
  const file = join(directory, `result-${sequence++}.json`)
  const result = spawnSync(exe, ['--automation', name, file], { env, windowsHide: true, timeout: 30_000 })
  assert.equal(result.error, undefined)
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}
function state() { return JSON.parse(readFileSync(join(home, 'run/desktop-state.json'), 'utf8')) }
let verified = false
try {
  assert.equal(action('start-desktop').success, true)
  let pages = []
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (state().status === 'stopped') throw new Error(readFileSync(join(home, 'logs/dsh-desktop.log'), 'utf8'))
    try { pages = await (await fetch(`http://127.0.0.1:${rendererPort}/json/list`, { signal: AbortSignal.timeout(1000) })).json() } catch {}
    if (pages.some(page => page.url === 'dsh-app://app/index.html' && page.title.includes('DSH'))) break
    await new Promise(done => setTimeout(done, 300))
  }
  assert.ok(pages.some(page => page.url === 'dsh-app://app/index.html' && page.title.includes('DSH')), 'Official Desktop did not render its page')
  const log = readFileSync(join(home, 'logs/dsh-desktop.log'), 'utf8')
  assert.ok(log.includes('pnpm run start:desktop'))
  const project = join(source, 'apps/desktop/.desktop-build/development/project/package.json')
  assert.ok(existsSync(project), 'Official development profile was not created')
  const bundles = JSON.parse(readFileSync(project, 'utf8')).dsh.profile.bundles
  assert.ok(bundles.every(name => name.startsWith('@deepseek-ai/')), 'Do not silently inject Web plugins into the official development profile')
  const report = { command: 'pnpm run start:desktop', source, launcherHome: home, rendererPort,
    page: pages.find(page => page.url === 'dsh-app://app/index.html'), bundles }
  // Keep debugger addresses local to the ignored verification directory.
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`Official source Desktop rendered through Launcher: ${directory}`)
  verified = true
} finally {
  if ((!verified || process.env.DSH_VERIFY_KEEP_DESKTOP !== '1') && existsSync(join(home, 'run/desktop-state.json'))) {
    action('stop-desktop')
    const deadline = Date.now() + 30_000
    while (state().status !== 'stopped' && Date.now() < deadline) await new Promise(done => setTimeout(done, 200))
    assert.equal(state().status, 'stopped', 'Desktop supervisor did not stop')
  }
}
