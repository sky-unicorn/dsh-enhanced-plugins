/** Verify compiled Launcher source-command dispatch, failures, duplicate suppression and tree cleanup. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, copyFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') throw new Error('Desktop Launcher verification requires Windows')
const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = join(root, '.verify-dsh-home')
mkdirSync(scratch, { recursive: true })
const directory = mkdtempSync(join(scratch, 'desktop-command-'))
const source = join(directory, 'DSH source 中文 & spaces')
const home = join(directory, 'launcher')
const bin = join(directory, 'bin')
for (const path of [source, home, bin]) mkdirSync(path, { recursive: true })
copyFileSync(process.execPath, join(bin, 'node.exe'))
const exe = join(root, 'packages/windows-launcher/lib/DSH-Launcher.exe')
const env = { ...process.env, DEEPSEEK_HARNESS_LAUNCHER_HOME: home, DSH_HOME: join(directory, 'dsh-home'),
  APPDATA: join(directory, 'appdata'), LOCALAPPDATA: join(directory, 'localappdata'),
  NVM_HOME: '', NVM_DIR: '', DSH_DESKTOP_OPEN_DEVTOOLS: '',
  PATH: [bin, dirname(process.execPath), ...(process.env.PATH ?? '').split(';').filter(p => !/nvm/i.test(p))].join(';') }
delete env.DSH_DESKTOP_OPEN_DEVTOOLS
const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
const reservation = createServer()
await new Promise(done => reservation.listen(0, '127.0.0.1', done))
const port = reservation.address().port
await new Promise(done => reservation.close(done))
const settings = { Port: port, LaunchMode: 'desktop', DshSourceDirectory: source, DesktopExecutable: 'C:\\retired\\ignored.exe' }
write(join(home, 'settings.json'), JSON.stringify(settings))
write(join(source, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version: '0.1.3-alpha.2',
  packageManager: 'pnpm@11.7.0', engines: { node: '>=22.19.0' },
  scripts: { build: 'fixture', 'dev:desktop': 'fixture', 'start:desktop': 'fixture' } }))
write(join(source, 'tsconfig.json'), '{}')
write(join(source, 'apps/desktop/scripts/dev.ts'), '// command selection fixture')
write(join(source, 'node_modules/tsx/dist/esm/index.mjs'), '// dependency presence fixture')
write(join(bin, 'pnpm.cmd'), [
  '@echo off',
  'if /I "%~1"=="--version" (',
  '  if exist "%CD%\\wrong-version" (echo 10.0.0) else (echo 11.7.0)',
  '  exit /b 0',
  ')',
  'if /I not "%~1"=="run" exit /b 91',
  'if /I not "%~2"=="start:desktop" if /I not "%~2"=="dev:desktop" exit /b 92',
  'if not "%~3"=="" exit /b 93',
  '>> "%CD%\\calls.txt" echo %~2',
  '> "%CD%\\devtools.txt" echo %DSH_DESKTOP_OPEN_DEVTOOLS%',
  'echo DESKTOP_COMMAND_STARTED',
  'if exist "%CD%\\fail" exit /b 19',
  'powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 120"',
  'exit /b 0', '',
].join('\r\n'))

let serial = 0
function action(name) {
  const output = join(directory, `result-${serial++}.json`)
  const result = spawnSync(exe, ['--automation', name, output], { env, windowsHide: true, timeout: 20_000 })
  assert.equal(result.error, undefined)
  return json(output)
}
const state = () => json(join(home, 'run/desktop-state.json'))
async function until(predicate, label) {
  const end = Date.now() + 30_000
  while (Date.now() < end) {
    if (predicate()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 150))
  }
  throw new Error(`Timed out: ${label}; ${existsSync(join(home, 'logs/dsh-desktop.log')) ? readFileSync(join(home, 'logs/dsh-desktop.log'), 'utf8') : ''}`)
}
const calls = () => existsSync(join(source, 'calls.txt')) ? readFileSync(join(source, 'calls.txt'), 'utf8').trim().split(/\r?\n/) : []
async function stop() {
  assert.equal(action('stop-desktop').success, true)
  await until(() => state().status === 'stopped', 'supervisor stop')
  assert.equal(state().stoppedByLauncher, true)
}

try {
  assert.equal(action('start-desktop').success, false, 'missing build must fail before launch')
  assert.equal(calls().length, 0)
  assert.equal(action('build-desktop').success, true)
  await until(() => calls().length === 1, 'dev:desktop dispatch')
  assert.deepEqual(calls(), ['dev:desktop'])
  assert.equal(json(join(home, 'run/desktop-toolchain.json')).managerVersion, '11.7.0')
  assert.equal(readFileSync(join(source, 'devtools.txt'), 'utf8').trim(), '0')
  const first = state().requestId
  assert.equal(action('build-desktop').success, true)
  assert.equal(state().requestId, first, 'duplicate start must reuse the running request')
  await stop()
  for (const file of ['apps/desktop/lib/main.js', 'apps/desktop-host/lib/index.js', 'apps/web/dist/index.html']) write(join(source, file), '')
  assert.equal(action('start-desktop').success, true)
  await until(() => calls().length === 2, 'start:desktop dispatch')
  assert.equal(calls()[1], 'start:desktop')
  await stop()
  write(join(source, 'fail'), '')
  assert.equal(action('start-desktop').success, true)
  await until(() => state().status === 'stopped', 'failed command exit')
  assert.equal(state().exitCode, 19, 'preserve pnpm failure')
  rmSync(join(source, 'fail'))
  write(join(source, 'wrong-version'), '')
  assert.equal(action('start-desktop').success, true)
  await until(() => state().status === 'stopped', 'version mismatch')
  assert.equal(state().exitCode, 1)
  assert.equal(calls().length, 3, 'mismatched pnpm must not run a source script')
  write(join(directory, 'report.json'), JSON.stringify({ start: 'passed', build: 'passed', duplicate: 'passed', stop: 'passed', failure: 'passed', version: 'passed' }, null, 2))
  console.log(`Desktop source command verification passed: ${directory}`)
} finally {
  if (existsSync(join(home, 'run/desktop-state.json')) && state().status !== 'stopped') await stop()
}
