import type {
  ChatConversationViewNode, ConversationNodeDefinition, ConversationSnapshot, UserMessageNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeDataMap } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { editLastMessageSource } from '../shared.ts'

/** Payload rendered at the original user-message position after a semantic rewind. */
export interface EditedUserChatData {
  readonly transactionId: string
  readonly rootSeq: number
  readonly rootMessageId: string
  readonly messageSeq: number
  readonly time: number
  readonly content: UserMessageNode['content']
  readonly source: UserMessageNode['source']
}

/** Invisible durable boundary delimiting the discarded raw transcript range. */
export interface EditCutEndChatData {
  readonly transactionId: string
  readonly rootMessageId: string
  readonly messageSeq: number
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Latest edited text projected back onto the original user-bubble position. */
    'edited-user': EditedUserChatData
    /** Invisible end of the raw rows shadowed by one edit transaction. */
    'edit-cut-end': EditCutEndChatData
  }
}

interface EditEventState {
  readonly transactionId: string
  readonly rootSeq: number
  readonly rootMessageId: string
  readonly messageSeq: number
  readonly time: number
  readonly content: UserMessageNode['content']
  readonly source: UserMessageNode['source']
  readonly location: ChatConversationViewNode['location']
}

function editEvent(event: Parameters<ConversationNodeDefinition['match']>[0]): EditEventState | undefined {
  if (event.type !== 'user/message' || !isReplacementSurfaceEvent(event)) return
  const source = editLastMessageSource(event.data.source)
  if (source === undefined) return
  return {
    transactionId: String(event.data.id),
    rootSeq: source.editLastMessage.rootSeq,
    rootMessageId: source.editLastMessage.rootMessageId,
    messageSeq: event.seq,
    time: event.time,
    content: event.data.content,
    source: event.data.source,
    location: { kind: 'unresolved' },
  }
}

function stateFromMatch(match: Parameters<ConversationNodeDefinition<EditEventState>['start']>[1]): EditEventState {
  const state = editEvent(match.event)
  if (state === undefined) throw new Error('edit-last-message node requires a replacement user event')
  return { ...state, location: match.location }
}

function chatNode<Kind extends keyof ChatNodeDataMap & string>(
  context: Parameters<NonNullable<ConversationNodeDefinition<EditEventState>['buildViewNode']>>[0],
  kind: Kind,
  anchorSeq: number,
  data: ChatNodeDataMap[Kind],
): ChatConversationViewNode & { readonly kind: Kind; readonly data: ChatNodeDataMap[Kind] } {
  return {
    key: context.key,
    kind,
    id: context.id,
    target: 'chat',
    anchorSeq,
    location: context.state?.location ?? { kind: 'unresolved' },
    visibility: 'visible',
    data,
  }
}

/** One independent display Context per replacement event; the renderer selects the latest per root. */
export const editedUserDefinition: ConversationNodeDefinition<EditEventState> = {
  kind: 'edit-last-message-display',
  target: 'chat',
  match: (event) => {
    const state = editEvent(event)
    return state === undefined ? null : { id: state.transactionId, role: 'start' }
  },
  start: (_context, match) => stateFromMatch(match),
  update: context => context.state,
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    return chatNode(context, 'edited-user', state.rootSeq, {
      transactionId: state.transactionId,
      rootSeq: state.rootSeq,
      rootMessageId: state.rootMessageId,
      messageSeq: state.messageSeq,
      time: state.time,
      content: state.content,
      source: state.source,
    })
  },
}

/** End marker for exact DOM-range projection of the append-only raw transcript. */
export const editCutEndDefinition: ConversationNodeDefinition<EditEventState> = {
  kind: 'edit-last-message-end',
  target: 'chat',
  match: (event) => {
    const state = editEvent(event)
    return state === undefined ? null : { id: state.transactionId, role: 'start' }
  },
  start: (_context, match) => stateFromMatch(match),
  update: context => context.state,
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    return chatNode(context, 'edit-cut-end', state.messageSeq, {
      transactionId: state.transactionId,
      rootMessageId: state.rootMessageId,
      messageSeq: state.messageSeq,
    })
  },
}

function legacyHumanSeq(nodes: ConversationSnapshot['nodes']): number | undefined {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node?.kind === 'user' || node?.kind === 'steering') return node.seq
  }
  return undefined
}

/** Latest editable durable user input across built-in and replacement projections. */
export function latestEditableMessageSeq(
  snapshot: Pick<ConversationSnapshot, 'nodes' | 'chat'>,
): number | undefined {
  let latest = legacyHumanSeq(snapshot.nodes)
  for (const raw of snapshot.chat.nodes.values()) {
    if (raw.kind !== 'edited-user') continue
    const data = raw.data as EditedUserChatData
    if (latest === undefined || data.messageSeq > latest) latest = data.messageSeq
  }
  return latest
}

/** Whether this transaction is the newest replacement for its original bubble. */
export function isLatestRootEdit(snapshot: Pick<ConversationSnapshot, 'chat'>, data: EditedUserChatData): boolean {
  for (const raw of snapshot.chat.nodes.values()) {
    if (raw.kind !== 'edited-user') continue
    const candidate = raw.data as EditedUserChatData
    if (candidate.rootMessageId === data.rootMessageId && candidate.messageSeq > data.messageSeq) return false
  }
  return true
}
