/**
 * MCP server manager: one settings-driven plugin that reconciles the `mcp`
 * Loader entry's `servers` record into live `mcp-client` connections.
 *
 * The composition entry in `cordis.yml` is the `base` layer; the user's
 * active profile patch is the override layer. When no settings
 * provider is mounted, the manager serves the composition entry alone. Every
 * dynamic server is mounted as an independent `mcp-client` fiber, so a
 * dynamic server and a static `cordis.yml` `mcp-client` instance can never
 * collide on a `serverName` (the `mcp-client` plugin reserves names itself).
 *
 * This plugin also serves the `mcpConfig` Typert Remote (see {@link McpConfigRemote}),
 * the portable configuration face the Web settings card reads and writes
 * through — the Host's settings RPC allowlist is a host-owned decision this
 * plugin cannot and does not extend.
 *
 * @module dsh-enhanced-plugins/mcp-server-manager
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { McpServerManager } from './manager.js'
import { McpConfigRemote } from './remote.js'
import { importLegacyMcpSettings } from './legacy-settings.js'
import { MCP_SETTINGS_NAMESPACE, snapshotMcpConfig, type Config as McpConfig } from './schema.js'
declare module '@deepseek-ai/cordis' {
  interface Events { 'loader/volatile-update'(paths: readonly (readonly string[])[]): void }
}
import { assertMcpConfigValid } from './validation.js'

export type {
  McpConfigView, McpImportIssue, McpImportIssueCode, McpImportOutcome, McpImportRequest,
  McpImportSource, McpImportSummary, McpMutateOutcome, McpMutateRequest, McpMutateWireOp, McpServerFieldOp,
  McpWireHttpServer, McpWireServer, McpWireStdioServer,
} from './types.js'
export {
  discoverMcpImports, planMcpImports, sanitizeServerName,
  type McpImportCandidate, type McpImportDiscovery, type McpImportDiscoveryOptions,
} from './importers.js'
export { McpConfigRemote, SECRET_MASK, maskServers } from './remote.js'
export {
  Config, MCP_SETTINGS_NAMESPACE, SERVER_NAME_PATTERN, ServerDefinition,
  type Config as McpManagerConfig, type ServerDefinition as McpServerDefinition,
  toMcpClientConfig,
} from './schema.js'
export {
  assertMcpConfigValid, inspectMcpConfig,
  type McpFormatIssue, type McpFormatIssueCode, type McpFormatReport,
} from './validation.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-manager'

/** Services required before any server can connect. */
export const inject = ['tools']

/**
 * Register the `mcp-manager` settings namespace and keep the live server record in
 * sync with it. Without a settings provider, the composition entry is served
 * alone; the optional-settings wiring falls back to it on provider disposal.
 * @param ctx - plugin context carrying the tools service.
 * @param config - resolved composition entry (`base` layer).
 */
export function apply(ctx: Context, config: McpConfig): void {
  const manager = new McpServerManager(ctx)
  let current: () => McpConfig = () => snapshotMcpConfig(config)
  const reconcile = (): void => {
    const next = current()
    assertMcpConfigValid(next)
    manager.reconcile(next)
  }

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
    settingsCtx.effect(() => {
      const abort = new AbortController()
      void importLegacyMcpSettings(settingsCtx, abort.signal)
        .then(count => { if (count > 0) settingsCtx.logger.info('mcp-manager: imported %d legacy MCP servers', count) })
        .catch(() => {
          if (!abort.signal.aborted) settingsCtx.logger.warn('mcp-manager: legacy MCP settings could not be imported; the original document remains available')
        })
      return () => { abort.abort() }
    }, 'mcp-manager: legacy settings import')
  })
  ctx.on('loader/volatile-update', reconcile)

  // Serve the composition base even before a settings provider attaches; the
  // attach-time `onChange` re-runs against the same resolved value and no-ops
  // through deep-equality when only the base layer is present.
  reconcile()

  // The plugin-owned configuration Remote rides the settings-injected fiber:
  // its constructor registers it there, so it exists exactly while the
  // settings service this face reads through exists, and the Typert Gateway
  // discovers it from the live service table.
  ctx.inject(['settings'], (sctx) => {
    new McpConfigRemote(sctx)
  })

  ctx.effect(() => () => manager.dispose(), 'mcp-manager.servers')
}
