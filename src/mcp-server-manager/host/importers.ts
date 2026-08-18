/**
 * Host-only importers for MCP servers configured in Claude Code and Codex.
 *
 * Configuration files are read only after an explicit Remote request. Secret
 * values stay in this process: candidates are de-duplicated and written
 * directly through the settings seam, while the browser receives counts,
 * names, and value-free diagnostic codes only.
 */

import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import {
  DEFAULT_TOOL_CALL_TIMEOUT_MS, SERVER_NAME_PATTERN,
  type ServerDefinition, type StdioServerDefinition, type StreamableHttpServerDefinition,
} from './schema.js'
import type {
  McpImportIssue, McpImportSource, McpImportSummary,
} from './types.js'
import { inspectMcpConfig } from './validation.js'

/** One converted, fully-defaulted external server definition. */
export interface McpImportCandidate {
  source: McpImportSource
  scope: McpImportIssue['scope']
  serverName: string
  definition: ServerDefinition
}

/** Explicit filesystem/environment inputs keep discovery deterministic in tests. */
export interface McpImportDiscoveryOptions {
  homeDir: string
  projectRoots: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  sources: readonly McpImportSource[]
}

/** Internal discovery answer before de-duplication against DSH settings. */
export interface McpImportDiscovery {
  candidates: McpImportCandidate[]
  found: Record<McpImportSource, boolean>
  skipped: number
  issues: McpImportIssue[]
}

interface SourceDocument {
  found: boolean
  value?: unknown
  issue?: McpImportIssue
}

/** Whether a value is a plain JSON/TOML table. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether an unknown filesystem error is a missing-path error. */
function isMissing(error: unknown): boolean {
  return isPlainObject(error) && error['code'] === 'ENOENT'
}

/** Read and decode one configuration document without returning its path. */
async function readDocument(
  path: string,
  source: McpImportSource,
  scope: McpImportIssue['scope'],
  decode: (text: string) => unknown,
): Promise<SourceDocument> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return { found: false }
    return { found: true, issue: { source, scope, code: 'source-unreadable' } }
  }
  try {
    return { found: true, value: decode(text) }
  } catch {
    return { found: true, issue: { source, scope, code: 'source-invalid' } }
  }
}

/** Locate the nearest named file from a project root without crawling siblings. */
async function findUp(start: string, segments: readonly string[]): Promise<string | undefined> {
  let directory = resolve(start)
  for (;;) {
    const candidate = join(directory, ...segments)
    try {
      if ((await stat(candidate)).isFile()) return candidate
    } catch (error) {
      if (!isMissing(error)) return candidate
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/** Dedupe and resolve project roots supplied by the running Host. */
function projectRoots(options: McpImportDiscoveryOptions): string[] {
  return [...new Set(options.projectRoots.map(root => resolve(root)))]
}

/** True when candidate is the same directory or a descendant of ancestor. */
function isWithin(candidate: string, ancestor: string): boolean {
  const path = relative(resolve(ancestor), resolve(candidate))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/** Read a plain record of server entries from a decoded document. */
function serverRecord(document: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(document)) return undefined
  const servers = document['mcpServers']
  return isPlainObject(servers) ? servers : undefined
}

/** Read a plain string map, or undefined when malformed. */
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {}
  if (!isPlainObject(value)) return undefined
  const entries = Object.entries(value)
  if (entries.some(([, item]) => typeof item !== 'string')) return undefined
  return Object.fromEntries(entries) as Record<string, string>
}

/** Read a string array, or undefined when malformed. */
function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return []
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? [...value]
    : undefined
}

/** Expand Claude Code's ${VAR} and ${VAR:-default} syntax. */
function expandClaudeString(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  let missing = false
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback: string | undefined) => {
    const current = env[name]
    if (current !== undefined) return current
    if (fallback !== undefined) return fallback
    missing = true
    return ''
  })
  return missing ? undefined : expanded
}

/** Expand one string map's keys and values. */
function expandClaudeRecord(
  value: Record<string, string>,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = expandClaudeString(rawKey, env)
    const item = expandClaudeString(rawValue, env)
    if (key === undefined || item === undefined) return undefined
    out[key] = item
  }
  return out
}

