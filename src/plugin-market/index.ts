/** Host half of the DeepSeek Harness plugin marketplace. */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {
  MarketCatalog,
  MarketCatalogFilter,
  MarketCredentialInfo,
  MarketErrorBody,
  MarketMutationResult,
  MarketPlugin,
  MarketSyncResult,
  MarketSyncStatus,
} from './contracts.js'
import {
  compareByStars,
  dshBundleEvidence,
  findInstalledPackageName,
  isPackageName,
  npmPackageCandidates,
  npmRepositoryMatches,
} from './market-utils.js'

export interface Config {
  profile: string
  topic: string
  pageSize: number
  operationTimeoutMs: number
  githubTokenEnv: string
  cliPath: string
}

export const Config: Schema<Config> = Schema.object({
  profile: Schema.string().default('web'),
  topic: Schema.string().default('dsh-plugin'),
  pageSize: Schema.number().min(1).max(30).default(12),
  operationTimeoutMs: Schema.number().min(1000).default(120000),
  githubTokenEnv: Schema.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).default('GITHUB_TOKEN'),
  cliPath: Schema.string().default(''),
})

export const name = 'plugin-market'
export const inject = ['webServer', 'credentials']

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
}

type SyncProgressEvent =
  | { readonly kind: 'search'; readonly found: number }
  | { readonly kind: 'validation'; readonly valid: boolean }

const CHANNEL_VALIDATION = 'root-dsh-bundle-v1' as const
const MANIFEST_CONCURRENCY = 16

interface ProfileManifest {
  readonly dependencies?: Record<string, string>
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

async function githubJson<T>(ctx: Context, url: string, config: Config): Promise<{ value: T; remaining: number | null }> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, { headers: await authHeaders(ctx, config), signal: AbortSignal.timeout(15000) })
    const remainingHeader = response.headers.get('x-ratelimit-remaining')
    const remaining = remainingHeader === null ? null : Number.parseInt(remainingHeader, 10)
    if (response.ok) return { value: await response.json() as T, remaining }
    const resetHeader = response.headers.get('x-ratelimit-reset')
    if ((response.status === 403 || response.status === 429) && remaining === 0 && resetHeader !== null && attempt < 3) {
      const resetAt = Number.parseInt(resetHeader, 10) * 1000
      const waitMs = Math.min(70000, Math.max(1000, resetAt - Date.now() + 1000))
      await new Promise(resolve => setTimeout(resolve, waitMs))
      continue
    }
    const message = response.status === 403 || response.status === 429
      ? 'GitHub API 速率受限；请配置 Token，或等待限额重置后重试。'
      : `GitHub API 返回 ${response.status}。`
    throw new HttpError(502, 'GITHUB_API', message)
  }
  throw new HttpError(502, 'GITHUB_API', 'GitHub API 多次达到速率限制，请稍后重试。')
}

