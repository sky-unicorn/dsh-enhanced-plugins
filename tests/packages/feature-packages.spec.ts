import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const packagesRoot = resolve(root, 'packages')

interface FeatureManifest {
  name: string
  main: string
  exports: Record<string, string>
  dsh: { bundle: { patch: string }, client: { platform: string, inject: string[] } }
  dshEnhanced: { feature: string, legacyPackages: string[] }
  files: string[]
  scripts: { build: string, prepare: string }
}

const expectedRows: Record<string, string[]> = {
  'edit-last-message': ['edit-last-message-host'],
  'mcp-server-manager': ['mcp-manager'],
  'model-input-types': ['model-input-types'],
  notification: ['desktop-notifications'],
  'plugin-market': ['plugin-market'],
  'sub-agent': [
    'subagent-codex', 'subagent-claude-code', 'subagent-product-toggles', 'subagent-product-toggle-tools',
  ],
}

function featurePackages(): { directory: string, manifest: FeatureManifest, patch: string }[] {
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(resolve(packagesRoot, entry.name, 'package.json')))
    .map((entry) => {
      const directory = resolve(packagesRoot, entry.name)
      const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as FeatureManifest
      return { directory, manifest, patch: readFileSync(resolve(directory, manifest.dsh.bundle.patch), 'utf8') }
    })
    .sort((left, right) => left.manifest.dshEnhanced.feature.localeCompare(right.manifest.dshEnhanced.feature))
}

describe('selective feature packages', () => {
  it('declares one independently installable bundle per feature', () => {
    const packages = featurePackages()
    expect(packages.map(item => item.manifest.dshEnhanced.feature)).toEqual(Object.keys(expectedRows).sort())
    expect(new Set(packages.map(item => item.manifest.name)).size).toBe(packages.length)

    for (const { manifest, patch } of packages) {
      expect(manifest.name).toBe(`dsh-enhanced-${manifest.dshEnhanced.feature}`)
      expect(manifest.dsh.client.platform).toBe('web')
      expect(manifest.dsh.client.inject.length).toBeGreaterThan(0)
      expect(manifest.exports['.']).toBe(manifest.main)
      expect(manifest.exports['./client']).toBe('./lib/client.js')
      expect(manifest.files).toContain('lib/')
      expect(manifest.files).toContain('cordis.patch.yml')
      expect(manifest.scripts.prepare).toBe('npm run build')
      expect(manifest.scripts.build).toContain(`--feature ${manifest.dshEnhanced.feature}`)
      expect(patch).toContain(`name: '${manifest.name}`)
      const ids = [...patch.matchAll(/^\s+- id: (.+)$/gm)].map(match => match[1])
      expect(ids).toEqual(expectedRows[manifest.dshEnhanced.feature])
    }
  })

  it.runIf(process.platform === 'win32')('lists features and accepts a comma-separated selection', () => {
    const script = resolve(root, 'scripts/migrate-to-enhanced-plugin.ps1')
    const listed = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ListFeatures',
    ], { cwd: root, encoding: 'utf8' })
    expect(listed.status, listed.stderr).toBe(0)
    for (const feature of Object.keys(expectedRows)) expect(listed.stdout).toContain(`${feature}\t`)
    expect(listed.stdout).not.toContain('referenced-file\t')

    const selected = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Features', 'notification,mcp-server-manager', '-WhatIf',
    ], { cwd: root, encoding: 'utf8' })
    expect(selected.status, selected.stderr).toBe(0)
    expect(selected.stdout).toContain("feature set 'mcp-server-manager,notification'")

    const retired = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Features', 'referenced-file', '-WhatIf',
    ], { cwd: root, encoding: 'utf8' })
    expect(retired.status).not.toBe(0)
    expect(`${retired.stdout}\n${retired.stderr}`).toContain("Feature 'referenced-file' is retired and cannot be installed")
    expect(`${retired.stdout}\n${retired.stderr}`).toContain('Official DSH now supports @ workspace file references')
  }, 10_000)

  it('keeps retired package names as migration metadata without publishing the feature', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dshEnhanced: { retiredFeatures: Array<{ feature: string; packageNames: string[]; notice: string }> }
    }
    expect(manifest.dshEnhanced.retiredFeatures).toContainEqual({
      feature: 'referenced-file',
      packageNames: ['dsh-enhanced-referenced-file', 'dsh-referenced-file'],
      notice: 'Official DSH now supports @ workspace file references; update DSH to the latest release.',
    })
    expect(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')).not.toContain('referenced-file')
  })
})
