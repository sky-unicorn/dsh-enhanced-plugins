import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as Host from '../../src/sub-agent/host.ts'
import { SETTINGS_NAMESPACE } from '../../src/sub-agent/settings.ts'
import { MemorySettings } from './memory-settings.ts'

interface RemoteFace {
  describe(): {
    registered: boolean
    writable: boolean
    value?: { claudeCode: boolean; codex: boolean }
    revision?: number
  }
  set(request: unknown): Promise<{ kind: 'ok' | 'conflict'; revision: number }>
}

async function boot() {
  const ctx = new Context()
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  const hostFiber = ctx.plugin(Host, { claudeCode: false, codex: false })
  await hostFiber.await()
  const settings = ctx.get('settings') as unknown as MemorySettings
  const remote = ctx.get('subagentProducts') as RemoteFace
  return { ctx, hostFiber, remote, settings, settingsFiber }
}

describe('subagent product settings remote', () => {
  it('persists path-addressed boolean overrides and returns the resolved section', async () => {
    const { hostFiber, remote, settings, settingsFiber } = await boot()

    expect(remote.describe()).toEqual({
      registered: true,
      writable: true,
      value: { claudeCode: false, codex: false },
      revision: 0,
    })

    await expect(remote.set({ product: 'claudeCode', enabled: true, expectedRevision: 0 }))
      .resolves.toEqual({ kind: 'ok', revision: 1 })
    expect(settings.persisted.at(-1)).toEqual({
      ns: SETTINGS_NAMESPACE,
      section: { claudeCode: true },
    })
    expect(remote.describe().value).toEqual({ claudeCode: true, codex: false })

    await expect(remote.set({ product: 'codex', enabled: true, expectedRevision: 1 }))
      .resolves.toEqual({ kind: 'ok', revision: 2 })
    expect(settings.persisted.at(-1)?.section).toEqual({ claudeCode: true, codex: true })

    await expect(remote.set({ product: 'claudeCode', enabled: false, expectedRevision: 2 }))
      .resolves.toEqual({ kind: 'ok', revision: 3 })
    expect(settings.persisted.at(-1)?.section).toEqual({ claudeCode: false, codex: true })
    expect(remote.describe().value).toEqual({ claudeCode: false, codex: true })

    await hostFiber.dispose()
    await settingsFiber.dispose()
  })

  it('refuses a stale revision without generating a second config write', async () => {
    const { hostFiber, remote, settings, settingsFiber } = await boot()

    await remote.set({ product: 'codex', enabled: true, expectedRevision: 0 })
    await expect(remote.set({ product: 'claudeCode', enabled: true, expectedRevision: 0 }))
      .resolves.toEqual({ kind: 'conflict', revision: 1 })
    expect(settings.persisted).toHaveLength(1)
    expect(remote.describe().value).toEqual({ claudeCode: false, codex: true })

    await hostFiber.dispose()
    await settingsFiber.dispose()
  })

  it('rejects malformed wire requests before they reach settings storage', async () => {
    const { hostFiber, remote, settings, settingsFiber } = await boot()

    await expect(remote.set(null)).rejects.toThrow(/request must be an object/)
    await expect(remote.set({ product: 'codex', enabled: 'yes' })).rejects.toThrow(/invalid product or enabled/)
    await expect(remote.set({ product: 'codex', enabled: true, expectedRevision: -1 }))
      .rejects.toThrow(/expectedRevision/)
    expect(settings.persisted).toEqual([])

    await hostFiber.dispose()
    await settingsFiber.dispose()
  })
})
