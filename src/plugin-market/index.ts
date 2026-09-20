/** Host half of the DeepSeek Harness plugin marketplace. */

import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {
  MarketCatalog,
  MarketErrorBody,
  MarketPlugin,
  MarketSyncResult,
  MarketSyncStatus,
} from './contracts.js'
import {
  compareByStars,
  dshBundleEvidence,
} from './market-utils.js'

export interface Config {
  topic: string
  channelUrl: string
  pageSize: number
}

export const Config: Schema<Config> = Schema.object({
  topic: Schema.string().default('dsh-plugin'),
  channelUrl: Schema.string().pattern(/^https:\/\//).default(
    'https://raw.githubusercontent.com/sky-unicorn/dsh-enhanced-plugins/market-index/plugins-cache.json',
  ),
  pageSize: Schema.number().min(1).max(30).default(12),
})

export const name = 'plugin-market'
export const inject: string[] = []

interface GitHubRepository {
  readonly name: string
  readonly full_name: string
  readonly description: string | null
  readonly html_url: string
  readonly stargazers_count: number
  readonly updated_at: string
  readonly pushed_at?: string
  readonly topics: readonly string[]
  readonly default_branch: string
  readonly owner: { readonly avatar_url: string }
  readonly market?: {
    readonly type?: string
    readonly packageName?: string
    readonly bundlePatch?: string
    readonly installCommands: readonly string[]
  }
}

interface ChannelDocument {
  readonly schemaVersion: 2
  readonly validation: 'root-dsh-bundle-v1'
  readonly topic: string
  readonly syncedAt: string
  readonly repositories: readonly GitHubRepository[]
}

type SyncProgressEvent = { readonly kind: 'channel'; readonly total: number }

const CHANNEL_VALIDATION = 'root-dsh-bundle-v1' as const
const MAX_CHANNEL_BYTES = 16 * 1024 * 1024
const MAX_UPSTREAM_RESPONSE_BYTES = 20 * 1024 * 1024
const INDEX_STALE_AFTER_MS = 24 * 60 * 60 * 1000
const RETRYABLE_HTTP_STATUS = new Set([429, 502, 503, 504])
const MARKET_REPOSITORY: GitHubRepository = {
  name: 'dsh-enhanced-plugins',
  full_name: 'sky-unicorn/dsh-enhanced-plugins',
  description: 'Aggregate and selective DeepSeek Harness enhancements, including the plugin community.',
  html_url: 'https://github.com/sky-unicorn/dsh-enhanced-plugins',
  stargazers_count: 3,
  updated_at: '2026-08-25T05:44:09.000Z',
  topics: ['deepseek', 'deepseek-harness', 'dsh', 'dsh-plugin', 'dsh-plugins'],
  default_branch: 'master',
  owner: { avatar_url: 'https://github.com/sky-unicorn.png' },
  market: {
    packageName: 'dsh-enhanced-plugins',
    bundlePatch: './cordis.patch.yml',
    installCommands: [],
  },
}

interface ChannelMetadata {
  readonly schemaVersion: 1
  readonly url: string
  readonly etag: string
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

function isRepositoryFullName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function upstreamFailureMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined
  const causeCode = cause === undefined ? undefined : (cause as NodeJS.ErrnoException).code
  if (name === 'TimeoutError' || causeCode === 'UND_ERR_CONNECT_TIMEOUT' || causeCode === 'UND_ERR_HEADERS_TIMEOUT') {
    return '连接上游服务超时；请检查网络以及 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY 与 NO_PROXY 设置。'
  }
  return '无法连接上游服务；请检查网络以及 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY 与 NO_PROXY 设置。'
}

async function fetchWithRetry(
  url: string,
  init: Omit<RequestInit, 'signal'>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (signal?.aborted === true) throw signal.reason
    try {
      const requestSignal = signal === undefined
        ? AbortSignal.timeout(timeoutMs)
        : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      const requestInit: RequestInit = {
        ...init,
        signal: requestSignal,
      }
      const response = await fetch(url, requestInit)
      const rateLimited = response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0'
      if ((!RETRYABLE_HTTP_STATUS.has(response.status) && !rateLimited) || attempt === 3) {
        if (response.status === 204 || response.status === 304) return response
        const payload = await response.arrayBuffer()
        if (payload.byteLength > MAX_UPSTREAM_RESPONSE_BYTES) {
          throw new HttpError(502, 'UPSTREAM_RESPONSE_TOO_LARGE', '上游响应超过允许大小。')
        }
        return new Response(payload, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
      const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10)
      const resetAt = Number.parseInt(response.headers.get('x-ratelimit-reset') ?? '', 10) * 1000
      const delayMs = Number.isFinite(retryAfter)
        ? Math.min(15_000, retryAfter * 1000)
        : Number.isFinite(resetAt)
          ? Math.min(15_000, Math.max(250, resetAt - Date.now() + 500))
        : 250 * (2 ** attempt) + Math.floor(Math.random() * 150)
      await response.body?.cancel()
      await abortableDelay(delayMs, signal)
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof HttpError) throw error
      lastError = error
      if (attempt === 3) break
      await abortableDelay(250 * (2 ** attempt) + Math.floor(Math.random() * 150), signal)
    }
  }
  throw new HttpError(502, 'UPSTREAM_UNAVAILABLE', upstreamFailureMessage(lastError))
}