/** Convert one Claude Code entry to DSH's two supported transports. */
function convertClaudeServer(
  serverName: string,
  value: unknown,
  scope: McpImportIssue['scope'],
  env: Readonly<Record<string, string | undefined>>,
): { candidate?: McpImportCandidate; issue?: McpImportIssue } {
  const base = { source: 'claude-code' as const, scope, serverName }
  if (!isPlainObject(value)) return { issue: { ...base, code: 'server-invalid' } }
  const type = value['type']
  if (type !== undefined && typeof type !== 'string') return { issue: { ...base, code: 'server-invalid' } }
  if (type === 'sse' || type === 'ws' || type === 'websocket') {
    return { issue: { ...base, code: 'unsupported-transport' } }
  }

  const timeoutValue = value['timeout']
  const toolCallTimeoutMs = timeoutValue === undefined
    ? DEFAULT_TOOL_CALL_TIMEOUT_MS
    : typeof timeoutValue === 'number' && Number.isFinite(timeoutValue) && timeoutValue >= 1
      ? timeoutValue
      : undefined
  if (toolCallTimeoutMs === undefined) return { issue: { ...base, code: 'server-invalid' } }

  if (type === 'http' || type === 'streamable-http') {
    if (value['oauth'] !== undefined || value['headersHelper'] !== undefined) {
      return { issue: { ...base, code: 'unsupported-auth' } }
    }
    if (typeof value['url'] !== 'string') return { issue: { ...base, code: 'server-invalid' } }
    const headers = stringRecord(value['headers'])
    if (headers === undefined) return { issue: { ...base, code: 'server-invalid' } }
    const url = expandClaudeString(value['url'], env)
    const expandedHeaders = expandClaudeRecord(headers, env)
    if (url === undefined || expandedHeaders === undefined) {
      return { issue: { ...base, code: 'environment-missing' } }
    }
    const definition: StreamableHttpServerDefinition = {
      transport: 'streamable-http',
      url,
      headers: expandedHeaders,
      toolCallTimeoutMs,
    }
    if (inspectMcpConfig({ servers: { [serverName]: definition } }).issues.some(issue => issue.severity === 'error')) {
      return { issue: { ...base, code: 'server-invalid' } }
    }
    return { candidate: { ...base, definition } }
  }

  // Claude Code treats an omitted type as stdio. A URL without a type is a
  // documented configuration error and must not be guessed as HTTP.
  if (type !== undefined && type !== 'stdio') return { issue: { ...base, code: 'unsupported-transport' } }
  if (value['url'] !== undefined) return { issue: { ...base, code: 'server-invalid' } }
  if (typeof value['command'] !== 'string') return { issue: { ...base, code: 'server-invalid' } }
  const args = stringArray(value['args'])
  const rawEnv = stringRecord(value['env'])
  if (args === undefined || rawEnv === undefined) return { issue: { ...base, code: 'server-invalid' } }
  const command = expandClaudeString(value['command'], env)
  const expandedArgs = args.map(argument => expandClaudeString(argument, env))
  const expandedEnv = expandClaudeRecord(rawEnv, env)
  const rawCwd = value['cwd']
  const cwd = rawCwd === undefined ? '' : typeof rawCwd === 'string' ? expandClaudeString(rawCwd, env) : undefined
  if (command === undefined || expandedArgs.some(argument => argument === undefined) || expandedEnv === undefined || cwd === undefined) {
    return { issue: { ...base, code: 'environment-missing' } }
  }
  const definition: StdioServerDefinition = {
    transport: 'stdio',
    command,
    args: expandedArgs as string[],
    env: expandedEnv,
    cwd,
    toolCallTimeoutMs,
  }
  if (inspectMcpConfig({ servers: { [serverName]: definition } }).issues.some(issue => issue.severity === 'error')) {
    return { issue: { ...base, code: 'server-invalid' } }
  }
  return { candidate: { ...base, definition } }
}

/** Add a record to a scope-resolved Claude map; later (higher) scopes replace names. */
function mergeClaudeRecord(
  target: Map<string, { value: unknown; scope: McpImportIssue['scope']; projectRoot?: string }>,
  record: Record<string, unknown> | undefined,
  scope: McpImportIssue['scope'],
  projectRoot?: string,
): void {
  if (record === undefined) return
  for (const [serverName, value] of Object.entries(record)) {
    target.set(serverName, { value, scope, ...(projectRoot === undefined ? {} : { projectRoot }) })
  }
}

