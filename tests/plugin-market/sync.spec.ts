import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config, type MarketSyncStatus } from '../../src/plugin-market/index.ts'

const config: Config = {
  profile: 'web',
  topic: 'dsh-plugin',
  pageSize: 12,
  operationTimeoutMs: 120000,
  githubTokenEnv: 'GITHUB_TOKEN',
  cliPath: '',
}

function repository(fullName: string) {
  const [owner, name] = fullName.split('/') as [string, string]
  return {
    name,
    full_name: fullName,
    description: `${name} description`,
    html_url: `https://github.com/${fullName}`,
    stargazers_count: name === 'real-plugin' ? 10 : 100,
    updated_at: '2026-08-18T00:00:00Z',
    topics: ['dsh-plugin'],
    default_branch: 'main',
    owner: { avatar_url: `https://github.com/${owner}.png` },
  }
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4999' },
  })
}

function createHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
  const ctx = {
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

describe('verified channel synchronization', () => {
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

  it('writes only repositories whose root manifest declares dsh.bundle.patch', async () => {
    const real = repository('example/real-plugin')
    const topicOnly = repository('example/topic-only')
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith('https://api.github.com/search/repositories?')) {
        return response({ total_count: 2, incomplete_results: false, items: [topicOnly, real] })
      }
      if (url === 'https://raw.githubusercontent.com/example/real-plugin/main/package.json') {
        return response({ name: '@example/real-plugin', dsh: { bundle: { patch: './cordis.patch.yml' } } })
      }
      if (url === 'https://raw.githubusercontent.com/example/topic-only/main/package.json') {
        return response({ name: 'topic-only', keywords: ['dsh-plugin'] })
      }
      throw new Error(`unexpected fetch ${url}`)
    }))
    const handler = createHandler()

    expect(await request(handler, 'POST', 'sync')).toMatchObject({ status: 202 })
    let sync: MarketSyncStatus = { state: 'idle' }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      sync = (await request(handler, 'GET', 'sync')).value as MarketSyncStatus
      if (sync.state === 'completed' || sync.state === 'failed') break
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    expect(sync).toMatchObject({ state: 'completed', result: { total: 1 } })
    const raw = await readFile(join(testHome, 'plugins', 'dsh-market', 'plugins-cache.json'), 'utf8')
    expect(JSON.parse(raw)).toMatchObject({
      schemaVersion: 2,
      validation: 'root-dsh-bundle-v1',
      repositories: [{
        full_name: 'example/real-plugin',
        market: {
          packageName: '@example/real-plugin',
          bundlePatch: './cordis.patch.yml',
        },
      }],
    })
    expect(await request(handler, 'GET', 'catalog')).toMatchObject({
      status: 200,
      value: { total: 1, plugins: [{ fullName: 'example/real-plugin' }] },
    })
  })
})
