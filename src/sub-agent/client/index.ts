import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SETTINGS_NAMESPACE_KEY } from '../shared.ts'
import { installSubagentNavIcon } from './nav-icon.tsx'
import { ToggleSection, type ToggleSectionInjected } from './ToggleSection.tsx'
import { ToggleController } from './store.ts'

export const inject = ['slots', 'locale', 'connection', 'remote']

const zh = {
  nav: '子智能体', title: '产品子智能体', intro: '控制新创建会话是否可以调用宿主机上的产品智能体。',
  'claudeCode.description': '通过 Claude Agent SDK 调用本机 Claude Code。',
  'codex.description': '通过 app-server 协议调用本机 Codex。',
  enabled: '启用', unavailable: '子智能体设置服务未就绪，请重启 dsh web 后重试。',
  conflict: '设置已被其他页面或外部编辑更新，已重新载入最新值，请重试。',
  note: '更改会立即应用到加载了此控制插件的预设，包括其已运行会话。',
}
const en = {
  nav: 'Subagents', title: 'Product subagents', intro: 'Control which native product agents newly created sessions may call.',
  'claudeCode.description': 'Use the host Claude Code through the Claude Agent SDK.',
  'codex.description': 'Use the host Codex through its app-server protocol.',
  enabled: 'enabled', unavailable: 'The subagent settings service is unavailable. Restart dsh web and try again.',
  conflict: 'The settings changed in another page or external edit. The latest values were reloaded; try again.',
  note: 'Changes apply immediately to presets that load this controller, including their running sessions.',
}

export function apply(ctx: ClientContext): void {
  const controller = new ToggleController((ctx.get('connection') as ConnectionHandle).rpc)
  ctx.effect(() => ctx.locale.register('settings.subagentProducts', { zh, en }), 'subagent toggles: dictionaries')
  ctx.effect(() => installSubagentNavIcon([zh.nav, en.nav]), 'subagent toggles: settings nav icon compatibility')
  ctx.effect(() => {
    const refresh = (): void => { if (controller.store.getSnapshot().status !== 'idle') void controller.load() }
    const disposers = [
      ctx.remote.$on('settings/document-updated', ns => { if (ns === SETTINGS_NAMESPACE_KEY) refresh() }),
      ctx.on('connection/reset', refresh),
    ]
    return () => { controller.dispose(); for (const dispose of disposers) dispose() }
  }, 'subagent toggles: settings refresh')
  const injected = (): ToggleSectionInjected => ({
    hooks: { subagentProducts: controller.store }, load: () => controller.load(), set: (product, enabled) => controller.set(product, enabled),
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'subagent-products', order: 21,
    label: () => ctx.locale.bind('settings.subagentProducts')('nav'), locale: 'settings.subagentProducts', inject: injected,
  }, ToggleSection))
}
