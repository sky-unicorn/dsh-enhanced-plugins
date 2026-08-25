import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_TOPIC = 'dsh-plugin'
const DEFAULT_OUTPUT = resolve(ROOT, 'assets/plugins-cache.json')
const DEFAULT_PREVIOUS = DEFAULT_OUTPUT
const DEFAULT_PREVIOUS_URL =
  'https://raw.githubusercontent.com/sky-unicorn/dsh-enhanced-plugins/market-index/plugins-cache.json'
const CHANNEL_VALIDATION = 'root-dsh-bundle-v1'
const SEARCH_START_SECONDS = Math.floor(Date.parse('2008-01-01T00:00:00.000Z') / 1000)
const SEARCH_INTERVAL_MS = 2_100
const MANIFEST_CONCURRENCY = 12
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024
const MAX_ATTEMPTS = 6
const MAX_RETRY_DELAY_MS = 65_000
const PACKAGE_PART_PATTERN = /^[a-z0-9._~-]+$/
const TOPIC_PATTERN = /^[a-z0-9][a-z0-9-]{0,49}$/

function validPackagePart(value) {
  return value !== '.' && value !== '..' && PACKAGE_PART_PATTERN.test(value)
}

function isPackageName(value) {
  if (typeof value !== 'string') return false
  if (!value.startsWith('@')) return validPackagePart(value)
  const parts = value.slice(1).split('/')
  return parts.length === 2 && validPackagePart(parts[0] ?? '') && validPackagePart(parts[1] ?? '')
}

function safeBundlePatch(value) {
  const normalized = value.trim().replaceAll('\\', '/')
  return normalized.length > 0
    && !normalized.startsWith('/')
    && !/^[A-Za-z]:/.test(normalized)
    && !normalized.split('/').includes('..')
}

/** Read the root DSH bundle identity without executing repository-owned code. */
export function dshBundleEvidence(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (!isPackageName(value.name)
    || value.dsh === null || typeof value.dsh !== 'object' || Array.isArray(value.dsh)) return undefined
  const bundle = value.dsh.bundle
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) return undefined
  const patch = bundle.patch
  if (typeof patch !== 'string' || !safeBundlePatch(patch)) return undefined
  return { packageName: value.name, bundlePatch: patch.trim() }
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolveDelay, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolveDelay()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function retryDelay(response, attempt, responseText) {
  const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10)
  if (Number.isFinite(retryAfter)) return Math.min(MAX_RETRY_DELAY_MS, Math.max(1_000, retryAfter * 1_000))
  const resetAt = Number.parseInt(response.headers.get('x-ratelimit-reset') ?? '', 10) * 1_000
  if (Number.isFinite(resetAt) && response.headers.get('x-ratelimit-remaining') === '0') {
    return Math.min(MAX_RETRY_DELAY_MS, Math.max(1_000, resetAt - Date.now() + 1_000))
  }
  if (response.status === 403 && /secondary rate limit/i.test(responseText)) return 60_000
  return Math.min(MAX_RETRY_DELAY_MS, 500 * (2 ** attempt) + Math.floor(Math.random() * 250))
}

function retryable(response, responseText) {
  return response.status === 429
    || response.status === 502
    || response.status === 503
    || response.status === 504
    || (response.status === 403 && (
      response.headers.get('x-ratelimit-remaining') === '0'
      || /secondary rate limit/i.test(responseText)
    ))
}

function responseError(response, responseText) {
  let detail = responseText.trim()
  try {
    const parsed = JSON.parse(responseText)
    if (typeof parsed?.message === 'string') detail = parsed.message
  } catch {
    // Keep the bounded response text when the upstream error is not JSON.
  }
  return new Error(`GitHub returned ${response.status}${detail.length === 0 ? '' : `: ${detail.slice(0, 300)}`}`)
}

