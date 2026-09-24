/**
 * The `mcpConfig` Typert Remote: this plugin's own configuration face over
 * the MCP Loader entry settings namespace. The Host's settings RPC exposes an explicit
 * allowlist a third-party plugin cannot extend, so this Remote is the
 * portable path: any composition mounting the Typert Gateway (the dsh-base
 * layer) serves `mcpConfig/describe` and `mcpConfig/mutate` to configuration
 * clients with no host-side change.
 *
 * Reads are masked: every `env` value and every `headers` value is replaced
 * by {@link SECRET_MASK}, because those fields carry credentials while this
 * endpoint sits behind the trusted-host fence rather than the loopback pin
 * the settings RPC applies. Writes are path-addressed ops, so a client never
 * restates a masked value it read. Existing-server edits are applied to the
 * Host's unmasked record before one revision-fenced settings mutation.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { discoverMcpImports, planMcpImports } from './importers.js'
import { LEGACY_MCP_SETTINGS_NAMESPACE, MCP_SETTINGS_NAMESPACE, SERVER_NAME_PATTERN, type Config, type ServerDefinition } from './schema.js'
import type {
  McpConfigView, McpImportOutcome, McpImportRequest, McpImportSource,
  McpMutateOutcome, McpMutateRequest, McpMutateWireOp, McpServerFieldOp,
} from './types.js'
import { inspectMcpConfig } from './validation.js'

/** Mask a describe returns in place of every `env`/`headers` value. */
export const SECRET_MASK = '••••'

/** Whether a value is a plain object (the wire request's container shape). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate one mutate request at the wire boundary and type it for the
 * settings seam. Everything past this point is same-process and typed.
 * @param request - the decoded RPC argument.
 * @returns the validated ops and expected revision.
 */
function assertMutateRequest(request: unknown): McpMutateRequest {
  if (!isPlainObject(request)) {
    throw new TypeError('mcpConfig/mutate: request must be a plain object')
  }
  const { ops, expectedRevision } = request
  if (!Array.isArray(ops)) {
    throw new TypeError('mcpConfig/mutate: request.ops must be an array of path ops')
  }
  for (const op of ops) {
    if (!isPlainObject(op) || (op['op'] !== 'set' && op['op'] !== 'unset' && op['op'] !== 'edit')) {
      throw new TypeError('mcpConfig/mutate: unsupported server operation')
    }
    if (!isServerPath(op['path'])) {
      throw new TypeError('mcpConfig/mutate: each op must address one valid server name')
    }
    if (op['op'] === 'set') {
      if (!isServerDefinition(op['value'])) {
        throw new TypeError('mcpConfig/mutate: a set op must carry a server definition')
      }
    }
    if (op['op'] === 'edit') assertEditOp(op)
  }
  if (expectedRevision !== undefined && (
    typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 0
  )) {
    throw new TypeError('mcpConfig/mutate: expectedRevision must be a non-negative integer when present')
  }
  return {
    ops: ops as McpMutateRequest['ops'],
    ...expectedRevision === undefined ? {} : { expectedRevision },
  }
}

/** Require an exact server path, never a section root or arbitrary nested field. */
function isServerPath(path: unknown): path is [string, string] {
  return Array.isArray(path) && path.length === 2 && path[0] === 'servers'
    && typeof path[1] === 'string' && SERVER_NAME_PATTERN.test(path[1])
}

/** The settings schema validates the remaining fields and their values. */
function isServerDefinition(value: unknown): boolean {
  return isPlainObject(value)
    && (value['transport'] === 'stdio' || value['transport'] === 'streamable-http')
}

