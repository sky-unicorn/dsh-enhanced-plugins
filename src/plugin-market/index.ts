/** Host half of the DeepSeek Harness plugin marketplace. */

import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {
  MarketCatalog,
  MarketCatalogFilter,
  MarketCredentialInfo,
  MarketErrorBody,
  MarketInstallPlan,
  MarketInstallPlanJob,
  MarketMutationJob,
  MarketMutationPhase,
  MarketMutationResult,
  MarketPlugin,
  MarketSyncResult,
  MarketSyncStatus,
} from './contracts.js'
import {
  compareByStars,
  dshBundleEvidence,
  findInstalledPackageName,
  hasInstallLifecycleScripts,
  isPackageName,
  npmPackageCandidates,
  npmRepositoryMatches,
} from './market-utils.js'

export interface Config {
  profile: string
  topic: string
  channelUrl: string
  pageSize: number
  operationTimeoutMs: number
  githubTokenEnv: string
  cliPath: string
}

export const Config: Schema<Config> = Schema.object({
  profile: Schema.string().default('web'),
  topic: Schema.string().default('dsh-plugin'),
  channelUrl: Schema.string().pattern(/^https:\/\//).default(
    'https://raw.githubusercontent.com/sky-unicorn/dsh-enhanced-plugins/master/assets/plugins-cache.json',
  ),
  pageSize: Schema.number().min(1).max(30).default(12),
  operationTimeoutMs: Schema.number().min(1000).default(120000),
  githubTokenEnv: Schema.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).default('GITHUB_TOKEN'),
  cliPath: Schema.string().default(''),
})

export const name = 'plugin-market'
export const inject = ['webServer', 'credentials', 'subprocess']

interface GitHubRepository {
  readonly name: string
  readonly full_name: string
  readonly description: string | null
  readonly html_url: string
  readonly stargazers_count: number
  readonly updated_at: string
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

interface MarketInstallRecord {
  readonly profile: string
  readonly fullName: string
  readonly packageName: string
  readonly source: 'npm' | 'github'
  readonly installedAt: string
}

interface MarketInstallDocument {
  readonly schemaVersion: 1
  readonly entries: readonly MarketInstallRecord[]
}

interface PackageManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly repository?: unknown
  readonly dsh?: { readonly bundle?: unknown }
  readonly scripts?: unknown
  readonly dist?: { readonly integrity?: unknown }
}

type SyncProgressEvent = { readonly kind: 'channel'; readonly total: number }

const CHANNEL_VALIDATION = 'root-dsh-bundle-v1' as const
const MAX_CHANNEL_BYTES = 16 * 1024 * 1024
const MAX_UPSTREAM_RESPONSE_BYTES = 20 * 1024 * 1024
const RETRYABLE_HTTP_STATUS = new Set([429, 502, 503, 504])
const MARKET_SELF_PACKAGES = new Set(['dsh-enhanced-plugins', 'dsh-enhanced-plugin-market', 'dsh-plugin-market'])
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

interface ProfileManifest {
  readonly dependencies?: Record<string, string>
  readonly dsh?: { readonly profile?: { readonly bundles?: readonly string[] } }
}

interface ChannelMetadata {
  readonly schemaVersion: 1
  readonly url: string
  readonly etag: string
}

interface MutationJobEntry {
  status: MarketMutationJob
  readonly controller: AbortController
}

interface InstallPlanJobEntry {
  status: MarketInstallPlanJob
  readonly controller: AbortController
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

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, 'CONTENT_TYPE', '请求必须使用 application/json。')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += value.length
    if (bytes > 8192) throw new HttpError(413, 'BODY_TOO_LARGE', '请求内容过大。')
    chunks.push(value)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required')
    return parsed as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'INVALID_JSON', '请求 JSON 无效。')
  }
}

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

