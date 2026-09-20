import type { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { McpServerManager } from '../../src/mcp-server-manager/host/manager.ts'
import type { Config, ServerDefinition } from '../../src/mcp-server-manager/host/schema.ts'

function config(command: string): Config {
  const server: ServerDefinition = {
    transport: 'stdio', command, args: [], env: {}, cwd: '', toolCallTimeoutMs: 60_000,
  }
  return { servers: { demo: server } }
}

async function settle(): Promise<void> {
  for (let step = 0; step < 8; step += 1) await Promise.resolve()
}

it('disposes a changed server before mounting its replacement under the same name', async () => {
  const events: string[] = []
  let release!: () => void
  const firstDispose = new Promise<void>(resolve => { release = resolve })
  let mounts = 0
  const ctx = {
    logger: { error: () => { throw new Error('unexpected manager error') } },
    plugin(_plugin: unknown, value: { command: string }) {
      mounts += 1
      events.push(`start:${value.command}`)
      return {
        dispose: async () => {
          events.push(`dispose:${value.command}`)
          if (mounts === 1) await firstDispose
        },
      }
    },
  } as unknown as Context
  const manager = new McpServerManager(ctx)
  manager.reconcile(config('old'))
  await settle()
  manager.reconcile(config('new'))
  await settle()
  expect(events).toEqual(['start:old', 'dispose:old'])
  manager.reconcile(config('latest'))
  release()
  await settle()
  expect(events).toEqual(['start:old', 'dispose:old', 'start:latest'])
  await manager.dispose()
  expect(events.at(-1)).toBe('dispose:latest')
})
