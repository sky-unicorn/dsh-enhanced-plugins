import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const installer = resolve(root, 'scripts/migrate-to-enhanced-plugin.ps1')
const release = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const bundled = JSON.parse(readFileSync(resolve(root, 'dsh-compatibility.json'), 'utf8'))
const supported = bundled.releases.find((entry: { pluginVersion: string }) => entry.pluginVersion === release.version)
const baseline = supported.dsh[0]
const packages = readdirSync(resolve(root, 'packages'))
  .filter(name => existsSync(resolve(root, 'packages', name, 'package.json')))
const temporary: string[] = []
const servers: ReturnType<typeof createServer>[] = []

function fixture(version = baseline.version) {
  const directory = mkdtempSync(resolve(tmpdir(), 'dsh-compatibility-'))
  temporary.push(directory)
  const plugin = resolve(directory, 'plugin')
  const dsh = resolve(directory, 'dsh')
  mkdirSync(plugin)
  mkdirSync(dsh)
  for (const file of ['package.json', 'package-lock.json', 'dsh-compatibility.json']) {
    copyFileSync(resolve(root, file), resolve(plugin, file))
  }
  for (const name of packages) {
    mkdirSync(resolve(plugin, 'packages', name), { recursive: true })
    copyFileSync(resolve(root, 'packages', name, 'package.json'), resolve(plugin, 'packages', name, 'package.json'))
  }
  writeFileSync(resolve(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version }))
  return { directory, plugin, dsh }
}

function check(source: ReturnType<typeof fixture>, args = ['-CheckCompatibility'], url = 'http://127.0.0.1:1/compatibility.json') {
  return new Promise<{ status: number | null, output: string }>((done, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', installer, '-PluginPath', source.plugin, '-DshCheckout', source.dsh, ...args,
    ], { cwd: root, windowsHide: true, env: { ...process.env, DSH_COMPATIBILITY_URL: url }, timeout: 25_000 })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    child.once('error', reject)
    child.once('close', status => done({ status, output }))
  })
}

async function remote(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing fixture server address')
  return `http://127.0.0.1:${address.port}/dsh-compatibility.json`
}

function table(version = '0.2.0-alpha.1', commit = 'a'.repeat(40)) {
  return { schemaVersion: 1, releases: [{ pluginVersion: release.version, dsh: [{ version, commits: [commit] }] }] }
}

function writeTable(source: ReturnType<typeof fixture>, value: unknown) {
  writeFileSync(resolve(source.plugin, 'dsh-compatibility.json'), JSON.stringify(value))
}

