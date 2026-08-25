import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const packagesRoot = resolve(root, 'packages')

interface FeatureManifest {
  name: string
  version: string
  main?: string
  exports?: Record<string, string>
  dsh?: { bundle: { patch: string }, client: { platform: string, inject: string[] } }
  dshEnhanced: {
    feature: string
    kind?: 'bundle' | 'companion'
    platforms?: string[]
    runtimeEntries?: string[]
    legacyPackages: string[]
  }
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
const expectedCompanions = ['windows-launcher']
const expectedFeatures = [...Object.keys(expectedRows), ...expectedCompanions].sort()

function featurePackages(): { directory: string, manifest: FeatureManifest, patch?: string }[] {
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(resolve(packagesRoot, entry.name, 'package.json')))
    .map((entry) => {
      const directory = resolve(packagesRoot, entry.name)
      const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as FeatureManifest
      const patch = manifest.dsh === undefined
        ? undefined
        : readFileSync(resolve(directory, manifest.dsh.bundle.patch), 'utf8')
      return { directory, manifest, patch }
    })
    .sort((left, right) => left.manifest.dshEnhanced.feature.localeCompare(right.manifest.dshEnhanced.feature))
}

describe('selective feature packages', () => {
  it('declares one independently installable package per feature', () => {
    const packages = featurePackages()
    expect(packages.map(item => item.manifest.dshEnhanced.feature)).toEqual(expectedFeatures)
    expect(new Set(packages.map(item => item.manifest.name)).size).toBe(packages.length)

    for (const { manifest, patch } of packages.filter(item => item.manifest.dshEnhanced.kind !== 'companion')) {
      expect(manifest.name).toBe(`dsh-enhanced-${manifest.dshEnhanced.feature}`)
      expect(manifest.dsh?.client.platform).toBe('web')
      expect(manifest.dsh?.client.inject.length).toBeGreaterThan(0)
      expect(manifest.exports?.['.']).toBe(manifest.main)
      expect(manifest.exports?.['./client']).toBe('./lib/client.js')
      expect(manifest.files).toContain('lib/')
      expect(manifest.files).toContain('cordis.patch.yml')
      expect(manifest.scripts.prepare).toBe('npm run build')
      expect(manifest.scripts.build).toContain(`--feature ${manifest.dshEnhanced.feature}`)
      expect(patch).toContain(`name: '${manifest.name}`)
      const ids = [...(patch ?? '').matchAll(/^\s+- id: (.+)$/gm)].map(match => match[1])
      expect(ids).toEqual(expectedRows[manifest.dshEnhanced.feature])
    }

    const launcher = packages.find(item => item.manifest.dshEnhanced.feature === 'windows-launcher')?.manifest
    expect(launcher).toBeDefined()
    expect(launcher?.name).toBe('dsh-enhanced-windows-launcher')
    expect(launcher?.dsh).toBeUndefined()
    expect(launcher?.dshEnhanced.kind).toBe('companion')
    expect(launcher?.dshEnhanced.platforms).toEqual(['win32'])
    expect(launcher?.dshEnhanced.runtimeEntries).toEqual([
      './lib/DSH-Launcher.exe',
      './lib/DSH-Launcher.exe.config',
      './lib/DSH-Launcher.Supervisor.ps1',
      './lib/DSH-Launcher.Command.ps1',
    ])
    expect(launcher?.scripts.build).toBe('node ./build.mjs')
  })

  it.runIf(process.platform === 'win32')('lists features and accepts a comma-separated selection', () => {
    const script = resolve(root, 'scripts/migrate-to-enhanced-plugin.ps1')
    const listed = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ListFeatures',
    ], { cwd: root, encoding: 'utf8' })
    expect(listed.status, listed.stderr).toBe(0)
    for (const feature of expectedFeatures) expect(listed.stdout).toContain(`${feature}\t`)
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

  it('keeps the Windows companion outside Cordis and avoids port-owner termination', () => {
    const launcherRoot = resolve(packagesRoot, 'windows-launcher')
    const runtime = readFileSync(resolve(launcherRoot, 'src', 'Runtime.cs'), 'utf8')
    const program = readFileSync(resolve(launcherRoot, 'src', 'Program.cs'), 'utf8')
    const theme = readFileSync(resolve(launcherRoot, 'src', 'Theme.cs'), 'utf8')
    const whale = readFileSync(resolve(launcherRoot, 'src', 'WhaleGlyph.cs'), 'utf8')
    const build = readFileSync(resolve(launcherRoot, 'build.mjs'), 'utf8')
    const appConfig = readFileSync(resolve(launcherRoot, 'src', 'DSH-Launcher.exe.config'), 'utf8')
    const appManifest = readFileSync(resolve(launcherRoot, 'src', 'app.manifest'), 'utf8')
    const command = readFileSync(resolve(launcherRoot, 'src', 'DSH-Launcher.Command.ps1'), 'utf8')
    const supervisor = readFileSync(resolve(launcherRoot, 'src', 'DSH-Launcher.Supervisor.ps1'), 'utf8')
    const installer = readFileSync(resolve(root, 'scripts', 'migrate-to-enhanced-plugin.ps1'), 'utf8')

    expect(runtime).not.toContain('cmd.exe')
    expect(runtime).not.toContain('Get-NetTCPConnection')
    expect(runtime).not.toContain('OwningProcess')
    expect(theme).toContain('internal sealed class ToggleSwitch : Control')
    expect(theme).toContain('internal sealed class ModernButton : Control')
    expect(theme).toContain('internal sealed class NavButton : Control')
    expect(theme).not.toContain('Appearance = Appearance.Button')
    expect(theme).not.toContain('Region = new Region')
    expect(program).toContain('LayoutResponsivePages')
    expect(program).toContain('QueueResponsiveLayout')
    expect(program).toContain('private Panel activePage;')
    expect(program).toContain('if (activePage == overviewPage) LayoutOverview();')
    expect(program).not.toContain('if (overviewPage.Visible) LayoutOverview();')
    expect(program).toContain('The overview page did not complete its first-show layout.')
    expect(program).toContain('width >= Dip(1020)')
    expect(program).toContain('ClientSize.Width < Dip(760)')
    expect(program).toContain('ApplyDisplayConstraints')
    expect(program).toContain('DeviceDpi / 96f')
    expect(program).toContain('SetProcessDpiAwarenessContext')
    expect(program).toContain('Interlocked.CompareExchange(ref refreshInFlight')
    expect(program).toContain('delayedDshTimer.Interval = 30000')
    expect(program).toContain('if (form.Handle == IntPtr.Zero)')
    expect(program).toContain('LoginStartupMode.LauncherOnly')
    expect(program).toContain('LoginStartupMode.LauncherAndDsh')
    expect(program).toContain('构建 DSH 源码')
    expect(program).toContain('runtime.BuildDshSource(out output)')
    expect(program).toContain('后台无窗口运行，输出以 UTF-8 保存在日志目录')
    expect(program).not.toContain('交互式 Profile 会在独立终端中运行')
    expect(program).not.toContain('TextRenderer.DrawText(graphics, "DS"')
    expect(whale).toContain('official DeepSeek whale silhouette')
    expect(build).toContain('/win32icon:')
    expect(build).toContain('/win32manifest:')
    expect(appConfig).toContain('DpiAwareness" value="PerMonitorV2')
    expect(appManifest).toContain('PerMonitorV2,PerMonitor')
    expect(command).toContain('& $Command @Arguments')
    expect(command).toContain('[Console]::OutputEncoding = $Utf8NoBom')
    expect(command).toContain('Invoke-LoggedDsh')
    expect(command).toContain("'build'")
    expect(command).toContain("@('run', 'build')")
    expect(command).not.toContain('Read-Host')
    expect(runtime).toContain('StandardOutputEncoding = new UTF8Encoding(false)')
    expect(runtime).toContain('PowerShellStartInfo(script, requestPath, true, false)')
    expect(runtime).toContain('" --tray --start-dsh"')
    expect(runtime).toContain('SetAutostartMode(LoginStartupMode mode)')
    expect(runtime).toContain('DshSourceDirectory')
    expect(runtime).toContain('BuildDshSource(out string output)')
    expect(runtime).toContain('dsh-build.log')
    expect(runtime).toContain('已在后台启动 Profile')
    expect(supervisor).toContain('if ($stopId -eq $requestId.ToString')
    expect(supervisor).toContain('taskkill.exe /PID $runner.Id /T /F')
    expect(installer).toContain('Set-WindowsLauncherDshCommand')
    expect(installer).toContain('dsh-checkout-invoker.ps1')
    expect(installer).toContain('TSX_TSCONFIG_PATH')
    expect(installer).toContain('DshSourceDirectory')
    expect(installer).toContain("' --tray --start-dsh'")
    expect(installer).toContain('Preserved the user-configured Launcher DSH command')
  })

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
