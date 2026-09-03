/** Verify that every standalone distribution prepares from its own packaged source. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const npm = process.env.npm_execpath
if (!npm) throw new Error('Use npm run verify:pack to select the repository package manager.')
const scratch = resolve(root, '.verify-dsh-home')
mkdirSync(scratch, { recursive: true })
const directory = mkdtempSync(resolve(scratch, 'packed-250-'))
const report = []
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  assert.equal(result.status, 0, `${command} failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
for (const name of readdirSync(resolve(root, 'packages'))) {
  const source = resolve(root, 'packages', name)
  if (!existsSync(resolve(source, 'package.json'))) continue
  const packed = JSON.parse(run(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory], source))[0]
  const extracted = resolve(directory, name)
  mkdirSync(extracted)
  run('tar', ['-xzf', resolve(directory, packed.filename), '-C', extracted], root)
  const workspace = resolve(extracted, 'package')
  const manifest = JSON.parse(readFileSync(resolve(workspace, 'package.json'), 'utf8'))
  // No DSH checkout or DSH peer packages are installed in this isolated source tree.
  run(process.execPath, [npm, 'install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], workspace)
  run(process.execPath, [npm, 'run', 'prepare'], workspace)
  const entries = manifest.dshEnhanced.runtimeEntries ?? Object.values(manifest.exports).filter(value => value.startsWith('./lib/'))
  for (const entry of entries) assert.ok(existsSync(resolve(workspace, entry)), `${manifest.name}: missing ${entry}`)
  const repacked = JSON.parse(run(process.execPath, [npm, 'pack', '--dry-run', '--ignore-scripts', '--json'], workspace))[0]
  assert.equal(repacked.version, '2.5.0')
  report.push({ name: manifest.name, version: manifest.version, prepare: 'passed', files: repacked.files.length })
  console.log(`${manifest.name}: isolated prepare and pack passed`)
}
writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2))
console.log(`Standalone pack gate passed; report: ${resolve(directory, 'report.json')}`)