function createGitHubClient({ token, fetchImpl = fetch, searchIntervalMs = SEARCH_INTERVAL_MS, signal }) {
  let nextSearchAt = 0
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-enhanced-plugin-indexer',
    'x-github-api-version': '2022-11-28',
    ...(token.length === 0 ? {} : { authorization: `Bearer ${token}` }),
  }

  const requestText = async (url, { search = false, allowNotFound = false } = {}) => {
    if (search && searchIntervalMs > 0) {
      const waitMs = Math.max(0, nextSearchAt - Date.now())
      if (waitMs > 0) await abortableDelay(waitMs, signal)
      nextSearchAt = Date.now() + searchIntervalMs
    }
    let lastError
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted()
      try {
        const requestSignal = signal === undefined
          ? AbortSignal.timeout(30_000)
          : AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        const response = await fetchImpl(url, { headers, signal: requestSignal })
        const length = Number.parseInt(response.headers.get('content-length') ?? '', 10)
        if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
          throw new Error(`GitHub response exceeds ${MAX_RESPONSE_BYTES} bytes`)
        }
        const responseText = await response.text()
        if (Buffer.byteLength(responseText, 'utf8') > MAX_RESPONSE_BYTES) {
          throw new Error(`GitHub response exceeds ${MAX_RESPONSE_BYTES} bytes`)
        }
        if (response.ok) return responseText
        if (allowNotFound && response.status === 404) return undefined
        if (!retryable(response, responseText) || attempt === MAX_ATTEMPTS - 1) {
          throw responseError(response, responseText)
        }
        await abortableDelay(retryDelay(response, attempt, responseText), signal)
      } catch (error) {
        signal?.throwIfAborted()
        lastError = error
        if (error instanceof Error && error.message.startsWith('GitHub returned ')) throw error
        if (attempt === MAX_ATTEMPTS - 1) break
        await abortableDelay(Math.min(8_000, 500 * (2 ** attempt)), signal)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('GitHub request failed')
  }

  return {
    async json(url, options) {
      const text = await requestText(url, options)
      if (text === undefined) return undefined
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`GitHub returned invalid JSON for ${url}`)
      }
    },
  }
}

function isoSecond(seconds) {
  return new Date(seconds * 1_000).toISOString().replace('.000Z', 'Z')
}

function normalizeRepository(value, topic) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (value.archived === true || value.disabled === true) return undefined
  if (typeof value.name !== 'string'
    || typeof value.full_name !== 'string'
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.full_name)
    || (typeof value.description !== 'string' && value.description !== null)
    || typeof value.html_url !== 'string'
    || !value.html_url.startsWith('https://github.com/')
    || typeof value.stargazers_count !== 'number'
    || typeof value.updated_at !== 'string'
    || typeof value.default_branch !== 'string'
    || value.default_branch.length === 0
    || !Array.isArray(value.topics)
    || !value.topics.every(entry => typeof entry === 'string')
    || !value.topics.includes(topic)
    || value.owner === null || typeof value.owner !== 'object' || Array.isArray(value.owner)
    || typeof value.owner.avatar_url !== 'string') return undefined
  return {
    name: value.name,
    full_name: value.full_name,
    description: value.description,
    html_url: value.html_url,
    stargazers_count: value.stargazers_count,
    updated_at: value.updated_at,
    ...(typeof value.pushed_at === 'string' ? { pushed_at: value.pushed_at } : {}),
    topics: value.topics,
    default_branch: value.default_branch,
    owner: { avatar_url: value.owner.avatar_url },
  }
}

