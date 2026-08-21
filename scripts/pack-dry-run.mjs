import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageDirectories = readdirSync(resolve(root, 'packages'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(resolve(root, 'packages', entry.name, 'package.json')))
  .map(entry => resolve(root, 'packages', entry.name))
  .sort()
const npmCli = process.env.npm_execpath
if (npmCli === undefined) throw new Error('pack-dry-run must be invoked through npm run pack:dry-run')

for (const directory of [root, ...packageDirectories]) {
  process.stdout.write(`\n==> npm pack --dry-run ${directory}\n`)
  const result = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', directory], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
