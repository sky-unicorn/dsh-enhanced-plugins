/**
 * The `mcp` settings namespace schema: one `servers` record keyed by
 * `serverName`, each value a stdio or Streamable HTTP server definition.
 *
 * This is the serialized settings shape both the Host manager and the Web
 * card agree on. `env` and `headers` stay plain (not `role('secret')`):
 * their values are user-private document content, and a redacted view would
 * additionally require path-addressed writes from the client — instead the
 * Remote masks every value on read and writes are path-addressed ops, so a
 * client never restates a masked value it read.
 */

import z from '@deepseek-ai/schemastery'

/** The `serverName` contract, mirrored by the Web card's client-side check. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Default per-tool-call timeout, mirroring `mcp-client`'s own default. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** Config for one stdio server, keyed by its `serverName` in the record. */
export interface StdioServerDefinition {
  /** Selects child-process stdio transport. */
  transport: 'stdio'
  /** Executable used to start the server. */
  command: string
  /** Arguments passed directly, without shell interpolation. */
  args: string[]
  /** Extra env vars merged on top of scrubbed ambient env. */
  env: Record<string, string>
  /** Working directory for the child process. */
  cwd: string
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
}

/** Config for one Streamable HTTP server, keyed by its `serverName` in the record. */
export interface StreamableHttpServerDefinition {
  /** Selects Streamable HTTP transport. */
  transport: 'streamable-http'
  /** MCP endpoint URL. */
  url: string
  /** Additional headers attached to MCP requests. */
  headers: Record<string, string>
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
}

/** One server definition, without the `serverName` (the record key carries it). */
export type ServerDefinition = StdioServerDefinition | StreamableHttpServerDefinition

/** The `mcp` namespace section: the server record. */
export interface Config {
  /** Servers to serve, keyed by `serverName`; each value is a stdio or Streamable HTTP definition. */
  servers: Record<string, ServerDefinition>
}

/** One server definition as the settings schema validates and defaults it. */
export const ServerDefinition = z.union([
  z.object({
    transport: z.const('stdio'),
    command: z.string().required(),
    args: z.array(String).default([]),
    env: z.dict(String).default({}),
    cwd: z.string().default(''),
    toolCallTimeoutMs: z.number().min(1).default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  }),
  z.object({
    transport: z.const('streamable-http'),
    url: z.string().required(),
    headers: z.dict(String).default({}),
    toolCallTimeoutMs: z.number().min(1).default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  }),
]) as unknown as z<ServerDefinition>

/** Settings namespace key for the `mcp` section. */
export const MCP_SETTINGS_NAMESPACE = 'mcp'

/** The `mcp` settings namespace schema. */
export const Config = z.object({
  servers: z.dict(ServerDefinition, z.string().pattern(SERVER_NAME_PATTERN)).default({}),
}) as unknown as z<Config>

/**
 * Build the `mcp-client` plugin config for one server from its record key
 * and value. `failOnStartupError` is fixed to `false`: a dynamic server
 * never gates the plugin activation that mounted it, so a failed initial
 * connection logs and (on mcp-client versions that have one) enters the
 * reconnect loop instead.
 * @param serverName - the record key, also the model-facing namespace.
 * @param def - the resolved server definition.
 * @returns the `mcp-client` instance config.
 */
export function toMcpClientConfig(
  serverName: string,
  def: ServerDefinition,
): { serverName: string; failOnStartupError: false } & ServerDefinition {
  return { serverName, failOnStartupError: false as const, ...def }
}
