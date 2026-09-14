import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { discoverNvm, inspectToolchain, requirements, resolveProject } from '../../packages/windows-launcher/src/toolchain.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-toolchain-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (file, value) => {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value))
    return target
  }
  const version = process.versions.node
  const node = path.join(root, 'nvm', `v${version}`, 'node.exe')
  write('nvm/nvm.exe', '')
  write(`nvm/v${version}/node.exe`, '')
  fs.unlinkSync(node)
  fs.copyFileSync(process.execPath, node)
  write(`nvm/v${version}/node_modules/npm/package.json`, { name: 'npm', version: '10.9.0', bin: { npm: 'bin/npm-cli.js' } })
  write(`nvm/v${version}/node_modules/npm/bin/npm-cli.js`, 'console.log("10.9.0")')
  write(`nvm/v${version}/node_modules/npm/bin/npx-cli.js`, 'console.log("10.9.0")')
  write('dsh/package.json', { name: '@deepseek-ai/dsh-root', engines: { node: `^${version}` }, packageManager: 'npm@10.9.0' })
  write('dsh/apps/cli/src/bin.ts', '')
  write('dsh/node_modules/tsx/dist/esm/index.mjs', '')
  write('dsh/tsconfig.json', '{}')
  const env = { ...process.env, NVM_HOME: path.join(root, 'nvm'), NVM_DIR: '', APPDATA: root, LOCALAPPDATA: root, PATH: '' }
  const request = { requestId: 'test', sourceDirectory: path.join(root, 'dsh'), dshCommand: path.join(root, 'dsh.ps1'),
    sandboxHome: path.join(root, 'sandbox'), runtimePath: path.join(root, 'run/runtime.json'), workingDirectory: root }
  return { root, write, version, node, env, request }
}

test('no NVM preserves the original launcher, including custom commands', t => {
  const f = fixture(t)
  const env = { ...f.env, NVM_HOME: '', APPDATA: '', LOCALAPPDATA: '' }
  assert.equal(discoverNvm(env), null)
  const plan = inspectToolchain({ ...f.request, sourceDirectory: 'missing' }, env)
  assert.equal(plan.summary.mode, 'system')
  assert.deepEqual(plan.environment, {})
  assert.deepEqual(plan.args, [])
})

test('installed NVM without Node is an error, never a system fallback', t => {
  const f = fixture(t)
  fs.unlinkSync(f.node)
  const plan = inspectToolchain(f.request, f.env)
  assert.equal(plan.summary.mode, 'sandbox')
  assert.equal(plan.summary.phase, 'error')
  assert.match(plan.summary.message, /nvm install/)
})

test('matches real Node, reports versions, isolates process environment and leaves source untouched', t => {
  const f = fixture(t)
  const before = fs.readFileSync(path.join(f.root, 'dsh/package.json'), 'utf8')
  const parentPath = process.env.PATH
  const plan = inspectToolchain(f.request, f.env)
  assert.equal(plan.summary.phase, 'ready', plan.summary.message)
  assert.equal(plan.summary.nodeVersion, f.version)
  assert.equal(plan.summary.managerVersion, '10.9.0')
  assert.equal(plan.summary.nodePath, f.node)
  assert.ok(plan.environment.NPM_CONFIG_PREFIX.startsWith(f.request.sandboxHome + path.sep))
  assert.ok(plan.environment.COREPACK_HOME.startsWith(f.request.sandboxHome + path.sep))
  assert.equal(process.env.PATH, parentPath)
  assert.equal(fs.readFileSync(path.join(f.root, 'dsh/package.json'), 'utf8'), before)
})

test('node declarations have precedence while engines remains a constraint', t => {
  const f = fixture(t)
  f.write('dsh/.node-version', '99.0.0')
  f.write('dsh/.nvmrc', `${f.version}\n`)
  assert.equal(inspectToolchain(f.request, f.env).summary.nodeSource, '.nvmrc')
  f.write('dsh/package.json', { name: '@deepseek-ai/dsh-root', engines: { node: '>=99' } })
  assert.equal(inspectToolchain(f.request, f.env).summary.phase, 'error')
})

