/** Browser-only inline editor for the latest durable user bubble. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Pulls the keyed Chat SlotMap and session standard-kit declarations without a runtime edge.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  EditCutEnd, EditableUserMessage, EditedUserMessage,
} from './EditableUserMessage.tsx'
import { editCutEndDefinition, editedUserDefinition } from './conversation-nodes.ts'
import { EditLastMessageClient } from './edit-session.ts'
import { en, zh } from './locales.ts'

export { EditCutEnd, EditableUserMessage, EditedUserMessage, editableText } from './EditableUserMessage.tsx'
export type {
  EditCutEndProps, EditableUserMessageInjected, EditableUserMessageProps, EditedUserMessageProps,
} from './EditableUserMessage.tsx'
export {
  editCutEndDefinition, editedUserDefinition, isLatestRootEdit, latestEditableMessageSeq,
} from './conversation-nodes.ts'
export type { EditCutEndChatData, EditedUserChatData } from './conversation-nodes.ts'
export { EditLastMessageClient } from './edit-session.ts'
export type { EditLastMessageRequest } from './edit-session.ts'
export type { EditLastMessageLocaleKey } from './locales.ts'

/** Locale namespace owned by this action. */
export const NS = 'edit-last-message'
/** Required browser services. */
export const inject = ['connection', 'conversationEvents', 'locale', 'sessions', 'slots']

/** Shadow the built-in user renderer to add inline editing beside Copy. */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) throw new Error('edit-last-message: connection service is unavailable')
  const remote = new EditLastMessageClient(connection.rpc)
  const injected = (sessionId: Parameters<typeof remote.rewrite>[0]) => ({
    editAndResend: (request: Parameters<typeof remote.rewrite>[1]) => remote.rewrite(sessionId, request).then(() => {}),
  })
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'edit-last-message: dictionaries')
  ctx.conversationEvents.register(editedUserDefinition)
  ctx.conversationEvents.register(editCutEndDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'user',
    // The shipped renderer is priority 0. Lowest live priority wins one keyed cell.
    priority: -10,
    locale: NS,
    inject: injected,
  }, EditableUserMessage))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'edited-user',
    priority: -10,
    locale: NS,
    inject: injected,
  }, EditedUserMessage))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'edit-cut-end',
    priority: -10,
    inject: () => ({}),
  }, EditCutEnd))
}
