import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, ...options })
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

async function readPnpmSteps(directory) {
  const trace = await readFile(resolve(directory, 'pnpm-steps.txt'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  return trace.trim() === '' ? [] : trace.trim().split(/\r?\n/)
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
const buildOnlyBin = resolve(temporary, 'build-only-bin')
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
  await mkdir(buildOnlyBin, { recursive: true })
  await copyFile(fixtureSource, fixture)
  await writeFile(resolve(dshSource, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-root',
    private: true,
    scripts: { clean: 'fixture-clean', build: 'fixture-build' },
  }), 'utf8')
  await writeFile(resolve(dshSource, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n", 'utf8')
  await writeFile(resolve(fakeBin, 'pnpm.cmd'), [
    '@echo off',
    '>> "%CD%\\pnpm-steps.txt" echo %*',
    'if not "%~3"=="" exit /b 40',
    'if /I "%~1"=="install" goto install',
    'if /I not "%~1"=="run" exit /b 41',
    'if /I "%~2"=="clean" goto clean',
    'if /I not "%~2"=="build" exit /b 42',
    'if not exist "%CD%\\install-marker.txt" exit /b 43',
    'echo BUILD_STDERR_WARNING 1>&2',
    'if defined DSH_LAUNCHER_VERIFY_BUILD_FAILURE echo BUILD_FAILED_FIXTURE 1>&2',
    'if defined DSH_LAUNCHER_VERIFY_BUILD_FAILURE exit /b 23',
    '> "%CD%\\build-marker.txt" echo BUILD_FIXTURE_OK',
    'echo BUILD_FIXTURE_OK',
    'exit /b 0',
    ':clean',
    'echo CLEAN_STDERR_WARNING 1>&2',
    'if defined DSH_LAUNCHER_VERIFY_CLEAN_FAILURE echo CLEAN_FAILED_FIXTURE 1>&2',
    'if defined DSH_LAUNCHER_VERIFY_CLEAN_FAILURE exit /b 21',
    '> "%CD%\\clean-marker.txt" echo CLEAN_FIXTURE_OK',
    'echo CLEAN_FIXTURE_OK',
    'exit /b 0',
    ':install',
    'if /I not "%~2"=="--frozen-lockfile" exit /b 44',
    'if not exist "%CD%\\clean-marker.txt" exit /b 45',
    'echo INSTALL_STDERR_WARNING 1>&2',
    'if defined DSH_LAUNCHER_VERIFY_INSTALL_FAILURE echo ERR_PNPM_OUTDATED_LOCKFILE 1>&2',
    'if defined DSH_LAUNCHER_VERIFY_INSTALL_FAILURE exit /b 22',
    '> "%CD%\\install-marker.txt" echo INSTALL_FIXTURE_OK',
    'echo INSTALL_FIXTURE_OK',
    'exit /b 0',
    '',
  ].join('\r\n'), 'utf8')
  await writeFile(resolve(fakeBin, 'git.cmd'), [
    '@echo off',
    'if /I not "%~1"=="-C" exit /b 51',
    'if /I "%~3"=="symbolic-ref" (echo master& exit /b 0)',
    'if /I "%~3"=="config" (echo origin& exit /b 0)',
    'if /I "%~3"=="remote" (echo https://github.com/deepseek-ai/deepseek-harness.git& exit /b 0)',
    'if /I "%~3"=="-c" goto proxied-pull',
    'if /I not "%~3"=="pull" exit /b 52',
    'if /I not "%~4"=="--ff-only" exit /b 53',
    'goto pull',
    ':proxied-pull',
    'rem Windows PowerShell 5.1 splits key=URL when invoking a .cmd fixture.',
    'if /I not "%~6"=="pull" exit /b 54',
    'if /I not "%~7"=="--ff-only" exit /b 55',
    ':pull',
    'echo GIT_STDERR_PROGRESS 1>&2',
    'if defined DSH_LAUNCHER_VERIFY_GIT_FAILURE echo fatal: Recv failure: Connection was reset 1>&2',
    'if defined DSH_LAUNCHER_VERIFY_GIT_FAILURE exit /b 128',
    '> "%~2\\git-pull-marker.txt" echo GIT_PULL_FIXTURE_OK',
    'echo GIT_PULL_FIXTURE_OK',
    'exit /b 0',
    '',
  ].join('\r\n'), 'utf8')
  await copyFile(resolve(fakeBin, 'pnpm.cmd'), resolve(buildOnlyBin, 'pnpm.cmd'))
  await writeFile(settingsPath, JSON.stringify({
    Port: port,
    NoOpen: true,
    DshCommand: fixture,
    DshSourceDirectory: dshSource,
    WorkingDirectory: profileHome,
  }), 'utf8')
  await writeFile(resolve(dataRoot, 'install-state.json'), JSON.stringify({
    schemaVersion: 1,
    projectSource: {
      mode: 'git-checkout',
      boundPath: root,
      repositoryUrl: 'https://github.com/sky-unicorn/dsh-enhanced-plugins.git',
      ref: 'master',
      lastSuccessfulRevision: 'fixture',
      lastCheckedRevision: 'fixture',
    },
    profiles: {
      web: {
        managed: true,
        desiredFeatures: [
          'edit-last-message', 'mcp-server-manager', 'model-input-types',
          'notification', 'plugin-market', 'sub-agent',
        ],
        knownFeatures: [
          'edit-last-message', 'mcp-server-manager', 'model-input-types',
          'notification', 'plugin-market', 'sub-agent',
        ],
      },
    },
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

  const buildOnlyResultPath = resolve(temporary, 'build-only-result.json')
  const windowsDirectory = process.env.WINDIR ?? 'C:\\Windows'
  const gitlessPath = [
    buildOnlyBin,
    resolve(windowsDirectory, 'System32'),
    windowsDirectory,
    resolve(windowsDirectory, 'System32/WindowsPowerShell/v1.0'),
  ].join(';')
  const buildOnly = run(executable, ['--automation', 'build', buildOnlyResultPath], {
    env: { ...environment, PATH: gitlessPath },
  })
  const buildOnlyResult = await readJson(buildOnlyResultPath)
  if (buildOnly.status !== 0 || buildOnlyResult.success !== true) {
    throw new Error(`launcher Git-less DSH source build did not start: ${JSON.stringify(buildOnlyResult)}\n${buildOnly.stderr}`)
  }
  const buildOnlyLog = await readFile(resolve(dataRoot, 'logs/dsh-build.log'), 'utf8')
  const buildOnlyMarker = await readFile(resolve(dshSource, 'build-marker.txt'), 'utf8')
  const expectedPnpmSteps = ['run clean', 'install --frozen-lockfile', 'run build']
  assert.deepEqual(await readPnpmSteps(dshSource), expectedPnpmSteps, 'Git-less clean/install/build order')
  if (!buildOnlyResult.output.includes('BUILD_FIXTURE_OK')
      || !buildOnlyLog.includes('Skipping Git source update; running clean, frozen install, and build')
      || buildOnlyLog.includes('git pull --ff-only')
      || buildOnlyMarker.trim() !== 'BUILD_FIXTURE_OK') {
    throw new Error(`launcher Git-less DSH source build failed: ${JSON.stringify(buildOnlyResult)}\n${buildOnly.stderr}`)
  }

  // Explicit build-only must also skip an installed Git, even when pulling would fail.
  const explicitBuildOnlyPath = resolve(temporary, 'explicit-build-only-result.json')
  const explicitBuildOnly = run(executable, ['--automation', 'build-only', explicitBuildOnlyPath], {
    env: { ...environment, DSH_LAUNCHER_VERIFY_GIT_FAILURE: '1' },
  })
  const explicitBuildOnlyResult = await readJson(explicitBuildOnlyPath)
  const explicitBuildOnlyLog = (await readFile(resolve(dataRoot, 'logs/dsh-build.log'), 'utf8')).slice(buildOnlyLog.length)
  assert.equal(explicitBuildOnly.status, 0, JSON.stringify(explicitBuildOnlyResult))
  assert.equal(explicitBuildOnlyResult.success, true)
  assert.match(explicitBuildOnlyLog, /Skipping Git source update/)
  assert.doesNotMatch(explicitBuildOnlyLog, /git pull --ff-only|Git unavailable|GIT_PULL_FIXTURE_OK/)
  assert.equal(await stat(resolve(dshSource, 'git-pull-marker.txt')).then(() => true, () => false), false)
  assert.deepEqual((await readPnpmSteps(dshSource)).slice(expectedPnpmSteps.length), expectedPnpmSteps,
    'explicit build-only clean/install/build order with Git installed')

  const buildResultPath = resolve(temporary, 'build-result.json')
  const priorBuildSteps = await readPnpmSteps(dshSource)
  const priorBuildLog = buildOnlyLog.length + explicitBuildOnlyLog.length
  const build = run(executable, ['--automation', 'build', buildResultPath], { env: environment })
  const buildResult = await readJson(buildResultPath)
  const buildLog = (await readFile(resolve(dataRoot, 'logs/dsh-build.log'), 'utf8')).slice(priorBuildLog)
  if (build.status !== 0 || buildResult.success !== true) {
    throw new Error(`launcher source build stopped before completion: ${JSON.stringify(buildResult)}\n${buildLog}`)
  }
  assert.deepEqual((await readPnpmSteps(dshSource)).slice(priorBuildSteps.length), expectedPnpmSteps,
    'updated source clean/install/build order')
  const buildMarker = await readFile(resolve(dshSource, 'build-marker.txt'), 'utf8')
  const gitMarker = await readFile(resolve(dshSource, 'git-pull-marker.txt'), 'utf8')
  if (build.status !== 0 || buildResult.success !== true
      || !buildResult.output.includes('BUILD_FIXTURE_OK')
      || !buildResult.output.includes('GIT_PULL_FIXTURE_OK')
      || !buildResult.output.includes('GIT_STDERR_PROGRESS')
      || !buildResult.output.includes('CLEAN_STDERR_WARNING')
      || !buildResult.output.includes('INSTALL_STDERR_WARNING')
      || !buildResult.output.includes('BUILD_STDERR_WARNING')
      || !buildLog.includes('git pull --ff-only') || !buildLog.includes('pnpm run build')
      || !buildLog.includes('pnpm run clean') || !buildLog.includes('pnpm install --frozen-lockfile')
      || buildLog.indexOf('git pull --ff-only') > buildLog.indexOf('pnpm run clean')
      || gitMarker.trim() !== 'GIT_PULL_FIXTURE_OK' || buildMarker.trim() !== 'BUILD_FIXTURE_OK') {
    throw new Error(`launcher DSH source build failed: ${JSON.stringify(buildResult)}\n${build.stderr}`)
  }

  // Exercise actual Windows PowerShell 5.1 stderr/exit behavior, not only the
  // success-only stdout fixtures that originally missed the early abort.
  async function failedBuild(name, env, expectedMessage, expectedLog,
    allowedSteps = expectedPnpmSteps, sourceDirectory = dshSource) {
    const previousLog = await readFile(resolve(dataRoot, 'logs/dsh-build.log'), 'utf8')
    const previousSteps = await readPnpmSteps(sourceDirectory)
    const resultPath = resolve(temporary, `${name}.json`)
    const processResult = run(executable, ['--automation', 'build', resultPath], { env })
    const result = await readJson(resultPath)
    const persistedLog = await readFile(resolve(dataRoot, 'logs/dsh-build.log'), 'utf8')
    const currentLog = persistedLog.slice(previousLog.length)
    assert.deepEqual((await readPnpmSteps(sourceDirectory)).slice(previousSteps.length), allowedSteps,
      `${name} must stop at the failed step`)
    if (processResult.status === 0 || result.success !== false
        || !result.message.includes(expectedMessage) || !currentLog.includes(expectedLog)
        || !currentLog.includes(result.message) || !result.output.includes(expectedLog)
        || expectedPnpmSteps.some(step => !allowedSteps.includes(step) && currentLog.includes(`pnpm ${step} (`))) {
      throw new Error(`${name} lost its failure or ran an unsafe next step: ${JSON.stringify(result)}\n${currentLog}`)
    }
  }

  await failedBuild('git-network-failure', { ...environment, DSH_LAUNCHER_VERIFY_GIT_FAILURE: '1' },
    'Git 拉取失败（退出码 128）', 'Connection was reset', [])
  const failureScreenshot = resolve(temporary, 'source-failure.png')
  const failureCapture = run(executable, ['--screenshot', failureScreenshot, 'source', 'sourcefailure'], { env: environment })
  if (failureCapture.status !== 0) {
    throw new Error(`source failure did not survive UI refresh: ${await readFile(`${failureScreenshot}.error.txt`, 'utf8')}`)
  }
  await failedBuild('pnpm-clean-failure', { ...environment, DSH_LAUNCHER_VERIFY_CLEAN_FAILURE: '1' },
    '清理构建产物失败（退出码 21）', 'CLEAN_FAILED_FIXTURE', ['run clean'])
  await failedBuild('pnpm-install-failure', { ...environment, DSH_LAUNCHER_VERIFY_INSTALL_FAILURE: '1' },
    '依赖安装失败（退出码 22）', 'ERR_PNPM_OUTDATED_LOCKFILE', ['run clean', 'install --frozen-lockfile'])
  await failedBuild('pnpm-build-failure', { ...environment, DSH_LAUNCHER_VERIFY_BUILD_FAILURE: '1' },
    'DSH 构建失败（退出码 23）', 'BUILD_FAILED_FIXTURE')

  const gitOnlyBin = resolve(temporary, 'git-only-bin')
  await mkdir(gitOnlyBin)
  await copyFile(resolve(fakeBin, 'git.cmd'), resolve(gitOnlyBin, 'git.cmd'))
  await failedBuild('missing-pnpm', { ...environment, PATH: gitlessPath.replace(buildOnlyBin, gitOnlyBin) },
    '环境检查失败', 'pnpm', [])

  const sourceLock = resolve(dshSource, 'pnpm-lock.yaml')
  const savedLock = await readFile(sourceLock, 'utf8')
  try {
    await rm(sourceLock)
    await failedBuild('missing-lockfile', environment, '环境检查失败', 'pnpm-lock.yaml', [])
  } finally {
    await writeFile(sourceLock, savedLock, 'utf8')
  }
  const sourceManifest = resolve(dshSource, 'package.json')
  const savedManifest = await readFile(sourceManifest, 'utf8')
  try {
    const withoutClean = JSON.parse(savedManifest)
    delete withoutClean.scripts.clean
    await writeFile(sourceManifest, JSON.stringify(withoutClean), 'utf8')
    await failedBuild('missing-clean-script', environment, '环境检查失败', 'clean', [])
  } finally {
    await writeFile(sourceManifest, savedManifest, 'utf8')
  }

  // A script-engine failure before its structured result is written must also
  // reach the durable log, otherwise the next UI timer tick would erase it.
  const brokenEngine = resolve(temporary, 'broken-engine')
  await mkdir(brokenEngine)
  await copyFile(executable, resolve(brokenEngine, 'DSH-Launcher.exe'))
  await writeFile(resolve(brokenEngine, 'DSH-Launcher.Command.ps1'), '\uFEFFthrow "ENGINE_FAILURE_FIXTURE 中文错误"\n', 'utf8')
  const engineResultPath = resolve(temporary, 'engine-failure.json')
  const engineRun = run(resolve(brokenEngine, 'DSH-Launcher.exe'), ['--automation', 'build', engineResultPath], { env: environment })
  const engineResult = await readJson(engineResultPath)
  const engineLog = await readFile(resolve(dataRoot, 'logs/dsh-build.log'), 'utf8')
  if (engineRun.status === 0 || !engineResult.output.includes('ENGINE_FAILURE_FIXTURE')
      || !engineLog.includes('ENGINE_FAILURE_FIXTURE')) {
    throw new Error(`command-engine error was not persisted: ${JSON.stringify(engineResult)}`)
  }
  const leakedRequests = (await readdir(resolve(dataRoot, 'requests'))).filter(name => name.startsWith('build-'))
  if (leakedRequests.length > 0) throw new Error(`source build left request files behind: ${leakedRequests.join(', ')}`)

  // Real Git, local-only: fast-forward a checkout with a Unicode/space path,
  // then reject an update that would overwrite the user's local changes.
  const realGit = run('where.exe', ['git.exe']).stdout.trim().split(/\r?\n/)[0]
  if (!realGit) throw new Error('real Git is required for source-update integration verification')
  const remote = resolve(temporary, 'source-remote.git')
  const seed = resolve(temporary, 'source-seed')
  const checkout = resolve(temporary, '源码 checkout & space')
  function git(args) {
    const result = run(realGit, args)
    if (result.status !== 0) throw new Error(`local Git fixture failed: ${result.stdout}\n${result.stderr}`)
    return result.stdout.trim()
  }
  git(['init', '--bare', remote])
  git(['init', '-b', 'main', seed])
  git(['-C', seed, 'config', 'user.name', 'Launcher Verification'])
  git(['-C', seed, 'config', 'user.email', 'launcher-verification@example.invalid'])
  await copyFile(resolve(dshSource, 'package.json'), resolve(seed, 'package.json'))
  await copyFile(resolve(dshSource, 'pnpm-lock.yaml'), resolve(seed, 'pnpm-lock.yaml'))
  await writeFile(resolve(seed, 'tracked.txt'), 'base\n')
  git(['-C', seed, 'add', 'package.json', 'pnpm-lock.yaml', 'tracked.txt'])
  git(['-C', seed, 'commit', '-m', 'fixture base'])
  git(['-C', seed, 'remote', 'add', 'origin', remote])
  git(['-C', seed, 'push', '-u', 'origin', 'main'])
  git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(['clone', remote, checkout])
  await writeFile(resolve(seed, 'tracked.txt'), 'remote update\n')
  git(['-C', seed, 'commit', '-am', 'fixture update'])
  git(['-C', seed, 'push'])
  const savedSettings = await readFile(settingsPath, 'utf8')
  const realGitEnvironment = { ...environment, PATH: `${buildOnlyBin};${dirname(realGit)};${process.env.PATH ?? ''}` }
  try {
    await writeFile(settingsPath, JSON.stringify({ ...JSON.parse(savedSettings), DshSourceDirectory: checkout }))
    const actualBuildPath = resolve(temporary, 'real-git-build.json')
    const actualBuild = run(executable, ['--automation', 'build', actualBuildPath], { env: realGitEnvironment })
    const actualResult = await readJson(actualBuildPath)
    if (actualBuild.status !== 0 || actualResult.success !== true
        || git(['-C', checkout, 'rev-parse', 'HEAD']) !== git(['-C', seed, 'rev-parse', 'HEAD'])
        || !actualResult.output.includes('BUILD_FIXTURE_OK')) {
      throw new Error(`real Git fast-forward failed: ${JSON.stringify(actualResult)}`)
    }
    assert.deepEqual(await readPnpmSteps(checkout), expectedPnpmSteps, 'real Git update before clean/install/build')
    await writeFile(resolve(checkout, 'tracked.txt'), 'user local changes\n')
    await writeFile(resolve(seed, 'tracked.txt'), 'another remote update\n')
    git(['-C', seed, 'commit', '-am', 'fixture conflict'])
    git(['-C', seed, 'push'])
    const preservedHead = git(['-C', checkout, 'rev-parse', 'HEAD'])
    await failedBuild('real-git-local-changes', realGitEnvironment,
      'Git 拉取失败', 'would be overwritten', [], checkout)
    if (await readFile(resolve(checkout, 'tracked.txt'), 'utf8') !== 'user local changes\n'
        || git(['-C', checkout, 'rev-parse', 'HEAD']) !== preservedHead) {
      throw new Error('source update changed a checkout after a rejected merge')
    }
  } finally {
    await writeFile(settingsPath, savedSettings)
  }

  // Real pnpm must not auto-install before clean and silently repair a stale
  // lockfile before the explicit frozen install can reject it.
  const pnpmSource = resolve(temporary, 'real-pnpm-source')
  await mkdir(pnpmSource)
  const pnpmManifest = {
    name: '@deepseek-ai/dsh-root', version: '1.0.0', private: true,
    scripts: { clean: 'node lifecycle.cjs clean', build: 'node lifecycle.cjs build' },
  }
  await writeFile(resolve(pnpmSource, 'package.json'), JSON.stringify(pnpmManifest))
  await writeFile(resolve(pnpmSource, 'pnpm-workspace.yaml'), 'verifyDepsBeforeRun: install\n')
  await writeFile(resolve(pnpmSource, 'lifecycle.cjs'), [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const output = path.resolve(__dirname, 'lib')",
    "if (path.dirname(output) !== __dirname) throw new Error('Unsafe fixture output path')",
    'const stage = process.argv[2]',
    "fs.appendFileSync(path.join(__dirname, 'steps.txt'), stage + '\\n')",
    "if (stage === 'clean') fs.rmSync(output, { recursive: true, force: true })",
    "else if (stage === 'build') {",
    '  fs.mkdirSync(output, { recursive: true })',
    "  fs.writeFileSync(path.join(output, 'fresh.txt'), 'REAL_BUILD_OK')",
    "} else throw new Error('Unexpected fixture stage')",
  ].join('\n'))
  const realPnpmEnvironment = { ...environment, PATH: process.env.PATH, pnpm_config_verify_deps_before_run: 'install' }
  const seedLock = run('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    "$ErrorActionPreference = 'Stop'\n$pnpm = Get-Command pnpm -CommandType Application | Select-Object -First 1\n& $pnpm.Source install --lockfile-only --offline --ignore-scripts\nexit $LASTEXITCODE",
  ], { cwd: pnpmSource, env: realPnpmEnvironment })
  if (seedLock.status !== 0) throw new Error(`real pnpm fixture setup failed: ${seedLock.stdout}\n${seedLock.stderr}`)
  const frozenLock = await readFile(resolve(pnpmSource, 'pnpm-lock.yaml'), 'utf8')
  await mkdir(resolve(pnpmSource, 'lib'))
  await writeFile(resolve(pnpmSource, 'lib/stale.txt'), 'stale build output')
  async function realPnpmBuild(name) {
    const requestPath = resolve(temporary, `${name}.request.json`)
    const resultPath = resolve(temporary, `${name}.result.json`)
    const logPath = resolve(temporary, `${name}.log`)
    await writeFile(requestPath, JSON.stringify({
      requestId: crypto.randomUUID(), mode: 'build', sourceDirectory: pnpmSource,
      workingDirectory: pnpmSource, updateSource: false, logPath, resultPath,
    }))
    const processResult = run('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', commandScript, '-RequestPath', requestPath,
    ], { env: realPnpmEnvironment })
    return { processResult, result: await readJson(resultPath), log: await readFile(logPath, 'utf8') }
  }
  const realBuild = await realPnpmBuild('real-pnpm-success')
  assert.equal(realBuild.processResult.status, 0, realBuild.log)
  assert.equal(realBuild.result.success, true, realBuild.log)
  assert.equal(await stat(resolve(pnpmSource, 'lib/stale.txt')).then(() => true, () => false), false)
  assert.equal(await readFile(resolve(pnpmSource, 'lib/fresh.txt'), 'utf8'), 'REAL_BUILD_OK')
  assert.equal(await readFile(resolve(pnpmSource, 'pnpm-lock.yaml'), 'utf8'), frozenLock)
  await mkdir(resolve(pnpmSource, 'fixture-dep'))
  await writeFile(resolve(pnpmSource, 'fixture-dep/package.json'), JSON.stringify({ name: 'fixture-dep', version: '1.0.0' }))
  await writeFile(resolve(pnpmSource, 'package.json'), JSON.stringify({
    ...pnpmManifest, dependencies: { 'fixture-dep': 'file:./fixture-dep' },
  }))
  const lockMismatch = await realPnpmBuild('real-pnpm-lock-mismatch')
  assert.notEqual(lockMismatch.processResult.status, 0, lockMismatch.log)
  assert.equal(lockMismatch.result.success, false, lockMismatch.log)
  assert.match(lockMismatch.result.message, /依赖安装失败/)
  assert.match(lockMismatch.log, /ERR_PNPM_OUTDATED_LOCKFILE/)
  assert.doesNotMatch(lockMismatch.log, /pnpm run build/)
  assert.equal(await readFile(resolve(pnpmSource, 'pnpm-lock.yaml'), 'utf8'), frozenLock)
  assert.equal(await readFile(resolve(pnpmSource, 'steps.txt'), 'utf8'), 'clean\nbuild\nclean\n')

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
  const ownedState = await readJson(resolve(dataRoot, 'run/web-state.json'))
  const accessPath = resolve(dataRoot, 'run/web-access.json')
  await waitFor(async () => stat(accessPath).then(() => true).catch(() => false), 'current Web authentication entry')
  const access = await readJson(accessPath)
  assert.equal(access.requestId, ownedState.requestId)
  assert.equal(access.port, port)
  assert.equal(access.token, 'LauncherFixtureToken_0123456789-abcdef')

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
  if (!webLogText.includes(`fixture web 中文监听 on ${port}`)
      || !webLogText.includes(`http://127.0.0.1:${port}/?token=<redacted>`)
      || webLogText.includes('LauncherFixtureToken_0123456789-abcdef')
      || webLogText.includes('\0')) {
    throw new Error(`Web log was not written as UTF-8: ${webLogText}`)
  }
  assert.equal(await stat(accessPath).then(() => true).catch(() => false), false)

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
    ['compact-source', 'source', 'compact', 820, 600],
    ['compact-plugins', 'plugins', 'compact', 820, 600],
    ['wide-tasks', 'tasks', 'wide', 1600, 900],
    ['wide-diagnostics', 'diagnostics', 'wide', 1600, 900],
    ['wide-source', 'source', 'wide', 1600, 900],
    ['wide-plugins', 'plugins', 'wide', 1600, 900],
    ['resize-scroll-plugins', 'plugins', 'pluginstress', 1600, 900],
    ['scale-125-overview', 'overview', 'scale125', 1366, 720],
    ['scale-150-overview', 'overview', 'scale150', 1366, 720],
    ['scale-175-overview', 'overview', 'scale175', 1366, 720],
    ['scale-200-overview', 'overview', 'scale200', 1366, 720],
    ['scale-200-tasks', 'tasks', 'scale200', 1366, 720],
    ['scale-200-diagnostics', 'diagnostics', 'scale200', 1366, 720],
    ['scale-200-source', 'source', 'scale200', 1366, 720],
    ['scale-150-plugins', 'plugins', 'scale150', 1366, 720],
    ['scale-200-plugins', 'plugins', 'scale200', 1366, 720],
    ['scale-150-wide-overview', 'overview', 'scale150wide', 1920, 1024],
    ['scale-150-wide-tasks', 'tasks', 'scale150wide', 1920, 1024],
    ['scale-150-wide-plugins', 'plugins', 'scale150wide', 1920, 1024],
  ]) {
    const responsiveScreenshot = resolve(temporary, `launcher-${name}.png`)
    const responsiveCapture = run(executable, [
      '--screenshot', responsiveScreenshot, page, layout,
    ], { env: environment })
    if (responsiveCapture.status !== 0) {
      const captureError = await readFile(`${responsiveScreenshot}.error.txt`, 'utf8').catch(() => responsiveCapture.stderr)
      throw new Error(`launcher ${name} capture failed: ${captureError}`)
    }
    await waitFor(async () => stat(responsiveScreenshot).then(() => true).catch(() => false), `${name} screenshot`, 5_000)
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