async function searchRange(client, topic, startSeconds, endSeconds, report) {
  const qualifier = `topic:${topic} created:${isoSecond(startSeconds)}..${isoSecond(endSeconds)}`
  const pageUrl = page => `https://api.github.com/search/repositories?q=${encodeURIComponent(qualifier)}`
    + `&sort=updated&order=desc&per_page=100&page=${page}`
  const first = await client.json(pageUrl(1), { search: true })
  if (first === null || typeof first !== 'object' || Array.isArray(first)
    || typeof first.total_count !== 'number' || !Array.isArray(first.items)) {
    throw new Error('GitHub repository search returned an invalid response')
  }
  if (first.total_count > 1_000 || first.incomplete_results === true) {
    const middle = Math.floor((startSeconds + endSeconds) / 2)
    if (middle < startSeconds || middle >= endSeconds) {
      throw new Error(`GitHub search cannot completely enumerate ${qualifier}`)
    }
    const left = await searchRange(client, topic, startSeconds, middle, report)
    const right = await searchRange(client, topic, middle + 1, endSeconds, report)
    return [...left, ...right]
  }
  const repositories = [...first.items]
  report({ kind: 'search', found: repositories.length, total: first.total_count })
  const pages = Math.ceil(first.total_count / 100)
  for (let page = 2; page <= pages; page += 1) {
    const next = await client.json(pageUrl(page), { search: true })
    if (next === null || typeof next !== 'object' || Array.isArray(next) || !Array.isArray(next.items)) {
      throw new Error(`GitHub repository search returned an invalid page ${page}`)
    }
    repositories.push(...next.items)
    report({ kind: 'search', found: next.items.length, total: first.total_count })
  }
  return repositories
}

function previousRepositoryMap(previous, topic) {
  if (previous === undefined
    || previous === null || typeof previous !== 'object' || Array.isArray(previous)
    || previous.schemaVersion !== 2
    || previous.validation !== CHANNEL_VALIDATION
    || previous.topic !== topic
    || !Array.isArray(previous.repositories)) return new Map()
  return new Map(previous.repositories.flatMap((repository) => {
    const normalized = normalizeRepository(repository, topic)
    const evidence = dshBundleEvidence({
      name: repository?.market?.packageName,
      dsh: { bundle: { patch: repository?.market?.bundlePatch } },
    })
    return normalized === undefined || evidence === undefined
      ? []
      : [[normalized.full_name.toLocaleLowerCase(), { ...normalized, market: { ...evidence, installCommands: [] } }]]
  }))
}

function compareRepositories(left, right) {
  const stars = right.stargazers_count - left.stargazers_count
  if (stars !== 0) return stars
  const updated = right.updated_at.localeCompare(left.updated_at)
  if (updated !== 0) return updated
  return left.full_name.localeCompare(right.full_name, 'en', { sensitivity: 'base' })
}

async function validateRepositories(client, repositories, previous, topic, report) {
  let cursor = 0
  const verified = []
  const worker = async () => {
    while (cursor < repositories.length) {
      const repository = repositories[cursor]
      cursor += 1
      if (repository === undefined) return
      const cached = previous.get(repository.full_name.toLocaleLowerCase())
      const sameRevision = cached?.pushed_at !== undefined && repository.pushed_at !== undefined
        ? cached.pushed_at === repository.pushed_at
        : cached?.updated_at === repository.updated_at
      if (cached !== undefined
        && sameRevision
        && cached.default_branch === repository.default_branch) {
        verified.push({ ...repository, market: cached.market })
        report({ kind: 'validation', fullName: repository.full_name, cached: true, valid: true })
        continue
      }
      const manifestUrl = `https://raw.githubusercontent.com/${repository.full_name}`
        + `/${encodeURIComponent(repository.default_branch)}/package.json`
      const manifest = await client.json(manifestUrl, { allowNotFound: true })
      const evidence = dshBundleEvidence(manifest)
      if (evidence !== undefined) {
        verified.push({ ...repository, market: { ...evidence, installCommands: [] } })
      }
      report({
        kind: 'validation',
        fullName: repository.full_name,
        cached: false,
        valid: evidence !== undefined,
      })
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(MANIFEST_CONCURRENCY, Math.max(1, repositories.length)) },
    worker,
  ))
  return verified.sort(compareRepositories)
}

