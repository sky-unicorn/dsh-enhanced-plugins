import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { MarketInstallPlan, MarketInstallPlanJob, MarketMutationJob } from '../../src/plugin-market/contracts.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/plugin-market/index.ts'

const fullName = 'example/dsh-context'
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
    owner: { avatar_url: 'https://github.com/example.png' },
    market: {
      packageName: 'dsh-context',
      bundlePatch: './cordis.patch.yml',
      installCommands: [],
    },
  }
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4999' },
  })
}

function fetchFor(options: { npm?: unknown; rootBundle: boolean; rootScripts?: unknown }) {
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
        ...(options.rootScripts === undefined ? {} : { scripts: options.rootScripts }),
      })
    }
    if (url === 'https://registry.npmjs.org/dsh-context/latest') {
      return options.npm === undefined ? response({}, 404) : response(options.npm)
    }
    throw new Error(`unexpected fetch ${url}`)
  })
}

async function writeChannel(testHome: string): Promise<void> {
  const directory = join(testHome, 'plugins', 'dsh-market')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'plugins-cache.json'), JSON.stringify({
    schemaVersion: 2,
    validation: 'root-dsh-bundle-v1',
    topic: 'dsh-plugin',
    syncedAt: '2026-08-18T00:00:00.000Z',
    repositories: [githubRepository()],
  }))
}

function createSubprocess(
  testHome: string,
  options: { readonly invalidInstall?: boolean; readonly hangUntilAbort?: boolean } = {},
) {
  return {
    spawn: vi.fn((spec: { readonly argv: readonly string[]; readonly signal?: AbortSignal }) => {
      if (options.hangUntilAbort === true) {
        const done = new Promise<{ exitCode: null; signal: 'SIGTERM' }>((resolve) => {
          const finish = (): void => { resolve({ exitCode: null, signal: 'SIGTERM' }) }
          if (spec.signal?.aborted === true) finish()
          else spec.signal?.addEventListener('abort', finish, { once: true })
        })
        return {
          pid: 1,
          stdin: undefined,
          stdout: undefined,
          stderr: undefined,
          collected: {
            stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          },
          done,
          terminate: vi.fn(),
          waitForExit: vi.fn(async () => true),
        }
      }
      const done = (async () => {
        if (spec.signal?.aborted === true) return { exitCode: null, signal: 'SIGTERM' as const }
        const addIndex = spec.argv.indexOf('add')
        const removeIndex = spec.argv.indexOf('remove')
        const profileDirectory = join(testHome, 'profiles', 'web')
        if (addIndex >= 0) {
          const installSpec = spec.argv[addIndex + 1] ?? ''
          const version = installSpec.startsWith('github:') ? installSpec : '2.3.4'
          const packageRoot = join(profileDirectory, 'node_modules', 'dsh-context')
          await mkdir(packageRoot, { recursive: true })
          await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
            name: 'dsh-context',
            dsh: { bundle: { patch: './cordis.patch.yml' } },
          }))
          if (options.invalidInstall !== true) await writeFile(join(packageRoot, 'cordis.patch.yml'), '- insert: []\n')
          await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({
            dependencies: { 'dsh-context': version },
            dsh: { profile: { bundles: ['dsh-context'] } },
          }))
        } else if (removeIndex >= 0) {
          await rm(join(profileDirectory, 'node_modules', 'dsh-context'), { recursive: true, force: true })
          await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({
            dependencies: {},
            dsh: { profile: { bundles: [] } },
          }))
        }
        return { exitCode: 0, signal: null }
      })()
      return {
        pid: 1,
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        collected: {
          stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done,
        terminate: vi.fn(),
        waitForExit: vi.fn(async () => true),
      }
    }),
  }
}

function createHandler(
  testHome: string,
  options: { readonly invalidInstall?: boolean; readonly hangUntilAbort?: boolean } = {},
): {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  subprocess: ReturnType<typeof createSubprocess>
} {
  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
  const subprocess = createSubprocess(testHome, options)
  const ctx = {
    credentials: {
      resolve: vi.fn(async () => undefined),
      describe: vi.fn(async () => ({ configured: false, writable: true })),
    },
    subprocess,
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
    channelUrl: 'https://market.example.test/plugins-cache.json',
    pageSize: 12,
    operationTimeoutMs: 120000,
    githubTokenEnv: 'GITHUB_TOKEN',
    cliPath: '',
  })
  if (handler === undefined) throw new Error('market route was not registered')
  return { handler, subprocess }
}