/** Admit only known fields in a masked client's existing-server edit. */
function assertEditOp(op: Record<string, unknown>): void {
  if (typeof op['nextName'] !== 'string' || !SERVER_NAME_PATTERN.test(op['nextName'])) {
    throw new TypeError('mcpConfig/mutate: edited server name is invalid')
  }
  const changes = op['changes']
  if (!Array.isArray(changes)) throw new TypeError('mcpConfig/mutate: edit changes must be an array')
  if (op['replacement'] !== undefined && (!isServerDefinition(op['replacement']) || changes.length > 0)) {
    throw new TypeError('mcpConfig/mutate: transport replacement must be a complete server without field changes')
  }
  for (const change of changes) {
    if (!isPlainObject(change) || (change['op'] !== 'set' && change['op'] !== 'unset')
      || !Array.isArray(change['path'])) {
      throw new TypeError('mcpConfig/mutate: invalid server field edit')
    }
    const path = change['path'] as unknown[]
    const scalar = path.length === 1 && typeof path[0] === 'string'
      && ['command', 'args', 'cwd', 'url', 'toolCallTimeoutMs'].includes(path[0])
    const secret = path.length === 2 && (path[0] === 'env' || path[0] === 'headers')
      && typeof path[1] === 'string' && path[1] !== ''
      && path[1] !== '__proto__' && path[1] !== 'constructor' && path[1] !== 'prototype'
    if (!scalar && !secret) throw new TypeError('mcpConfig/mutate: unsupported server field path')
    if (change['op'] === 'set') {
      const value = change['value']
      if (secret && typeof value !== 'string') throw new TypeError('mcpConfig/mutate: secret field value must be text')
      if (scalar && path[0] === 'args' && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) {
        throw new TypeError('mcpConfig/mutate: args must be text entries')
      }
      if (scalar && path[0] === 'toolCallTimeoutMs' && (!Number.isSafeInteger(value) || (value as number) < 1)) {
        throw new TypeError('mcpConfig/mutate: timeout must be a positive integer')
      }
      if (scalar && path[0] !== 'args' && path[0] !== 'toolCallTimeoutMs' && typeof value !== 'string') {
        throw new TypeError('mcpConfig/mutate: server field value must be text')
      }
    }
  }
}

/** Expand edits against unmasked resolved values; only expanded settings ops persist. */
function expandMutations(
  ops: readonly McpMutateWireOp[],
  servers: Config['servers'],
  inheritedNames: ReadonlySet<string>,
): SettingsPathOp[] {
  const working = new Map<string, ServerDefinition>(Object.entries(servers).map(([name, definition]) => (
    [name, structuredClone(definition)]
  )))
  const expanded: SettingsPathOp[] = []
  for (const op of ops) {
    const serverName = op.path[1]!
    if (op.op === 'set') {
      if (working.has(serverName)) throw new TypeError(`mcpConfig/mutate: server "${serverName}" already exists; edit it instead`)
      expanded.push({ op: 'set', path: op.path, value: op.value })
      working.set(serverName, op.value as ServerDefinition)
      continue
    }
    if (op.op === 'unset') {
      if (inheritedNames.has(serverName)) {
        throw new TypeError(`mcpConfig/mutate: inherited server "${serverName}" cannot be removed from user settings`)
      }
      expanded.push({ op: 'unset', path: op.path })
      working.delete(serverName)
      continue
    }
    const original = working.get(serverName)
    if (original === undefined) throw new TypeError(`mcpConfig/mutate: server "${serverName}" no longer exists`)
    if (op.nextName !== serverName && inheritedNames.has(serverName)) {
      throw new TypeError(`mcpConfig/mutate: inherited server "${serverName}" cannot be renamed from user settings`)
    }
    if (op.nextName !== serverName && working.has(op.nextName)) {
      throw new TypeError(`mcpConfig/mutate: server "${op.nextName}" already exists`)
    }
    const next = op.replacement === undefined
      ? applyServerChanges(original, op.changes)
      : op.replacement as ServerDefinition
    expanded.push({ op: 'set', path: ['servers', op.nextName], value: next })
    if (op.nextName !== serverName) {
      expanded.push({ op: 'unset', path: op.path })
      working.delete(serverName)
    }
    working.set(op.nextName, next)
  }
  return expanded
}