async function installedDependencies(profile: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(dshHome(), 'profiles', profile, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as ProfileManifest
    return parsed.dependencies ?? {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

async function installedPackageManifests(
  profile: string,
  dependencies: Record<string, string>,
): Promise<Map<string, PackageManifest>> {
  const entries = await Promise.all(Object.keys(dependencies).map(async (packageName) => {
    if (!isPackageName(packageName)) return null
    try {
      const raw = await readFile(join(dshHome(), 'profiles', profile, 'node_modules', packageName, 'package.json'), 'utf8')
      return [packageName, JSON.parse(raw) as PackageManifest] as const
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }))
  return new Map(entries.filter((entry): entry is readonly [string, PackageManifest] => entry !== null))
}

async function authHeaders(ctx: Context, config: Config, tokenOverride?: string): Promise<Record<string, string>> {
  const token = tokenOverride ?? (await ctx.credentials.resolve(credentialRef(config.githubTokenEnv)))?.value
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-enhanced-plugins',
    'x-github-api-version': '2022-11-28',
    ...(token === undefined || token.length === 0 ? {} : { authorization: `Bearer ${token}` }),
  }
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
      const response = await fetch(url, { ...init, signal: requestSignal })
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
  throw new HttpError(502, 'UPSTREAM_UNAVAILABLE', lastError instanceof Error ? lastError.message : '上游服务暂时不可用。')
}

async function githubJson<T>(
  ctx: Context,
  url: string,
  config: Config,
  signal?: AbortSignal,
): Promise<{ value: T; remaining: number | null }> {
  const response = await fetchWithRetry(url, { headers: await authHeaders(ctx, config) }, 15_000, signal)
  const remainingHeader = response.headers.get('x-ratelimit-remaining')
  const remaining = remainingHeader === null ? null : Number.parseInt(remainingHeader, 10)
  if (response.ok) return { value: await response.json() as T, remaining }
  const message = response.status === 403 || response.status === 429
    ? 'GitHub API 速率受限；请配置 Token，或等待限额重置后重试。'
    : `GitHub API 返回 ${response.status}。`
  throw new HttpError(502, 'GITHUB_API', message)
}

async function repositoryManifest(
  ctx: Context,
  fullName: string,
  ref: string,
  config: Config,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<PackageManifest | null> {
  const url = `https://raw.githubusercontent.com/${fullName}/${encodeURIComponent(ref)}/package.json`
  const response = await fetchWithRetry(url, { headers: headers ?? await authHeaders(ctx, config) }, 10_000, signal)
  if (response.status === 404) return null
  if (!response.ok) throw new HttpError(502, 'GITHUB_MANIFEST', `读取 ${fullName} 的 package.json 时 GitHub 返回 ${response.status}。`)
  try {
    return await response.json() as PackageManifest
  } catch {
    return null
  }
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

function installRecordPath(): string {
  return join(marketDirectory(), 'installed-plugins.json')
}

function parseMarketInstallDocument(raw: string): MarketInstallDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new HttpError(500, 'INVALID_INSTALL_RECORD', '插件社区安装记录不是有效 JSON。')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(500, 'INVALID_INSTALL_RECORD', '插件社区安装记录结构无效。')
  }
  const document = parsed as { readonly schemaVersion?: unknown; readonly entries?: unknown }
  if (document.schemaVersion !== 1 || !Array.isArray(document.entries)) {
    throw new HttpError(500, 'INVALID_INSTALL_RECORD', '插件社区安装记录版本无效。')
  }
  const valid = document.entries.every((entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false
    const value = entry as Partial<MarketInstallRecord>
    return typeof value.profile === 'string' && value.profile.length > 0
      && isRepositoryFullName(value.fullName)
      && isPackageName(value.packageName)
      && (value.source === 'npm' || value.source === 'github')
      && typeof value.installedAt === 'string'
  })
  if (!valid) throw new HttpError(500, 'INVALID_INSTALL_RECORD', '插件社区安装记录包含无效条目。')
  return document as MarketInstallDocument
}

async function readMarketInstalls(): Promise<readonly MarketInstallRecord[]> {
  try {
    return parseMarketInstallDocument(await readFile(installRecordPath(), 'utf8')).entries
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function writeMarketInstalls(entries: readonly MarketInstallRecord[]): Promise<void> {
  const filename = installRecordPath()
  await mkdir(marketDirectory(), { recursive: true })
  const temporary = `${filename}.${process.pid}.tmp`
  const document: MarketInstallDocument = { schemaVersion: 1, entries }
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  await rename(temporary, filename)
}

async function recordMarketInstall(record: MarketInstallRecord): Promise<void> {
  const fullName = record.fullName.toLocaleLowerCase()
  const entries = (await readMarketInstalls()).filter(entry =>
    entry.profile !== record.profile
    || (entry.fullName.toLocaleLowerCase() !== fullName && entry.packageName !== record.packageName))
  await writeMarketInstalls([...entries, record])
}

async function removeMarketInstall(profile: string, packageName: string): Promise<void> {
  const entries = await readMarketInstalls()
  const remaining = entries.filter(entry => entry.profile !== profile || entry.packageName !== packageName)
  if (remaining.length !== entries.length) await writeMarketInstalls(remaining)
}

function parseChannel(raw: string, config: Config): ChannelDocument {
  const parsed = JSON.parse(raw) as Partial<ChannelDocument>
  if (parsed.schemaVersion !== 2 || parsed.validation !== CHANNEL_VALIDATION) {
    throw new HttpError(500, 'UNVERIFIED_CHANNEL', '插件渠道尚未经过 dsh.bundle 校验，请重新同步。')
  }
  if (parsed.topic !== config.topic || typeof parsed.syncedAt !== 'string' || !Array.isArray(parsed.repositories)) {
    throw new HttpError(500, 'INVALID_CHANNEL', '本地插件渠道 JSON 无效，请重新同步。')
  }
  if (parsed.repositories.some(repo => dshBundleEvidence({
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

async function discover(
  config: Config,
  channel: ChannelDocument,
  page: number,
  pageSize: number,
  query: string,
  filter: MarketCatalogFilter,
): Promise<MarketCatalog> {
  const dependencies = await installedDependencies(config.profile)
  const installedManifests = await installedPackageManifests(config.profile, dependencies)
  const marketInstalls = new Map((await readMarketInstalls())
    .filter(entry => entry.profile === config.profile && dependencies[entry.packageName] !== undefined)
    .map(entry => [entry.fullName.toLocaleLowerCase(), entry]))
  const plugins: MarketPlugin[] = []
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const catalogEntries = channel.repositories
    .filter(repo => normalizedQuery.length === 0 || [
      repo.full_name, repo.name, repo.description ?? '', ...repo.topics,
    ].some(value => value.toLocaleLowerCase().includes(normalizedQuery)))
    .sort((left, right) => compareByStars(
      { fullName: left.full_name, stars: left.stargazers_count, updatedAt: left.updated_at },
      { fullName: right.full_name, stars: right.stargazers_count, updatedAt: right.updated_at },
    ))
    .map((repo) => {
      const packageCandidates = npmPackageCandidates(repo.market?.installCommands ?? [], repo.market?.packageName)
      return { repo, packageCandidates }
    })
  const packageCandidateCounts = new Map<string, number>()
  for (const { packageCandidates } of catalogEntries) {
    for (const candidate of packageCandidates) {
      const normalized = candidate.toLocaleLowerCase()
      packageCandidateCounts.set(normalized, (packageCandidateCounts.get(normalized) ?? 0) + 1)
    }
  }
  const filtered = catalogEntries
    .map(({ repo, packageCandidates }) => {
      const marketInstall = marketInstalls.get(repo.full_name.toLocaleLowerCase())
      return {
        repo,
        packageCandidates,
        marketInstalled: marketInstall !== undefined,
        installedPackageName: marketInstall?.packageName ?? findInstalledPackageName(
          repo.full_name,
          packageCandidates.filter(candidate => packageCandidateCounts.get(candidate.toLocaleLowerCase()) === 1),
          dependencies,
          installedManifests,
        ),
      }
    })
    .filter(entry => filter === 'all' || entry.installedPackageName !== undefined)
  const start = (page - 1) * pageSize
  for (const entry of filtered.slice(start, start + pageSize)) {
    const { repo, packageCandidates, installedPackageName } = entry
    const packageName = installedPackageName ?? packageCandidates[0] ?? repo.name
    const installedSpec = installedPackageName === undefined ? undefined : dependencies[installedPackageName]
    plugins.push({
      fullName: repo.full_name,
      packageName,
      description: repo.description ?? '暂无简介',
      url: repo.html_url,
      ownerAvatarUrl: repo.owner.avatar_url,
      stars: repo.stargazers_count,
      updatedAt: repo.updated_at,
      topics: repo.topics,
      installed: installedSpec !== undefined,
      removable: installedSpec !== undefined && entry.marketInstalled && !MARKET_SELF_PACKAGES.has(packageName),
      ...(installedSpec === undefined ? {} : { installedSpec }),
    })
  }
  return {
    plugins,
    fetchedAt: channel.syncedAt,
    rateLimitRemaining: null,
    profile: config.profile,
    page,
    pageSize,
    total: filtered.length,
    totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
  }
}

async function resolveNpmPackage(
  repo: GitHubRepository,
  rootManifest: PackageManifest | null,
  signal?: AbortSignal,
): Promise<{ packageName: string; version: string; integrity?: string; manifest: PackageManifest } | null> {
  const candidates = [...new Set([
    ...npmPackageCandidates(repo.market?.installCommands ?? [], rootManifest?.name),
    ...npmPackageCandidates([], repo.market?.packageName),
  ])]
  for (const packageName of candidates) {
    const response = await fetchWithRetry(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-enhanced-plugins' },
    }, 10_000, signal)
    if (response.status === 404) continue
    if (!response.ok) throw new HttpError(502, 'NPM_REGISTRY', `npm registry 返回 ${response.status}。`)
    const manifest = await response.json() as PackageManifest
    const latest = manifest.version
    if (typeof latest !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(latest)) continue
    if (dshBundleEvidence(manifest)?.packageName !== packageName
      || !npmRepositoryMatches(manifest.repository, repo.full_name)) continue
    const integrity = manifest.dist?.integrity
    return {
      packageName,
      version: latest,
      ...(typeof integrity === 'string' && integrity.length > 0 ? { integrity } : {}),
      manifest,
    }
  }
  return null
}

function catalogRepository(channel: ChannelDocument, fullName: string): GitHubRepository {
  const repo = channel.repositories.find(entry => entry.full_name.toLocaleLowerCase() === fullName.toLocaleLowerCase())
  if (repo === undefined) throw new HttpError(404, 'NOT_IN_CATALOG', '该仓库不在当前插件渠道中。')
  if (dshBundleEvidence({
    name: repo.market?.packageName,
    dsh: { bundle: { patch: repo.market?.bundlePatch } },
  }) === undefined) {
    throw new HttpError(400, 'NOT_DSH_BUNDLE', '该仓库不是经过验证的 DSH bundle。')
  }
  return repo
}

async function resolveInstallPlan(
  ctx: Context,
  config: Config,
  catalogRepo: GitHubRepository,
  signal?: AbortSignal,
): Promise<MarketInstallPlan> {
  const repoResult = await githubJson<GitHubRepository>(
    ctx,
    `https://api.github.com/repos/${catalogRepo.full_name}`,
    config,
    signal,
  )
  if (repoResult.value.full_name.toLocaleLowerCase() !== catalogRepo.full_name.toLocaleLowerCase()) {
    throw new HttpError(502, 'GITHUB_IDENTITY_MISMATCH', 'GitHub 返回的仓库身份与插件渠道不一致。')
  }
  const commit = await githubJson<{ readonly sha: string }>(
    ctx,
    `https://api.github.com/repos/${catalogRepo.full_name}/commits/${encodeURIComponent(repoResult.value.default_branch)}`,
    config,
    signal,
  )
  if (!/^[0-9a-f]{40}$/i.test(commit.value.sha)) {
    throw new HttpError(502, 'INVALID_COMMIT', 'GitHub 返回了无效的 commit 标识。')
  }
  const manifest = await repositoryManifest(ctx, repoResult.value.full_name, commit.value.sha, config, undefined, signal)
  const installRepo: GitHubRepository = catalogRepo.market === undefined
    ? repoResult.value
    : { ...repoResult.value, market: catalogRepo.market }
  const npmPackage = await resolveNpmPackage(installRepo, manifest, signal)
  if (npmPackage !== null) {
    if (hasInstallLifecycleScripts(npmPackage.manifest, 'npm')) {
      return {
        kind: 'manual',
        packageName: npmPackage.packageName,
        repository: repoResult.value.full_name,
        documentationUrl: `${repoResult.value.html_url}#readme`,
        reason: 'requires-build-approval',
      }
    }
    if (npmPackage.integrity === undefined || !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(npmPackage.integrity)) {
      return {
        kind: 'manual',
        packageName: npmPackage.packageName,
        repository: repoResult.value.full_name,
        documentationUrl: `${repoResult.value.html_url}#readme`,
        reason: 'missing-integrity',
      }
    }
    return {
      kind: 'npm',
      packageName: npmPackage.packageName,
      version: npmPackage.version,
      ...(npmPackage.integrity === undefined ? {} : { integrity: npmPackage.integrity }),
      repository: repoResult.value.full_name,
    }
  }
  const bundle = dshBundleEvidence(manifest)
  if (bundle === undefined) {
    return {
      kind: 'manual',
      packageName: catalogRepo.market?.packageName ?? catalogRepo.name,
      repository: repoResult.value.full_name,
      documentationUrl: `${repoResult.value.html_url}#readme`,
      reason: 'no-automatic-source',
    }
  }
  if (hasInstallLifecycleScripts(manifest, 'github')) {
    return {
      kind: 'manual',
      packageName: bundle.packageName,
      repository: repoResult.value.full_name,
      documentationUrl: `${repoResult.value.html_url}#readme`,
      reason: 'requires-build-approval',
    }
  }
  return {
    kind: 'github',
    packageName: bundle.packageName,
    repository: repoResult.value.full_name,
    commit: commit.value.sha,
    requiresConfirmation: true,
  }
}

async function verifyInstalledBundle(config: Config, packageName: string): Promise<void> {
  const dependencies = await installedDependencies(config.profile)
  if (dependencies[packageName] === undefined) {
    throw new HttpError(500, 'INSTALL_VALIDATION_FAILED', `${packageName} 未写入目标 profile。`)
  }
  const root = join(dshHome(), 'profiles', config.profile, 'node_modules', packageName)
  let manifest: PackageManifest
  try {
    manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as PackageManifest
  } catch {
    throw new HttpError(500, 'INSTALL_VALIDATION_FAILED', `${packageName} 的已安装 manifest 无法读取。`)
  }
  const evidence = dshBundleEvidence(manifest)
  if (evidence?.packageName !== packageName) {
    throw new HttpError(500, 'INSTALL_VALIDATION_FAILED', `${packageName} 不是可加载的 DSH bundle。`)
  }
  try {
    await access(join(root, evidence.bundlePatch))
  } catch {
    throw new HttpError(500, 'INSTALL_VALIDATION_FAILED', `${packageName} 声明的 bundle patch 不存在。`)
  }
  const profile = JSON.parse(await readFile(join(dshHome(), 'profiles', config.profile, 'package.json'), 'utf8')) as ProfileManifest
  if (!profile.dsh?.profile?.bundles?.includes(packageName)) {
    throw new HttpError(500, 'INSTALL_VALIDATION_FAILED', `${packageName} 未加入 profile bundle 组合。`)
  }
}

async function runDsh(ctx: Context, config: Config, args: readonly string[], signal?: AbortSignal): Promise<string> {
  const command = config.cliPath.length > 0 ? config.cliPath : process.execPath
  const launcher = process.argv[1] ?? ''
  if (config.cliPath.length === 0 && launcher === '') {
    throw new HttpError(500, 'CLI_UNAVAILABLE', '无法定位当前 dsh 启动器；请配置 cliPath。')
  }
  // Preserve the current launcher's Node flags. Source runs use
  // `node --import tsx/esm apps/cli/src/bin.ts`; dropping process.execArgv
  // would make the marketplace's child invocation differ from `pnpm dsh`.
  const prefix = config.cliPath.length > 0 ? [] : [...process.execArgv, launcher]
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new Error('插件操作超时。')), config.operationTimeoutMs)
  const operationSignal = signal === undefined
    ? deadline.signal
    : AbortSignal.any([signal, deadline.signal])
  try {
    const child = ctx.subprocess.spawn({
      argv: [command, ...prefix, 'plugin', '--profile', config.profile, ...args],
      cwd: process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 65_536 },
        stderr: { maxBytes: 65_536 },
      },
      graceMs: 5_000,
      signal: operationSignal,
      env: process.env.DSH_HOME === undefined ? undefined : { DSH_HOME: process.env.DSH_HOME },
    })
    const outcome = await child.done
    const stdout = child.collected.stdout?.readFrom(0).text ?? ''
    const stderr = child.collected.stderr?.readFrom(0).text ?? ''
    const output = `${stdout}\n${stderr}`.trim()
    if (outcome.exitCode === 0) return output
    if (deadline.signal.aborted) throw new HttpError(504, 'OPERATION_TIMEOUT', '插件操作超时，相关进程已终止。')
    if (signal?.aborted === true) throw new HttpError(409, 'OPERATION_CANCELLED', '插件操作已取消。')
    throw new HttpError(500, 'PLUGIN_COMMAND_FAILED', output || `dsh plugin 退出码 ${String(outcome.exitCode)}。`)
  } catch (error) {
    if (deadline.signal.aborted) throw new HttpError(504, 'OPERATION_TIMEOUT', '插件操作超时，相关进程已终止。')
    if (signal?.aborted === true) throw new HttpError(409, 'OPERATION_CANCELLED', '插件操作已取消。')
    if (error instanceof HttpError) throw error
    throw new HttpError(500, 'CLI_START_FAILED', error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
  }
}

/** Register the marketplace API used by this package's browser half. */
export function apply(ctx: Context, config: Config): void {
  let channelSnapshot: Promise<ChannelDocument> | undefined
  let syncStatus: MarketSyncStatus = { state: 'idle' }
  let syncController: AbortController | undefined
  let syncTask: Promise<void> | undefined
  let activeMutationId: string | undefined
  const jobs = new Map<string, MutationJobEntry>()
  const mutationTasks = new Set<Promise<void>>()
  const planJobs = new Map<string, InstallPlanJobEntry>()
  const planTasks = new Set<Promise<void>>()

  const channel = (): Promise<ChannelDocument> => {
    channelSnapshot ??= readChannel(config).then(value => withMarketRepository(value, config))
    return channelSnapshot
  }

  const pruneJobs = (): void => {
    if (jobs.size <= 50) return
    for (const [id, entry] of jobs) {
      if (entry.status.state === 'running') continue
      jobs.delete(id)
      if (jobs.size <= 50) return
    }
  }

  const prunePlanJobs = (): void => {
    if (planJobs.size <= 100) return
    for (const [id, entry] of planJobs) {
      if (entry.status.state === 'running') continue
      planJobs.delete(id)
      if (planJobs.size <= 100) return
    }
  }

  const startInstallPlan = (fullName: string, repo: GitHubRepository): MarketInstallPlanJob => {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const controller = new AbortController()
    const entry: InstallPlanJobEntry = {
      controller,
      status: { id, fullName, createdAt, state: 'running' },
    }
    planJobs.set(id, entry)
    const task = resolveInstallPlan(ctx, config, repo, controller.signal).then(
      (plan) => {
        entry.status = { id, fullName, createdAt, state: 'completed', completedAt: new Date().toISOString(), plan }
      },
      (error: unknown) => {
        entry.status = {
          id,
          fullName,
          createdAt,
          state: 'failed',
          completedAt: new Date().toISOString(),
          message: error instanceof Error ? error.message : String(error),
        }
      },
    )
    planTasks.add(task)
    void task.then(() => {
      planTasks.delete(task)
      prunePlanJobs()
    })
    return entry.status
  }

  const startMutation = (
    operation: 'install' | 'uninstall',
    target: string,
    work: (signal: AbortSignal, phase: (value: MarketMutationPhase) => void) => Promise<MarketMutationResult>,
  ): MarketMutationJob => {
    if (activeMutationId !== undefined) {
      throw new HttpError(409, 'MUTATION_BUSY', '另一个安装或卸载任务正在进行。')
    }
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const controller = new AbortController()
    const entry: MutationJobEntry = {
      controller,
      status: { id, operation, target, createdAt, state: 'running', phase: 'queued', cancellable: true },
    }
    jobs.set(id, entry)
    activeMutationId = id
    const phase = (value: MarketMutationPhase): void => {
      if (entry.status.state === 'running') entry.status = { ...entry.status, phase: value }
    }
    const task = Promise.resolve()
      .then(async () => await work(controller.signal, phase))
      .then(
        (result) => {
          entry.status = { id, operation, target, createdAt, state: 'completed', completedAt: new Date().toISOString(), result }
        },
        (error: unknown) => {
          const cancelled = controller.signal.aborted
            || (error instanceof HttpError && error.code === 'OPERATION_CANCELLED')
          entry.status = {
            id,
            operation,
            target,
            createdAt,
            state: cancelled ? 'cancelled' : 'failed',
            completedAt: new Date().toISOString(),
            message: cancelled ? '插件操作已取消。' : error instanceof Error ? error.message : String(error),
          }
        },
      )
    mutationTasks.add(task)
    void task.then(() => {
      mutationTasks.delete(task)
      if (activeMutationId === id) activeMutationId = undefined
      pruneJobs()
    })
    return entry.status
  }

  const install = async (
    fullName: string,
    expectedKind: 'npm' | 'github',
    expectedRef: string,
    confirmSource: boolean,
    signal: AbortSignal,
    phase: (value: MarketMutationPhase) => void,
  ): Promise<MarketMutationResult> => {
    phase('preflight')
    const catalogRepo = catalogRepository(await channel(), fullName)
    const plan = await resolveInstallPlan(ctx, config, catalogRepo, signal)
    if (plan.kind === 'manual') {
      throw new HttpError(400, 'MANUAL_INSTALL_REQUIRED', '该插件需要按照仓库安装说明手工处理。')
    }
    if (plan.kind !== expectedKind) {
      throw new HttpError(409, 'INSTALL_PLAN_CHANGED', '插件安装来源已变化，请重新检查安装方式。')
    }
    const planRef = plan.kind === 'npm' ? plan.version : plan.commit
    if (planRef !== expectedRef) {
      throw new HttpError(409, 'INSTALL_PLAN_CHANGED', '插件版本或 commit 已变化，请重新检查安装方式。')
    }
    if (plan.kind === 'github' && !confirmSource) {
      throw new HttpError(400, 'SOURCE_CONFIRMATION_REQUIRED', '安装固定 commit 的源码前需要明确确认。')
    }
    const dependencies = await installedDependencies(config.profile)
    if (dependencies[plan.packageName] !== undefined) {
      throw new HttpError(409, 'ALREADY_INSTALLED', `${plan.packageName} 已存在于目标 profile。`)
    }
    phase('installing')
    await runDsh(ctx, config, [
      'add',
      plan.kind === 'npm'
        ? `${plan.packageName}@${plan.version}`
        : `github:${plan.repository}#${plan.commit}`,
    ], signal)
    try {
      phase('verifying')
      await verifyInstalledBundle(config, plan.packageName)
      await recordMarketInstall({
        profile: config.profile,
        fullName: plan.repository,
        packageName: plan.packageName,
        source: plan.kind,
        installedAt: new Date().toISOString(),
      })
    } catch (error) {
      phase('rolling-back')
      try {
        await runDsh(ctx, config, ['remove', plan.packageName])
      } catch (rollbackError) {
        throw new HttpError(
          500,
          'ROLLBACK_FAILED',
          `安装验证失败，且自动回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        )
      }
      throw error
    }
    return {
      packageName: plan.packageName,
      source: plan.kind,
      restartRequired: true,
      message: plan.kind === 'npm'
        ? '已从 npm 安装并验证，重启当前 Web profile 后生效。'
        : '已从固定 commit 的 GitHub 源安装并验证，重启当前 Web profile 后生效。',
    }
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
          const requestedFilter = url.searchParams.get('filter') ?? 'all'
          if (requestedFilter !== 'all' && requestedFilter !== 'installed') {
            throw new HttpError(400, 'INVALID_FILTER', '插件目录筛选条件无效。')
          }
          const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1
          const pageSize = Number.isFinite(requestedSize) ? Math.min(100, Math.max(1, requestedSize)) : config.pageSize
          json(res, 200, await discover(
            config,
            await channel(),
            page,
            pageSize,
            url.searchParams.get('query') ?? '',
            requestedFilter,
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
        if (pathname === '/api/plugin-market/config' && req.method === 'GET') {
          const info = await ctx.credentials.describe(credentialRef(config.githubTokenEnv))
          json(res, 200, { ref: config.githubTokenEnv, ...info } satisfies MarketCredentialInfo)
          return
        }
        if (pathname === '/api/plugin-market/config' && req.method === 'POST') {
          const request = await body(req)
          if (typeof request.token !== 'string' || request.token.trim().length < 20 || request.token.length > 1024) {
            throw new HttpError(400, 'INVALID_TOKEN', 'GitHub Token 格式无效。')
          }
          const token = request.token.trim()
          const probe = await fetchWithRetry('https://api.github.com/rate_limit', {
            headers: await authHeaders(ctx, config, token),
          }, 15_000)
          if (!probe.ok) throw new HttpError(400, 'TOKEN_REJECTED', 'GitHub 拒绝了这个 Token，请检查后重试。')
          await ctx.credentials.set(credentialRef(config.githubTokenEnv), token)
          const info = await ctx.credentials.describe(credentialRef(config.githubTokenEnv))
          json(res, 200, { ref: config.githubTokenEnv, ...info } satisfies MarketCredentialInfo)
          return
        }
        if (pathname === '/api/plugin-market/config' && req.method === 'DELETE') {
          await ctx.credentials.unset(credentialRef(config.githubTokenEnv))
          const info = await ctx.credentials.describe(credentialRef(config.githubTokenEnv))
          json(res, 200, { ref: config.githubTokenEnv, ...info } satisfies MarketCredentialInfo)
          return
        }
        if (req.method === 'POST' && pathname === '/api/plugin-market/install-plan') {
          const request = await body(req)
          if (!isRepositoryFullName(request.fullName)) throw new HttpError(400, 'INVALID_REPOSITORY', '仓库名称无效。')
          const fullName = request.fullName
          const repo = catalogRepository(await channel(), fullName)
          json(res, 202, startInstallPlan(fullName, repo))
          return
        }
        const planJobMatch = /^\/api\/plugin-market\/install-plans\/([0-9a-f-]+)$/.exec(pathname)
        if (planJobMatch !== null && req.method === 'GET') {
          const entry = planJobs.get(planJobMatch[1] ?? '')
          if (entry === undefined) throw new HttpError(404, 'PLAN_JOB_NOT_FOUND', '安装预检任务不存在或已过期。')
          json(res, 200, entry.status)
          return
        }
        const jobMatch = /^\/api\/plugin-market\/jobs\/([0-9a-f-]+)$/.exec(pathname)
        if (jobMatch !== null && req.method === 'GET') {
          const entry = jobs.get(jobMatch[1] ?? '')
          if (entry === undefined) throw new HttpError(404, 'JOB_NOT_FOUND', '插件操作任务不存在或已过期。')
          json(res, 200, entry.status)
          return
        }
        if (jobMatch !== null && req.method === 'DELETE') {
          const entry = jobs.get(jobMatch[1] ?? '')
          if (entry === undefined) throw new HttpError(404, 'JOB_NOT_FOUND', '插件操作任务不存在或已过期。')
          if (entry.status.state === 'running') entry.controller.abort(new Error('用户取消了插件操作。'))
          json(res, 202, entry.status)
          return
        }
        if (req.method === 'POST' && pathname === '/api/plugin-market/install') {
          const request = await body(req)
          if (!isRepositoryFullName(request.fullName)) {
            throw new HttpError(400, 'INVALID_REPOSITORY', '仓库名称无效。')
          }
          if (request.planKind !== 'npm' && request.planKind !== 'github') {
            throw new HttpError(400, 'INVALID_INSTALL_PLAN', '安装计划类型无效。')
          }
          if (typeof request.expectedRef !== 'string' || request.expectedRef.length === 0 || request.expectedRef.length > 128) {
            throw new HttpError(400, 'INVALID_INSTALL_PLAN', '安装计划版本标识无效。')
          }
          const fullName = request.fullName
          const planKind = request.planKind
          const expectedRef = request.expectedRef
          catalogRepository(await channel(), fullName)
          const job = startMutation('install', fullName, async (signal, phase) => await install(
            fullName,
            planKind,
            expectedRef,
            request.confirmSource === true,
            signal,
            phase,
          ))
          json(res, 202, job)
          return
        }
        if (req.method === 'POST' && pathname === '/api/plugin-market/uninstall') {
          const request = await body(req)
          if (!isPackageName(request.packageName) || request.packageName === 'dsh-enhanced-plugins') {
            throw new HttpError(400, 'INVALID_PACKAGE', '包名无效或不允许从市场中卸载市场本身。')
          }
          const packageName = request.packageName as string
          if (MARKET_SELF_PACKAGES.has(packageName)) throw new HttpError(400, 'INVALID_PACKAGE', '不允许从市场中卸载市场本身。')
          const dependencies = await installedDependencies(config.profile)
          if (dependencies[request.packageName] === undefined) throw new HttpError(404, 'NOT_INSTALLED', '该插件未安装。')
          const records = await readMarketInstalls()
          if (!records.some(entry => entry.profile === config.profile && entry.packageName === packageName)) {
            throw new HttpError(403, 'NOT_MARKET_INSTALL', '只能从这里卸载由插件社区安装的项目。')
          }
          const job = startMutation('uninstall', packageName, async (signal, phase) => {
            phase('installing')
            await runDsh(ctx, config, ['remove', packageName], signal)
            phase('verifying')
            const remaining = await installedDependencies(config.profile)
            if (remaining[packageName] !== undefined) throw new HttpError(500, 'UNINSTALL_VALIDATION_FAILED', `${packageName} 仍存在于目标 profile。`)
            await removeMarketInstall(config.profile, packageName)
            return { packageName, restartRequired: true, message: '卸载完成，重启当前 Web profile 后生效。' }
          })
          json(res, 202, job)
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
      for (const entry of jobs.values()) {
        if (entry.status.state === 'running') entry.controller.abort(new Error('插件市场正在卸载。'))
      }
      for (const entry of planJobs.values()) {
        if (entry.status.state === 'running') entry.controller.abort(new Error('插件市场正在卸载。'))
      }
      await Promise.allSettled([
        ...(syncTask === undefined ? [] : [syncTask]),
        ...mutationTasks,
        ...planTasks,
      ])
    }
  }, 'plugin-market: HTTP API')
}

export type * from './contracts.js'
