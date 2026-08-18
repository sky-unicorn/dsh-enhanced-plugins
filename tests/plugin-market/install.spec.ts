import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn((_command: string, _args: readonly string[]) => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  queueMicrotask(() => { child.emit('close', 0) })
  return child
})

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

const { apply } = await import('../../src/plugin-market/index.ts')

const fullName = 'bowenliang123/dsh-context'
const sha = '0123456789abcdef0123456789abcdef01234567'

function githubRepository() {
  return {
    name: 'dsh-context',
    full_name: fullName,
    description: 'Context insight panel',
    html_url: `https://github.com/${fullName}`,
    stargazers_count: 42,
    updated_at: '2026-08-15T17:34:05Z',
    topics: ['dsh-plugin'],
    default_branch: 'main',
    owner: { avatar_url: 'https://github.com/bowenliang123.png' },
  }
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4999' },
  })
}

function fetchFor(options: { npm?: unknown; rootBundle: boolean }) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url === `https://api.github.com/repos/${fullName}`) return response(githubRepository())
    if (url.endsWith('/commits/main')) return response({ sha })
    if (url === `https://raw.githubusercontent.com/${fullName}/${sha}/package.json`) {
      return response({
        name: 'dsh-context',
        version: '1.0.0',
        repository: `https://github.com/${fullName}.git`,
        ...(options.rootBundle ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}),
      })
    }
    if (url === 'https://registry.npmjs.org/dsh-context/latest') {
      return options.npm === undefined ? response({}, 404) : response(options.npm)
    }
    throw new Error(`unexpected fetch ${url}`)
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
  apply(ctx, {
    profile: 'web',
    topic: 'dsh-plugin',
    pageSize: 12,
    operationTimeoutMs: 120000,
    githubTokenEnv: 'GITHUB_TOKEN',
    cliPath: '',
  })
  if (handler === undefined) throw new Error('market route was not registered')
  return handler
}

async function post(path: string, value: unknown): Promise<{ status: number; value: unknown }> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]), {
    method: 'POST',
    url: `/api/plugin-market/${path}`,
    headers: { 'content-type': 'application/json' },
  }) as IncomingMessage
  let status = 0
  let raw = ''
  const res = {
    writeHead(next: number) { status = next; return this },
    end(value?: string) { raw = value ?? '' },
  } as unknown as ServerResponse
  await createHandler()(req, res)
  return { status, value: JSON.parse(raw) as unknown }
}

async function install(): Promise<{ status: number; value: unknown }> {
  return await post('install', { fullName })
}

describe('automatic install source selection', () => {
  const originalDshHome = process.env.DSH_HOME
  let testHome: string

  beforeEach(async () => {
    spawnMock.mockClear()
    testHome = await mkdtemp(join(tmpdir(), 'dsh-plugin-market-install-'))
    process.env.DSH_HOME = testHome
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    if (originalDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalDshHome
    await rm(testHome, { recursive: true, force: true })
  })

  async function installEntries(): Promise<readonly Record<string, unknown>[]> {
    const raw = await readFile(join(testHome, 'plugins', 'dsh-market', 'installed-plugins.json'), 'utf8')
    return (JSON.parse(raw) as { readonly entries: readonly Record<string, unknown>[] }).entries
  }

  it('prefers a verified npm bundle and pins its version', async () => {
    vi.stubGlobal('fetch', fetchFor({
      rootBundle: true,
      npm: {
        name: 'dsh-context',
        version: '2.3.4',
        repository: { type: 'git', url: `git+https://github.com/${fullName}.git` },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
    }))
    expect(await install()).toMatchObject({ status: 200, value: { source: 'npm', packageName: 'dsh-context' } })
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['add', 'dsh-context@2.3.4']))
    expect(await installEntries()).toEqual([expect.objectContaining({
      profile: 'web',
      fullName,
      packageName: 'dsh-context',
      source: 'npm',
    })])
  })

  it('falls back to a pinned GitHub commit when npm has no matching bundle', async () => {
    vi.stubGlobal('fetch', fetchFor({ rootBundle: true }))
    expect(await install()).toMatchObject({ status: 200, value: { source: 'github', packageName: 'dsh-context' } })
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['add', `github:${fullName}#${sha}`]))
    expect(await installEntries()).toEqual([expect.objectContaining({
      profile: 'web',
      fullName,
      packageName: 'dsh-context',
      source: 'github',
    })])
  })

  it('refuses unrelated npm packages and non-root local-only bundles', async () => {
    vi.stubGlobal('fetch', fetchFor({
      rootBundle: false,
      npm: {
        name: 'dsh-context',
        version: '2.3.4',
        repository: 'https://github.com/other/project.git',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
    }))
    expect(await install()).toMatchObject({
      status: 400,
      value: { error: { code: 'NO_AUTOMATIC_INSTALL_SOURCE' } },
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('refuses npm packages whose dsh bundle has no patch declaration', async () => {
    vi.stubGlobal('fetch', fetchFor({
      rootBundle: false,
      npm: {
        name: 'dsh-context',
        version: '2.3.4',
        repository: `https://github.com/${fullName}.git`,
        dsh: { bundle: {} },
      },
    }))
    expect(await install()).toMatchObject({
      status: 400,
      value: { error: { code: 'NO_AUTOMATIC_INSTALL_SOURCE' } },
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('removes the marketplace record after a successful uninstall', async () => {
    const profileDirectory = join(testHome, 'profiles', 'web')
    const recordDirectory = join(testHome, 'plugins', 'dsh-market')
    await mkdir(profileDirectory, { recursive: true })
    await mkdir(recordDirectory, { recursive: true })
    await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-context': '2.3.4' },
    }))
    await writeFile(join(recordDirectory, 'installed-plugins.json'), JSON.stringify({
      schemaVersion: 1,
      entries: [{
        profile: 'web',
        fullName,
        packageName: 'dsh-context',
        source: 'npm',
        installedAt: '2026-08-18T00:00:00.000Z',
      }],
    }))

    expect(await post('uninstall', { packageName: 'dsh-context' })).toMatchObject({
      status: 200,
      value: { packageName: 'dsh-context' },
    })
    expect(await installEntries()).toEqual([])
  })

  it('refuses to uninstall the merged bundle from its own marketplace', async () => {
    expect(await post('uninstall', { packageName: 'dsh-enhanced-plugins' })).toMatchObject({
      status: 400,
      value: { error: { code: 'INVALID_PACKAGE' } },
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
