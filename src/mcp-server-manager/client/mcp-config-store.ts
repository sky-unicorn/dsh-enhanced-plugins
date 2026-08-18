/**
 * The `mcpConfig` Remote store: the client-side snapshot source behind the
 * MCP settings card.
 *
 * The card cannot use the shared settings scope: the Host's settings RPC
 * serves an explicit allowlist a plugin cannot extend, so reads and writes
 * cross the wire through the MCP manager's own `mcpConfig` Typert Remote
 * (`mcpConfig/describe` and `mcpConfig/mutate` on the shared `/api`
 * channel). Writes are path-addressed ops built from the staged draft, and
 * the view this store serves carries `env`/`headers` values already masked
 * by the Host - the card never sees a stored credential.
 */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { McpServer, McpSettings } from './mcp-card-controller.ts'

/** Stable format diagnostic codes emitted by the Host. */
export type McpFormatIssueCode =
  | 'invalid-name' | 'missing-command' | 'invalid-url' | 'invalid-timeout'
  | 'invalid-header-name' | 'invalid-character' | 'surrounding-whitespace'

/** One value-free format issue. */
export interface McpFormatIssue {
  serverName: string
  field: string
  code: McpFormatIssueCode
  severity: 'error' | 'warning'
}

/** Current resolved MCP record audit. */
export interface McpFormatReport {
  valid: boolean
  serverCount: number
  issues: McpFormatIssue[]
}

/** External configuration families the import Remote accepts. */
export type McpImportSource = 'claude-code' | 'codex'

/** Stable external-import problem codes. */
export type McpImportIssueCode =
  | 'source-unreadable' | 'source-invalid' | 'server-invalid' | 'unsupported-transport'
  | 'unsupported-auth' | 'environment-missing' | 'disabled' | 'ignored-options'

/** One value-free import diagnostic. */
export interface McpImportIssue {
  source: McpImportSource
  scope: 'user' | 'project' | 'local'
  serverName?: string
  code: McpImportIssueCode
}

/** Safe summary returned after Host-side import and de-duplication. */
export interface McpImportSummary {
  imported: number
  /** Exact definitions or names already owned by the current DSH configuration. */
  duplicates: number
  renamed: number
  skipped: number
  found: Record<McpImportSource, boolean>
  importedNames: string[]
  issues: McpImportIssue[]
}

const FORMAT_ISSUE_CODES: ReadonlySet<string> = new Set<McpFormatIssueCode>([
  'invalid-name', 'missing-command', 'invalid-url', 'invalid-timeout',
  'invalid-header-name', 'invalid-character', 'surrounding-whitespace',
])

const IMPORT_ISSUE_CODES: ReadonlySet<string> = new Set<McpImportIssueCode>([
  'source-unreadable', 'source-invalid', 'server-invalid', 'unsupported-transport',
  'unsupported-auth', 'environment-missing', 'disabled', 'ignored-options',
])

/** One path edit the `mcpConfig/mutate` wire accepts (the settings path-op shape). */
export interface McpWireOp {
  /** The edit to perform. */
  op: 'set' | 'unset'
  /** Dotted path inside the `mcp` section, starting at a field name. */
  path: string[]
  /** The value a `set` writes. */
  value?: unknown
}

/** One `mcpConfig/describe` answer (the Host-owned view shape). */
interface McpConfigView {
  registered: boolean
  servers?: Record<string, McpServer>
  revision?: number
  format?: McpFormatReport
}

/** What the card renders of the `mcp` namespace right now. */
export interface McpConfigSnapshot {
  /** `ready` while the manager serves the namespace; otherwise nothing renders. */
  status: 'pending' | 'ready' | 'unsupported'
  /** Whether writes are accepted. */
  writable: boolean
  /** The masked resolved section, present while ready. */
  value?: McpSettings
  /** The revision a write must restate to refuse a stale edit. */
  revision?: number
  /** Host-side format audit, with no field values. */
  format?: McpFormatReport
}

/** Whether a value is a plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a wire count is a non-negative integer. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Validate one describe answer at the wire boundary.
 * @param value - the decoded RPC result value.
 * @returns the typed view.
 */
function assertView(value: unknown): McpConfigView {
  if (!isPlainObject(value) || typeof value['registered'] !== 'boolean') {
    throw new Error('mcpConfig/describe: answer must be { registered, servers?, revision? }')
  }
  const servers = value['servers']
  if (servers !== undefined && !isPlainObject(servers)) {
    throw new Error('mcpConfig/describe: servers must be a plain record')
  }
  const revision = value['revision']
  if (revision !== undefined && typeof revision !== 'number') {
    throw new Error('mcpConfig/describe: revision must be a number')
  }
  const format = value['format']
  if (format !== undefined) assertFormatReport(format)
  return value as unknown as McpConfigView
}

