import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { Config } from '../../src/sub-agent/host.ts'
import { SETTINGS_NAMESPACE } from '../../src/sub-agent/settings.ts'
import { MemorySettings } from './memory-settings.ts'

const toolState = vi.hoisted(() => ({
  mounted: [] as Array<Record<string, unknown>>,
  disposed: [] as string[],
}))

vi.mock('@deepseek-ai/dsh-tool-subagent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-tool-subagent')>()
  return {
    ...actual,
    inject: [],
    apply(ctx: Context, config: { provider: string }) {
      toolState.mounted.push(structuredClone(config) as unknown as Record<string, unknown>)
      ctx.effect(() => () => { toolState.disposed.push(config.provider) }, `mock ${config.provider}`)
    },
  }
})

async function boot() {
  const Preset = await import('../../src/sub-agent/preset.ts')
  toolState.mounted.length = 0
  toolState.disposed.length = 0
  const ctx = new Context()
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  ctx.settings.register(SETTINGS_NAMESPACE, Config, {
    base: { claudeCode: false, codex: false },
  })
  const presetFiber = ctx.plugin({
    name: 'preset-test-owner',
    inject: ['settings'],
    apply: (scope: Context) => { Preset.apply(scope) },
  })
  await presetFiber.await()
  return { ctx, presetFiber, settingsFiber }
}

describe('product tool reconciliation', () => {
  it('turns each persisted boolean into the intended dsh-tool-subagent config', async () => {
    const { ctx, presetFiber, settingsFiber } = await boot()

    await ctx.settings.mutate(SETTINGS_NAMESPACE, [
      { op: 'set', path: ['claudeCode'], value: true },
      { op: 'set', path: ['codex'], value: true },
    ])
    await vi.waitFor(() => { expect(toolState.mounted).toHaveLength(2) })

    expect(toolState.mounted).toEqual([
      {
        provider: 'claude-code',
        toolName: 'subagent_claude_code',
        enableRunInBackground: false,
        backgroundMode: 'one-shot',
        maxDepth: 'provider-managed',
        modelSelectionSettings: false,
      },
      {
        provider: 'codex',
        toolName: 'subagent_codex',
        enableRunInBackground: false,
        backgroundMode: 'one-shot',
        maxDepth: 'provider-managed',
        modelSelectionSettings: false,
      },
    ])

    await ctx.settings.mutate(SETTINGS_NAMESPACE, [
      { op: 'set', path: ['claudeCode'], value: false },
    ])
    await vi.waitFor(() => { expect(toolState.disposed).toEqual(['claude-code']) })

    await presetFiber.dispose()
    expect(toolState.disposed).toEqual(['claude-code', 'codex'])
    await settingsFiber.dispose()
  })
})
