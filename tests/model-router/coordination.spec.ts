import { expect, it } from 'vitest'
import { WorkspaceLocks, workspaceIdentity } from '../../src/model-router/host/coordination.ts'
import { Config } from '../../src/model-router/host/config.ts'
import { snapshotSchema } from '../../src/model-router/schema.ts'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { dshCheckout } from '../dsh-aliases.ts'

it('cancels a queued writer immediately without opening a hole in the active writer lock', async () => {
  const locks = new WorkspaceLocks(); const order: number[] = []
  let release!: () => void
  const first = locks.run('workspace', new AbortController().signal, async () => { order.push(1); await new Promise<void>(r => { release = r }); order.push(2) })
  await Promise.resolve(); await Promise.resolve()
  const abort = new AbortController()
  const cancelled = locks.run('workspace', abort.signal, async () => { order.push(99) })
  abort.abort(new Error('cancel queued'))
  await expect(cancelled).rejects.toThrow('cancel queued')
  const third = locks.run('workspace', new AbortController().signal, async () => { order.push(3) })
  expect(order).toEqual([1]); release(); await Promise.all([first, third]); expect(order).toEqual([1, 2, 3])
})

it('coordinates canonical paths and releases locks after a tool error', async () => {
  expect(await workspaceIdentity('.')).toBe(await workspaceIdentity('./src/..'))
  const locks = new WorkspaceLocks()
  await expect(locks.run('workspace', new AbortController().signal, async () => { throw new Error('tool failed') })).rejects.toThrow('tool failed')
  expect(await locks.run('workspace', new AbortController().signal, async () => 42)).toBe(42)
})

it('validates finite deployment limits and rejects malformed wire state', () => {
  expect(Config({}).limits).toEqual({ maxConcurrentChildren: 2, maxChildExecutions: 0, maxRequests: 0, maxAdditionalDepth: 1 })
  expect(() => Config({ limits: { maxConcurrentChildren: 0 } })).toThrow()
  expect(() => Config({ retry: { maxRetries: 4 } })).toThrow()
  expect(() => snapshotSchema.parse({ enabled: true, control: { mode: 'automatic', revision: -1 } })).toThrow()
})

it('uses only existing semantic theme tokens and maintains both locale dictionaries', async () => {
  const css = readFileSync(resolve('src/model-router/client/Router.module.css'), 'utf8')
  const theme = readFileSync(resolve(dshCheckout, 'packages/client/ui-theme/src/styles/design-platform.css'), 'utf8')
  for (const match of css.matchAll(/var\((--[^)]+)\)/g)) { expect(match[1]).toMatch(/^--dsw-alias-/); expect(theme).toContain(`${match[1]}:`) }
  expect(css).not.toMatch(/#[0-9a-f]|rgba?\(|hsla?\(|prefers-color-scheme|data-ds-dark-theme/)
  const { zh, en } = await import('../../src/model-router/client/locales.ts')
  expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
})

it('preserves named Remote arguments in the independently bundled Host', async () => {
  const { build } = await import('esbuild')
  const result = await build({ entryPoints: ['src/model-router/host/index.ts'], bundle: true, write: false, packages: 'external', platform: 'node', format: 'esm', target: 'node22' })
  const js = result.outputFiles[0]!.text
  expect(js).toMatch(/describe\(request\)/)
  expect(js).toMatch(/command\(request\)/)
  expect(js).not.toMatch(/describe\(request\d+\)/)
})

it('includes every relative Host dependency in the aggregate distribution', async () => {
  const { build } = await import('esbuild')
  const manifest = JSON.parse(readFileSync(resolve('packages/model-router/package.json'), 'utf8'))
  const result = await build({ entryPoints: manifest.dshEnhanced.build.hostEntries, outbase: 'src', outdir: 'lib', bundle: false, write: false, platform: 'node', format: 'esm', target: 'node22' })
  const files = new Set(result.outputFiles.map(file => resolve(file.path)))
  for (const file of result.outputFiles) for (const match of file.text.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
    expect(files.has(resolve(dirname(file.path), match[1]!)), `${file.path} depends on ${match[1]}`).toBe(true)
  }
})
