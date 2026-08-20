/** Independent desktop-notification Settings section, browser half. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { NOTIFICATION_SETTINGS_NAMESPACE } from '../shared.ts'
import { NotificationSection, type NotificationSectionFace } from './NotificationSection.tsx'
import { en, zh } from './locales.ts'
import { installDesktopPetNavIcon } from './nav-icon.tsx'
import { decodeNotificationSettings, NotificationConfigStore } from './notification-config-store.ts'

export const inject = ['slots', 'locale', 'connection', 'remote']

export { decodeNotificationSettings, NotificationConfigStore } from './notification-config-store.ts'

/** Bind the Host namespace and contribute an independent Settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register('settings.desktopNotifications', { zh, en }),
    'desktop notifications: settings dictionaries',
  )
  ctx.effect(
    () => installDesktopPetNavIcon([zh.nav, en.nav]),
    'desktop notifications: settings nav icon compatibility',
  )
  const { rpc } = ctx.get('connection') as ConnectionHandle
  const settings = new NotificationConfigStore(rpc)
  void settings.refresh()
  ctx.effect(() => ctx.remote.$on('settings/document-updated', (namespace?: string) => {
    if (namespace === undefined || namespace === NOTIFICATION_SETTINGS_NAMESPACE) void settings.refresh()
  }), 'desktop notifications: settings document invalidation')
  ctx.effect(() => ctx.on('connection/reset', () => {
    void settings.refresh()
  }), 'desktop notifications: connection invalidation')
  const face = (): NotificationSectionFace => ({
    hooks: { notificationSettings: settings },
    soundLibrary: {
      getSnapshot: () => settings.getSoundLibrarySnapshot(),
      subscribe: listener => settings.subscribe(listener),
    },
    set: (field, value) => { void settings.set(field, value) },
    selectSound: (kind, sound) => settings.setSound(kind, sound),
    reset: (field) => { void settings.unset(field) },
    upload: (fileName, dataBase64) => settings.uploadSound(fileName, dataBase64),
    preview: (kind) => settings.previewSound(kind),
  })
  const t = ctx.locale.bind('settings.desktopNotifications')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'desktop-notifications',
    order: 22,
    label: () => t('nav'),
    locale: 'settings.desktopNotifications',
    inject: face,
  }, NotificationSection))
}
