import { describe, expect, it, vi } from 'vitest'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { McpConfigStore } from '../../src/mcp-server-manager/client/mcp-config-store.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const view = (revision: number) => ({ ok: true, value: { registered: true, servers: {}, revision } })

describe('MCP config transport ordering', () => {
  it('ignores a stale describe response arriving after a newer refresh', async () => {
    const old = deferred<ReturnType<typeof view>>()
    const call = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(view(2))
    const store = new McpConfigStore({ call } as unknown as ClientConnectionRpc)
    const pending = store.refresh()
    await store.refresh()
    old.resolve(view(1))
    await pending
    expect(store.getSnapshot().revision).toBe(2)
  })

  it('re-reads authority after a rejected write before returning failure', async () => {
    const call = vi.fn().mockResolvedValueOnce(view(1))
      .mockResolvedValueOnce({ ok: false, error: { message: 'write refused' } })
      .mockResolvedValueOnce(view(2))
    const store = new McpConfigStore({ call } as unknown as ClientConnectionRpc)
    await store.refresh()
    expect(await store.mutate([{ op: 'unset', path: ['servers', 'demo'] }], 1)).toBe(false)
    expect(store.getSnapshot().revision).toBe(2)
  })
})
