import { describe, expect, it, vi } from 'vitest'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { ToggleController } from '../../src/sub-agent/client/store.ts'

vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore<T extends object>(initial: T) {
    let snapshot = structuredClone(initial)
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      update(mutator: (draft: T) => void) {
        const next = structuredClone(snapshot)
        mutator(next)
        snapshot = next
        for (const listener of listeners) listener()
      },
    }
  },
}))

function rpcWith(...responses: unknown[]): { rpc: ClientConnectionRpc; call: ReturnType<typeof vi.fn> } {
  const call = vi.fn()
  for (const response of responses) call.mockResolvedValueOnce(response)
  return { rpc: { call } as unknown as ClientConnectionRpc, call }
}

const described = (claudeCode: boolean, codex: boolean, revision: number) => ({
  ok: true,
  value: {
    registered: true,
    writable: true,
    value: { claudeCode, codex },
    revision,
  },
})

describe('ToggleController', () => {
  it('writes the selected product path with the last described revision', async () => {
    const { rpc, call } = rpcWith(
      described(false, false, 3),
      { ok: true, value: { kind: 'ok', revision: 4 } },
      described(true, false, 4),
    )
    const controller = new ToggleController(rpc)

    await controller.load()
    await controller.set('claudeCode', true)

    expect(call).toHaveBeenNthCalledWith(2, '/api', 'subagentProducts/set', {
      args: { request: { product: 'claudeCode', enabled: true, expectedRevision: 3 } },
    })
    expect(controller.store.getSnapshot()).toMatchObject({
      claudeCode: true,
      codex: false,
      status: 'ready',
      error: null,
      writable: true,
      revision: 4,
    })
  })

  it('reloads the winner and surfaces a localized conflict marker', async () => {
    const { rpc } = rpcWith(
      described(false, false, 0),
      { ok: true, value: { kind: 'conflict', revision: 1 } },
      described(false, true, 1),
    )
    const controller = new ToggleController(rpc)

    await controller.load()
    await controller.set('claudeCode', true)

    expect(controller.store.getSnapshot()).toMatchObject({
      claudeCode: false,
      codex: true,
      status: 'ready',
      error: { kind: 'conflict' },
      revision: 1,
    })
  })

  it('re-reads after a rejected write before allowing a retry', async () => {
    const { rpc, call } = rpcWith(
      described(false, false, 0),
      { ok: false, error: { message: 'write rejected' } },
      described(false, true, 1),
    )
    const controller = new ToggleController(rpc)

    await controller.load()
    await controller.set('codex', true)

    expect(call).toHaveBeenCalledTimes(3)
    expect(controller.store.getSnapshot()).toMatchObject({
      claudeCode: false,
      codex: true,
      status: 'ready',
      error: { kind: 'message', message: 'write rejected' },
      writable: true,
      revision: 1,
    })
  })

  it('disables stale writes when a refresh fails or returns malformed data', async () => {
    const { rpc } = rpcWith(
      described(false, false, 0),
      { ok: true, value: { registered: true, writable: true, value: { claudeCode: 'yes', codex: false }, revision: 1 } },
    )
    const controller = new ToggleController(rpc)

    await controller.load()
    await controller.load()

    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'error',
      writable: false,
      error: { kind: 'message' },
    })
  })
})
