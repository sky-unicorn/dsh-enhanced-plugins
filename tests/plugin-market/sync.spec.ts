import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config, type MarketSyncStatus } from '../../src/plugin-market/index.ts'

const config: Config = {
  profile: 'web',
  topic: 'dsh-plugin',
  channelUrl: 'https://market.example.test/plugins-cache.json',
  pageSize: 12,
  operationTimeoutMs: 120000,
  githubTokenEnv: 'GITHUB_TOKEN',
  cliPath: '',
}

function channel() {
  return {
    schemaVersion: 2,
    validation: 'root-dsh-bundle-v1',
    topic: 'dsh-plugin',
    syncedAt: '2026-08-25T00:00:00.000Z',
    repositories: [{
      name: 'real-plugin',
      full_name: 'example/real-plugin',
      description: 'real-plugin description',
      html_url: 'https://github.com/example/real-plugin',
      stargazers_count: 10,
      updated_at: '2026-08-18T00:00:00Z',
      topics: ['dsh-plugin'],
      default_branch: 'main',
      owner: { avatar_url: 'https://github.com/example.png' },
      market: {
        packageName: '@example/real-plugin',
        bundlePatch: './cordis.patch.yml',
        installCommands: [],
      },
    }],
  }
}

function createHandler(onDispose?: (dispose: () => Promise<void>) => void): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
  const ctx = {
    credentials: { resolve: vi.fn(async () => undefined) },
    subprocess: {},
    webServer: {
      register: vi.fn((entry: { handler: typeof handler }) => {
        handler = entry.handler
        return () => {}
      }),
    },
    effect: (setup: () => () => Promise<void>) => { const dispose = setup(); onDispose?.(dispose) },
  } as unknown as Context
  apply(ctx, config)
  if (handler === undefined) throw new Error('market route was not registered')
  return handler
}

async function request(
  handler: ReturnType<typeof createHandler>,
  method: 'GET' | 'POST',
  path: string,
): Promise<{ status: number; value: unknown }> {
  const req = method === 'POST'
    ? Object.assign(Readable.from([Buffer.from('{}')]), {
      method,
      url: `/api/plugin-market/${path}`,
      headers: { 'content-type': 'application/json' },
    }) as IncomingMessage
    : { method, url: `/api/plugin-market/${path}`, headers: {} } as IncomingMessage
  let status = 0
  let raw = ''
  const res = {
    writeHead(next: number) { status = next; return this },
    end(value?: string) { raw = value ?? '' },
  } as unknown as ServerResponse
  await handler(req, res)
  return { status, value: JSON.parse(raw) as unknown }
}

async function waitForSync(handler: ReturnType<typeof createHandler>): Promise<MarketSyncStatus> {
  let sync: MarketSyncStatus = { state: 'idle' }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    sync = (await request(handler, 'GET', 'sync')).value as MarketSyncStatus
    if (sync.state === 'completed' || sync.state === 'failed') return sync
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return sync
}

describe('mirrored channel synchronization', () => {
  const originalDshHome = process.env.DSH_HOME
  let testHome: string

  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'dsh-plugin-market-sync-'))
    process.env.DSH_HOME = testHome
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    if (originalDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalDshHome
    await rm(testHome, { recursive: true, force: true })
  })

  it('downloads one validated snapshot and persists its ETag', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(channel()), {
      status: 200,
      headers: { 'content-type': 'application/json', etag: '"channel-v1"' },
    })))
    const handler = createHandler()

    expect(await request(handler, 'POST', 'sync')).toMatchObject({ status: 202 })
    expect(await waitForSync(handler)).toMatchObject({ state: 'completed', result: { total: 1 } })
    expect(JSON.parse(await readFile(join(testHome, 'plugins', 'dsh-market', 'plugins-cache.json'), 'utf8')))
      .toMatchObject({ repositories: [{ full_name: 'example/real-plugin' }] })
    expect(JSON.parse(await readFile(join(testHome, 'plugins', 'dsh-market', 'channel-metadata.json'), 'utf8')))
      .toMatchObject({ url: config.channelUrl, etag: '"channel-v1"' })
    expect(await request(handler, 'GET', 'catalog')).toMatchObject({
      status: 200,
      value: {
        total: 2,
        plugins: [
          { fullName: 'example/real-plugin' },
          { fullName: 'sky-unicorn/dsh-enhanced-plugins' },
        ],
      },
    })
  })

  it('retries a transient 504 and keeps the last-good snapshot until validation succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 504 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(channel()), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const handler = createHandler()

    expect(await request(handler, 'POST', 'sync')).toMatchObject({ status: 202 })
    expect(await waitForSync(handler)).toMatchObject({ state: 'completed', result: { total: 1 } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses the launcher transport after HTTPS proxy rejection and leaves it open on unload', async () => {
    const proxyNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']
    const previousEnvironment = new Map(proxyNames.map(name => [name, process.env[name]]))
    for (const name of proxyNames) delete process.env[name]
    // DSH keeps the accepted HTTP proxy but clears HTTPS after rejecting its
    // value. Its installed dispatcher, rather than another env parser, owns routing.
    process.env.HTTP_PROXY = 'http://127.0.0.1:1'
    const previousDispatcher = getGlobalDispatcher()
    const transport = new MockAgent()
    transport.disableNetConnect()
    const upstream = transport.get(new URL(config.channelUrl).origin)
    upstream.intercept({ path: '/plugins-cache.json', method: 'GET' }).reply(200, channel())
    upstream.intercept({ path: '/after-dispose', method: 'GET' }).reply(200, 'still open')
    setGlobalDispatcher(transport)
    let dispose: (() => Promise<void>) | undefined
    try {
      const handler = createHandler(cleanup => { dispose = cleanup })

      expect(await request(handler, 'POST', 'sync')).toMatchObject({ status: 202 })
      expect(await waitForSync(handler)).toMatchObject({ state: 'completed' })
      await dispose?.()
      dispose = undefined
      expect(await (await fetch(new URL('/after-dispose', config.channelUrl))).text()).toBe('still open')
      transport.assertNoPendingInterceptors()
    } finally {
      await dispose?.()
      setGlobalDispatcher(previousDispatcher)
      await transport.close()
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})