/** Apply vetted field ops to a private unmasked copy of the server. */
function applyServerChanges(server: ServerDefinition, changes: readonly McpServerFieldOp[]): ServerDefinition {
  const next = structuredClone(server) as unknown as Record<string, unknown>
  for (const change of changes) {
    const [field, key] = change.path
    if (field === undefined) throw new TypeError('mcpConfig/mutate: empty server field path')
    if ((field === 'env' && server.transport !== 'stdio')
      || (field === 'headers' && server.transport !== 'streamable-http')
      || (field === 'command' || field === 'args' || field === 'cwd') && server.transport !== 'stdio'
      || field === 'url' && server.transport !== 'streamable-http') {
      throw new TypeError('mcpConfig/mutate: field does not belong to this transport')
    }
    if (key === undefined) {
      if (change.op === 'set') next[field] = change.value
      else delete next[field]
    } else {
      const map = next[field]
      if (!isPlainObject(map)) throw new TypeError('mcpConfig/mutate: server secret map is invalid')
      if (change.op === 'set') map[key] = change.value
      else delete map[key]
    }
  }
  return next as unknown as ServerDefinition
}

/** Validate the import request at the Remote wire boundary. */
function assertImportRequest(request: unknown): McpImportRequest {
  if (!isPlainObject(request) || !Array.isArray(request['sources'])) {
    throw new TypeError('mcpConfig/import: request must be { sources, expectedRevision? }')
  }
  const allowed: readonly McpImportSource[] = ['claude-code', 'codex']
  const sources = request['sources']
  if (sources.length === 0 || sources.some(source => !allowed.includes(source as McpImportSource))) {
    throw new TypeError('mcpConfig/import: sources must contain claude-code and/or codex')
  }
  const expectedRevision = request['expectedRevision']
  if (expectedRevision !== undefined && (
    typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 0
  )) {
    throw new TypeError('mcpConfig/import: expectedRevision must be a non-negative integer when present')
  }
  return {
    sources: [...new Set(sources as McpImportSource[])],
    ...expectedRevision === undefined ? {} : { expectedRevision },
  }
}

/** Replace every value in a secrets record with the mask, keeping the keys visible. */
function maskSecrets(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(record).map(key => [key, SECRET_MASK]))
}

/** Mask one server definition's credential-bearing maps. */
function maskServer(definition: ServerDefinition): ServerDefinition {
  if (definition.transport === 'stdio') {
    return { ...definition, env: maskSecrets(definition.env) }
  }
  return { ...definition, headers: maskSecrets(definition.headers) }
}

/**
 * The masked projection of a server record for configuration clients.
 * @param servers - the resolved server record.
 * @returns each definition with `env`/`headers` values replaced by the mask.
 */
export function maskServers(servers: Record<string, ServerDefinition>): Record<string, ServerDefinition> {
  return Object.fromEntries(
    Object.entries(servers).map(([serverName, definition]) => [serverName, maskServer(definition)]),
  )
}

/** The plugin-owned Remote over the MCP Loader entry settings namespace. */
export class McpConfigRemote extends TypertRemoteService {
  /** The settings service this face reads and writes through. */
  static inject = ['settings']

  constructor(ctx: Context) {
    super(ctx, 'mcpConfig')
  }

  /** This namespace's descriptor, when its registration is live. */
  private descriptor(): { namespace: string; value: Config; revision: number; inheritedNames: ReadonlySet<string> } | undefined {
    const descriptor = this.ctx.settings.describe()
      .find(entry => entry.ns === MCP_SETTINGS_NAMESPACE || entry.ns === LEGACY_MCP_SETTINGS_NAMESPACE)
    if (descriptor === undefined) return undefined
    // The value carries this plugin's own registered schema; the seam types
    // it as unknown because it serves every registrant's schema alike.
    const base = descriptor.base as Partial<Config> | undefined
    return {
      namespace: descriptor.ns,
      value: descriptor.value as Config,
      revision: descriptor.revision,
      inheritedNames: new Set(Object.keys(base?.servers ?? {})),
    }
  }

