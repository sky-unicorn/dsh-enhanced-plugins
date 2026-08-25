import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const launcherRoot = resolve(root, 'packages/windows-launcher')
const executable = resolve(launcherRoot, 'lib/DSH-Launcher.exe')
const commandScript = resolve(launcherRoot, 'lib/DSH-Launcher.Command.ps1')
const fixtureSource = resolve(root, 'tests/packages/fixtures/dsh.ps1')

function run(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', ...options })
  if (result.error !== undefined) throw result.error
  return result
}

async function freePort() {
  const server = createServer()
  await new Promise((resolveReady, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveReady)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('unable to allocate a launcher test port')
  await new Promise(resolveClose => server.close(resolveClose))
  return address.port
}

async function waitFor(check, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 180))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

if (process.platform !== 'win32') {
  process.stdout.write('windows-launcher verification skipped on a non-Windows host\n')
  process.exit(0)
}

const temporary = await mkdtemp(resolve(tmpdir(), 'dsh-enhanced-launcher-'))
const localAppData = resolve(temporary, 'LocalAppData')
const profileHome = resolve(temporary, 'User')
const fixture = resolve(temporary, 'dsh.ps1')
const dshSource = resolve(temporary, 'deepseek-harness')
const fakeBin = resolve(temporary, 'bin')
const dataRoot = resolve(localAppData, 'DeepSeekHarness/Launcher')
const settingsPath = resolve(dataRoot, 'settings.json')
const port = await freePort()
const environment = {
  ...process.env,
  LOCALAPPDATA: localAppData,
  USERPROFILE: profileHome,
  DSH_CMD: fixture,
  DEEPSEEK_HARNESS_LAUNCHER_HOME: dataRoot,
  PATH: `${fakeBin};${process.env.PATH ?? ''}`,
}