async function repositoryManifest(
  ctx: Context,
  fullName: string,
  ref: string,
  config: Config,
  headers?: Record<string, string>,
): Promise<PackageManifest | null> {
  const url = `https://raw.githubusercontent.com/${fullName}/${encodeURIComponent(ref)}/package.json`
  const response = await fetch(url, { headers: headers ?? await authHeaders(ctx, config), signal: AbortSignal.timeout(10000) })
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

async function readChannel(config: Config): Promise<ChannelDocument> {
  try {
    return parseChannel(await readFile(channelPath(), 'utf8'), config)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT'
      || (error instanceof HttpError && error.code === 'UNVERIFIED_CHANNEL')) {
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

async function searchRange(
  ctx: Context,
  config: Config,
  start: Date,
  end: Date,
  report: (event: SyncProgressEvent) => void,
): Promise<{ repositories: GitHubRepository[]; remaining: number | null }> {
  const qualifier = `topic:${config.topic} created:${start.toISOString()}..${end.toISOString()}`
  const first = await githubJson<{ readonly total_count: number; readonly incomplete_results: boolean; readonly items: GitHubRepository[] }>(
    ctx,
    `https://api.github.com/search/repositories?q=${encodeURIComponent(qualifier)}&sort=updated&order=desc&per_page=100&page=1`,
    config,
  )
  if (first.value.total_count > 1000 || first.value.incomplete_results) {
    const middleMs = Math.floor((start.getTime() + end.getTime()) / 2)
    if (middleMs <= start.getTime()) throw new HttpError(502, 'GITHUB_SEARCH_LIMIT', '某个时间区间超过 GitHub Search 的 1000 条上限。')
    const middle = new Date(middleMs)
    const left = await searchRange(ctx, config, start, middle, report)
    const right = await searchRange(ctx, config, new Date(middleMs + 1), end, report)
    return { repositories: [...left.repositories, ...right.repositories], remaining: right.remaining ?? left.remaining }
  }
  report({ kind: 'search', found: first.value.items.length })
  const repositories = [...first.value.items]
  const pages = Math.ceil(first.value.total_count / 100)
  let remaining = first.remaining
  for (let page = 2; page <= pages; page += 1) {
    const next = await githubJson<{ readonly items: GitHubRepository[] }>(
      ctx,
      `https://api.github.com/search/repositories?q=${encodeURIComponent(qualifier)}&sort=updated&order=desc&per_page=100&page=${page}`,
      config,
    )
    report({ kind: 'search', found: next.value.items.length })
    repositories.push(...next.value.items)
    remaining = next.remaining
  }
  return { repositories, remaining }
}

function verifiedChannelRepository(repository: GitHubRepository, packageName: string, bundlePatch: string): GitHubRepository {
  return {
    name: repository.name,
    full_name: repository.full_name,
    description: repository.description,
    html_url: repository.html_url,
    stargazers_count: repository.stargazers_count,
    updated_at: repository.updated_at,
    topics: repository.topics,
    default_branch: repository.default_branch,
    owner: { avatar_url: repository.owner.avatar_url },
    market: { packageName, bundlePatch, installCommands: [] },
  }
}

async function validateRepositories(
  ctx: Context,
  config: Config,
  repositories: readonly GitHubRepository[],
  report: (event: SyncProgressEvent) => void,
): Promise<GitHubRepository[]> {
  let cursor = 0
  const verified: GitHubRepository[] = []
  const headers = await authHeaders(ctx, config)
  const worker = async (): Promise<void> => {
    while (cursor < repositories.length) {
      const repository = repositories[cursor]
      cursor += 1
      if (repository === undefined) return
      const manifest = await repositoryManifest(ctx, repository.full_name, repository.default_branch, config, headers)
      const evidence = dshBundleEvidence(manifest)
      if (evidence !== undefined) {
        verified.push(verifiedChannelRepository(repository, evidence.packageName, evidence.bundlePatch))
      }
      report({ kind: 'validation', valid: evidence !== undefined })
    }
  }
  const workers = await Promise.allSettled(Array.from(
    { length: Math.min(MANIFEST_CONCURRENCY, repositories.length) },
    async () => await worker(),
  ))
  const failed = workers.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed !== undefined) throw failed.reason
  return verified
}

async function syncChannel(ctx: Context, config: Config, report: (event: SyncProgressEvent) => void): Promise<MarketSyncResult> {
  const result = await searchRange(ctx, config, new Date('2008-01-01T00:00:00.000Z'), new Date(), report)
  const unique = new Map(result.repositories.map(repository => [repository.full_name.toLocaleLowerCase(), repository]))
  const repositories = (await validateRepositories(ctx, config, [...unique.values()], report)).sort((left, right) => compareByStars(
    { fullName: left.full_name, stars: left.stargazers_count, updatedAt: left.updated_at },
    { fullName: right.full_name, stars: right.stargazers_count, updatedAt: right.updated_at },
  ))
  const syncedAt = new Date().toISOString()
  await writeChannel({ schemaVersion: 2, validation: CHANNEL_VALIDATION, topic: config.topic, syncedAt, repositories })
  return { total: repositories.length, syncedAt, rateLimitRemaining: result.remaining }
}

async function discover(
  ctx: Context,
  config: Config,
  page: number,
  pageSize: number,
  query: string,
  filter: MarketCatalogFilter,
): Promise<MarketCatalog> {
  const channel = await readChannel(config)
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
    .filter(entry => filter === 'all' || entry.marketInstalled)
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
): Promise<{ packageName: string; version: string } | null> {
  const candidates = [...new Set([
    ...npmPackageCandidates(repo.market?.installCommands ?? [], rootManifest?.name),
    ...npmPackageCandidates([], repo.market?.packageName),
  ])]
  for (const packageName of candidates) {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-enhanced-plugins' },
      signal: AbortSignal.timeout(10000),
    })
    if (response.status === 404) continue
    if (!response.ok) throw new HttpError(502, 'NPM_REGISTRY', `npm registry 返回 ${response.status}。`)
    const manifest = await response.json() as PackageManifest
    const latest = manifest.version
    if (typeof latest !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(latest)) continue
    if (dshBundleEvidence(manifest)?.packageName !== packageName
      || !npmRepositoryMatches(manifest.repository, repo.full_name)) continue
    return { packageName, version: latest }
  }
  return null
}

