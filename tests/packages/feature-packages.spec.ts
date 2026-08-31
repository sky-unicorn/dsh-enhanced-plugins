import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { relative, resolve, sep } from 'node:path'
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
    manager: {
      scope: 'profile' | 'global'
      required: boolean
      defaultSelected: boolean
      order: number
      category: string
      name: { 'zh-CN': string, 'en-US': string }
      description: { 'zh-CN': string, 'en-US': string }
    }
  }
  files: string[]
  scripts: { build: string, prepare: string }
}

const expectedRows: Record<string, string[]> = {
  'agent-team-monitor': ['agent-team-monitor'],
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
      expect(manifest.dshEnhanced.manager.scope).toBe('profile')
      expect(manifest.dshEnhanced.manager.required).toBe(false)
      expect(manifest.dshEnhanced.manager.defaultSelected).toBe(true)
      expect(manifest.dshEnhanced.manager.name['zh-CN']).not.toBe('')
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
      './lib/DSH-Launcher.PluginManager.ps1',
    ])
    expect(launcher?.dshEnhanced.manager).toMatchObject({
      scope: 'global', required: true, defaultSelected: true, order: 0,
    })
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

    const whatIfHome = mkdtempSync(resolve(tmpdir(), 'dsh-enhanced-what-if-'))
    try {
      const env = {
        ...process.env,
        DSH_HOME: whatIfHome,
        DEEPSEEK_HARNESS_LAUNCHER_HOME: resolve(whatIfHome, 'launcher'),
      }
      const selected = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-Features', 'notification,mcp-server-manager', '-WhatIf',
      ], { cwd: root, encoding: 'utf8', env })
      expect(selected.status, `${selected.stdout}\n${selected.stderr}`).toBe(0)
      expect(selected.stdout).toContain("feature set 'mcp-server-manager,notification,windows-launcher'")

      const none = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-Features', 'none', '-WhatIf',
      ], { cwd: root, encoding: 'utf8', env })
      expect(none.status, `${none.stdout}\n${none.stderr}`).toBe(0)
      expect(none.stdout).toContain("feature set 'none (+required windows-launcher)'")
    } finally {
      if (!whatIfHome.startsWith(resolve(tmpdir()) + sep)
        || !whatIfHome.includes(`${sep}dsh-enhanced-what-if-`)) {
        throw new Error('Refusing cleanup outside the what-if fixture directory')
      }
      rmSync(whatIfHome, { recursive: true, force: true })
    }

    const managerDirectory = mkdtempSync(resolve(tmpdir(), 'dsh-enhanced-manager-catalog-'))
    try {
      const managerSource = readFileSync(resolve(root,
        'packages/windows-launcher/src/DSH-Launcher.PluginManager.ps1'), 'utf8')
      const managerScript = resolve(managerDirectory, 'DSH-Launcher.PluginManager.ps1')
      const catalogPath = resolve(managerDirectory, 'catalog.json')
      // Windows PowerShell 5.1 requires a BOM to parse localized source text.
      writeFileSync(managerScript, `\uFEFF${managerSource}`, 'utf8')
      const machineCatalog = spawnSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', managerScript, '-Operation', 'Catalog', '-RepositoryRoot', root, '-OutputPath', catalogPath,
      ], { cwd: root, encoding: 'utf8' })
      expect(machineCatalog.status, `${machineCatalog.stdout}\n${machineCatalog.stderr}`).toBe(0)
      const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
        protocolVersion: number
        sourceRevision: string
        features: Array<{ id: string, required: boolean, scope: string }>
      }
      expect(catalog.protocolVersion).toBe(1)
      expect(catalog.features.map(feature => feature.id).sort()).toEqual(expectedFeatures)
      expect(catalog.features.find(feature => feature.id === 'windows-launcher')).toMatchObject({
        required: true, scope: 'global',
      })

      const planRequestPath = resolve(managerDirectory, 'request.json')
      const planPath = resolve(managerDirectory, 'plan.json')
      writeFileSync(planRequestPath, JSON.stringify({
        requestId: '11111111-1111-1111-1111-111111111111',
        profile: 'web',
        desiredFeatures: ['notification'],
        updateSource: false,
      }), 'utf8')
      const machinePlan = spawnSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', managerScript, '-Operation', 'Plan', '-RepositoryRoot', root,
        '-Profile', 'web', '-RequestPath', planRequestPath, '-OutputPath', planPath,
      ], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          DEEPSEEK_HARNESS_LAUNCHER_HOME: resolve(managerDirectory, 'launcher'),
          DSH_HOME: resolve(managerDirectory, 'dsh-home'),
        },
      })
      expect(machinePlan.status, `${machinePlan.stdout}\n${machinePlan.stderr}`).toBe(0)
      const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
        launcher: { required: boolean, action: string }
        profile: { install: string[], update: string[], remove: string[] }
      }
      expect(plan.launcher.required).toBe(true)
      expect(plan.profile.install).toEqual(['notification'])
      expect(plan.profile.update).toEqual([])
      expect(plan.profile.remove).toEqual([])

      const launcherRoot = resolve(managerDirectory, 'launcher')
      const dshHome = resolve(managerDirectory, 'dsh-home')
      mkdirSync(resolve(launcherRoot), { recursive: true })
      mkdirSync(resolve(dshHome, 'profiles/web'), { recursive: true })
      writeFileSync(resolve(dshHome, 'profiles/web/package.json'), JSON.stringify({
        dependencies: { 'dsh-enhanced-notification': '0.1.0' },
      }), 'utf8')
      writeFileSync(resolve(launcherRoot, 'install-state.json'), JSON.stringify({
        schemaVersion: 1,
        profiles: {
          web: {
            managed: true,
            desiredFeatures: ['notification'],
            knownFeatures: expectedFeatures,
            lastAppliedRevision: catalog.sourceRevision,
          },
        },
      }), 'utf8')
      const noChangePlanPath = resolve(managerDirectory, 'no-change-plan.json')
      const noChangePlan = spawnSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', managerScript, '-Operation', 'Plan', '-RepositoryRoot', root,
        '-Profile', 'web', '-RequestPath', planRequestPath, '-OutputPath', noChangePlanPath,
      ], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, DEEPSEEK_HARNESS_LAUNCHER_HOME: launcherRoot, DSH_HOME: dshHome },
      })
      expect(noChangePlan.status, `${noChangePlan.stdout}\n${noChangePlan.stderr}`).toBe(0)
      const unchanged = JSON.parse(readFileSync(noChangePlanPath, 'utf8')) as {
        profile: { install: string[], update: string[], remove: string[] }
      }
      expect(unchanged.profile).toMatchObject({ install: [], update: [], remove: [] })
    } finally {
      rmSync(managerDirectory, { recursive: true, force: true })
    }

    const retired = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Features', 'referenced-file', '-WhatIf',
    ], { cwd: root, encoding: 'utf8' })
    expect(retired.status).not.toBe(0)
    expect(`${retired.stdout}\n${retired.stderr}`).toContain("Feature 'referenced-file' is retired and cannot be installed")
    expect(`${retired.stdout}\n${retired.stderr}`).toContain('Official DSH now supports @ workspace file references')
  }, 20_000)

  it.runIf(process.platform === 'win32')('imports a manual source ZIP as a validated immutable snapshot', () => {
    const managerDirectory = mkdtempSync(resolve(tmpdir(), 'dsh 增强管理器 import-'))
    try {
      const archivePath = resolve(managerDirectory, 'source.zip')
      const archiveSource = resolve(managerDirectory, 'source')
      cpSync(root, archiveSource, {
        recursive: true,
        filter: (source) => {
          const sourceRelative = relative(root, source)
          return sourceRelative === '' || sourceRelative.split(/[\\/]/u).every(segment =>
            segment !== '.git'
            && segment !== 'node_modules'
            && segment !== 'lib'
            && !segment.startsWith('.verify-'))
        },
      })
      // Use the inbox .NET Framework ZIP API available with Windows PowerShell
      // instead of whichever tar.exe happens to appear first on PATH. Git's
      // GNU tar treats an absolute drive-letter archive path as host:path.
      const archived = spawnSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command',
        "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; "
          + '[System.IO.Compression.ZipFile]::CreateFromDirectory('
          + '$env:DSH_TEST_ARCHIVE_SOURCE, $env:DSH_TEST_ARCHIVE_PATH)',
      ], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          DSH_TEST_ARCHIVE_SOURCE: archiveSource,
          DSH_TEST_ARCHIVE_PATH: archivePath,
        },
      })
      expect(archived.status, `${archived.stdout}\n${archived.stderr}`).toBe(0)

      const managerSource = readFileSync(resolve(root,
        'packages/windows-launcher/src/DSH-Launcher.PluginManager.ps1'), 'utf8')
      const managerScript = resolve(managerDirectory, 'DSH-Launcher.PluginManager.ps1')
      const outputPath = resolve(managerDirectory, 'import.json')
      const launcherHome = resolve(managerDirectory, 'launcher')
      writeFileSync(managerScript, `\uFEFF${managerSource}`, 'utf8')
      const imported = spawnSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', managerScript, '-Operation', 'ImportZip', '-RepositoryRoot', archivePath,
        '-OutputPath', outputPath,
      ], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          DEEPSEEK_HARNESS_LAUNCHER_HOME: launcherHome,
          DSH_HOME: resolve(managerDirectory, 'dsh-home'),
        },
      })
      expect(imported.status, `${imported.stdout}\n${imported.stderr}`).toBe(0)
      const snapshot = JSON.parse(readFileSync(outputPath, 'utf8')) as {
        success: boolean
        source: { path: string, revision: string }
        features: Array<{ id: string }>
      }
      expect(snapshot.success).toBe(true)
      expect(snapshot.source.revision).toMatch(/^local-[0-9a-f]{64}$/)
      expect(snapshot.source.path.startsWith(resolve(launcherHome, 'sources'))).toBe(true)
      expect(snapshot.features.map(feature => feature.id).sort()).toEqual(expectedFeatures)
    } finally {
      rmSync(managerDirectory, { recursive: true, force: true })
    }
  }, 30_000)

  it.runIf(process.platform === 'win32')('retries transient GitHub resets with HTTP/1.1 before checking updates', () => {
    const managerDirectory = mkdtempSync(resolve(tmpdir(), 'dsh-enhanced-manager-git-retry-'))
    try {
      const fakeBin = resolve(managerDirectory, 'bin')
      const launcherHome = resolve(managerDirectory, 'launcher')
      const managerScript = resolve(managerDirectory, 'DSH-Launcher.PluginManager.ps1')
      const outputPath = resolve(managerDirectory, 'update-check.json')
      const attemptPath = resolve(managerDirectory, 'attempt.txt')
      const tracePath = resolve(managerDirectory, 'git-trace.txt')
      mkdirSync(fakeBin, { recursive: true })
      mkdirSync(launcherHome, { recursive: true })
      const managerSource = readFileSync(resolve(root,
        'packages/windows-launcher/src/DSH-Launcher.PluginManager.ps1'), 'utf8')
      writeFileSync(managerScript, `\uFEFF${managerSource}`, 'utf8')
      writeFileSync(resolve(fakeBin, 'git.cmd'), [
        '@echo off',
        'setlocal EnableExtensions EnableDelayedExpansion',
        '>> "%DSH_TEST_GIT_TRACE%" echo %*',
        'for %%A in (%*) do if /I "%%~A"=="fetch" goto fetch',
        'if /I "%~3"=="status" exit /b 0',
        'if /I "%~3"=="branch" (echo master& exit /b 0)',
        'if /I "%~3"=="config" (echo https://github.com/sky-unicorn/dsh-enhanced-plugins.git& exit /b 0)',
        'if /I "%~3"=="merge-base" exit /b 0',
        'if /I "%~3"=="rev-parse" if /I "%~4"=="HEAD" (echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa& exit /b 0)',
        'if /I "%~3"=="rev-parse" if /I "%~4"=="--abbrev-ref" (echo origin/master& exit /b 0)',
        'if /I "%~3"=="rev-parse" (echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa& exit /b 0)',
        'exit /b 91',
        ':fetch',
        'set /a count=0',
        'if exist "%DSH_TEST_GIT_ATTEMPT%" set /p count=<"%DSH_TEST_GIT_ATTEMPT%"',
        'set /a count+=1',
        '> "%DSH_TEST_GIT_ATTEMPT%" echo !count!',
        'if !count! LSS %DSH_TEST_GIT_SUCCEED_AFTER% (echo fatal: unable to access repository: Recv failure: Connection was reset 1>&2& exit /b 128)',
        'echo FETCH_RETRY_OK',
        'exit /b 0',
        '',
      ].join('\r\n'), 'utf8')

      const checked = spawnSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', managerScript, '-Operation', 'CheckUpdate', '-RepositoryRoot', root,
        '-Profile', 'web', '-OutputPath', outputPath,
      ], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin};${process.env.PATH ?? ''}`,
          DEEPSEEK_HARNESS_LAUNCHER_HOME: launcherHome,
          DSH_HOME: resolve(managerDirectory, 'dsh-home'),
          DSH_TEST_GIT_ATTEMPT: attemptPath,
          DSH_TEST_GIT_TRACE: tracePath,
          DSH_TEST_GIT_SUCCEED_AFTER: '3',
        },
      })
      expect(checked.status, `${checked.stdout}\n${checked.stderr}`).toBe(0)
      expect(readFileSync(attemptPath, 'utf8').trim()).toBe('3')
      const trace = readFileSync(tracePath, 'utf8')
      expect(trace).toContain('http.version=HTTP/1.1')
      expect(trace).not.toContain(' pull ')
      const result = JSON.parse(readFileSync(outputPath, 'utf8')) as {
        success: boolean
        source: { relation: string, updateAvailable: boolean }
      }
      expect(result.success).toBe(true)
      expect(result.source).toMatchObject({ relation: 'current', updateAvailable: false })

      const failedOutputPath = resolve(managerDirectory, 'update-check-failed.json')
      const failedAttemptPath = resolve(managerDirectory, 'failed-attempt.txt')
      const failedTracePath = resolve(managerDirectory, 'failed-git-trace.txt')
      const failed = spawnSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', managerScript, '-Operation', 'CheckUpdate', '-RepositoryRoot', root,
        '-Profile', 'web', '-OutputPath', failedOutputPath,
      ], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin};${process.env.PATH ?? ''}`,
          DEEPSEEK_HARNESS_LAUNCHER_HOME: launcherHome,
          DSH_HOME: resolve(managerDirectory, 'dsh-home'),
          DSH_TEST_GIT_ATTEMPT: failedAttemptPath,
          DSH_TEST_GIT_TRACE: failedTracePath,
          DSH_TEST_GIT_SUCCEED_AFTER: '99',
        },
      })
      expect(failed.status).toBe(1)
      expect(readFileSync(failedAttemptPath, 'utf8').trim()).toBe('3')
      const failure = JSON.parse(readFileSync(failedOutputPath, 'utf8')) as {
        success: boolean
        message: string
      }
      expect(failure.success).toBe(false)
      expect(failure.message).toContain('Launcher 已自动重试 3 次')
      expect(failure.message).toContain('本地源码、Profile 和 Launcher 均未修改')
    } finally {
      rmSync(managerDirectory, { recursive: true, force: true })
    }
  }, 30_000)

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
    const manager = readFileSync(resolve(launcherRoot, 'src', 'DSH-Launcher.PluginManager.ps1'), 'utf8')
    const pluginUi = readFileSync(resolve(launcherRoot, 'src', 'PluginManagement.cs'), 'utf8')

    expect(runtime).not.toContain('cmd.exe')
    expect(runtime).not.toContain('Get-NetTCPConnection')
    expect(runtime).not.toContain('OwningProcess')
    expect(theme).toContain('internal sealed class ToggleSwitch : Control')
    expect(theme).toContain('internal sealed class ModernButton : Control')
    expect(theme).toContain('internal sealed class ModernComboBox : Control')
    expect(theme).toContain('internal sealed class ModernScrollBar : Control')
    expect(theme).toContain('internal sealed class ModernScrollPage : UserControl, IMessageFilter')
    expect(theme).toContain('internal sealed class ModernRichTextBox : RichTextBox')
    expect(theme).toContain('internal static class ModernTextAreaScroll')
    expect(theme).toContain('editor.ScrollBars = RichTextBoxScrollBars.None')
    expect(theme).toContain('private const int EmGetFirstVisibleLine = 0x00CE')
    expect(theme).toContain('Application.AddMessageFilter(this)')
    expect(theme).toContain('AccessibleRole = AccessibleRole.ScrollBar')
    expect(theme).toContain('choices.DrawMode = DrawMode.OwnerDrawFixed')
    expect(theme).toContain('internal sealed class NavButton : Control')
    expect(theme).not.toContain('Appearance = Appearance.Button')
    expect(theme).not.toContain('Region = new Region')
    expect(program).toContain('LayoutResponsivePages')
    expect(program).toContain('QueueResponsiveLayout')
    expect(program).toContain('private ModernScrollPage activePage;')
    expect(program).toContain('if (activePage == overviewPage) LayoutOverview();')
    expect(program).not.toContain('if (overviewPage.Visible) LayoutOverview();')
    expect(program).toContain('The overview page did not complete its first-show layout.')
    expect(program).not.toContain('bool sideBySide = width >=')
    expect(program).toContain('SetBoundsIfChanged(pathCard, left, cardsTop + settingsHeight + gap, width, pathHeight);')
    expect(program).toContain('SetBoundsIfChanged(profileCard, left, taskHeight + gap, width, profileHeight);')
    expect(program).toContain('Overview cards must remain vertically stacked.')
    expect(program).toContain('Task cards must remain vertically stacked.')
    expect(program).toContain('ClientSize.Width < Dip(760)')
    expect(program).toContain('ApplyDisplayConstraints')
    expect(program).toContain('DeviceDpi / 96f')
    expect(program).toContain('SetProcessDpiAwarenessContext')
    expect(program).toContain('WindowPlacementGeometry.SelfTest()')
    expect(program).toContain('ModernScrollPage.SelfTest()')
    expect(program).toContain('ModernTextAreaScroll.SelfTest()')
    expect(program).toContain('LauncherRuntime.SourceLogSelfTest()')
    expect(program).toContain('ModernTextAreaScroll.Attach(diagnosticsLogShell, diagnosticsOutput)')
    expect(program).toContain('ModernTextAreaScroll.Attach(sourceLogShell, sourceOutput)')
    expect(program).toContain('ModernTextAreaScroll.Attach(taskInputShell, taskInput)')
    expect(program).not.toContain('new RichTextBox()')
    expect(pluginUi).toContain('ModernTextAreaScroll.Attach(logShell, pluginLogOutput)')
    expect(program).toContain('runtime.Settings.WindowPlacement')
    expect(program).toContain('ScreenDeviceName = screen.DeviceName')
    expect(program).toContain('Screen.FromRectangle(Bounds).WorkingArea')
    expect(program).not.toContain('MaximizedBounds = workingArea')
    expect(program).toContain('Page title and subtitle must not overlap at any DPI.')
    expect(program).toContain('ScaleStandardControls(this)')
    expect(program).toContain('overviewPage = new ModernScrollPage()')
    expect(program).toContain('overviewPage.Content.Controls.Add(hero)')
    expect(program).toContain('Pages must not expose a system-native scrollbar.')
    expect(program).not.toContain('.AutoScroll = true;')
    expect(runtime).toContain('public LauncherWindowPlacement WindowPlacement { get; set; }')
    expect(theme).toContain('internal int LogicalWidth { get; set; }')
    expect(program).toContain('Interlocked.CompareExchange(ref refreshInFlight')
    expect(program).toContain('delayedDshTimer.Interval = 30000')
    expect(program).toContain('if (form.Handle == IntPtr.Zero)')
    expect(program).toContain('A hidden form is removed from the taskbar automatically.')
    expect(program).not.toContain('form.ShowInTaskbar =')
    expect(manager).toContain('$supervisorProcessId = [int](Get-OptionalProperty $webState \'supervisorPid\' 0)')
    expect(manager).not.toMatch(/\$pid\b/i)
    expect(manager).toContain("Get-Command -Name 'powershell.exe'")
    expect(manager).toContain('& $installerPowerShell.Source @installerProcessArguments')
    expect(manager).not.toContain('& $installer @installerParameters')
    expect(manager).not.toContain('$installerArguments = @(')
    expect(manager).toContain("$ErrorActionPreference = 'Continue'")
    expect(manager).toContain('$exitCode = $LASTEXITCODE')
    expect(manager).toContain('Release-PluginManagementLock $ManagementLock')
    expect(manager).toContain("$ownership -eq 'Owned'")
    expect(manager).toContain('AddSeconds(60)')
    expect(manager).toContain('$Process.WaitForExit($TimeoutMilliseconds)')
    expect(manager).not.toContain('-PassThru -Wait -WindowStyle Hidden')
    expect(program).toContain('menu.Items.Add("退出 Launcher", null, delegate { StopDshAndExit(); })')
    expect(program).toContain('menu.Items.Add("仅退出 Launcher", null, delegate { ExitLauncher(); })')
    expect(program).toContain('tray.DoubleClick += delegate { ShowWindow(); };')
    expect(program).not.toContain('tray.MouseClick +=')
    expect(program).not.toContain('Launcher 已在托盘就绪。')
    expect(program).not.toContain('Launcher 仍在运行')
    expect(program).toContain('bool activateUpdate = StartupRegistration.HasArgument(args, "--activate-update")')
    expect(program).toContain('SignalEvent(ShutdownEventName);')
    expect(program).toContain('mutex.WaitOne(TimeSpan.FromSeconds(15))')
    expect(program.indexOf('menu.Items.Add("仅退出 Launcher"'))
      .toBeLessThan(program.indexOf('menu.Items.Add("退出 Launcher"'))
    expect(program).not.toContain('NewButton("退出 Launcher"')
    expect(program).not.toContain('NewButton("仅退出 Launcher"')
    expect(program).toContain('runtime.StopWebAndWait()')
    expect(program).toContain('LoginStartupMode.LauncherOnly')
    expect(program).toContain('LoginStartupMode.LauncherAndDsh')
    expect(program).toContain('NewNav("DSH 源码", 272, NavGlyph.Source)')
    expect(program).toContain('NewNav("插件管理", 322, NavGlyph.Plugins)')
    expect(program).toContain('LayoutPluginManager()')
    expect(program).toContain('NewButton("拉取最新源码并构建"')
    expect(program).toContain('MessageBox.Show(this, confirmation, "更新并构建 DSH"')
    expect(program).toContain('bool updateSource = runtime.IsGitAvailable()')
    expect(program).toContain('runtime.BuildDshSource(updateSource, out output)')
    expect(program).toContain('RefreshSourceLog(true)')
    expect(program).toContain('Source failure details must survive refresh and page navigation.')
    expect(program).toContain('Unchanged source logs must not reset the reader\'s selection.')
    expect(program).toContain('sourceOutput.Font = new Font("Consolas", 10f')
    expect(program).toContain('SetSourceStatus(result)')
    expect(program).toContain('后台无窗口运行，输出以 UTF-8 保存在日志目录')
    expect(program).toContain('profileInput = new ModernComboBox()')
    expect(program).not.toContain('profileInput = new ComboBox()')
    expect(program).not.toContain('交互式 Profile 会在独立终端中运行')
    expect(program).not.toContain('TextRenderer.DrawText(graphics, "DS"')
    expect(whale).toContain('official DeepSeek whale silhouette')
    expect(build).toContain('/win32icon:')
    expect(build).toContain('/win32manifest:')
    expect(build).toContain('`\\uFEFF${content}`')
    expect(appConfig).toContain('DpiAwareness" value="PerMonitorV2')
    expect(appManifest).toContain('PerMonitorV2,PerMonitor')
    expect(command).toContain('& $Command @Arguments')
    expect(command).toContain('[Console]::OutputEncoding = $Utf8NoBom')
    expect(command).toContain('Invoke-LoggedDsh')
    expect(command).toContain("$ErrorActionPreference = 'Continue'")
    expect(command).toContain('$ErrorActionPreference = $originalErrorActionPreference')
    expect(command).toContain('Write-BuildOutcome')
    expect(command).toContain('Get-SourceFailureMessage')
    expect(command).toContain('$code = $LASTEXITCODE')
    expect(command).not.toMatch(/\$LASTEXITCODE\s*=/)
    expect(command).toContain('exit $gitResult.code')
    expect(command).toContain("'build'")
    expect(command).toContain("@('-C', $workingDirectory, 'pull', '--ff-only')")
    expect(command).toContain('Git unavailable: skipping source update; running clean, frozen install, and build')
    expect(command).toContain("@('run', 'build')")
    expect(command).not.toContain('Read-Host')
    expect(runtime).toContain('StandardOutputEncoding = new UTF8Encoding(false)')
    expect(runtime).toContain('PowerShellStartInfo(script, requestPath, true, false)')
    expect(runtime).toContain('" --tray --start-dsh"')
    expect(runtime).toContain('SetAutostartMode(LoginStartupMode mode)')
    expect(runtime).toContain('DshSourceDirectory')
    expect(runtime).toContain('BuildDshSource(out string output)')
    expect(runtime).toContain('BuildDshSource(bool updateSource, out string output)')
    expect(runtime).toContain('internal bool IsGitAvailable()')
    expect(runtime).toContain('StopWebAndWait()')
    expect(runtime).toContain('等待 DSH 停止超时；Launcher 保持运行。')
    expect(runtime).toContain('dsh-build.log')
    expect(runtime).toContain('JsonFile.Read<LauncherCommandResult>(request.resultPath)')
    expect(runtime).toContain('File.AppendAllText(LauncherPaths.BuildLog')
    expect(runtime).toContain('FileShare.ReadWrite | FileShare.Delete')
    expect(runtime).toContain('已在后台启动 Profile')
    expect(supervisor).toContain('if ($stopId -eq $requestId.ToString')
    expect(supervisor).toContain('taskkill.exe /PID $runner.Id /T /F')
    expect(installer).toContain('Set-WindowsLauncherDshCommand')
    expect(installer).toContain('dsh-checkout-invoker.ps1')
    expect(installer).toContain('TSX_TSCONFIG_PATH')
    expect(installer).toContain('DshSourceDirectory')
    expect(installer).toContain("' --tray --start-dsh'")
    expect(installer).toContain('Save-LauncherInstallState')
    expect(installer).toContain('[AllowEmptyCollection()][string[]] $DesiredFeatures')
    expect(installer).toContain("Feature 'none'")
    expect(installer).toContain('npm run check')
    expect(manager).toContain("[ValidateSet('Catalog', 'Snapshot', 'CheckUpdate', 'Bind', 'ImportZip', 'Plan', 'Apply')]")
    expect(manager).toContain("'Local\\DSH.Enhanced.WindowsLauncher.PluginManagement'")
    expect(manager).toContain('Expand-SafeZip')
    expect(manager).toContain('Invoke-GitFetchWithRetry')
    expect(manager).toContain("# transient network error can reach the retry policy below.")
    expect(manager).toContain("'http.version=HTTP/1.1'")
    expect(manager).toContain('Launcher 已自动重试 3 次')
    expect(manager).toContain("@('merge', '--ff-only', '@{u}')")
    expect(manager).not.toContain("Invoke-GitText $gitInfo.git $InitialRoot @('pull', '--ff-only')")
    expect(manager).toContain(".dsh-enhanced-source.json")
    expect(manager).toContain('Write-SourceRevisionMarker')
    expect(manager).toContain('Import-ManualSourceZip')
    expect(manager).toContain('New-BuildWorkspace')
    expect(manager).toContain('("runtime-$revisionToken-$requestToken")')
    expect(manager).toContain('Remove-UnreferencedRuntimeSources $LauncherRoot $source')
    expect(manager).toContain('TotalSeconds -ge 15')
    expect(manager).toContain("'\\\\?\\' + $candidate")
    expect(manager).not.toContain("Join-Path (Join-Path (Join-Path $LauncherRoot 'updates') $RequestId) 'build-source'")
    expect(installer).toContain('$SkipLauncherInstall')
    expect(installer).toContain('[switch] $RestartLauncherAfterUpdate')
    expect(installer).toContain('if ($launcherChanged -and $RestartAfterUpdate)')
    expect(installer).toContain('-RestartAfterUpdate:$RestartLauncherAfterUpdate')
    expect(installer).toContain("@('--activate-update', '--tray', '--ready-file'")
    expect(installer).not.toContain("Start-Process -FilePath $previousExecutable -ArgumentList '--shutdown'")
    expect(installer).toContain('AddSeconds(20)')
    expect(installer).toContain('Start-Sleep -Seconds 2')
    expect(installer).toContain('$newLauncher.Refresh()')
    expect(installer).toContain('$newLauncher.Kill()')
    expect(manager).toContain("$installerProcessArguments += '-RestartLauncherAfterUpdate'")
    expect(pluginUi).toContain('class PluginFeatureRow')
    expect(pluginUi).toContain('desiredFeatures = desired.Distinct')
    expect(pluginUi).toContain('File.Copy(ScriptPath, coordinatorPath, true)')
    expect(pluginUi).toContain('LatestPendingOperation')
    expect(pluginUi).toContain('CapturePluginSelections')
    expect(pluginUi).toContain('pluginSelections[feature.id] = selected')
    expect(pluginUi).toContain('NewButton("确认并应用"')
    expect(pluginUi).toContain('pluginPlanShell.Controls.Add(pluginApplyButton)')
    expect(pluginUi).toContain('新版将在托盘继续运行，可双击托盘图标或通过右键菜单再次打开。')
    expect(pluginUi).not.toContain('由新版自动重开')
    expect(pluginUi).toContain('DateTime.UtcNow - pluginSnapshotLoadedAtUtc < TimeSpan.FromSeconds(30)')
    expect(pluginUi).toContain('pluginRows.TryGetValue(feature.id, out row)')
    expect(pluginUi).not.toContain('pluginFeatureRows.AutoScroll = true')
    expect(pluginUi).toContain('pluginPage.Content.Controls.Add(pluginSourceCard)')
    expect(pluginUi).not.toContain('pluginGlobalCard')
    expect(pluginUi).toContain('bool stackSourceActions = width < Dip(500);')
    expect(pluginUi).toContain('bool stackCompactToolbar = toolbarWidth < Dip(400);')
    expect(pluginUi).toContain('bool stackLog = width < Dip(520);')
    expect(manager).toContain('if (-not $manifestInventoryAvailable')
    expect(manager).toContain("$ErrorActionPreference = 'Continue'")
    expect(manager).toContain("lastAppliedRevision = [string](Get-OptionalProperty $profileState 'lastAppliedRevision' '')")
    expect(manager).toContain("Invoke-LoggedCommand $npm.Source @('run', 'build') $source $logPath 'npm run build'")
    expect(manager).not.toContain("Invoke-LoggedCommand $npm.Source @('run', 'check')")
    expect(pluginUi).toContain('PluginPlanHasWork(plan)')
    expect(pluginUi).toContain('当前已是目标状态，无需再次构建或应用。')
    expect(pluginUi).not.toContain('edit-last-message')
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