function synchronize(source: ReturnType<typeof fixture>, versions?: string) {
  return spawnSync(process.execPath, [resolve(root, 'scripts/sync-dsh-compatibility.mjs'), source.plugin,
    ...(versions === undefined ? [] : [versions])], { encoding: 'utf8' })
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
  for (const directory of temporary.splice(0)) {
    if (!directory.startsWith(resolve(tmpdir()) + sep) || !directory.includes(`${sep}dsh-compatibility-`)) {
      throw new Error('Refusing cleanup outside the compatibility fixture directory')
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('central compatibility authority', () => {
  it('keeps package and native versions aligned without duplicating compatibility in the manifest', () => {
    expect(release.dshEnhanced.compatibility).toBeUndefined()
    expect(release.files).toEqual(expect.arrayContaining([
      'dsh-compatibility.json', 'scripts/dsh-compatibility.ps1', 'scripts/sync-dsh-compatibility.mjs',
    ]))
    for (const manifest of [release, ...packages.map(name => JSON.parse(readFileSync(resolve(root, 'packages', name, 'package.json'), 'utf8')))]) {
      expect(manifest.version, manifest.name).toBe(release.version)
      expect(manifest.dsh?.client?.inject ?? []).not.toContain('@deepseek-ai/dsh-client-runtime')
    }
    expect(readFileSync(resolve(root, 'packages/windows-launcher/src/AssemblyInfo.cs'), 'utf8'))
      .toContain(`AssemblyFileVersion("${release.version}.0")`)
    const patch = readFileSync(resolve(root, 'packages/sub-agent/cordis.patch.yml'), 'utf8')
    const subagents = JSON.parse(readFileSync(resolve(root, 'packages/sub-agent/package.json'), 'utf8'))
    for (const provider of ['codex', 'claude-code']) {
      expect(patch).toContain(`name: 'dsh-enhanced-sub-agent/${provider}'`)
      expect(subagents.exports[`./${provider}`]).toBe(`./lib/sub-agent/${provider}.js`)
    }
  })

  it('generates every DSH peer and root lock metadata by changing only the mapping file', () => {
    const source = fixture()
    const newTable = table()
    newTable.releases[0].dsh.unshift(baseline)
    writeTable(source, newTable)
    const result = synchronize(source)
    expect(result.status, result.stderr).toBe(0)
    const range = `${baseline.version} || 0.2.0-alpha.1`
    for (const path of ['package.json', ...packages.map(name => `packages/${name}/package.json`)]) {
      const before = JSON.parse(readFileSync(resolve(root, path), 'utf8'))
      const after = JSON.parse(readFileSync(resolve(source.plugin, path), 'utf8'))
      for (const name of Object.keys(before.peerDependencies ?? {})) {
        if (name.startsWith('@deepseek-ai/dsh-')) before.peerDependencies[name] = range
      }
      expect(after).toEqual(before)
    }
    const lock = JSON.parse(readFileSync(resolve(source.plugin, 'package-lock.json'), 'utf8'))
    expect(lock.packages[''].peerDependencies).toEqual(JSON.parse(readFileSync(resolve(source.plugin, 'package.json'), 'utf8')).peerDependencies)
    // Installation can use a fresh remote selection even when bundled data is old.
    expect(synchronize(source, '0.3.0-alpha.1').status).toBe(0)
    expect(JSON.parse(readFileSync(resolve(source.plugin, 'package.json'), 'utf8')).peerDependencies['@deepseek-ai/dsh-agent']).toBe('0.3.0-alpha.1')
    expect(synchronize(source, '*').status).not.toBe(0)
  })

  it.runIf(process.platform === 'win32')('rejects the reserved Desktop profile before any installation', async () => {
    const source = fixture()
    const result = await check(source, ['-Profile', 'Desktop', '-Features', 'all'])
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('Desktop profile is managed by the official desktop application')
    expect(readdirSync(source.dsh)).toEqual(['package.json'])
  })

  it.runIf(process.platform === 'win32')('falls back offline, warns about ZIP source, and keeps preflight read-only', async () => {
    const source = fixture()
    const before = readFileSync(resolve(source.plugin, 'package.json'), 'utf8')
    const result = await check(source)
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain(`Compatibility OK: plugin ${release.version} -> DSH ${baseline.version}`)
    expect(result.output).toContain('Compatibility source: bundled')
    expect(result.output).toContain('source commit cannot be verified')
    expect(readFileSync(resolve(source.plugin, 'package.json'), 'utf8')).toBe(before)
    expect(readdirSync(source.dsh)).toEqual(['package.json'])
  })

  it.runIf(process.platform === 'win32')('prefers fresh remote support and fetches again on every check without changing bundled data', async () => {
    const source = fixture('0.2.0-alpha.1')
    const original = readFileSync(resolve(source.plugin, 'dsh-compatibility.json'), 'utf8')
    let requests = 0
    const url = await remote((_request, response) => {
      requests++
      response.end(JSON.stringify(requests === 1 ? table() : table('0.3.0-alpha.1')))
    })
    const accepted = await check(source, undefined, url)
    expect(accepted.status, accepted.output).toBe(0)
    expect(accepted.output).toContain('Compatibility source: remote')
    const refused = await check(source, undefined, url)
    expect(refused.status).not.toBe(0)
    expect(refused.output).toContain('Incompatible DSH')
    expect(requests).toBe(2)
    expect(readFileSync(resolve(source.plugin, 'dsh-compatibility.json'), 'utf8')).toBe(original)
  })

  it.runIf(process.platform === 'win32').each(['missing', 'empty', 'other-plugin'])('does not restore bundled support after a valid remote %s release', async (kind) => {
    const source = fixture()
    const value = table()
    if (kind === 'missing') value.releases = []
    if (kind === 'empty') value.releases[0].dsh = []
    if (kind === 'other-plugin') value.releases[0].pluginVersion = '99.0.0'
    const url = await remote((_request, response) => response.end(JSON.stringify(value)))
    const result = await check(source, undefined, url)
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('No supported DSH versions')
    expect(result.output).not.toContain('Compatibility source: bundled')
  })

  it.runIf(process.platform === 'win32').each([404, 500, 'invalid-json', 'invalid-schema', 'oversize'])('falls back for remote failure %s', async (kind) => {
    const source = fixture()
    const url = await remote((_request, response) => {
      if (typeof kind === 'number') { response.writeHead(kind); response.end(); return }
      response.end(kind === 'invalid-json' ? '<html>error</html>' : kind === 'oversize' ? 'x'.repeat(1024 * 1024 + 1) : '{"schemaVersion":2,"releases":[]}')
    })
    const result = await check(source, undefined, url)
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('Compatibility source: bundled')
  })

  it.runIf(process.platform === 'win32').each(['headers', 'body'])('bounds a hanging %s download before falling back', async (phase) => {
    const source = fixture()
    const url = await remote((_request, response) => {
      if (phase === 'body') { response.writeHead(200); response.write('{') }
    })
    const started = Date.now()
    const result = await check(source, undefined, url)
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('Compatibility source: bundled')
    expect(Date.now() - started).toBeLessThan(15_000)
  }, 20_000)

  it.runIf(process.platform === 'win32').each(['0.1.5-rc.2', '0.1.5', '99.0.0'])('rejects unsupported DSH %s before build or installation', async (version) => {
    const source = fixture(version)
    const result = await check(source, ['-Features', 'notification', '-SkipBuild'])
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('Incompatible DSH')
    expect(result.output).toContain('Nothing was installed or removed')
    expect(existsSync(resolve(source.plugin, 'lib'))).toBe(false)
  })

  it.runIf(process.platform === 'win32').each([
    null, { schemaVersion: '1', releases: [] }, { schemaVersion: 2, releases: [] },
    { schemaVersion: 1, releases: [table().releases[0], table().releases[0]] },
    table('>=0.2.0'), table('01.2.0'), table('0.2.0-01'), table('0.2.0', 'invalid'),
    { schemaVersion: 1, releases: [{ pluginVersion: release.version, dsh: [{ version: '0.2.0', commits: [] }] }] },
  ].map(value => [value]))('rejects invalid bundled schema %j when offline', async (value) => {
    const source = fixture()
    writeTable(source, value)
    expect(synchronize(source).status).not.toBe(0)
    const result = await check(source)
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('Invalid compatibility')
    expect(readdirSync(source.dsh)).toEqual(['package.json'])
  })

  it.runIf(process.platform === 'win32')('rejects missing fallback, mixed packages and unrelated DSH identity', async () => {
    const source = fixture()
    rmSync(resolve(source.plugin, 'dsh-compatibility.json'))
    expect((await check(source)).output).toContain('Bundled dsh-compatibility.json is missing')
    writeTable(source, bundled)
    const path = resolve(source.plugin, 'packages/notification/package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...manifest, version: '0.1.0' }))
    expect((await check(source)).output).toContain('Mixed plugin release')
    writeFileSync(path, JSON.stringify(manifest))
    writeFileSync(resolve(source.dsh, 'package.json'), JSON.stringify({ name: 'unrelated', version: baseline.version }))
    expect((await check(source)).output).toContain('Cannot identify the DSH source version')
  }, 15_000)

  it.runIf(process.platform === 'win32')('only verifies commits paired with the actual DSH version, and warns for local edits', async () => {
    const source = fixture()
    for (const args of [['init'], ['add', 'package.json'],
      ['-c', 'user.name=Compatibility fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']]) {
      expect(spawnSync('git', args, { cwd: source.dsh, encoding: 'utf8' }).status).toBe(0)
    }
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source.dsh, encoding: 'utf8' }).stdout.trim()
    const value = table(baseline.version, head)
    writeTable(source, value)
    expect((await check(source)).output).not.toContain('this source revision is unverified')
    value.releases[0].dsh = [baseline, { version: '0.2.0-alpha.1', commits: [head] }]
    writeTable(source, value)
    expect((await check(source)).output).toContain('this source revision is unverified')
    writeFileSync(resolve(source.dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version: baseline.version, modified: true }))
    expect((await check(source)).output).toContain('local tracked changes')
  }, 15_000)
})