async function catalogRepository(config: Config, fullName: string): Promise<GitHubRepository> {
  const channel = await readChannel(config)
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

async function runDsh(config: Config, args: readonly string[]): Promise<string> {
  const command = config.cliPath.length > 0 ? config.cliPath : process.execPath
  const launcher = process.argv[1] ?? ''
  if (config.cliPath.length === 0 && launcher === '') {
    throw new HttpError(500, 'CLI_UNAVAILABLE', '无法定位当前 dsh 启动器；请配置 cliPath。')
  }
  // Preserve the current launcher's Node flags. Source runs use
  // `node --import tsx/esm apps/cli/src/bin.ts`; dropping process.execArgv
  // would make the marketplace's child invocation differ from `pnpm dsh`.
  const prefix = config.cliPath.length > 0 ? [] : [...process.execArgv, launcher]
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...prefix, 'plugin', '--profile', config.profile, ...args], {
      shell: false,
      windowsHide: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const output: Buffer[] = []
    let size = 0
    const collect = (chunk: Buffer): void => {
      if (size >= 65536) return
      const kept = chunk.subarray(0, 65536 - size)
      output.push(kept)
      size += kept.length
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => child.kill(), config.operationTimeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new HttpError(500, 'CLI_START_FAILED', error.message))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      const text = Buffer.concat(output).toString('utf8').trim()
      if (code === 0) resolve(text)
      else reject(new HttpError(500, 'PLUGIN_COMMAND_FAILED', text || `dsh plugin 退出码 ${String(code)}。`))
    })
  })
}

