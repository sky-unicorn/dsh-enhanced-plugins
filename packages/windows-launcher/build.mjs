import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const source = resolve(root, 'src')
const output = resolve(root, 'lib')

function processFailure(result) {
  const outputText = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  const errorText = result.error === undefined ? '' : `${result.error.code ?? 'SPAWN_ERROR'}: ${result.error.message}`
  return [outputText, errorText].filter(Boolean).join('\n') || `process exited with status ${String(result.status)}`
}

function compilerCandidates() {
  const windows = process.env.WINDIR ?? 'C:\\Windows'
  return [
    resolve(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    resolve(windows, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
}

async function existingCompiler() {
  const files = new Set(await Promise.all(compilerCandidates().map(async (candidate) => {
    try {
      await import('node:fs/promises').then(({ access }) => access(candidate))
      return candidate
    } catch {
      return undefined
    }
  })))
  files.delete(undefined)
  return [...files][0]
}

export async function buildWindowsLauncher() {
  if (process.platform !== 'win32') {
    process.stdout.write('windows-launcher: skipping native build on a non-Windows host\n')
    return
  }

  const compiler = await existingCompiler()
  if (compiler === undefined) {
    throw new Error('windows-launcher: .NET Framework 4.x csc.exe was not found')
  }

  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  const sourceFiles = (await readdir(source))
    .filter(file => file.endsWith('.cs'))
    .sort()
    .map(file => resolve(source, file))
  if (sourceFiles.length === 0) throw new Error('windows-launcher: no C# sources were found')

  // Some Windows security policies block freshly compiled executables from the
  // user temp directory. Keep this short-lived helper inside the build output.
  const temporary = await mkdtemp(resolve(output, 'icon-build-'))
  try {
    const iconTool = resolve(temporary, 'DSH-Launcher.IconGenerator.exe')
    const iconPath = resolve(temporary, 'DSH-Launcher.ico')
    const iconBuild = spawnSync(compiler, [
      '/nologo',
      '/target:exe',
      '/optimize+',
      '/codepage:65001',
      '/r:System.dll',
      '/r:System.Core.dll',
      '/r:System.Drawing.dll',
      `/out:${iconTool}`,
      resolve(source, 'WhaleGlyph.cs'),
      resolve(root, 'tools', 'IconGenerator.cs'),
    ], { cwd: root, encoding: 'utf8' })
    if (iconBuild.status !== 0) {
      throw new Error(`windows-launcher: icon generator compilation failed\n${processFailure(iconBuild)}`)
    }
    const iconResult = spawnSync(iconTool, [iconPath], { cwd: temporary, encoding: 'utf8' })
    if (iconResult.status !== 0) {
      throw new Error(`windows-launcher: icon generation failed\n${processFailure(iconResult)}`)
    }

    const executable = resolve(output, 'DSH-Launcher.exe')
    const result = spawnSync(compiler, [
      '/nologo',
      '/target:winexe',
      '/optimize+',
      '/codepage:65001',
      '/r:System.dll',
      '/r:System.Core.dll',
      '/r:System.Drawing.dll',
      '/r:System.Windows.Forms.dll',
      '/r:System.Web.Extensions.dll',
      `/win32icon:${iconPath}`,
      `/win32manifest:${resolve(source, 'app.manifest')}`,
      `/out:${executable}`,
      ...sourceFiles,
    ], { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`windows-launcher: csc.exe failed\n${processFailure(result)}`)
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }

  for (const file of ['DSH-Launcher.Supervisor.ps1', 'DSH-Launcher.Command.ps1', 'DSH-Launcher.exe.config']) {
    await copyFile(resolve(source, file), resolve(output, basename(file)))
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildWindowsLauncher().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