/** Discover Claude Code user, project, and local-scope servers. */
async function discoverClaude(options: McpImportDiscoveryOptions): Promise<McpImportDiscovery> {
  const found = { 'claude-code': false, codex: false }
  const issues: McpImportIssue[] = []
  const resolved = new Map<string, { value: unknown; scope: McpImportIssue['scope']; projectRoot?: string }>()
  const roots = projectRoots(options)
  const userPath = join(options.homeDir, '.claude.json')
  const user = await readDocument(userPath, 'claude-code', 'user', JSON.parse)
  found['claude-code'] ||= user.found
  if (user.issue !== undefined) issues.push(user.issue)
  if (user.value !== undefined) {
    mergeClaudeRecord(resolved, serverRecord(user.value), 'user')
  }

  // Project scope overrides user scope.
  const projectFiles = new Map<string, string>()
  for (const root of roots) {
    const path = await findUp(root, ['.mcp.json'])
    if (path !== undefined) projectFiles.set(path, dirname(path))
  }
  for (const [path, root] of projectFiles) {
    const document = await readDocument(path, 'claude-code', 'project', JSON.parse)
    found['claude-code'] ||= document.found
    if (document.issue !== undefined) issues.push(document.issue)
    if (document.value !== undefined) {
      const record = serverRecord(document.value)
      if (record === undefined) issues.push({ source: 'claude-code', scope: 'project', code: 'source-invalid' })
      else mergeClaudeRecord(resolved, record, 'project', root)
    }
  }

  // Local scope in ~/.claude.json has highest precedence, but only for the
  // running Host's project roots; unrelated projects are never imported.
  if (isPlainObject(user.value) && isPlainObject(user.value['projects'])) {
    const projects = user.value['projects']
    for (const root of roots) {
      const match = Object.keys(projects)
        .filter(project => isWithin(root, project))
        .sort((a, b) => resolve(b).length - resolve(a).length)[0]
      if (match === undefined) continue
      const project = projects[match]
      if (!isPlainObject(project)) continue
      mergeClaudeRecord(resolved, serverRecord(project), 'local', match)
    }
  }

  const candidates: McpImportCandidate[] = []
  let skipped = 0
  for (const [serverName, entry] of resolved) {
    const env = entry.projectRoot === undefined
      ? options.env
      : { ...options.env, CLAUDE_PROJECT_DIR: entry.projectRoot }
    const converted = convertClaudeServer(serverName, entry.value, entry.scope, env)
    if (converted.candidate !== undefined) candidates.push(converted.candidate)
    else skipped += 1
    if (converted.issue !== undefined) issues.push(converted.issue)
  }
  return { candidates, found, skipped, issues }
}

/** Whether a Codex entry declares options DSH cannot carry through. */
function hasIgnoredCodexOptions(value: Record<string, unknown>): boolean {
  return [
    'default_tools_approval_mode', 'disabled_tools', 'enabled_tools', 'required',
    'startup_timeout_ms', 'startup_timeout_sec', 'tools',
  ].some(field => value[field] !== undefined)
}

/** Resolve one Codex environment variable reference. */
function readEnvironment(
  name: string,
  options: McpImportDiscoveryOptions,
): string | undefined {
  return options.env[name]
}

