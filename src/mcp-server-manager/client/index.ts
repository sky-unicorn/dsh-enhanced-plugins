/**
 * MCP servers settings card, browser half. Registers one card into the
 * Plugins section's `settings.plugin.item` slot - a slot declared by
 * `ui-settings-plugins`, which stays mounted in the shipped Web composition,
 * so this package contributes its card without touching that package.
 *
 * Reads and writes go through the MCP manager's `mcpConfig` Remote on the
 * shared `/api` channel (see {@link McpConfigStore}): the Host's settings
 * RPC allowlist is a host-owned decision this plugin cannot and does not extend.
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the `settings.plugin.item` SlotMap declaration and the client
// runtime's Context merges.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { McpCard } from './McpCard.tsx'
import { McpCardController } from './mcp-card-controller.ts'
import { McpConfigStore } from './mcp-config-store.ts'
import type { McpSettingsLocaleKey } from './locales.ts'
import { en, zh } from './locales.ts'

export type { McpCardProps } from './McpCard.tsx'
export type {
  CardShell, DraftPair, McpCardFace, McpCardState, McpDraftForm, McpListField,
  McpServer, McpServerRow, McpSettings, McpTextField, StdioMcpServer, StreamableHttpMcpServer,
} from './mcp-card-controller.ts'
export type {
  McpConfigSnapshot, McpConfigStore, McpFormatIssue, McpFormatIssueCode, McpFormatReport,
  McpImportIssue, McpImportIssueCode, McpImportSource, McpImportSummary, McpWireOp,
} from './mcp-config-store.ts'
export { collectArgs, collectPairs, isValidHttpUrl, planOps, recordsEqual, SERVER_NAME_PATTERN } from './mcp-card-controller.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MCP servers settings card copy. */
    'settings.mcp': McpSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.mcp'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote']

/**
 * Mount the MCP servers card into the Plugins section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-server-manager: card dictionary')

  const { rpc } = ctx.get('connection') as ConnectionHandle
  const store = new McpConfigStore(rpc)
  const controller = new McpCardController(store)
  void store.refresh()

  // The settings document moves under this client when another surface writes
  // it (another tab, or a hand-edit the provider picks up); both invalidation
  // signals are the ones the shared settings scope rides too.
  ctx.effect(() => ctx.remote.$on('settings/document-updated', (namespace?: string) => {
    if (namespace !== undefined && namespace !== 'mcp') return
    void store.refresh()
  }), 'mcp-server-manager: document invalidation')
  ctx.effect(() => ctx.on('connection/reset', () => { void store.refresh() }), 'mcp-server-manager: connection invalidation')

  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      id: 'mcp',
      order: 30,
      locale: NS,
      inject: () => controller.inject(),
    }, McpCard)
  })
}