  /**
   * Serve the masked MCP namespace view.
   * @returns the masked server record and its revision, or `registered: false`.
   */
  @Remote('describe')
  describe(): McpConfigView {
    const current = this.descriptor()
    if (current === undefined) return { registered: false }
    return {
      registered: true,
      servers: maskServers(current.value.servers),
      revision: current.revision,
      format: inspectMcpConfig(current.value),
    }
  }

  /**
   * Apply one batch of path edits under revision fencing. The parameter is
   * the wire shape; {@link assertMutateRequest} re-validates the decoded
   * value because the wire, not the signature, is the trust boundary.
   * @param request - ops plus the revision they were built against.
   * @returns the namespace's new revision, or the actual revision a stale
   *   request conflicted with.
   */
  @Remote('mutate')
  async mutate(request: McpMutateRequest): Promise<McpMutateOutcome> {
    const { ops, expectedRevision } = assertMutateRequest(request)
    const before = this.descriptor()
    if (before === undefined) return { kind: 'conflict', revision: 0 }
    if (expectedRevision !== undefined && expectedRevision !== before.revision) {
      return { kind: 'conflict', revision: before.revision }
    }
    const expanded = expandMutations(ops, before.value.servers, before.inheritedNames)
    try {
      await this.ctx.settings.mutate(
        before.namespace,
        expanded,
        expectedRevision,
      )
    } catch (error) {
      if (error instanceof SettingsConflictError) return { kind: 'conflict', revision: error.actual }
      throw error
    }
    const revision = this.descriptor()?.revision ?? 0
    return { kind: 'ok', revision }
  }

  /**
   * Discover Claude Code/Codex MCP configs, convert supported transports,
   * de-duplicate them against the unmasked authoritative record, and commit
   * additions atomically. Secret-bearing fields never cross this Remote.
   * @param request - requested families and the revision the user triggered from.
   * @returns a safe summary, or the current revision on a stale request.
   */
  @Remote('import')
  async importServers(request: McpImportRequest): Promise<McpImportOutcome> {
    const { sources, expectedRevision } = assertImportRequest(request)
    const before = this.descriptor()
    if (before === undefined) return { kind: 'conflict', revision: 0 }
    if (expectedRevision !== undefined && expectedRevision !== before.revision) {
      return { kind: 'conflict', revision: before.revision }
    }

    const roots = [process.cwd()]
    if (this.ctx.baseUrl !== undefined) {
      try {
        if (new URL(this.ctx.baseUrl).protocol === 'file:') roots.push(fileURLToPath(this.ctx.baseUrl))
      } catch {
        // A non-file or malformed composition base is not a project root; the
        // process cwd remains the explicit, bounded discovery anchor.
      }
    }
    const discovery = await discoverMcpImports({
      homeDir: homedir(),
      projectRoots: roots,
      env: process.env,
      sources,
    })
    const { additions, summary } = planMcpImports(before.value.servers, discovery)

    // Discovery can take long enough for another settings surface to commit.
    const latest = this.descriptor()
    if (latest === undefined || latest.revision !== before.revision) {
      return { kind: 'conflict', revision: latest?.revision ?? 0 }
    }
    const ops: SettingsPathOp[] = Object.entries(additions).map(([serverName, definition]) => ({
      op: 'set',
      path: ['servers', serverName],
      value: definition,
    }))
    if (ops.length > 0) {
      try {
        await this.ctx.settings.mutate(before.namespace, ops, before.revision)
      } catch (error) {
        if (error instanceof SettingsConflictError) return { kind: 'conflict', revision: error.actual }
        throw error
      }
    }
    return { kind: 'ok', revision: this.descriptor()?.revision ?? before.revision, summary }
  }
}
