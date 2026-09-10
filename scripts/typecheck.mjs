/** Check against the chosen built DSH checkout; never silently validate against stale Session declarations. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dsh = resolve(process.env.DSH_VERIFY_CHECKOUT ?? resolve(root, '../deepseek-harness'))
const formatVersion = path => readFileSync(path, 'utf8').match(/SESSION_FORMAT_VERSION\s*=\s*(\d+)/)?.[1]
const source = formatVersion(resolve(dsh, 'packages/core/session/src/types.ts'))
const built = formatVersion(resolve(dsh, 'packages/core/session/lib/types/types.d.ts'))
if (source !== '3' || source !== built) throw new Error(`DSH Session declarations are stale or incompatible (source=${source}, built=${built}); build the target checkout or set DSH_VERIFY_CHECKOUT to a freshly built copy.`)
const scratch = mkdtempSync(resolve(tmpdir(), 'dsh-enhanced-typecheck-'))
try {
  for (const name of ['tsconfig.json', 'tsconfig.client.json']) {
    const config = JSON.parse(readFileSync(resolve(root, name), 'utf8'))
    const paths = Object.fromEntries(Object.entries(config.compilerOptions.paths).map(([key, values]) => [
      key, values.map(value => resolve(dsh, value.replace('../deepseek-harness/', ''))),
    ]))
    const path = resolve(scratch, name)
    writeFileSync(path, JSON.stringify({ extends: resolve(root, name), compilerOptions: { paths } }))
    const result = spawnSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--project', path, '--noEmit'], { cwd: root, stdio: 'inherit', windowsHide: true })
    if (result.error) throw result.error
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break }
  }
} finally { rmSync(scratch, { recursive: true, force: true }) }
