import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const installer = resolve(root, 'scripts/migrate-to-enhanced-plugin.ps1')
const release = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const packages = readdirSync(resolve(root, 'packages'))
  .filter(name => existsSync(resolve(root, 'packages', name, 'package.json')))
const temporary: string[] = []

function fixture(version = release.dshEnhanced.compatibility.dshVersion) {
  const directory = mkdtempSync(resolve(tmpdir(), 'dsh-compatibility-'))
  temporary.push(directory)
  const plugin = resolve(directory, 'plugin')
  const dsh = resolve(directory, 'dsh')
  mkdirSync(plugin)
  mkdirSync(dsh)
  copyFileSync(resolve(root, 'package.json'), resolve(plugin, 'package.json'))
  for (const name of packages) {
    mkdirSync(resolve(plugin, 'packages', name), { recursive: true })
    copyFileSync(resolve(root, 'packages', name, 'package.json'), resolve(plugin, 'packages', name, 'package.json'))
  }
  writeFileSync(resolve(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version }))
  return { directory, plugin, dsh }
}

function check(source: ReturnType<typeof fixture>, args = ['-CheckCompatibility']) {
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', installer, '-PluginPath', source.plugin, '-DshCheckout', source.dsh, ...args,
  ], { cwd: root, encoding: 'utf8', timeout: 30_000 })
  return { ...result, output: `${result.stdout}\n${result.stderr}` }
}

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    if (!directory.startsWith(resolve(tmpdir()) + sep) || !directory.includes(`${sep}dsh-compatibility-`)) {
      throw new Error('Refusing cleanup outside the compatibility fixture directory')
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('0.3.0 release compatibility', () => {
  it('keeps the aggregate, standalone packages, native version and DSH peers aligned', () => {
    expect(release.version).toBe('0.3.0')
    expect(release.dshEnhanced.compatibility).toEqual({
      dshVersion: '0.1.2-alpha.2', sourceCommit: '0a53fb55bea101816fa226bb964ae2bed71c343b',
    })
    for (const manifest of [release, ...packages.map(name => JSON.parse(readFileSync(resolve(root, 'packages', name, 'package.json'), 'utf8')))]) {
      expect(manifest.version, manifest.name).toBe(release.version)
      expect(manifest.dsh?.client?.inject ?? []).not.toContain('@deepseek-ai/dsh-client-runtime')
      for (const [name, version] of Object.entries(manifest.peerDependencies ?? {})) {
        if (name.startsWith('@deepseek-ai/dsh-')) expect(version, `${manifest.name}: ${name}`).toBe(release.dshEnhanced.compatibility.dshVersion)
      }
    }
    expect(readFileSync(resolve(root, 'packages/windows-launcher/src/AssemblyInfo.cs'), 'utf8'))
      .toContain(`AssemblyFileVersion("${release.version}.0")`)
    // Bare official providers cannot be resolved by DSH's package inventory
    // from an external profile; Loader provenance must stay with this bundle.
    const patch = readFileSync(resolve(root, 'packages/sub-agent/cordis.patch.yml'), 'utf8')
    const subagents = JSON.parse(readFileSync(resolve(root, 'packages/sub-agent/package.json'), 'utf8'))
    for (const provider of ['codex', 'claude-code']) {
      expect(patch).toContain(`name: 'dsh-enhanced-sub-agent/${provider}'`)
      expect(subagents.exports[`./${provider}`]).toBe(`./lib/sub-agent/${provider}.js`)
    }
  })

  it.runIf(process.platform === 'win32')('accepts a matching source ZIP, warns about unverifiable Git, and writes nothing', () => {
    const source = fixture()
    const result = check(source)
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('Compatibility OK: plugin 0.3.0 -> DSH 0.1.2-alpha.2')
    expect(result.output).toContain('source commit cannot be verified')
    expect(readdirSync(source.plugin).sort()).toEqual(['package.json', 'packages'])
    expect(readdirSync(source.dsh)).toEqual(['package.json'])
  })

  it.runIf(process.platform === 'win32').each(['0.1.1-rc.2', '0.1.2-alpha.1', '0.1.2'])('rejects DSH %s before build or installation', (version) => {
    const source = fixture(version)
    const result = check(source, ['-Features', 'notification', '-SkipBuild'])
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('Incompatible DSH')
    expect(result.output).toContain(version)
    expect(result.output).toContain('Nothing was installed or removed')
    expect(existsSync(resolve(source.plugin, 'lib'))).toBe(false)
    expect(readdirSync(source.dsh)).toEqual(['package.json'])
  })

  it.runIf(process.platform === 'win32')('rejects a mixed plugin release before touching DSH', () => {
    const source = fixture()
    const path = resolve(source.plugin, 'packages/notification/package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...manifest, version: '0.1.0' }))
    const result = check(source)
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('Mixed plugin release')
  })

  it.runIf(process.platform === 'win32')('rejects missing compatibility metadata and an unrelated checkout identity', () => {
    const source = fixture()
    const path = resolve(source.plugin, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    delete manifest.dshEnhanced.compatibility
    writeFileSync(path, JSON.stringify(manifest))
    expect(check(source).output).toContain('has no dshEnhanced.compatibility')
    copyFileSync(resolve(root, 'package.json'), path)
    writeFileSync(resolve(source.dsh, 'package.json'), JSON.stringify({ name: 'unrelated', version: '0.1.2-alpha.2' }))
    expect(check(source).output).toContain('Cannot identify the DSH source version')
  })

  it.runIf(process.platform === 'win32')('warns for a different Git commit without claiming it was verified', () => {
    const source = fixture()
    for (const args of [
      ['init'], ['add', 'package.json'],
      ['-c', 'user.name=Compatibility fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'],
    ]) {
      const result = spawnSync('git', args, { cwd: source.dsh, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
    }
    const result = check(source)
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('differs from verified')
    expect(result.output).toContain('this source revision is unverified')
  })
})
