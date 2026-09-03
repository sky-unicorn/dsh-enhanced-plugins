import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')

it.runIf(process.platform === 'win32')('reuses the update workspace without overwriting live or mismatched requests', () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'dsh-update-workspace-'))
  try {
    const source = resolve(root, 'packages/windows-launcher/src')
    const executable = resolve(temporary, 'UpdateWorkspaceTest.exe')
    const compiler = resolve(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework/v4.0.30319/csc.exe')
    const compiled = spawnSync(compiler, [
      '/nologo', '/target:exe', '/codepage:65001', '/main:LauncherUpdateWorkspaceTest',
      '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll',
      '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll', `/out:${executable}`,
      ...readdirSync(source).filter(file => file.endsWith('.cs')).map(file => resolve(source, file)),
      resolve(root, 'tests/packages/fixtures/LauncherUpdateWorkspace.cs'),
    ], { cwd: root, encoding: 'utf8', windowsHide: true })
    expect(compiled.status, `${compiled.stdout}\n${compiled.stderr}`).toBe(0)
    writeFileSync(resolve(temporary, 'DSH-Launcher.PluginManager.ps1'),
      `\uFEFF${readFileSync(resolve(source, 'DSH-Launcher.PluginManager.ps1'), 'utf8')}`, 'utf8')
    const tested = spawnSync(executable, [root], {
      cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 75_000,
      env: {
        ...process.env,
        DEEPSEEK_HARNESS_LAUNCHER_HOME: resolve(temporary, 'launcher'),
        DSH_HOME: resolve(temporary, 'dsh-home'),
      },
    })
    expect(tested.status, `${tested.stdout}\n${tested.stderr}\n${tested.error ?? ''}`).toBe(0)
    expect(tested.stdout).toContain('UPDATE_WORKSPACE_OK')
  } finally {
    if (!temporary.startsWith(resolve(tmpdir()) + sep)) throw new Error('Invalid fixture cleanup path')
    rmSync(temporary, { recursive: true, force: true })
  }
}, 90_000)

it.runIf(process.platform === 'win32')('retires unused legacy builds while preserving processes, references, and link targets', () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'dsh-legacy-cleanup-'))
  try {
    const managerScript = resolve(temporary, 'manager.ps1')
    writeFileSync(managerScript, `\uFEFF${readFileSync(resolve(root,
      'packages/windows-launcher/src/DSH-Launcher.PluginManager.ps1'), 'utf8')}`, 'utf8')
    const tested = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', resolve(root, 'tests/packages/fixtures/LegacyUpdateCleanup.ps1'),
      '-ManagerScript', managerScript, '-TestRoot', temporary,
    ], { cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    expect(tested.status, `${tested.stdout}\n${tested.stderr}\n${tested.error ?? ''}`).toBe(0)
    expect(tested.stdout).toContain('LEGACY_UPDATE_CLEANUP_OK')
  } finally {
    if (!temporary.startsWith(resolve(tmpdir()) + sep)) throw new Error('Invalid fixture cleanup path')
    rmSync(temporary, { recursive: true, force: true })
  }
}, 40_000)