async function request(
  handler: ReturnType<typeof createHandler>['handler'],
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  value?: unknown,
): Promise<{ status: number; value: unknown }> {
  const hasBody = value !== undefined
  const req = hasBody
    ? Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]), {
      method,
      url: `/api/plugin-market/${path}`,
      headers: { 'content-type': 'application/json' },
    }) as IncomingMessage
    : { method, url: `/api/plugin-market/${path}`, headers: {} } as IncomingMessage
  let status = 0
  let raw = ''
  const res = {
    writeHead(next: number) { status = next; return this },
    end(next?: string) { raw = next ?? '' },
  } as unknown as ServerResponse
  await handler(req, res)
  return { status, value: JSON.parse(raw) as unknown }
}

async function waitForJob(handler: ReturnType<typeof createHandler>['handler'], initial: MarketMutationJob): Promise<MarketMutationJob> {
  let job = initial
  for (let attempt = 0; attempt < 50 && job.state === 'running'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
    job = (await request(handler, 'GET', `jobs/${job.id}`)).value as MarketMutationJob
  }
  return job
}

async function installPlan(handler: ReturnType<typeof createHandler>['handler']): Promise<MarketInstallPlan> {
  const started = await request(handler, 'POST', 'install-plan', { fullName })
  expect(started.status).toBe(202)
  let job = started.value as MarketInstallPlanJob
  for (let attempt = 0; attempt < 50 && job.state === 'running'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
    job = (await request(handler, 'GET', `install-plans/${job.id}`)).value as MarketInstallPlanJob
  }
  if (job.state !== 'completed') throw new Error(job.state === 'failed' ? job.message : 'plan did not complete')
  return job.plan
}