test('detects declared npm, pnpm, yarn and rejects invalid metadata', t => {
  const f = fixture(t)
  for (const manager of ['npm', 'pnpm', 'yarn']) {
    f.write('dsh/package.json', { name: '@deepseek-ai/dsh-root', packageManager: `${manager}@9.2.1+sha512.aabb` })
    const required = requirements(resolveProject(f.request))
    assert.equal(required.manager, manager)
    assert.equal(required.managerRange, '9.2.1')
  }
  f.write('dsh/package.json', { name: '@deepseek-ai/dsh-root', packageManager: 'pnpm@latest & calc.exe' })
  assert.equal(inspectToolchain(f.request, f.env).summary.phase, 'error')
})

test('lockfiles identify manager without inventing an exact version; ambiguous locks fail', t => {
  const f = fixture(t)
  f.write('dsh/package.json', { name: '@deepseek-ai/dsh-root' })
  f.write('dsh/pnpm-lock.yaml', 'lockfileVersion: 9')
  const required = requirements(resolveProject(f.request))
  assert.equal(required.manager, 'pnpm')
  assert.equal(required.managerRange, '*')
  f.write('dsh/yarn.lock', '')
  assert.equal(inspectToolchain(f.request, f.env).summary.phase, 'error')
})

test('exact manager mismatch is prepared at startup, never silently replaced by bundled npm', t => {
  const f = fixture(t)
  f.write('dsh/package.json', { name: '@deepseek-ai/dsh-root', packageManager: 'npm@10.8.0' })
  const plan = inspectToolchain(f.request, f.env)
  assert.equal(plan.summary.phase, 'needs-manager')
  assert.equal(plan.summary.managerVersion, '')
  assert.equal(plan.summary.managerRequirement, '10.8.0')
})

test('Yarn lock metadata distinguishes Classic from Berry without guessing exact releases', t => {
  const f = fixture(t)
  f.write('dsh/package.json', { name: '@deepseek-ai/dsh-root' })
  f.write('dsh/yarn.lock', '# yarn lockfile v1\n')
  assert.equal(requirements(resolveProject(f.request)).managerRange, '1.x')
  f.write('dsh/yarn.lock', '__metadata:\n  version: 8\n')
  assert.equal(requirements(resolveProject(f.request)).managerRange, '>=2')
  f.write('dsh/yarn.lock', '')
  assert.throws(() => requirements(resolveProject(f.request)), /Classic/)
})