/** Convert one Codex mcp_servers entry. */
function convertCodexServer(
  serverName: string,
  value: unknown,
  scope: McpImportIssue['scope'],
  options: McpImportDiscoveryOptions,
): { candidate?: McpImportCandidate; issue?: McpImportIssue; warning?: McpImportIssue } {
  const base = { source: 'codex' as const, scope, serverName }
  if (!isPlainObject(value)) return { issue: { ...base, code: 'server-invalid' } }
  if (value['enabled'] === false) return { issue: { ...base, code: 'disabled' } }
  if (value['enabled'] !== undefined && typeof value['enabled'] !== 'boolean') {
    return { issue: { ...base, code: 'server-invalid' } }
  }
  if (value['experimental_environment'] === 'remote') {
    return { issue: { ...base, code: 'unsupported-transport' } }
  }
  const command = value['command']
  const url = value['url']
  if ((command === undefined) === (url === undefined)) return { issue: { ...base, code: 'server-invalid' } }
  const timeout = value['tool_timeout_sec']
  const toolCallTimeoutMs = timeout === undefined
    ? DEFAULT_TOOL_CALL_TIMEOUT_MS
    : typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
      ? timeout * 1_000
      : undefined
  if (toolCallTimeoutMs === undefined) return { issue: { ...base, code: 'server-invalid' } }
  const warning = hasIgnoredCodexOptions(value) ? { ...base, code: 'ignored-options' as const } : undefined

  if (typeof command === 'string') {
    const args = stringArray(value['args'])
    const explicitEnv = stringRecord(value['env'])
    if (args === undefined || explicitEnv === undefined) return { issue: { ...base, code: 'server-invalid' } }
    const inheritedEnv: Record<string, string> = {}
    const envVars = value['env_vars']
    if (envVars !== undefined) {
      if (!Array.isArray(envVars)) return { issue: { ...base, code: 'server-invalid' } }
      for (const item of envVars) {
        const name = typeof item === 'string'
          ? item
          : isPlainObject(item) && typeof item['name'] === 'string' && (item['source'] === undefined || item['source'] === 'local')
            ? item['name']
            : undefined
        if (name === undefined) return { issue: { ...base, code: 'unsupported-transport' } }
        const resolved = readEnvironment(name, options)
        if (resolved === undefined) return { issue: { ...base, code: 'environment-missing' } }
        inheritedEnv[name] = resolved
      }
    }
    const cwd = value['cwd'] === undefined ? '' : value['cwd']
    if (typeof cwd !== 'string') return { issue: { ...base, code: 'server-invalid' } }
    const definition: StdioServerDefinition = {
      transport: 'stdio', command, args, env: { ...inheritedEnv, ...explicitEnv }, cwd, toolCallTimeoutMs,
    }
    if (inspectMcpConfig({ servers: { [serverName]: definition } }).issues.some(issue => issue.severity === 'error')) {
      return { issue: { ...base, code: 'server-invalid' } }
    }
    return { candidate: { ...base, definition }, warning }
  }

  if (typeof url !== 'string') return { issue: { ...base, code: 'server-invalid' } }
  if (value['oauth_resource'] !== undefined || value['scopes'] !== undefined) {
    return { issue: { ...base, code: 'unsupported-auth' } }
  }
  const headers = stringRecord(value['http_headers'])
  const envHeaders = stringRecord(value['env_http_headers'])
  if (headers === undefined || envHeaders === undefined) return { issue: { ...base, code: 'server-invalid' } }
  const resolvedHeaders = { ...headers }
  for (const [header, variable] of Object.entries(envHeaders)) {
    const resolved = readEnvironment(variable, options)
    if (resolved === undefined) return { issue: { ...base, code: 'environment-missing' } }
    resolvedHeaders[header] = resolved
  }
  const bearerVariable = value['bearer_token_env_var']
  if (bearerVariable !== undefined) {
    if (typeof bearerVariable !== 'string') return { issue: { ...base, code: 'server-invalid' } }
    const token = readEnvironment(bearerVariable, options)
    if (token === undefined) return { issue: { ...base, code: 'environment-missing' } }
    if (resolvedHeaders['Authorization'] === undefined) resolvedHeaders['Authorization'] = `Bearer ${token}`
  }
  const definition: StreamableHttpServerDefinition = {
    transport: 'streamable-http', url, headers: resolvedHeaders, toolCallTimeoutMs,
  }
  if (inspectMcpConfig({ servers: { [serverName]: definition } }).issues.some(issue => issue.severity === 'error')) {
    return { issue: { ...base, code: 'server-invalid' } }
  }
  return { candidate: { ...base, definition }, warning }
}

/** Read one TOML mcp_servers record. */
function codexServerRecord(document: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(document)) return undefined
  const servers = document['mcp_servers']
  return isPlainObject(servers) ? servers : undefined
}

/** Whether a decoded Codex document contains a malformed `mcp_servers` table. */
function hasInvalidCodexServerRecord(document: unknown): boolean {
  return document !== undefined && (
    !isPlainObject(document)
    || (document['mcp_servers'] !== undefined && !isPlainObject(document['mcp_servers']))
  )
}

/** Discover global and nearest project Codex configuration. */
async function discoverCodex(options: McpImportDiscoveryOptions): Promise<McpImportDiscovery> {
  const found = { 'claude-code': false, codex: false }
  const issues: McpImportIssue[] = []
  const resolved = new Map<string, { value: unknown; scope: McpImportIssue['scope'] }>()
  const configuredHome = options.env['CODEX_HOME']
  const userPath = join(configuredHome === undefined ? join(options.homeDir, '.codex') : configuredHome, 'config.toml')
  const user = await readDocument(userPath, 'codex', 'user', parseToml)
  found.codex ||= user.found
  if (user.issue !== undefined) issues.push(user.issue)
  if (hasInvalidCodexServerRecord(user.value)) {
    issues.push({ source: 'codex', scope: 'user', code: 'source-invalid' })
  }
  for (const [serverName, value] of Object.entries(codexServerRecord(user.value) ?? {})) {
    resolved.set(serverName, { value, scope: 'user' })
  }

  const projectFiles = new Set<string>()
  for (const root of projectRoots(options)) {
    const path = await findUp(root, ['.codex', 'config.toml'])
    if (path !== undefined && resolve(path) !== resolve(userPath)) projectFiles.add(path)
  }
  for (const path of projectFiles) {
    const document = await readDocument(path, 'codex', 'project', parseToml)
    found.codex ||= document.found
    if (document.issue !== undefined) issues.push(document.issue)
    const record = codexServerRecord(document.value)
    if (hasInvalidCodexServerRecord(document.value)) {
      issues.push({ source: 'codex', scope: 'project', code: 'source-invalid' })
    }
    for (const [serverName, value] of Object.entries(record ?? {})) {
      resolved.set(serverName, { value, scope: 'project' })
    }
  }

  const candidates: McpImportCandidate[] = []
  let skipped = 0
  for (const [serverName, entry] of resolved) {
    const converted = convertCodexServer(serverName, entry.value, entry.scope, options)
    if (converted.candidate !== undefined) candidates.push(converted.candidate)
    else skipped += 1
    if (converted.issue !== undefined) issues.push(converted.issue)
    if (converted.warning !== undefined) issues.push(converted.warning)
  }
  return { candidates, found, skipped, issues }
}

