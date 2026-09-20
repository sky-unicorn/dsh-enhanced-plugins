import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../../src/plugin-market/index.ts'

const config: Config = {
  topic: 'dsh-plugin',
  channelUrl: 'https://market.example.test/plugins-cache.json',
  pageSize: 12,
}

function createHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
  const ctx = {
    inject: (_keys: string[], setup: (value: Context) => void) => setup(ctx),
    credentials: { resolve: vi.fn(async () => undefined) },
    webServer: {
      register: vi.fn((entry: { handler: typeof handler }) => {
        handler = entry.handler
        return () => {}
      }),
    },
    effect: (setup: () => () => void) => { setup() },
  } as unknown as Context
  apply(ctx, config)
  if (handler === undefined) throw new Error('market route was not registered')
  return handler
}

async function get(handler: ReturnType<typeof createHandler>, url: string): Promise<{ status: number; value: unknown }> {
  const req = { method: 'GET', url, headers: {} } as IncomingMessage
  let status = 0
  let raw = ''
  const res = {
    writeHead(next: number) { status = next; return this },
    end(value?: string) { raw = value ?? '' },
  } as unknown as ServerResponse
  await handler(req, res)
  return { status, value: JSON.parse(raw) as unknown }
}

describe('catalog filtering', () => {
  const originalDshHome = process.env.DSH_HOME
  let testHome: string

  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'dsh-plugin-market-'))
    process.env.DSH_HOME = testHome
  })

  afterEach(async () => {
    if (originalDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalDshHome
    await rm(testHome, { recursive: true, force: true })
  })

  it('provides a source without reading installed state or probing GitHub/npm', async () => {
    const fetchMock = vi.fn(() => { throw new Error('catalog must not preflight') })
    vi.stubGlobal('fetch', fetchMock)
    const result = await get(createHandler(), '/api/plugin-market/catalog?query=dsh-enhanced-plugins')
    expect(result).toMatchObject({ status: 200, value: { total: 1, plugins: [{
      fullName: 'sky-unicorn/dsh-enhanced-plugins',
      installSpec: 'github:sky-unicorn/dsh-enhanced-plugins',
    }] } })
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('no longer exposes marketplace install, uninstall, preflight or credential endpoints', async () => {
    const handler = createHandler()
    for (const path of ['install', 'uninstall', 'install-plan', 'jobs/old-id', 'config']) {
      for (const method of ['GET', 'POST', 'DELETE']) {
        let status = 0
        await handler({ method, url: `/api/plugin-market/${path}`, headers: {} } as IncomingMessage,
          { writeHead(value: number) { status = value }, end() {} } as unknown as ServerResponse)
        expect(status).toBe(404)
      }
    }
  })

  it('does not display repositories from a legacy unverified user channel', async () => {
    const directory = join(testHome, 'plugins', 'dsh-market')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'plugins-cache.json'), JSON.stringify({
      schemaVersion: 1,
      topic: 'dsh-plugin',
      syncedAt: '2026-08-18T00:00:00.000Z',
      repositories: [{
        name: 'legacy-fake',
        full_name: 'example/legacy-fake',
        description: 'Not a bundle',
        html_url: 'https://github.com/example/legacy-fake',
        stargazers_count: 999,
        updated_at: '2026-08-18T00:00:00.000Z',
        topics: ['dsh-plugin'],
        default_branch: 'main',
        owner: { avatar_url: 'https://github.com/example.png' },
      }],
    }))

    expect(await get(createHandler(), '/api/plugin-market/catalog?query=legacy-fake')).toMatchObject({
      status: 200,
      value: { total: 0, plugins: [] },
    })
  })
})
