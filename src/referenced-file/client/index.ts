/** Browser half: # detection, content-free candidate RPC, and composer menu. */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Pulls the overlay SlotMap and session standard-kit declarations without a runtime edge.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ReferencedFileMenu, type ReferencedFileMenuInjected } from './ReferencedFileMenu.tsx'
import { en, zh, type ReferencedFileLocaleKey } from './locales.ts'
import { ReferencedFilesClient } from './remote.ts'

export { ReferencedFileMenu } from './ReferencedFileMenu.tsx'
export type { ReferencedFileMenuInjected, ReferencedFileMenuProps } from './ReferencedFileMenu.tsx'
export { detectHashTrigger, formatFileReference, replaceHashTrigger } from './references.ts'
export type { HashTriggerHit } from './references.ts'
export { ReferencedFilesClient } from './remote.ts'
export type { ReferencedFileCandidate, ReferencedFileCandidates } from './remote.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the # file candidate menu. */
    'referenced-file.menu': ReferencedFileLocaleKey
  }
}

/** Locale namespace owned by this plugin. */
export const NS = 'referenced-file.menu'
/** Required browser services. */
export const inject = ['connection', 'locale', 'slots']

/** Register the locale dictionary and session-scoped composer overlay. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'referenced-file: menu dictionaries')
  const { rpc } = ctx.get('connection') as ConnectionHandle
  const client = new ReferencedFilesClient(rpc)
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'referenced-file-menu',
    order: 20,
    locale: NS,
    inject: (): ReferencedFileMenuInjected => ({
      search: (sessionId, query, signal) => client.list(sessionId, query, signal),
    }),
  }, ReferencedFileMenu))
}
