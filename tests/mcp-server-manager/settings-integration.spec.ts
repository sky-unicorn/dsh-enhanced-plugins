import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { MemorySettings } from '../sub-agent/memory-settings.ts'
import { Config } from '../../src/mcp-server-manager/host/schema.ts'
import { McpConfigRemote } from '../../src/mcp-server-manager/host/remote.ts'
import { McpConfigStore } from '../../src/mcp-server-manager/client/mcp-config-store.ts'
import { McpCardController } from '../../src/mcp-server-manager/client/mcp-card-controller.ts'

it('edits and renames an existing server while preserving untouched Host secrets', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(MemorySettings, { document: { mcp: { servers: {
      demo: {
        transport: 'stdio', command: 'npx', args: ['old'],
        env: { TOKEN: 'fixture-secret', OLD: 'remove-me' },
      },
    } } } })
    ctx.settings.register('mcp', Config, { base: { servers: {} } })
    const remote = new McpConfigRemote(ctx)
    const writes: unknown[] = []
    const rpc = {
      async call(_channel: string, method: string, payload: { args: { request?: unknown } }) {
        if (method === 'mcpConfig/describe') return { ok: true, value: remote.describe() }
        if (method === 'mcpConfig/mutate') {
          writes.push(payload.args.request)
          return { ok: true, value: await remote.mutate(payload.args.request) }
        }
        throw new Error(`Unexpected method: ${method}`)
      },
    } as unknown as ClientConnectionRpc
    const store = new McpConfigStore(rpc)
    await store.refresh()
    const controller = new McpCardController(store)
    const face = controller.inject()
    face.editServer('demo')
    expect(face.hooks.mcpCard.getSnapshot().form?.env).toEqual([
      { key: 'TOKEN', value: '••••' }, { key: 'OLD', value: '••••' },
    ])
    face.editForm('serverName', 'renamed')
    face.editForm('command', 'node')
    face.editForm('toolCallTimeoutMs', '90000')
    face.removeListRow('env', 1)
    face.appendListRow('env')
    face.editListRow('env', 1, 'key', 'NEW')
    face.editListRow('env', 1, 'value', 'new-secret')
    expect(face.hooks.mcpCard.getSnapshot().formInvalid).toBe(false)
    face.addServer()
    expect(face.hooks.mcpCard.getSnapshot().servers.map(server => server.serverName)).toEqual(['renamed'])
    await controller['save']()
    expect(face.hooks.mcpCard.getSnapshot()).toMatchObject({ dirty: false, failed: false })
    const value = ctx.settings.get('mcp') as { servers: Record<string, { command: string; env: Record<string, string>; toolCallTimeoutMs: number }> }
    expect(value.servers['demo']).toBeUndefined()
    expect(value.servers['renamed']).toMatchObject({
      command: 'node', toolCallTimeoutMs: 90_000,
      env: { TOKEN: 'fixture-secret', NEW: 'new-secret' },
    })
    expect(JSON.stringify(writes)).not.toContain('fixture-secret')
    expect(JSON.stringify(writes)).not.toContain('remove-me')
    expect(JSON.stringify(store.getSnapshot())).not.toContain('fixture-secret')
    store.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('replaces only the chosen HTTP secret and switches transport without copying old headers', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(MemorySettings, { document: { mcp: { servers: {
      web: { transport: 'streamable-http', url: 'https://old.test/mcp', headers: {
        Authorization: 'Bearer retained', 'X-Token': 'old-secret',
      } },
    } } } })
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
    face.editServer('web')
    face.editForm('url', 'https://new.test/mcp')
    face.editListRow('headers', 1, 'value', 'replacement')
    face.addServer()
    await controller['save']()
    expect((ctx.settings.get('mcp') as { servers: Record<string, { headers: Record<string, string> }> }).servers['web']?.headers)
      .toEqual({ Authorization: 'Bearer retained', 'X-Token': 'replacement' })
    face.editServer('web')
    face.editForm('transport', 'stdio')
    face.editForm('command', 'node')
    face.addServer()
    await controller['save']()
    const switched = (ctx.settings.get('mcp') as { servers: Record<string, Record<string, unknown>> }).servers['web']
    expect(switched).toMatchObject({ transport: 'stdio', command: 'node', env: {} })
    expect(switched).not.toHaveProperty('headers')
    store.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('rejects renaming an inherited composition server before writing a duplicate', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(MemorySettings)
    ctx.settings.register('mcp', Config, { base: { servers: {
      inherited: {
        transport: 'stdio', command: 'npx', args: [], env: { TOKEN: 'base-secret' },
        cwd: '', toolCallTimeoutMs: 60_000,
      },
    } } })
    const remote = new McpConfigRemote(ctx)
    await expect(remote.mutate({
      expectedRevision: 0,
      ops: [{ op: 'edit', path: ['servers', 'inherited'], nextName: 'renamed', changes: [] }],
    })).rejects.toThrow('inherited server')
    expect(Object.keys((ctx.settings.get('mcp') as { servers: Record<string, unknown> }).servers)).toEqual(['inherited'])
  } finally {
    await ctx.fiber.dispose()
  }
})

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
