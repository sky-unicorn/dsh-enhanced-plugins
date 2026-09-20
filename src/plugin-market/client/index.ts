/** Browser half: register the marketplace as an independent Settings section. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { installPluginCommunityNavIcon } from './nav-icon.tsx'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { MarketInstaller } from './installer.ts'
import { PluginMarket } from './PluginMarket.tsx'
import { en, zh, type LocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.pluginMarket': LocaleKey
  }
}

export const NS = 'settings.pluginMarket'
export const inject = ['slots', 'locale', 'remote', 'remote.pluginManager', 'layout']

/** Contribute the Plugin Community entry to the Settings navigation rail. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plugin-market: dictionaries')
  ctx.effect(
    () => installPluginCommunityNavIcon([zh.nav, en.nav]),
    'plugin-market: settings nav icon compatibility',
  )
  const t = ctx.locale.bind(NS)
  const installer = new MarketInstaller(ctx.remote.pluginManager)
  ctx.effect(() => () => installer.dispose(), 'plugin-market: DSH installation request')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'plugin-community',
    order: 20,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ installer, openManager: () => ctx.layout.selectPanel('plugins' as MainPanelId) }),
  }, PluginMarket))
}
