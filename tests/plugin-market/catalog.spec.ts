import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../../src/plugin-market/index.ts'

const config: Config = {
  profile: 'web',
  topic: 'dsh-plugin',
  pageSize: 12,
  operationTimeoutMs: 120000,
  githubTokenEnv: 'GITHUB_TOKEN',
  cliPath: '',
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

  async function writeInstallRecord(fullName: string, packageName: string): Promise<void> {
    const directory = join(testHome, 'plugins', 'dsh-market')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'installed-plugins.json'), JSON.stringify({
      schemaVersion: 1,
      entries: [{ profile: 'web', fullName, packageName, source: 'npm', installedAt: '2026-08-18T00:00:00.000Z' }],
    }))
  }

  it('filters marketplace-installed entries before pagination', async () => {
    const packageName = 'dsh-deepresearch'
    const packageRoot = join(testHome, 'profiles', 'web', 'node_modules', packageName)
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(testHome, 'profiles', 'web', 'package.json'), JSON.stringify({
      dependencies: { [packageName]: '1.0.0' },
    }))
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: packageName,
      repository: 'https://github.com/havingautism/dsh-deepresearch.git',
    }))
    await writeInstallRecord('havingautism/dsh-deepresearch', packageName)

    const response = await get(createHandler(), '/api/plugin-market/catalog?filter=installed&page=1&pageSize=1')

    expect(response).toMatchObject({
      status: 200,
      value: {
        total: 1,
        totalPages: 1,
        plugins: [{ packageName, installed: true }],
      },
    })
  })

  it('does not include a profile dependency that was installed outside the marketplace', async () => {
    const packageName = 'dsh-deepresearch'
    const packageRoot = join(testHome, 'profiles', 'web', 'node_modules', packageName)
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(testHome, 'profiles', 'web', 'package.json'), JSON.stringify({
      dependencies: { [packageName]: '1.0.0' },
    }))
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: packageName,
      repository: 'https://github.com/havingautism/dsh-deepresearch.git',
    }))

    expect(await get(createHandler(), '/api/plugin-market/catalog?filter=installed')).toMatchObject({
      status: 200,
      value: { total: 0, plugins: [] },
    })
  })

  it('uses the recorded repository identity when catalog entries share one package name', async () => {
    const packageName = 'dsh-plugin-market'
    const packageRoot = join(testHome, 'profiles', 'web', 'node_modules', packageName)
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(testHome, 'profiles', 'web', 'package.json'), JSON.stringify({
      dependencies: { [packageName]: 'link:../../../../dsh-plugin-market' },
    }))
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: packageName }))
    await writeInstallRecord('TheYoungChen/dsh-plugin-market', packageName)

    expect(await get(createHandler(), '/api/plugin-market/catalog?filter=installed')).toMatchObject({
      status: 200,
      value: {
        total: 1,
        plugins: [{ fullName: 'TheYoungChen/dsh-plugin-market', packageName, installed: true }],
      },
    })
  })

  it('rejects unknown catalog filters', async () => {
    expect(await get(createHandler(), '/api/plugin-market/catalog?filter=unknown')).toMatchObject({
      status: 400,
      value: { error: { code: 'INVALID_FILTER' } },
    })
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