/** Register the marketplace API used by this package's browser half. */
export function apply(ctx: Context, config: Config): void {
  let operation: Promise<unknown> | undefined
  let syncStatus: MarketSyncStatus = { state: 'idle' }
  const exclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    if (operation !== undefined) throw new HttpError(409, 'OPERATION_BUSY', '另一个插件操作正在进行。')
    const next = work()
    operation = next
    try { return await next } finally { operation = undefined }
  }
  ctx.effect(() => ctx.webServer.register({
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
            ctx,
            config,
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
            let requests = 0
            let discovered = 0
            let checked = 0
            let verified = 0
            syncStatus = { state: 'running', startedAt, requests, discovered, checked, verified }
            const task = exclusive(() => syncChannel(ctx, config, (event) => {
              if (event.kind === 'search') {
                requests += 1
                discovered += event.found
              } else {
                checked += 1
                if (event.valid) verified += 1
              }
              syncStatus = { state: 'running', startedAt, requests, discovered, checked, verified }
            }))
            void task.then(
              result => { syncStatus = { state: 'completed', result: result as MarketSyncResult } },
              error => { syncStatus = { state: 'failed', message: error instanceof Error ? error.message : String(error) } },
            )
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
          const probe = await fetch('https://api.github.com/rate_limit', {
            headers: await authHeaders(ctx, config, token),
            signal: AbortSignal.timeout(15000),
          })
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
        if (req.method === 'POST' && pathname === '/api/plugin-market/install') {
          const request = await body(req)
          if (!isRepositoryFullName(request.fullName)) {
            throw new HttpError(400, 'INVALID_REPOSITORY', '仓库名称无效。')
          }
          const result = await exclusive(async (): Promise<MarketMutationResult> => {
            const catalogRepo = await catalogRepository(config, request.fullName as string)
            const repoResult = await githubJson<GitHubRepository>(ctx, `https://api.github.com/repos/${request.fullName}`, config)
            const commit = await githubJson<{ readonly sha: string }>(ctx,
              `https://api.github.com/repos/${request.fullName}/commits/${encodeURIComponent(repoResult.value.default_branch)}`,
              config,
            )
            const manifest = await repositoryManifest(ctx, repoResult.value.full_name, commit.value.sha, config)
            const installRepo: GitHubRepository = catalogRepo.market === undefined
              ? repoResult.value
              : { ...repoResult.value, market: catalogRepo.market }
            const npmPackage = await resolveNpmPackage(installRepo, manifest)
            if (npmPackage !== null) {
              await runDsh(config, ['add', `${npmPackage.packageName}@${npmPackage.version}`])
              await recordMarketInstall({
                profile: config.profile,
                fullName: repoResult.value.full_name,
                packageName: npmPackage.packageName,
                source: 'npm',
                installedAt: new Date().toISOString(),
              })
              return {
                packageName: npmPackage.packageName,
                source: 'npm',
                restartRequired: true,
                message: '已从 npm 安装，重启当前 Web profile 后生效。',
              }
            }
            const bundle = dshBundleEvidence(manifest)
            if (bundle === undefined) {
              throw new HttpError(
                400,
                'NO_AUTOMATIC_INSTALL_SOURCE',
                '没有找到与仓库匹配的 npm bundle，仓库根目录也不是可直接安装的 DSH bundle；请按仓库 README 使用本地目录或 tarball 安装。',
              )
            }
            await runDsh(config, ['add', `github:${request.fullName}#${commit.value.sha}`])
            await recordMarketInstall({
              profile: config.profile,
              fullName: repoResult.value.full_name,
              packageName: bundle.packageName,
              source: 'github',
              installedAt: new Date().toISOString(),
            })
            return {
              packageName: bundle.packageName,
              source: 'github',
              restartRequired: true,
              message: '已从固定 commit 的 GitHub 源安装，重启当前 Web profile 后生效。',
            }
          })
          json(res, 200, result)
          return
        }
        if (req.method === 'POST' && pathname === '/api/plugin-market/uninstall') {
          const request = await body(req)
          if (!isPackageName(request.packageName) || request.packageName === 'dsh-enhanced-plugins') {
            throw new HttpError(400, 'INVALID_PACKAGE', '包名无效或不允许从市场中卸载市场本身。')
          }
          const dependencies = await installedDependencies(config.profile)
          if (dependencies[request.packageName] === undefined) throw new HttpError(404, 'NOT_INSTALLED', '该插件未安装。')
          const result = await exclusive(async (): Promise<MarketMutationResult> => {
            await runDsh(config, ['remove', request.packageName as string])
            await removeMarketInstall(config.profile, request.packageName as string)
            return { packageName: request.packageName as string, restartRequired: true, message: '卸载完成，重启当前 Web profile 后生效。' }
          })
          json(res, 200, result)
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
  }), 'plugin-market: HTTP API')
}

export type * from './contracts.js'