let started = false
try {
  await mkdir(dataRoot, { recursive: true })
  await mkdir(profileHome, { recursive: true })
  await mkdir(dshSource, { recursive: true })
  await mkdir(fakeBin, { recursive: true })
  await copyFile(fixtureSource, fixture)
  await writeFile(resolve(dshSource, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-root',
    private: true,
    scripts: { build: 'fixture-build' },
  }), 'utf8')
  await writeFile(resolve(fakeBin, 'pnpm.cmd'), [
    '@echo off',
    'if /I not "%~1"=="run" exit /b 41',
    'if /I not "%~2"=="build" exit /b 42',
    '> "%CD%\\build-marker.txt" echo BUILD_FIXTURE_OK',
    'echo BUILD_FIXTURE_OK',
    'exit /b 0',
    '',
  ].join('\r\n'), 'utf8')
  await writeFile(settingsPath, JSON.stringify({
    Port: port,
    NoOpen: true,
    DshCommand: fixture,
    DshSourceDirectory: dshSource,
    WorkingDirectory: profileHome,
  }), 'utf8')

  const selfTest = resolve(temporary, 'self-test.txt')
  const self = run(executable, ['--self-test', selfTest], { env: environment })
  if (self.status !== 0 || (await readFile(selfTest, 'utf8')).trim() !== 'SELF_TEST_OK') {
    throw new Error(`launcher self-test failed: ${self.stderr}`)
  }

  const doctorPath = resolve(temporary, 'doctor.txt')
  const doctor = run(executable, ['--doctor', doctorPath], { env: environment })
  const doctorText = await readFile(doctorPath, 'utf8')
  if (doctor.status !== 0 || !doctorText.includes('dsh-launcher-fixture 中文结果 0.1.0')) {
    throw new Error(`launcher doctor failed: ${doctorText}\n${doctor.stderr}`)
  }

  const buildResultPath = resolve(temporary, 'build-result.json')
  const build = run(executable, ['--automation', 'build', buildResultPath], { env: environment })
  const buildResult = await readJson(buildResultPath)
  const buildLog = await readFile(resolve(dataRoot, 'logs/dsh-build.log'), 'utf8')
  const buildMarker = await readFile(resolve(dshSource, 'build-marker.txt'), 'utf8')
  if (build.status !== 0 || buildResult.success !== true
      || !buildResult.output.includes('BUILD_FIXTURE_OK')
      || !buildLog.includes('pnpm run build') || buildMarker.trim() !== 'BUILD_FIXTURE_OK') {
    throw new Error(`launcher DSH source build failed: ${JSON.stringify(buildResult)}\n${build.stderr}`)
  }

  const headlessRequest = resolve(temporary, 'headless.json')
  const metacharacterTask = '中文任务 & whoami | more > marker.txt'
  await writeFile(headlessRequest, JSON.stringify({
    requestId: crypto.randomUUID(),
    mode: 'headless',
    dshCommand: fixture,
    workingDirectory: profileHome,
    task: metacharacterTask,
  }), 'utf8')
  const headless = run('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', commandScript, '-RequestPath', headlessRequest,
  ], { env: environment, windowsHide: true })
  if (headless.status !== 0 || headless.stdout.trim() !== `HEADLESS:中文结果:${metacharacterTask}`) {
    throw new Error(`headless request was not preserved as data: ${headless.stdout}\n${headless.stderr}`)
  }

  const profileRequest = resolve(temporary, 'profile.json')
  const profileLog = resolve(dataRoot, 'logs/profile-web.log')
  await writeFile(profileRequest, JSON.stringify({
    requestId: crypto.randomUUID(),
    mode: 'profile',
    dshCommand: fixture,
    workingDirectory: profileHome,
    profile: 'web',
    logPath: profileLog,
  }), 'utf8')
  const profile = run('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', commandScript, '-RequestPath', profileRequest,
  ], { env: environment, windowsHide: true })
  const profileLogText = await readFile(profileLog, 'utf8')
  if (profile.status !== 0 || !profileLogText.includes('PROFILE:中文结果:web') || profileLogText.includes('\0')) {
    throw new Error(`hidden profile UTF-8 log validation failed: ${profileLogText}\n${profile.stderr}`)
  }

  const startOutput = resolve(temporary, 'start.json')
  const start = run(executable, ['--automation', 'start', startOutput], { env: environment })
  if (start.status !== 0) {
    const detail = await readJson(startOutput).catch(() => undefined)
    throw new Error(`launcher start failed: ${JSON.stringify(detail)} ${start.stderr}`)
  }
  started = true
  await waitFor(async () => {
    const statusOutput = resolve(temporary, `status-${Date.now()}.json`)
    const status = run(executable, ['--automation', 'status', statusOutput], { env: environment })
    if (status.status !== 0) return false
    return (await readJson(statusOutput)).ownership === 'Owned'
  }, 'launcher-owned Web readiness')

  const stopOutput = resolve(temporary, 'stop.json')
  const stop = run(executable, ['--automation', 'stop-and-wait', stopOutput], { env: environment })
  if (stop.status !== 0) throw new Error(`launcher stop failed: ${stop.stderr}`)
  await waitFor(async () => {
    const statusOutput = resolve(temporary, `stopped-${Date.now()}.json`)
    const status = run(executable, ['--automation', 'status', statusOutput], { env: environment })
    if (status.status !== 0) return false
    return (await readJson(statusOutput)).ownership === 'Stopped'
  }, 'launcher-owned Web shutdown')
  started = false
  const webLogText = await readFile(resolve(dataRoot, 'logs/dsh-web.log'), 'utf8')
  if (!webLogText.includes(`fixture web 中文监听 on ${port}`) || webLogText.includes('\0')) {
    throw new Error(`Web log was not written as UTF-8: ${webLogText}`)
  }

  const screenshot = resolve(temporary, 'launcher.png')
  const capture = run(executable, ['--screenshot', screenshot], { env: environment })
  const screenshotInfo = await stat(screenshot)
  const screenshotBytes = await readFile(screenshot)
  const signature = screenshotBytes.subarray(0, 8).toString('hex')
  if (capture.status !== 0 || screenshotInfo.size < 20_000 || signature !== '89504e470d0a1a0a'
      || screenshotBytes.readUInt32BE(16) < 1000 || screenshotBytes.readUInt32BE(20) < 650) {
    throw new Error('launcher visual capture validation failed')
  }

  const firstShowScreenshot = resolve(temporary, 'launcher-first-show.png')
  const firstShowCapture = run(executable, [
    '--screenshot', firstShowScreenshot, 'overview', 'first',
  ], { env: environment })
  const firstShowBytes = await readFile(firstShowScreenshot)
  if (firstShowCapture.status !== 0 || firstShowBytes.length < 20_000
      || firstShowBytes.readUInt32BE(16) !== 1120 || firstShowBytes.readUInt32BE(20) !== 740) {
    throw new Error(`launcher first-show layout validation failed: ${firstShowCapture.stderr}`)
  }

  const wideScreenshot = resolve(temporary, 'launcher-wide.png')
  const wideCapture = run(executable, ['--screenshot', wideScreenshot, 'overview', 'wide'], { env: environment })
  const wideBytes = await readFile(wideScreenshot)
  if (wideCapture.status !== 0 || wideBytes.length < 20_000
      || wideBytes.readUInt32BE(16) !== 1600 || wideBytes.readUInt32BE(20) !== 900) {
    throw new Error('launcher responsive visual capture validation failed')
  }

  const stressScreenshot = resolve(temporary, 'launcher-resize-stress.png')
  const stressStartedAt = Date.now()
  const stressCapture = run(executable, ['--screenshot', stressScreenshot, 'overview', 'stress'], { env: environment })
  const stressElapsedMs = Date.now() - stressStartedAt
  const stressBytes = await readFile(stressScreenshot)
  if (stressCapture.status !== 0 || stressBytes.length < 20_000 || stressElapsedMs > 7500
      || stressBytes.readUInt32BE(16) !== 1120 || stressBytes.readUInt32BE(20) !== 740) {
    throw new Error(`launcher resize stress validation failed after ${stressElapsedMs}ms`)
  }

  for (const [name, page, layout, expectedWidth, expectedHeight] of [
    ['compact-overview', 'overview', 'compact', 820, 600],
    ['compact-tasks', 'tasks', 'compact', 820, 600],
    ['compact-diagnostics', 'diagnostics', 'compact', 820, 600],
    ['scale-150-overview', 'overview', 'scale150', 1366, 720],
    ['scale-200-overview', 'overview', 'scale200', 1366, 720],
    ['scale-200-tasks', 'tasks', 'scale200', 1366, 720],
    ['scale-200-diagnostics', 'diagnostics', 'scale200', 1366, 720],
  ]) {
    const responsiveScreenshot = resolve(temporary, `launcher-${name}.png`)
    const responsiveCapture = run(executable, [
      '--screenshot', responsiveScreenshot, page, layout,
    ], { env: environment })
    const responsiveBytes = await readFile(responsiveScreenshot)
    if (responsiveCapture.status !== 0 || responsiveBytes.length < 20_000
        || responsiveBytes.readUInt32BE(16) !== expectedWidth
        || responsiveBytes.readUInt32BE(20) !== expectedHeight) {
      throw new Error(`launcher ${name} layout validation failed: ${responsiveCapture.stderr}`)
    }
  }

  process.stdout.write(`windows-launcher verification passed on port ${port}\n`)
} finally {
  if (started) {
    const emergencyOutput = resolve(temporary, 'emergency-stop.json')
    run(executable, ['--automation', 'stop', emergencyOutput], { env: environment })
    await new Promise(resolveWait => setTimeout(resolveWait, 800))
  }
  await rm(temporary, { recursive: true, force: true })
}