function marketDirectory(): string {
  return join(dshHome(), 'plugins', 'dsh-market')
}

function channelPath(): string {
  return join(marketDirectory(), 'plugins-cache.json')
}

function channelMetadataPath(): string {
  return join(marketDirectory(), 'channel-metadata.json')
}

function parseChannel(raw: string, config: Config): ChannelDocument {
  const parsed = JSON.parse(raw) as Partial<ChannelDocument>
  if (parsed.schemaVersion !== 2 || parsed.validation !== CHANNEL_VALIDATION) {
    throw new HttpError(500, 'UNVERIFIED_CHANNEL', '插件渠道尚未经过 dsh.bundle 校验，请重新同步。')
  }
  if (parsed.topic !== config.topic
    || typeof parsed.syncedAt !== 'string'
    || !Number.isFinite(Date.parse(parsed.syncedAt))
    || !Array.isArray(parsed.repositories)) {
    throw new HttpError(500, 'INVALID_CHANNEL', '本地插件渠道 JSON 无效，请重新同步。')
  }
  if (parsed.repositories.some(repo => !isRepositoryFullName(repo?.full_name) || dshBundleEvidence({
    name: repo.market?.packageName,
    dsh: { bundle: { patch: repo.market?.bundlePatch } },
  }) === undefined)) {
    throw new HttpError(500, 'INVALID_CHANNEL', '插件渠道包含未经验证的仓库，请重新同步。')
  }
  return parsed as ChannelDocument
}

/** Keep this marketplace's own verified bundle discoverable when a mirror snapshot predates it. */
function withMarketRepository(channel: ChannelDocument, config: Config): ChannelDocument {
  if (!MARKET_REPOSITORY.topics.includes(config.topic)
    || channel.repositories.some(repo => repo.full_name.toLocaleLowerCase()
      === MARKET_REPOSITORY.full_name.toLocaleLowerCase())) {
    return channel
  }
  return { ...channel, repositories: [...channel.repositories, MARKET_REPOSITORY] }
}

async function readChannel(config: Config): Promise<ChannelDocument> {
  try {
    return parseChannel(await readFile(channelPath(), 'utf8'), config)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT'
      || error instanceof HttpError
      || error instanceof SyntaxError) {
      return parseChannel(await readFile(new URL('../../assets/plugins-cache.json', import.meta.url), 'utf8'), config)
    }
    throw error
  }
}

async function writeChannel(document: ChannelDocument): Promise<void> {
  const filename = channelPath()
  await mkdir(marketDirectory(), { recursive: true })
  const temporary = `${filename}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  await rename(temporary, filename)
}

async function readChannelMetadata(config: Config): Promise<ChannelMetadata | undefined> {
  try {
    await access(channelPath())
    const value = JSON.parse(await readFile(channelMetadataPath(), 'utf8')) as Partial<ChannelMetadata>
    if (value.schemaVersion !== 1 || value.url !== config.channelUrl || typeof value.etag !== 'string') return undefined
    return value as ChannelMetadata
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

async function writeChannelMetadata(value: ChannelMetadata): Promise<void> {
  const filename = channelMetadataPath()
  await mkdir(marketDirectory(), { recursive: true })
  const temporary = `${filename}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, filename)
}

async function syncChannel(
  config: Config,
  report: (event: SyncProgressEvent) => void,
  signal?: AbortSignal,
): Promise<MarketSyncResult> {
  const metadata = await readChannelMetadata(config)
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'dsh-enhanced-plugins',
    ...(metadata === undefined ? {} : { 'if-none-match': metadata.etag }),
  }
  const response = await fetchWithRetry(config.channelUrl, { headers }, 30_000, signal)
  if (response.status === 304) {
    const channel = await readChannel(config)
    report({ kind: 'channel', total: channel.repositories.length })
    return {
      total: channel.repositories.length,
      syncedAt: channel.syncedAt,
      rateLimitRemaining: null,
      unchanged: true,
    }
  }
  if (!response.ok) {
    throw new HttpError(502, 'CHANNEL_UNAVAILABLE', `插件渠道镜像返回 ${response.status}；已保留上次可用快照。`)
  }
  const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(contentLength) && contentLength > MAX_CHANNEL_BYTES) {
    throw new HttpError(502, 'CHANNEL_TOO_LARGE', '插件渠道镜像超过允许大小；已保留上次可用快照。')
  }
  const raw = await response.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_CHANNEL_BYTES) {
    throw new HttpError(502, 'CHANNEL_TOO_LARGE', '插件渠道镜像超过允许大小；已保留上次可用快照。')
  }
  const channel = parseChannel(raw, config)
  report({ kind: 'channel', total: channel.repositories.length })
  await writeChannel(channel)
  const etag = response.headers.get('etag')
  if (etag !== null) await writeChannelMetadata({ schemaVersion: 1, url: config.channelUrl, etag })
  return { total: channel.repositories.length, syncedAt: channel.syncedAt, rateLimitRemaining: null }
}

