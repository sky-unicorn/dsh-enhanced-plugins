import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { ModeControl } from './ModeControl.tsx'
import { installRouterNavIcon } from './nav-icon.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { SidebarDetails, SidebarTitle } from './Sidebar.tsx'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { NAMESPACE, type RouterConfig, type RouterSnapshot } from '../shared.ts'
import { NS, zh, en, type LocaleKey } from './locales.ts'
import { snapshotSchema, runPageSchema } from '../schema.ts'
import { catalogSchema } from './Controls.tsx'
import { Settings, type Injected } from './Views.tsx'
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'model-router': LocaleKey } }
export const name = 'model-router-client'
export const inject = ['connection', 'settingsScope', 'slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'modelDirectories', 'sessions', 'remote', 'remote.session']
export function apply(ctx: Context): void {
  ctx.effect(() => installRouterNavIcon([zh.title, en.title]), 'model router: settings icon compatibility')
  const scope = ctx.settingsScope.bind<RouterConfig>({ namespace: NAMESPACE })
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'model router: dictionaries')
  const call = async (method: string, request: Record<string, unknown>, signal: AbortSignal): Promise<RouterSnapshot> => {
    const result = await connection.rpc.call('/api', `modelRouterControl/${method}`, { args: { request } }, signal)
    if (!result.ok || !result.value || typeof result.value !== 'object' || !('control' in result.value)) throw new Error('Model router unavailable')
    return snapshotSchema.parse(result.value)
  }
  const injected: Injected = { scope, openDetails: () => ctx.sidebarRight.openTab('enhanced-model-router'), loadCatalog: async signal => { const result = await connection.rpc.call('/api', 'session/modelCatalog', { args: {} }, signal); if (!result.ok) throw new Error('Model catalog unavailable'); return catalogSchema.parse(result.value) }, listRuns: async (query, signal) => { const result = await connection.rpc.call('/api', 'modelRouterControl/listRuns', { args: { request: query } }, signal); if (!result.ok) throw new Error('Run history unavailable'); return runPageSchema.parse(result.value) }, describe: (sessionId, signal) => call('describe', { sessionId }, signal), command: (request, signal) => call('command', request, signal) }
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: 'enhanced-model-router', kind: 'enhanced-model-router', title: () => ctx.locale.bind(NS)('title') }), 'model router: sidebar type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'enhanced-model-router', locale: NS, inject: () => injected }, SidebarDetails))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: 'enhanced-model-router', locale: NS }, SidebarTitle))
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'model-router', order: 22, label: () => ctx.locale.bind(NS)('title'), locale: NS, inject: () => injected }, Settings))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({ name: 'conversation.input.right', id: 'model-router', order: 90, locale: NS, inject: sessionId => ({ ...injected, directory: ctx.modelDirectories.directoryFor(sessionId), available: ctx.sessions.subagentAddress(sessionId) === undefined }) }, ModeControl))
}
