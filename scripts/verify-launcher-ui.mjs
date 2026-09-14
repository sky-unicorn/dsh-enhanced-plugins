import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

if (process.platform !== 'win32') {
  console.log('Launcher UI verification requires Windows.')
  process.exit(0)
}

const root = resolve(import.meta.dirname, '..')
const artifacts = resolve(root, '.verify-dsh-home/ui-performance')
mkdirSync(artifacts, { recursive: true })
const directory = mkdtempSync(resolve(artifacts, 'run-'))
const source = resolve(root, 'packages/windows-launcher/src')
const executable = resolve(directory, 'LauncherUiTest.exe')
const compiler = resolve(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
const compiled = spawnSync(compiler, [
  '/nologo', '/target:exe', '/optimize+', '/codepage:65001', '/main:LauncherUiPerformanceTest',
  '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll',
  '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll', `/out:${executable}`,
  ...readdirSync(source).filter(file => file.endsWith('.cs')).map(file => resolve(source, file)),
  resolve(root, 'tests/packages/fixtures/LauncherUiPerformance.cs'),
], { cwd: root, encoding: 'utf8', windowsHide: true })
assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`)
copyFileSync(resolve(source, 'DSH-Launcher.exe.config'), `${executable}.config`)
const tested = spawnSync(executable, process.argv.slice(2), {
  cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 120_000,
  env: {
    ...process.env,
    DEEPSEEK_HARNESS_LAUNCHER_HOME: resolve(directory, 'launcher'),
    DSH_HOME: resolve(directory, 'dsh-home'),
  },
})
process.stdout.write(tested.stdout ?? '')
process.stderr.write(tested.stderr ?? '')
console.log(`UI verification artifacts: ${directory}`)
assert.equal(tested.status, 0, String(tested.error ?? 'Launcher UI verification failed'))