/** Project the channel only; installed state and installation decisions belong to DSH. */
function discover(channel: ChannelDocument, page: number, pageSize: number, query: string): MarketCatalog {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const repositories = channel.repositories.filter(repo => [
    repo.full_name, repo.market?.packageName ?? '', repo.description ?? '', ...repo.topics,
  ].some(value => value.toLocaleLowerCase().includes(normalizedQuery)))
    .sort((left, right) => compareByStars(
      { fullName: left.full_name, stars: left.stargazers_count, updatedAt: left.updated_at },
      { fullName: right.full_name, stars: right.stargazers_count, updatedAt: right.updated_at },
    ))
  const start = (page - 1) * pageSize
  const plugins: MarketPlugin[] = repositories.slice(start, start + pageSize).map(repo => ({
    fullName: repo.full_name,
    packageName: repo.market?.packageName ?? repo.name,
    description: repo.description ?? '',
    url: repo.html_url,
    ownerAvatarUrl: repo.owner.avatar_url,
    stars: repo.stargazers_count,
    updatedAt: repo.updated_at,
    topics: repo.topics,
    // A package name in a source manifest does not establish an npm publication.
    // Hand the indexed repository to DSH without probing GitHub or a registry.
    installSpec: `github:${repo.full_name}`,
  }))
  return { plugins, fetchedAt: channel.syncedAt,
    indexStale: Date.now() - Date.parse(channel.syncedAt) > INDEX_STALE_AFTER_MS,
    page, pageSize, total: repositories.length, totalPages: Math.max(1, Math.ceil(repositories.length / pageSize)) }
}

/** Register the marketplace API used by this package's browser half. */
export function apply(ctx: Context, config: Config): void {
  // Desktop owns plugin transactions and deliberately has no HTTP server.
  // Wait for the optional Web carrier so HMR/dependency replacement remains reversible.
  ctx.inject(['webServer'], web => applyWeb(web, config))
}

function applyWeb(ctx: Context, config: Config): void {
  let channelSnapshot: Promise<ChannelDocument> | undefined
  let syncStatus: MarketSyncStatus = { state: 'idle' }
  let syncController: AbortController | undefined
  let syncTask: Promise<void> | undefined
  const channel = (): Promise<ChannelDocument> => {
    channelSnapshot ??= readChannel(config).then(value => withMarketRepository(value, config))
    return channelSnapshot
  }

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
    kind: 'prefix',
    path: '/api/plugin-market',
    handler: async (req, res) => {
      try {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
        if (req.method === 'GET' && pathname === '/api/plugin-market/catalog') {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const requestedPage = Number.parseInt(url.searchParams.get('page') ?? '1', 10)
          const requestedSize = Number.parseInt(url.searchParams.get('pageSize') ?? String(config.pageSize), 10)
          const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1
          const pageSize = Number.isFinite(requestedSize) ? Math.min(100, Math.max(1, requestedSize)) : config.pageSize
          json(res, 200, discover(
            await channel(),
            page,
            pageSize,
            url.searchParams.get('query') ?? '',
          ))
          return
        }
        if (req.method === 'GET' && pathname === '/api/plugin-market/sync') {
          json(res, 200, syncStatus)
          return
        }
        if (req.method === 'POST' && pathname === '/api/plugin-market/sync') {
          if (syncStatus.state !== 'running') {
            const startedAt = new Date().toISOString()
            syncController = new AbortController()
            syncStatus = { state: 'running', startedAt, requests: 1, discovered: 0, checked: 0, verified: 0 }
            syncTask = syncChannel(config, (event) => {
              syncStatus = {
                state: 'running',
                startedAt,
                requests: 1,
                discovered: event.total,
                checked: event.total,
                verified: event.total,
              }
            }, syncController.signal).then(
              (result) => {
                channelSnapshot = undefined
                syncStatus = { state: 'completed', result }
              },
              (error: unknown) => {
                syncStatus = { state: 'failed', message: error instanceof Error ? error.message : String(error) }
              },
            ).finally(() => {
              syncController = undefined
              syncTask = undefined
            })
          }
          json(res, 202, syncStatus)
          return
        }
        json(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在。' } } satisfies MarketErrorBody)
      } catch (error) {
        const known = error instanceof HttpError
          ? error
          : new HttpError(500, 'INTERNAL_ERROR', error instanceof Error ? error.message : String(error))
        json(res, known.status, { error: { code: known.code, message: known.message } } satisfies MarketErrorBody)
      }
    },
    })
    return async () => {
      disposeRoute()
      syncController?.abort(new Error('插件市场正在卸载。'))
      await syncTask
    }
  }, 'plugin-market: HTTP API')
}

export type * from './contracts.js'