/** Validate a value-free format report from the Remote. */
function assertFormatReport(value: unknown): asserts value is McpFormatReport {
  if (
    !isPlainObject(value)
    || typeof value['valid'] !== 'boolean'
    || !isCount(value['serverCount'])
  ) {
    throw new Error('mcpConfig/describe: format must be a format report')
  }
  const issues = value['issues']
  if (!Array.isArray(issues) || issues.some(issue => (
    !isPlainObject(issue)
    || typeof issue['serverName'] !== 'string'
    || typeof issue['field'] !== 'string'
    || typeof issue['code'] !== 'string'
    || !FORMAT_ISSUE_CODES.has(issue['code'])
    || (issue['severity'] !== 'error' && issue['severity'] !== 'warning')
  ))) {
    throw new Error('mcpConfig/describe: format.issues must be value-free diagnostics')
  }
}

/** Validate the safe summary returned by mcpConfig/import. */
function assertImportSummary(value: unknown): McpImportSummary | undefined {
  if (!isPlainObject(value)) return undefined
  if (['imported', 'duplicates', 'renamed', 'skipped'].some(field => !isCount(value[field]))) return undefined
  if (!isPlainObject(value['found']) || typeof value['found']['claude-code'] !== 'boolean' || typeof value['found']['codex'] !== 'boolean') {
    return undefined
  }
  if (!Array.isArray(value['importedNames']) || value['importedNames'].some(name => typeof name !== 'string')) return undefined
  if (!Array.isArray(value['issues']) || value['issues'].some(issue => (
    !isPlainObject(issue)
    || (issue['source'] !== 'claude-code' && issue['source'] !== 'codex')
    || (issue['scope'] !== 'user' && issue['scope'] !== 'project' && issue['scope'] !== 'local')
    || (issue['serverName'] !== undefined && typeof issue['serverName'] !== 'string')
    || typeof issue['code'] !== 'string'
    || !IMPORT_ISSUE_CODES.has(issue['code'])
  ))) return undefined
  return value as unknown as McpImportSummary
}

/**
 * Snapshot store over the `mcpConfig` Remote. One instance backs one card;
 * refreshes run on construction, after every write, and on the forwarded
 * `settings/document-updated` event the browser runtime delivers.
 */
export class McpConfigStore {
  private snapshot: McpConfigSnapshot = { status: 'pending', writable: false }
  private readonly listeners = new Set<() => void>()

  /** @param rpc - the connection's generic logical-RPC caller. */
  constructor(private readonly rpc: ClientConnectionRpc) {}

  /**
   * The current snapshot.
   * @returns the most recently served view of the namespace.
   */
  getSnapshot(): McpConfigSnapshot {
    return this.snapshot
  }

  /**
   * Subscribe to snapshot changes.
   * @param listener - called after every settled refresh or write.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Read the namespace through the Remote and publish what came back.
   * @returns settlement after the view is applied.
   */
  async refresh(): Promise<void> {
    const result = await this.rpc.call('/api', 'mcpConfig/describe', { args: {} })
    if (!result.ok) {
      // The manager (or its Remote) is absent from this composition; the card
      // renders nothing rather than retrying a namespace nobody serves.
      this.snapshot = { status: 'unsupported', writable: false }
      this.publish()
      return
    }
    const view = assertView(result.value)
    this.snapshot = view.registered && view.servers !== undefined
      ? {
        status: 'ready',
        writable: true,
        value: { servers: view.servers },
        revision: view.revision ?? 0,
        format: view.format ?? { valid: true, serverCount: Object.keys(view.servers).length, issues: [] },
      }
      : { status: 'unsupported', writable: false }
    this.publish()
  }

  /**
   * Apply one batch of path edits under revision fencing, then re-read.
   * @param ops - the edits the staged draft planned.
   * @param expectedRevision - the revision the draft was built against.
   * @returns whether the batch landed (false on conflict or refusal).
   */
  async mutate(ops: readonly McpWireOp[], expectedRevision: number | undefined): Promise<boolean> {
    const result = await this.rpc.call('/api', 'mcpConfig/mutate', {
      args: { request: { ops, expectedRevision } },
    })
    if (!result.ok) return false
    const outcome = result.value
    if (!isPlainObject(outcome) || (outcome['kind'] !== 'ok' && outcome['kind'] !== 'conflict')) {
      return false
    }
    await this.refresh()
    return outcome['kind'] === 'ok'
  }

  /**
   * Ask the Host to discover, convert, de-duplicate, and directly persist
   * external configs. Definitions (including secrets) never enter this store.
   * @param sources - external configuration families to inspect.
   * @param expectedRevision - revision visible when the action was triggered.
   * @returns the safe summary, or undefined on conflict/refusal.
   */
  async importServers(
    sources: readonly McpImportSource[],
    expectedRevision: number | undefined,
  ): Promise<McpImportSummary | undefined> {
    const result = await this.rpc.call('/api', 'mcpConfig/import', {
      args: { request: { sources, expectedRevision } },
    })
    if (!result.ok || !isPlainObject(result.value)) return undefined
    const outcome = result.value
    if (outcome['kind'] !== 'ok' && outcome['kind'] !== 'conflict') return undefined
    await this.refresh()
    return outcome['kind'] === 'ok' ? assertImportSummary(outcome['summary']) : undefined
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}
