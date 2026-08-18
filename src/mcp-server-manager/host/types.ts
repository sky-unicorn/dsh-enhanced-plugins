/**
 * The `mcpConfig` Remote's wire types, in their own public `./types` subpath
 * so client-side consumers and generated Typert faces share one home.
 */

import type { ServerDefinition } from './schema.js'
import type { McpFormatReport } from './validation.js'

/** One `mcpConfig/describe` answer for configuration clients. */
export interface McpConfigView {
  /** Whether the `mcp` settings section is registered and served right now. */
  registered: boolean
  /** The resolved server record with secret values masked; present when registered. */
  servers?: Record<string, ServerDefinition>
  /** Document revision of the namespace this view was read at. */
  revision?: number
  /** Value-free format audit of the resolved server record. */
  format?: McpFormatReport
}

/** One stdio server as the mutate wire accepts it; the settings schema validates and defaults it fully. */
export interface McpWireStdioServer {
  /** Selects child-process stdio transport. */
  transport: 'stdio'
  /** Executable used to start the server. */
  command: string
  /** Arguments passed directly, without shell interpolation. */
  args?: string[]
  /** Extra env vars merged over the scrubbed ambient env. */
  env?: Record<string, string>
  /** Working directory for the child process. */
  cwd?: string
}

/** One Streamable HTTP server as the mutate wire accepts it. */
export interface McpWireHttpServer {
  /** Selects Streamable HTTP transport. */
  transport: 'streamable-http'
  /** MCP endpoint URL. */
  url: string
  /** Additional headers attached to MCP requests. */
  headers?: Record<string, string>
}

/** One server definition a `set` op may write. */
export type McpWireServer = McpWireStdioServer | McpWireHttpServer

/** One `mcpConfig/mutate` path op. */
export interface McpMutateWireOp {
  /** The edit to perform. */
  op: 'set' | 'unset'
  /** Dotted path inside the `mcp` section, starting at a field name. */
  path: readonly string[]
  /** The server definition a `set` writes. */
  value?: McpWireServer
}

/** One `mcpConfig/mutate` request. */
export interface McpMutateRequest {
  /** Ordered path edits; later ops observe earlier ones. */
  ops: readonly McpMutateWireOp[]
  /** The `describe` revision the request was built against. */
  expectedRevision?: number
}

/** One `mcpConfig/mutate` answer. */
export type McpMutateOutcome =
  | { kind: 'ok'; revision: number }
  | { kind: 'conflict'; revision: number }

/** External MCP configuration families the Host can import. */
export type McpImportSource = 'claude-code' | 'codex'

/** Stable, localizable import diagnostic codes. */
export type McpImportIssueCode =
  | 'source-unreadable'
  | 'source-invalid'
  | 'server-invalid'
  | 'unsupported-transport'
  | 'unsupported-auth'
  | 'environment-missing'
  | 'disabled'
  | 'ignored-options'

/** One value-free problem encountered while reading an external configuration. */
export interface McpImportIssue {
  /** Which configuration family produced the issue. */
  source: McpImportSource
  /** General source layer; absolute local paths are deliberately not sent. */
  scope: 'user' | 'project' | 'local'
  /** Server name when the issue belongs to one entry. */
  serverName?: string
  /** Stable reason for localization in the browser. */
  code: McpImportIssueCode
}

/** Safe summary of one import; no server definition or credential crosses the wire. */
export interface McpImportSummary {
  /** Number of external entries accepted into the DSH settings record. */
  imported: number
  /** Exact definitions or names already owned by the current DSH settings record. */
  duplicates: number
  /** Accepted entries renamed to avoid a distinct definition's name collision. */
  renamed: number
  /** External entries not imported because they were disabled, invalid, or unsupported. */
  skipped: number
  /** Whether any supported config document was found for each family. */
  found: Record<McpImportSource, boolean>
  /** Imported DSH-safe names (definitions and secret values are never returned). */
  importedNames: string[]
  /** Value-free import diagnostics. */
  issues: McpImportIssue[]
}

/** One Host-side import request. */
export interface McpImportRequest {
  /** One or both external configuration families. */
  sources: readonly McpImportSource[]
  /** The descriptor revision the user triggered the import from. */
  expectedRevision?: number
}

/** Result of an atomic discover, de-duplicate, and settings mutation. */
export type McpImportOutcome =
  | { kind: 'ok'; revision: number; summary: McpImportSummary }
  | { kind: 'conflict'; revision: number }