test('prepare bundle publishes facts and reusable shims with safe paths', t => {
  const f = fixture(t)
  const requestPath = f.write('request.json', f.request)
  const bundle = path.resolve('packages/windows-launcher/lib/DSH-Launcher.Toolchain.cjs')
  const result = spawnSync(f.node, [bundle, 'prepare', requestPath], { encoding: 'utf8', env: f.env, windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.summary.phase, 'ready')
  const snapshot = JSON.parse(fs.readFileSync(f.request.runtimePath, 'utf8'))
  assert.equal(snapshot.requestId, 'test')
  assert.equal(snapshot.managerVersion, '10.9.0')
  assert.equal(snapshot.environment, undefined)
  const npmShim = path.join(plan.environment.PATH.split(path.delimiter)[0], 'npm.ps1')
  assert.ok(fs.existsSync(npmShim))
  assert.match(fs.readFileSync(npmShim, 'utf8'), /\$env:NVM_SANDBOX_NPM_CLI/)
})

test('installed DSH resolves through its public bin; custom shims are not guessed', t => {
  const f = fixture(t)
  const shim = f.write('global/dsh.ps1', '& node "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" @args')
  f.write('global/node_modules/@deepseek-ai/dsh/package.json', { name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' }, engines: { node: '>=22' } })
  const entry = f.write('global/node_modules/@deepseek-ai/dsh/lib/bin.js', '')
  assert.equal(resolveProject({ dshCommand: shim }).args[0], entry)
  f.write('global/dsh.ps1', '& some-custom-launcher @args')
  assert.throws(() => resolveProject({ dshCommand: shim }), /package.json/)
})

test('source builds share Overview selection before dependencies exist', t => {
  const f = fixture(t)
  const overview = inspectToolchain(f.request, f.env)
  fs.unlinkSync(path.join(f.root, 'dsh/node_modules/tsx/dist/esm/index.mjs'))
  fs.unlinkSync(path.join(f.root, 'dsh/apps/cli/src/bin.ts'))
  const build = inspectToolchain({ ...f.request, mode: 'build' }, f.env)
  assert.equal(build.summary.phase, 'ready', build.summary.message)
  assert.equal(build.summary.nodePath, overview.summary.nodePath)
  assert.equal(build.summary.managerVersion, overview.summary.managerVersion)
  assert.equal(build.home, overview.home)
  assert.deepEqual(build.args, [])
  assert.equal(inspectToolchain(f.request, f.env).summary.phase, 'error')
})

test('manual Node selection uses the exact installed version even when a higher candidate exists', t => {
  const f = fixture(t)
  f.write('dsh/package.json', { name: '@deepseek-ai/dsh-root', engines: { node: '*' }, packageManager: 'npm@10.9.0' })
  f.write('nvm/v99.0.0/node.exe', '')
  const plan = inspectToolchain({ ...f.request, nodeVersion: f.version }, f.env)
  assert.equal(plan.summary.phase, 'ready', plan.summary.message)
  assert.equal(plan.summary.nodePath, f.node)
  assert.equal(plan.summary.requestedNodeVersion, f.version)
  assert.deepEqual(plan.summary.installedNodeVersions, ['99.0.0', f.version])
  assert.match(plan.summary.nodeSource, /手动选择/)
})

test('manual missing, incompatible or invalid versions fail without an automatic/system fallback', t => {
  const f = fixture(t)
  const missing = inspectToolchain({ ...f.request, nodeVersion: '99.0.0' }, f.env)
  assert.equal(missing.summary.phase, 'error')
  assert.match(missing.summary.message, /手动选择.*未安装/)
  assert.deepEqual(missing.environment, {})
  const invalid = inspectToolchain({ ...f.request, nodeVersion: '>=22' }, f.env)
  assert.equal(invalid.summary.phase, 'error')
  assert.match(invalid.summary.message, /完整的版本号/)
  f.write('dsh/.nvmrc', '99')
  const incompatible = inspectToolchain({ ...f.request, nodeVersion: f.version }, f.env)
  assert.equal(incompatible.summary.phase, 'error')
  assert.match(incompatible.summary.message, /手动选择.*不满足 DSH/)
  const noNvm = { ...f.env, NVM_HOME: '', APPDATA: '', LOCALAPPDATA: '' }
  assert.match(inspectToolchain({ ...f.request, nodeVersion: f.version }, noNvm).summary.message, /未检测到 NVM/)
  assert.equal(inspectToolchain(f.request, noNvm).summary.mode, 'system')
})

test('plugin builds validate their requirements against the Overview Node without selecting another version', t => {
  const f = fixture(t)
  const request = { ...f.request, mode: 'build', pluginSourceDirectory: path.join(f.root, 'plugins') }
  const manifest = { name: 'dsh-enhanced-plugins', engines: { node: `^${f.version}` } }
  f.write('plugins/package.json', manifest)
  f.write('plugins/package-lock.json', '{}')
  const overview = inspectToolchain(f.request, f.env)
  const plugin = inspectToolchain(request, f.env)
  assert.equal(plugin.summary.phase, 'ready', plugin.summary.message)
  assert.equal(plugin.summary.nodePath, overview.summary.nodePath)
  assert.equal(plugin.home, overview.home)
  f.write('plugins/.nvmrc', '99')
  const incompatible = inspectToolchain(request, f.env)
  assert.equal(incompatible.summary.phase, 'error')
  assert.match(incompatible.summary.message, /不满足插件源码/)
  fs.unlinkSync(path.join(f.root, 'plugins/.nvmrc'))
  f.write('plugins/package.json', { ...manifest, packageManager: 'npm@99.0.0' })
  assert.match(inspectToolchain(request, f.env).summary.message, /npm.*不满足插件源码/)
})

function sourceFixture(t) {
  const f = fixture(t)
  f.write('dsh/package.json', { name: '@deepseek-ai/dsh-root', engines: { node: `^${f.version}` },
    packageManager: 'pnpm@11.7.0', scripts: { clean: 'fixture', build: 'fixture' } })
  f.write('dsh/pnpm-lock.yaml', 'lockfileVersion: 9')
  const cli = version => `
    const fs = require('node:fs');
    if (process.argv[2] === '--version') console.log('${version}');
    else fs.appendFileSync(process.env.LAUNCHER_TEST_TRACE, JSON.stringify({
      node: process.execPath, args: process.argv.slice(2),
      prefix: process.env.NPM_CONFIG_PREFIX,
      verifyDeps: process.env.pnpm_config_verify_deps_before_run,
    }) + '\\n');
  `
  f.write(`nvm/v${f.version}/node_modules/pnpm/package.json`,
    { name: 'pnpm', version: '11.7.0', bin: { pnpm: 'bin/pnpm.cjs' } })
  f.write(`nvm/v${f.version}/node_modules/pnpm/bin/pnpm.cjs`, cli('11.7.0'))
  f.write(`nvm/v${f.version}/node_modules/npm/bin/npm-cli.js`, cli('10.9.0'))
  f.write('system-bin/pnpm.cmd', '@echo off\r\necho WRONG_SYSTEM_PNPM\r\nexit /b 99\r\n')
  f.write('system-bin/npm.cmd', '@echo off\r\necho WRONG_SYSTEM_NPM\r\nexit /b 99\r\n')
  const launcherHome = path.join(f.root, 'launcher')
  const trace = path.join(f.root, 'trace.jsonl')
  const environment = { ...f.env, PATH: [path.join(f.root, 'system-bin'),
    path.join(process.env.WINDIR, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter),
    DEEPSEEK_HARNESS_LAUNCHER_HOME: launcherHome, DSH_HOME: path.join(f.root, 'dsh-home'),
    LAUNCHER_TEST_TRACE: trace }
  return { ...f, launcherHome, trace, environment,
    records: () => fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)) }
}

test('compiled Launcher builds through the Overview Node and pnpm instead of system PATH', { skip: process.platform !== 'win32' }, t => {
  const f = sourceFixture(t)
  f.write('launcher/settings.json', { DshSourceDirectory: f.request.sourceDirectory, WorkingDirectory: f.root, NodeVersion: f.version })
  const resultFile = path.join(f.root, 'result.json')
  const executable = path.resolve('packages/windows-launcher/lib/DSH-Launcher.exe')
  const run = () => spawnSync(executable, ['--automation', 'build-only', resultFile],
    { env: f.environment, encoding: 'utf8', windowsHide: true, timeout: 45000 })
  const overview = inspectToolchain(f.request, f.env)
  fs.unlinkSync(path.join(f.root, 'dsh/node_modules/tsx/dist/esm/index.mjs'))
  const result = run()
  const outcome = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  assert.equal(result.status, 0, JSON.stringify(outcome) + result.stderr)
  assert.equal(outcome.success, true, outcome.message)
  const records = f.records()
  assert.deepEqual(records.map(record => record.args), [['run', 'clean'], ['install', '--frozen-lockfile'], ['run', 'build']])
  for (const record of records) {
    assert.equal(record.node, overview.summary.nodePath)
    assert.ok(record.prefix.startsWith(path.join(f.launcherHome, 'sandbox') + path.sep))
    assert.equal(record.verifyDeps, 'false')
  }
  const snapshot = JSON.parse(fs.readFileSync(path.join(f.launcherHome, 'run/build-toolchain.json'), 'utf8'))
  assert.equal(snapshot.nodePath, overview.summary.nodePath)
  assert.equal(snapshot.managerVersion, overview.summary.managerVersion)
  assert.equal(snapshot.requestedNodeVersion, f.version)
  f.write('launcher/settings.json', { DshSourceDirectory: f.request.sourceDirectory, WorkingDirectory: f.root, NodeVersion: '99.0.0' })
  const failed = run()
  assert.notEqual(failed.status, 0)
  assert.equal(f.records().length, 3, 'incompatible Node must fail before clean')
  assert.match(fs.readFileSync(path.join(f.launcherHome, 'logs/dsh-build.log'), 'utf8'), /nvm install/)
})

test('plugin coordinator preparation pins npm and installer pnpm to the Overview Node', { skip: process.platform !== 'win32' }, t => {
  const f = sourceFixture(t)
  f.write('plugins/package.json', { name: 'dsh-enhanced-plugins', engines: { node: `^${f.version}` } })
  const script = f.write('plugin-toolchain.ps1', `\uFEFF
    param([string]$ManagerScript, [string]$DshCheckout, [string]$PluginSource, [string]$LauncherRoot, [string]$RuntimeNode)
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [Console]::InputEncoding = $Utf8NoBom
    [Console]::OutputEncoding = $Utf8NoBom
    $OutputEncoding = $Utf8NoBom
    $tokens = $null; $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($ManagerScript, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }
    $definitions = @($ast.FindAll({ param($item)
      $item -is [System.Management.Automation.Language.FunctionDefinitionAst]
    }, $false) | ForEach-Object { $_.Extent.Text })
    $functionsPath = Join-Path $PSScriptRoot 'manager-functions.ps1'
    [System.IO.File]::WriteAllText($functionsPath, [char]0xFEFF + ($definitions -join [Environment]::NewLine), $Utf8NoBom)
    . $functionsPath
    [void](New-Item -ItemType Directory -Force -Path (Join-Path $LauncherRoot 'updates/current'))
    $request = [pscustomobject]@{ requestId = 'test'; runtimeNode = $RuntimeNode; nodeVersion = $env:LAUNCHER_TEST_NODE_VERSION }
    Initialize-PluginToolchain $request $PluginSource $DshCheckout $LauncherRoot (Join-Path $LauncherRoot 'build.log')
    $npm = Get-Command npm -CommandType Application | Select-Object -First 1
    Invoke-LoggedCommand $npm.Source @('ci') $PluginSource (Join-Path $LauncherRoot 'build.log') 'npm ci'
    Invoke-LoggedCommand $npm.Source @('run', 'build') $PluginSource (Join-Path $LauncherRoot 'build.log') 'npm run build'
    $pnpm = Get-Command pnpm -CommandType Application | Select-Object -First 1
    & $pnpm.Source dsh --version
    exit $LASTEXITCODE
  `)
  fs.copyFileSync(path.resolve('packages/windows-launcher/lib/DSH-Launcher.Toolchain.cjs'), path.join(f.root, 'DSH-Launcher.Toolchain.cjs'))
  const powershell = path.join(process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const run = () => spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-ManagerScript', path.resolve('packages/windows-launcher/lib/DSH-Launcher.PluginManager.ps1'),
    '-DshCheckout', f.request.sourceDirectory, '-PluginSource', path.join(f.root, 'plugins'),
    '-LauncherRoot', f.launcherHome, '-RuntimeNode', process.execPath],
  { encoding: 'utf8', env: { ...f.environment, LAUNCHER_TEST_NODE_VERSION: f.version }, windowsHide: true, timeout: 45000 })
  const result = run()
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(f.records().map(record => record.args), [['ci'], ['run', 'build'], ['dsh', '--version']])
  const overview = inspectToolchain(f.request, f.env)
  const runtime = JSON.parse(fs.readFileSync(path.join(f.launcherHome, 'updates/current/toolchain.json'), 'utf8'))
  assert.equal(runtime.requestedNodeVersion, f.version)
  for (const record of f.records()) assert.equal(record.node, overview.summary.nodePath)
  f.write('plugins/.nvmrc', '99')
  assert.notEqual(run().status, 0)
  assert.equal(f.records().length, 3, 'incompatible plugin must fail before npm ci or installation')
})

test('Overview selector persists manual/automatic choices and renders missing versions and responsive layouts', { skip: process.platform !== 'win32' }, t => {
  const f = sourceFixture(t)
  f.write('launcher/settings.json', { DshSourceDirectory: f.request.sourceDirectory, WorkingDirectory: f.root })
  const source = path.resolve('packages/windows-launcher/src')
  const executable = path.join(f.root, 'NodeSelectionTest.exe')
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET/Framework/v4.0.30319/csc.exe')
  const compiled = spawnSync(compiler, ['/nologo', '/target:exe', '/codepage:65001', '/main:LauncherNodeSelectionTest',
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll',
    '/r:System.Web.Extensions.dll', `/out:${executable}`,
    ...fs.readdirSync(source).filter(file => file.endsWith('.cs')).map(file => path.join(source, file)),
    path.resolve('tests/packages/fixtures/LauncherNodeSelection.cs')], { encoding: 'utf8', windowsHide: true })
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
  fs.copyFileSync(path.resolve('packages/windows-launcher/lib/DSH-Launcher.Toolchain.cjs'), path.join(f.root, 'DSH-Launcher.Toolchain.cjs'))
  const artifacts = path.join(f.root, 'artifacts')
  fs.mkdirSync(artifacts)
  const tested = spawnSync(executable, [f.version, artifacts],
    { env: f.environment, encoding: 'utf8', windowsHide: true, timeout: 45000 })
  if (process.env.DSH_LAUNCHER_VERIFY_ARTIFACTS) {
    fs.cpSync(artifacts, process.env.DSH_LAUNCHER_VERIFY_ARTIFACTS, { recursive: true })
  }
  assert.equal(tested.status, 0, tested.stdout + tested.stderr)
  assert.match(tested.stdout, /NODE_SELECTION_UI_OK/)
})

test('pnpm storage settings remain user-owned and old Launcher overrides are cleared', t => {
  const f = fixture(t)
  const custom = { ...f.env, PNPM_HOME: path.join(f.root, 'custom-pnpm'),
    pnpm_config_store_dir: path.join(f.root, 'custom-store') }
  for (const mode of ['web', 'build']) {
    const plan = inspectToolchain({ ...f.request, mode }, custom)
    assert.equal(plan.summary.phase, 'ready', plan.summary.message)
    assert.equal(plan.environment.PNPM_HOME, undefined)
    assert.equal(plan.environment.NPM_CONFIG_STORE_DIR, undefined)
    assert.equal(plan.environment.pnpm_config_store_dir, undefined)
  }
  const legacy = { ...f.env, PNPM_HOME: path.join(f.request.sandboxHome, 'old/global'),
    NPM_CONFIG_STORE_DIR: path.join(f.request.sandboxHome, 'old/cache/pnpm') }
  const recovered = inspectToolchain(f.request, legacy)
  assert.equal(recovered.environment.PNPM_HOME, '')
  assert.equal(recovered.environment.NPM_CONFIG_STORE_DIR, '')
})

const realPnpmRoot = process.env.DSH_LAUNCHER_TEST_PNPM_ROOT || path.join(path.dirname(process.execPath), 'node_modules/pnpm')
test('real pnpm updates existing hoisted dependencies without changing their store', {
  skip: process.platform !== 'win32' || !fs.existsSync(path.join(realPnpmRoot, 'package.json')),
}, t => {
  const f = fixture(t)
  const manifest = JSON.parse(fs.readFileSync(path.join(realPnpmRoot, 'package.json'), 'utf8'))
  fs.symlinkSync(realPnpmRoot, path.join(path.dirname(f.node), 'node_modules/pnpm'), 'junction')
  f.write('dsh/package.json', { name: '@deepseek-ai/dsh-root', packageManager: `pnpm@${manifest.version}` })
  for (const name of ['existing-dependency', 'added-dependency']) {
    f.write(`${name}/package.json`, { name, version: '1.0.0', main: 'index.js' })
    f.write(`${name}/index.js`, `module.exports = '${name}'`)
  }
  const baseline = { ...f.env, PNPM_HOME: path.join(f.root, 'user-pnpm-home') }
  const pnpmCli = path.join(realPnpmRoot, manifest.bin.pnpm)
  const invoke = (args, cwd, env) => spawnSync(f.node, [pnpmCli, ...args],
    { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 45000 })
  const profile = path.join(f.root, 'profile')
  f.write('profile/package.json', { name: 'existing-profile', private: true })
  f.write('profile/pnpm-workspace.yaml', 'nodeLinker: hoisted\n')
  const add = name => ['add', `file:${path.join(f.root, name)}`, '--offline', '--ignore-scripts']
  const initial = invoke(add('existing-dependency'), profile, baseline)
  assert.equal(initial.status, 0, initial.stdout + initial.stderr)
  const modulesFile = path.join(profile, 'node_modules/.modules.yaml')
  const readStore = () => {
    const result = invoke(['store', 'path'], profile, baseline)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return result.stdout.trim()
  }
  const originalStore = readStore()
  const request = { ...f.request, mode: 'build', nodeVersion: f.version }
  const requestFile = f.write('store-request.json', request)
  const prepared = spawnSync(f.node, [path.resolve('packages/windows-launcher/lib/DSH-Launcher.Toolchain.cjs'), 'prepare', requestFile],
    { env: baseline, encoding: 'utf8', windowsHide: true, timeout: 45000 })
  assert.equal(prepared.status, 0, prepared.stderr)
  const plan = JSON.parse(prepared.stdout)
  // Reproduce the reported error using the old PNPM_HOME override on this disposable profile.
  const beforeFailure = fs.readFileSync(modulesFile, 'utf8')
  const broken = invoke(add('added-dependency'), profile, { ...baseline, ...plan.environment,
    PNPM_HOME: path.join(f.request.sandboxHome, 'old/global') })
  assert.notEqual(broken.status, 0)
  assert.match(broken.stdout + broken.stderr, /ERR_PNPM_UNEXPECTED_STORE/)
  assert.equal(fs.readFileSync(modulesFile, 'utf8'), beforeFailure)
  const fixed = invoke(add('added-dependency'), profile, { ...baseline, ...plan.environment })
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr)
  assert.equal(readStore(), originalStore)
  assert.ok(fs.readFileSync(modulesFile, 'utf8').includes(originalStore.replaceAll('\\', '\\\\'))
    || fs.readFileSync(modulesFile, 'utf8').includes(originalStore))
  for (const name of ['existing-dependency', 'added-dependency']) {
    assert.equal(fs.readFileSync(path.join(profile, 'node_modules', name, 'index.js'), 'utf8'), `module.exports = '${name}'`)
  }
})