/** Build one complete, root-bundle-validated channel document. */
export async function buildPluginIndex({
  topic = DEFAULT_TOPIC,
  token = '',
  previous,
  fetchImpl = fetch,
  now = () => new Date(),
  report = () => {},
  searchIntervalMs = SEARCH_INTERVAL_MS,
  allowLargeShrink = false,
  signal,
} = {}) {
  if (!TOPIC_PATTERN.test(topic)) throw new Error(`Invalid GitHub topic ${JSON.stringify(topic)}`)
  const client = createGitHubClient({ token, fetchImpl, searchIntervalMs, signal })
  const rawRepositories = await searchRange(
    client,
    topic,
    SEARCH_START_SECONDS,
    Math.floor(now().getTime() / 1_000),
    report,
  )
  const unique = new Map()
  for (const candidate of rawRepositories) {
    const repository = normalizeRepository(candidate, topic)
    if (repository !== undefined) unique.set(repository.full_name.toLocaleLowerCase(), repository)
  }
  const previousMap = previousRepositoryMap(previous, topic)
  const repositories = await validateRepositories(client, [...unique.values()], previousMap, topic, report)
  if (!allowLargeShrink && previousMap.size >= 20 && repositories.length < previousMap.size * 0.75) {
    throw new Error(
      `Refusing to publish an index that shrank from ${previousMap.size} to ${repositories.length}; `
      + 'rerun with --allow-large-shrink after verifying the result',
    )
  }
  return {
    schemaVersion: 2,
    validation: CHANNEL_VALIDATION,
    topic,
    syncedAt: now().toISOString(),
    repositories,
  }
}

function parseArguments(argv) {
  const options = {
    topic: DEFAULT_TOPIC,
    output: DEFAULT_OUTPUT,
    previous: DEFAULT_PREVIOUS,
    previousUrl: DEFAULT_PREVIOUS_URL,
    allowLargeShrink: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--allow-large-shrink') {
      options.allowLargeShrink = true
      continue
    }
    if (!['--topic', '--output', '--previous', '--previous-url'].includes(argument)) {
      throw new Error(`Unknown argument ${JSON.stringify(argument)}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    index += 1
    if (argument === '--topic') options.topic = value
    else if (argument === '--output') options.output = resolve(value)
    else if (argument === '--previous') options.previous = resolve(value)
    else options.previousUrl = value
  }
  return options
}

async function readJsonFile(filename) {
  try {
    return JSON.parse(await readFile(filename, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

export async function readPrevious(options, {
  fetchImpl = fetch,
  readJsonFileImpl = readJsonFile,
} = {}) {
  if (options.previousUrl.length > 0) {
    try {
      const response = await fetchImpl(options.previousUrl, { signal: AbortSignal.timeout(15_000) })
      if (response.ok) return { document: await response.json(), authoritative: true }
      if (response.status === 404) {
        process.stderr.write('Previous published index does not exist; using bundled seed for bootstrap\n')
        return { document: await readJsonFileImpl(options.previous), authoritative: false }
      }
      throw new Error(`previous index returned ${response.status}`)
    } catch (error) {
      throw new Error(
        `Previous published index unavailable: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }
  return { document: await readJsonFileImpl(options.previous), authoritative: true }
}

async function writeJsonAtomic(filename, value) {
  const temporary = resolve(dirname(filename), `.${Date.now()}-${process.pid}-plugins-cache.tmp`)
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, filename)
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const previous = await readPrevious(options)
  let discovered = 0
  let checked = 0
  let cached = 0
  const document = await buildPluginIndex({
    topic: options.topic,
    token: process.env.GITHUB_TOKEN?.trim() ?? '',
    previous: previous.document,
    allowLargeShrink: options.allowLargeShrink || !previous.authoritative,
    report(event) {
      if (event.kind === 'search') discovered += event.found
      else {
        checked += 1
        if (event.cached) cached += 1
        if (checked % 100 === 0) process.stdout.write(`Validated ${checked} repositories (${cached} cached)\n`)
      }
    },
  })
  await writeJsonAtomic(options.output, document)
  process.stdout.write(
    `Published ${document.repositories.length} verified plugins from ${discovered} search results; `
    + `${cached} validations reused\n`,
  )
}

const invokedAsScript = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedAsScript) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
