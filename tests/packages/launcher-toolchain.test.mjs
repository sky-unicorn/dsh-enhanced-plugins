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
