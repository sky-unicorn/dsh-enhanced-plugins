import { describe, expect, it, vi } from 'vitest'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import {
  ModelInputTypesController, modelsWithType, projectModelInputTypes,
} from '../../src/model-input-types/client/controller.ts'

function view(providers: Record<string, unknown>, revision = 0): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai',
    schema: {},
    value: { providers },
    user: { providers },
    revision,
    applies: 'live',
  }
}

function ok<T>(value: T) {
  return { rpcId: 'test', result: { ok: true as const, value } }
}

function described(namespace: SettingsNamespaceView, writable = true) {
  return ok({ writable, hasDocument: true, namespaces: [namespace] })
}

describe('pi-ai model request-type projection', () => {
  it('maps absent, text, and image modalities without losing route identity', () => {
    expect(projectModelInputTypes(view({
      gateway: {
        displayName: 'Gateway',
        models: [
          { id: 'default' },
          { id: 'plain', input: ['text'] },
          { id: 'vision', name: 'Vision', input: ['text', 'image'] },
        ],
      },
    }))).toEqual([{
      provider: 'gateway',
      displayName: 'Gateway',
      models: [
        { id: 'default', name: 'default', type: 'default' },
        { id: 'plain', name: 'plain', type: 'text' },
        { id: 'vision', name: 'Vision', type: 'multimodal' },
      ],
    }])
  })

  it('replaces only input on the selected model and removes it for provider defaults', () => {
    const source = view({
      gateway: {
        models: [
          { id: 'vision', input: ['text'], compat: { preserved: true } },
          { id: 'other', input: ['text', 'image'], maxTokens: 8192 },
        ],
      },
    })
    expect(modelsWithType(source, 'gateway', 0, 'vision', 'multimodal')).toEqual([
      { id: 'vision', input: ['text', 'image'], compat: { preserved: true } },
      { id: 'other', input: ['text', 'image'], maxTokens: 8192 },
    ])
    expect(modelsWithType(source, 'gateway', 0, 'vision', 'default')).toEqual([
      { id: 'vision', compat: { preserved: true } },
      { id: 'other', input: ['text', 'image'], maxTokens: 8192 },
    ])
  })

  it('builds writes from the raw user layer instead of materialized schema defaults', () => {
    const source = {
      ...view({ gateway: { models: [{ id: 'vision', compat: {} }] } }),
      user: { providers: { gateway: { models: [{ id: 'vision' }] } } },
    }
    expect(modelsWithType(source, 'gateway', 0, 'vision', 'multimodal')).toEqual([
      { id: 'vision', input: ['text', 'image'] },
    ])
  })

  it('falls back to composition models when the user layer only overrides provider metadata', () => {
    const source = {
      ...view({ gateway: { displayName: 'User gateway', models: [{ id: 'vision' }] } }),
      user: { providers: { gateway: { displayName: 'User gateway' } } },
      base: { providers: { gateway: { models: [{ id: 'vision', compat: { inherited: true } }] } } },
    }
    expect(modelsWithType(source, 'gateway', 0, 'vision', 'text')).toEqual([
      { id: 'vision', compat: { inherited: true }, input: ['text'] },
    ])
  })
})

describe('ModelInputTypesController', () => {
  it('writes the complete models array at the provider path with the described revision', async () => {
    const initial = view({
      gateway: { models: [{ id: 'vision', input: ['text'], compat: { preserved: true } }] },
    }, 4)
    const committed = view({
      gateway: { models: [{ id: 'vision', input: ['text', 'image'], compat: { preserved: true } }] },
    }, 5)
    const describe = vi.fn().mockResolvedValue(described(initial))
    const mutate = vi.fn().mockResolvedValue(ok(committed))
    const controller = new ModelInputTypesController({ settings: { describe, mutate } as never })

    await controller.load()
    await controller.selectModelType('gateway', 0, 'vision', 'multimodal')

    expect(mutate).toHaveBeenCalledWith({
      ns: 'llm-pi-ai',
      ops: [{
        op: 'set',
        path: ['providers', 'gateway', 'models'],
        value: [{ id: 'vision', input: ['text', 'image'], compat: { preserved: true } }],
      }],
      expectedRevision: 4,
    })
    expect(controller.store.getSnapshot()).toMatchObject({
      writable: true,
      saved: true,
      saving: null,
      providers: [{ models: [{ id: 'vision', type: 'multimodal' }] }],
    })
  })

  it('re-reads the winning value after a conflict and surfaces a value-free marker', async () => {
    const initial = view({ gateway: { models: [{ id: 'vision', input: ['text'] }] } }, 1)
    const winner = view({ gateway: { models: [{ id: 'vision' }] } }, 2)
    const describe = vi.fn()
      .mockResolvedValueOnce(described(initial))
      .mockResolvedValueOnce(described(winner))
    const mutate = vi.fn().mockResolvedValue({
      rpcId: 'test',
      result: {
        ok: false as const,
        error: { code: 'settings-conflict', message: 'stale', details: {} },
      },
    })
    const controller = new ModelInputTypesController({ settings: { describe, mutate } as never })

    await controller.load()
    await controller.selectModelType('gateway', 0, 'vision', 'multimodal')

    expect(describe).toHaveBeenCalledTimes(2)
    expect(controller.store.getSnapshot()).toMatchObject({
      writable: true,
      error: { kind: 'conflict' },
      providers: [{ models: [{ id: 'vision', type: 'default' }] }],
    })
  })

  it('does not write a read-only view and fails closed on malformed settings', async () => {
    const readOnlyMutate = vi.fn()
    const readOnly = new ModelInputTypesController({
      settings: {
        describe: () => Promise.resolve(described(view({ gateway: { models: [{ id: 'text' }] } }), false)),
        mutate: readOnlyMutate,
      } as never,
    })
    await readOnly.load()
    await readOnly.selectModelType('gateway', 0, 'text', 'multimodal')
    expect(readOnlyMutate).not.toHaveBeenCalled()

    const malformed = new ModelInputTypesController({
      settings: {
        describe: () => Promise.resolve(described({ ...view({}), value: { providers: [] } })),
        mutate: vi.fn(),
      } as never,
    })
    await malformed.load()
    expect(malformed.store.getSnapshot()).toMatchObject({
      available: false,
      writable: false,
      error: { kind: 'message' },
    })
  })

  it('ignores its own revision invalidation and reloads a newer external one', async () => {
    const describe = vi.fn().mockResolvedValue(described(view({ gateway: { models: [{ id: 'text' }] } }, 3)))
    const controller = new ModelInputTypesController({ settings: { describe, mutate: vi.fn() } as never })
    await controller.load()

    controller.invalidate(3)
    expect(describe).toHaveBeenCalledTimes(1)
    controller.invalidate(4)
    await vi.waitFor(() => { expect(describe).toHaveBeenCalledTimes(2) })
  })
})