/** Discover and convert the requested external configuration families. */
export async function discoverMcpImports(options: McpImportDiscoveryOptions): Promise<McpImportDiscovery> {
  const requested = [...new Set(options.sources)]
  const parts: McpImportDiscovery[] = []
  if (requested.includes('claude-code')) parts.push(await discoverClaude(options))
  if (requested.includes('codex')) parts.push(await discoverCodex(options))
  return parts.reduce<McpImportDiscovery>((combined, part) => ({
    candidates: [...combined.candidates, ...part.candidates],
    found: {
      'claude-code': combined.found['claude-code'] || part.found['claude-code'],
      codex: combined.found.codex || part.found.codex,
    },
    skipped: combined.skipped + part.skipped,
    issues: [...combined.issues, ...part.issues],
  }), {
    candidates: [],
    found: { 'claude-code': false, codex: false },
    skipped: 0,
    issues: [],
  })
}

/** Recursively sort JSON object keys so semantic map order does not affect de-duplication. */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]))
}

/** Exact normalized-definition identity, kept only in Host memory. */
function fingerprint(definition: ServerDefinition): string {
  return JSON.stringify(canonicalJson(definition))
}

/** Convert an external name into the mcp-client serverName contract. */
export function sanitizeServerName(name: string): string {
  const normalized = name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return SERVER_NAME_PATTERN.test(normalized) ? normalized : 'imported-mcp'
}

/** Allocate a non-colliding name while respecting the 32-character limit. */
function uniqueServerName(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base
  for (let ordinal = 2; ; ordinal += 1) {
    const suffix = `-${String(ordinal)}`
    const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

/**
 * Merge candidates into a settings record with content and name de-duplication.
 * @param current - authoritative, unmasked DSH definitions.
 * @param discovery - converted external definitions and safe diagnostics.
 * @returns the definitions to add plus the browser-safe summary.
 */
export function planMcpImports(
  current: Record<string, ServerDefinition>,
  discovery: McpImportDiscovery,
): { additions: Record<string, ServerDefinition>; summary: McpImportSummary } {
  const existingNames = new Set(Object.keys(current))
  const used = new Set(existingNames)
  const fingerprints = new Set(Object.values(current).map(fingerprint))
  const additions: Record<string, ServerDefinition> = {}
  const importedNames: string[] = []
  let duplicates = 0
  let renamed = 0
  for (const candidate of discovery.candidates) {
    const identity = fingerprint(candidate.definition)
    if (fingerprints.has(identity)) {
      duplicates += 1
      continue
    }
    const base = sanitizeServerName(candidate.serverName)
    // The DSH settings record is authoritative. A differently configured
    // external server must never displace it or sneak in under a suffix.
    if (existingNames.has(base)) {
      duplicates += 1
      continue
    }
    const serverName = uniqueServerName(base, used)
    if (serverName !== candidate.serverName) renamed += 1
    used.add(serverName)
    fingerprints.add(identity)
    additions[serverName] = candidate.definition
    importedNames.push(serverName)
  }
  return {
    additions,
    summary: {
      imported: importedNames.length,
      duplicates,
      renamed,
      skipped: discovery.skipped,
      found: discovery.found,
      importedNames,
      issues: discovery.issues.map(issue => issue.serverName === undefined
        ? issue
        : {
          ...issue,
          serverName: issue.serverName.replace(/[\u0000-\u001F\u007F]/g, '�').slice(0, 80),
        }),
    },
  }
}