describe('capability-aware background installation', () => {
  const originalDshHome = process.env.DSH_HOME
  let testHome: string

  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'dsh-plugin-market-install-'))
    process.env.DSH_HOME = testHome
    await writeChannel(testHome)
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

  it('offers and completes one-click install only for a verified npm bundle', async () => {
    vi.stubGlobal('fetch', fetchFor({
      rootBundle: true,
      npm: {
        name: 'dsh-context',
        version: '2.3.4',
        repository: { type: 'git', url: `git+https://github.com/${fullName}.git` },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        dist: { integrity: 'sha512-example' },
      },
    }))
    const { handler, subprocess } = createHandler(testHome)
    const plan = await installPlan(handler)
    expect(plan).toMatchObject({ kind: 'npm', packageName: 'dsh-context', version: '2.3.4', integrity: 'sha512-example' })

    const started = await request(handler, 'POST', 'install', { fullName, planKind: 'npm', expectedRef: '2.3.4' })
    expect(started).toMatchObject({ status: 202, value: { state: 'running', operation: 'install' } })
    const completed = await waitForJob(handler, started.value as MarketMutationJob)
    expect(completed).toMatchObject({ state: 'completed', result: { source: 'npm', packageName: 'dsh-context' } })
    expect(subprocess.spawn.mock.calls[0]?.[0].argv).toEqual(expect.arrayContaining(['add', 'dsh-context@2.3.4']))
    expect(await installEntries()).toEqual([expect.objectContaining({ fullName, source: 'npm' })])
  })

  it('requires a second explicit action for a safe pinned-source plan', async () => {
    vi.stubGlobal('fetch', fetchFor({ rootBundle: true }))
    const { handler } = createHandler(testHome)
    const plan = await installPlan(handler)
    expect(plan).toMatchObject({ kind: 'github', commit: sha, requiresConfirmation: true })

    const started = await request(handler, 'POST', 'install', {
      fullName,
      planKind: 'github',
      expectedRef: sha,
      confirmSource: true,
    })
    const completed = await waitForJob(handler, started.value as MarketMutationJob)
    expect(completed).toMatchObject({ state: 'completed', result: { source: 'github' } })
  })

  it('downgrades build-script and unverifiable repositories to manual instructions', async () => {
    vi.stubGlobal('fetch', fetchFor({ rootBundle: true, rootScripts: { prepare: 'npm run build' } }))
    let handler = createHandler(testHome).handler
    expect(await installPlan(handler)).toMatchObject({ kind: 'manual', reason: 'requires-build-approval' })

    vi.stubGlobal('fetch', fetchFor({ rootBundle: false }))
    handler = createHandler(testHome).handler
    expect(await installPlan(handler)).toMatchObject({ kind: 'manual', reason: 'no-automatic-source' })
  })

  it('runs uninstall as a background task and removes its market record after verification', async () => {
    const profileDirectory = join(testHome, 'profiles', 'web')
    const recordDirectory = join(testHome, 'plugins', 'dsh-market')
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-context': '2.3.4' },
      dsh: { profile: { bundles: ['dsh-context'] } },
    }))
    await writeFile(join(recordDirectory, 'installed-plugins.json'), JSON.stringify({
      schemaVersion: 1,
      entries: [{ profile: 'web', fullName, packageName: 'dsh-context', source: 'npm', installedAt: '2026-08-18T00:00:00.000Z' }],
    }))
    const { handler } = createHandler(testHome)
    const started = await request(handler, 'POST', 'uninstall', { packageName: 'dsh-context' })
    expect(started.status).toBe(202)
    expect(await waitForJob(handler, started.value as MarketMutationJob)).toMatchObject({ state: 'completed' })
    expect(await installEntries()).toEqual([])
  })

  it('rolls back a package that fails post-install bundle validation', async () => {
    vi.stubGlobal('fetch', fetchFor({
      rootBundle: true,
      npm: {
        name: 'dsh-context',
        version: '2.3.4',
        repository: `https://github.com/${fullName}.git`,
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        dist: { integrity: 'sha512-example' },
      },
    }))
    const { handler, subprocess } = createHandler(testHome, { invalidInstall: true })
    const started = await request(handler, 'POST', 'install', {
      fullName,
      planKind: 'npm',
      expectedRef: '2.3.4',
    })
    expect(await waitForJob(handler, started.value as MarketMutationJob)).toMatchObject({
      state: 'failed',
      message: expect.stringContaining('bundle patch'),
    })
    expect(subprocess.spawn).toHaveBeenCalledTimes(2)
    const profile = JSON.parse(await readFile(join(testHome, 'profiles', 'web', 'package.json'), 'utf8')) as {
      readonly dependencies: Record<string, string>
    }
    expect(profile.dependencies).toEqual({})
    await expect(readFile(join(testHome, 'plugins', 'dsh-market', 'installed-plugins.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cancels a running managed process through the background job endpoint', async () => {
    vi.stubGlobal('fetch', fetchFor({
      rootBundle: true,
      npm: {
        name: 'dsh-context',
        version: '2.3.4',
        repository: `https://github.com/${fullName}.git`,
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        dist: { integrity: 'sha512-example' },
      },
    }))
    const { handler, subprocess } = createHandler(testHome, { hangUntilAbort: true })
    const started = await request(handler, 'POST', 'install', {
      fullName,
      planKind: 'npm',
      expectedRef: '2.3.4',
    })
    const running = started.value as MarketMutationJob
    await vi.waitFor(() => { expect(subprocess.spawn).toHaveBeenCalledTimes(1) })
    expect(await request(handler, 'DELETE', `jobs/${running.id}`)).toMatchObject({ status: 202 })
    expect(await waitForJob(handler, running)).toMatchObject({ state: 'cancelled' })
  })

  it('refuses to uninstall the marketplace itself', async () => {
    const { handler, subprocess } = createHandler(testHome)
    expect(await request(handler, 'POST', 'uninstall', { packageName: 'dsh-enhanced-plugins' })).toMatchObject({
      status: 400,
      value: { error: { code: 'INVALID_PACKAGE' } },
    })
    expect(subprocess.spawn).not.toHaveBeenCalled()
  })
})
