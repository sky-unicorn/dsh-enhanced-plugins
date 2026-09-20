/** pi-ai model request-type settings card, browser half. */

// Type-only Context merges for locale, remote events, and the plugin-card slot.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ModelInputTypesCard } from './ModelInputTypesCard.tsx'
import { ModelInputTypesController, PI_AI_SETTINGS_NS } from './controller.ts'
import type { ModelInputTypesLocaleKey } from './locales.ts'
import { en, zh } from './locales.ts'

export type { ModelInputTypesCardProps } from './ModelInputTypesCard.tsx'
export type {
  ModelInputTypesError, ModelInputTypesFace, ModelInputTypesState, ModelRequestTypeRow,
  ModelType, ProviderRequestTypeRows,
} from './controller.ts'
export { inputFor, isModelType, modelTypeOf, modelsWithType, projectModelInputTypes } from './controller.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** pi-ai request-type settings card copy. */
    'settings.modelInputTypes': ModelInputTypesLocaleKey
  }
}

/** Dictionary namespace owned by this plugin feature. */
export const NS = 'settings.modelInputTypes'

/** Required browser services; the child fiber waits for each one. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'remote.settings']

/** Register the card and bind its Settings transport to this child fiber. */
export function apply(ctx: ClientContext): void {
  mount(ctx, 'dsh-enhanced-model-input-types#model-input-types')
}

/** Compose the configuration under its standalone or aggregate Loader row.
 * @param bundleName - installed bundle package name.
 * @param rowId - configuration owner's stable Loader entry id.
 * @returns Client plugin whose registration and settings reads follow its fiber lifetime.
 */
export function createBundleClient(bundleName: string, rowId: string) {
  return { inject, apply: (ctx: ClientContext) => mount(ctx, `${bundleName}#${rowId}`) }
}

function mount(ctx: ClientContext, configKey: string): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'model-input-types: card dictionary')

  const controller = new ModelInputTypesController(ctx.remote)
  ctx.effect(() => {
    const disposers = [
      ctx.remote.$on('settings/document-updated', (namespace?: string, revision?: number) => {
        if (namespace !== undefined && namespace !== PI_AI_SETTINGS_NS) return
        controller.invalidate(revision)
      }),
      ctx.on('connection/reset', () => { void controller.load() }),
    ]
    void controller.load()
    return () => {
      for (const dispose of disposers) dispose()
      controller.dispose()
    }
  }, 'model-input-types: settings invalidations')

  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config',
    key: configKey,
    locale: NS,
    inject: () => controller.inject(),
  }, ModelInputTypesCard))
}
