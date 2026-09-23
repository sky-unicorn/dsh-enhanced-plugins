import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import * as Host from '../../src/sub-agent/host.ts'

interface ProductsRemote {
  describe(): { registered: boolean; writable: boolean; value?: { claudeCode: boolean; codex: boolean }; revision?: number }
  set(request: { product: 'claudeCode' | 'codex'; enabled: boolean; expectedRevision: number }): Promise<{ kind: 'ok' | 'conflict' }>
}

it('reads and writes the real Loader-owned section, survives reload, and unregisters on disposal', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'subagent-settings-')))
  const dir = join(home, 'profiles', 'test')
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"subagent-settings-test"}')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  // Take the id from the shipped patch, not the shared constant: a fake
  // namespace registration previously concealed this mismatch.
  const patch = readFileSync(new URL('../../packages/sub-agent/cordis.patch.yml', import.meta.url), 'utf8')
  const ownerId = patch.match(/- id: (\S+)\r?\n\s+name: 'dsh-enhanced-sub-agent'/)?.[1]
  expect(ownerId).toBeDefined()
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: ownerId, name: 'cordis:products', config: { claudeCode: false, codex: false } },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const start = async () => {
    const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), ctx => {
      ctx.provide('profileContext', profile)
      ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
      Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, products: Host })
    })
    onTestFinished(async () => { await ctx.fiber.dispose() })
    return ctx
  }
  const ctx = await start()
  const remote = ctx.get('subagentProducts') as ProductsRemote
  const initial = remote.describe()
  expect(initial).toMatchObject({ registered: true, writable: true, value: { claudeCode: false, codex: false } })
  expect(ctx.settings.describe().find(row => row.ns === ownerId)?.autoGenerate).toBe(false)
  await expect(remote.set({ product: 'codex', enabled: true, expectedRevision: initial.revision! })).resolves.toMatchObject({ kind: 'ok' })
  expect(remote.describe().value).toEqual({ claudeCode: false, codex: true })
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('codex: true')
  await expect(remote.set({ product: 'claudeCode', enabled: true, expectedRevision: initial.revision! })).resolves.toMatchObject({ kind: 'conflict' })
  await ctx.fiber.dispose()
  const restored = await start()
  expect((restored.get('subagentProducts') as ProductsRemote).describe().value).toEqual({ claudeCode: false, codex: true })
  const owner = [...restored.loader.entries()].find(entry => entry.options.id === ownerId)!.fiber!
  await owner.dispose()
  expect(restored.get('subagentProducts')).toBeUndefined()
  expect(restored.settings.describe().some(row => row.ns === ownerId)).toBe(false)
})
