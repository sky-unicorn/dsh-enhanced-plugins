/**
 * The `mcpConfig` Typert Remote: this plugin's own configuration face over
 * the `mcp` settings namespace. The Host's settings RPC exposes an explicit
 * allowlist a third-party plugin cannot extend, so this Remote is the
 * portable path: any composition mounting the Typert Gateway (the dsh-base
 * layer) serves `mcpConfig/describe` and `mcpConfig/mutate` to configuration
 * clients with no host-side change.
 *
 * Reads are masked: every `env` value and every `headers` value is replaced
 * by {@link SECRET_MASK}, because those fields carry credentials while this
 * endpoint sits behind the trusted-host fence rather than the loopback pin
 * the settings RPC applies. Writes are path-addressed ops, so a client never
 * restates a masked value it read - it sends only the servers it added or
 * removed, and untouched entries keep their stored secrets.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { discoverMcpImports, planMcpImports } from './importers.js'
import { MCP_SETTINGS_NAMESPACE, type Config, type ServerDefinition } from './schema.js'
import type {
  McpConfigView, McpImportOutcome, McpImportRequest, McpImportSource,
  McpMutateOutcome, McpMutateRequest,
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
    if (!isPlainObject(op) || (op['op'] !== 'set' && op['op'] !== 'unset')) {
      throw new TypeError('mcpConfig/mutate: each op must be { op: \'set\' | \'unset\', path }')
    }
    if (!Array.isArray(op['path']) || op['path'].some(part => typeof part !== 'string')) {
      throw new TypeError('mcpConfig/mutate: each op path must be an array of strings')
    }
    if (op['op'] === 'set') {
      // The transport discriminant is the one shape fact this face relies on;
      // the settings schema owns every deeper validation.
      if (!isPlainObject(op['value']) || typeof op['value']['transport'] !== 'string') {
        throw new TypeError('mcpConfig/mutate: a set op must carry a server definition')
      }
    }
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

/** The plugin-owned Remote over the `mcp` settings namespace. */
export class McpConfigRemote extends TypertRemoteService {
  /** The settings service this face reads and writes through. */
  static inject = ['settings']

  constructor(ctx: Context) {
    super(ctx, 'mcpConfig')
  }

  /** This namespace's descriptor, when its registration is live. */
  private descriptor(): { value: Config; revision: number } | undefined {
    const descriptor = this.ctx.settings.describe()
      .find(entry => entry.ns === MCP_SETTINGS_NAMESPACE)
    if (descriptor === undefined) return undefined
    // The value carries this plugin's own registered schema; the seam types
    // it as unknown because it serves every registrant's schema alike.
    return { value: descriptor.value as Config, revision: descriptor.revision }
  }

  /**
   * Serve the masked `mcp` namespace view.
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
    try {
      await this.ctx.settings.mutate(
        MCP_SETTINGS_NAMESPACE,
        ops as readonly SettingsPathOp[],
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
        await this.ctx.settings.mutate(MCP_SETTINGS_NAMESPACE, ops, before.revision)
      } catch (error) {
        if (error instanceof SettingsConflictError) return { kind: 'conflict', revision: error.actual }
        throw error
      }
    }
    return { kind: 'ok', revision: this.descriptor()?.revision ?? before.revision, summary }
  }
}