test('candidate installer recovers legacy tray storage overrides without changing user configuration or Node', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t)
  const script = f.write('legacy-store.ps1', `\uFEFF
    param([string]$Installer)
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw ($errors | Out-String) }
    foreach ($definition in $ast.FindAll({ param($item)
      $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $item.Name -in @('Suspend-LegacyLauncherPnpmStorage', 'Get-WindowsLauncherInstallRoot')
    }, $false)) { Invoke-Expression $definition.Extent.Text }
    $beforePath = $env:PATH
    $beforeNode = $env:NVM_SANDBOX_NODE_EXE
    $userStore = $env:PNPM_CONFIG_STORE_DIR
    $saved = Suspend-LegacyLauncherPnpmStorage
    if ($saved.Count -ne 2 -or $env:PNPM_HOME -or $env:NPM_CONFIG_STORE_DIR) { throw 'Legacy storage overrides survived.' }
    if ($env:PNPM_CONFIG_STORE_DIR -ne $userStore) { throw 'User store changed.' }
    if ($env:PATH -ne $beforePath -or $env:NVM_SANDBOX_NODE_EXE -ne $beforeNode) { throw 'Node selection changed.' }
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    if (-not $env:PNPM_HOME -or -not $env:NPM_CONFIG_STORE_DIR) { throw 'Caller environment was not restored.' }
    Write-Output 'LEGACY_STORE_OK'
  `)
  const result = spawnSync(path.join(process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Installer', path.resolve('scripts/migrate-to-enhanced-plugin.ps1')], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
      env: { ...f.env, PATH: path.dirname(f.node), DEEPSEEK_HARNESS_LAUNCHER_HOME: f.root, NVM_SANDBOX_NODE_EXE: f.node,
        PNPM_HOME: path.join(f.request.sandboxHome, 'old/global'),
        NPM_CONFIG_STORE_DIR: path.join(f.request.sandboxHome, 'old/cache/pnpm'),
        PNPM_CONFIG_STORE_DIR: path.join(f.root, 'user-store') },
    })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /LEGACY_STORE_OK/)
})
