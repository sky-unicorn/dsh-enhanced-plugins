import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { MemorySettings } from '../sub-agent/memory-settings.ts'
import { Config } from '../../src/mcp-server-manager/host/schema.ts'
import { McpConfigRemote } from '../../src/mcp-server-manager/host/remote.ts'
import { McpConfigStore } from '../../src/mcp-server-manager/client/mcp-config-store.ts'
import { McpCardController } from '../../src/mcp-server-manager/client/mcp-card-controller.ts'

it('preserves another editor\'s committed server through the real DSH settings revision fence', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(MemorySettings)
    ctx.settings.register('mcp', Config, { base: { servers: {} } })
    const remote = new McpConfigRemote(ctx)
    const rpc = {
      async call(_channel: string, method: string, payload: { args: { request?: unknown } }) {
        if (method === 'mcpConfig/describe') return { ok: true, value: remote.describe() }
        if (method === 'mcpConfig/mutate') return { ok: true, value: await remote.mutate(payload.args.request) }
        throw new Error(`Unexpected method: ${method}`)
      },
    } as unknown as ClientConnectionRpc
    const store = new McpConfigStore(rpc)
    await store.refresh()
    const controller = new McpCardController(store)
    const face = controller.inject()
    face.openForm()
    face.editForm('serverName', 'local')
    face.editForm('command', 'local-server')
    face.addServer()
    await ctx.settings.mutate('mcp', [{ op: 'set', path: ['servers', 'external'], value: {
      transport: 'stdio', command: 'external-server', env: { TOKEN: 'fixture-secret' },
    } }])
    await store.refresh()
    await controller['save']()
    expect(face.hooks.mcpCard.getSnapshot()).toMatchObject({ failed: true, saving: false, dirty: true })
    expect(remote.describe().servers).toHaveProperty('external')
    expect(remote.describe().servers).not.toHaveProperty('local')
    expect(JSON.stringify(store.getSnapshot())).not.toContain('fixture-secret')
    // Discarding refreshes the user's starting point; a deliberate new edit succeeds.
    face.discard()
    face.removeServer('external')
    await controller['save']()
    expect(remote.describe().servers).toEqual({})
    expect(face.hooks.mcpCard.getSnapshot()).toMatchObject({ failed: false, saving: false, dirty: false })
    store.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})
