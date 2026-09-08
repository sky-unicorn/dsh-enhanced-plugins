import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  EDIT_LAST_MESSAGE_SOURCE_KIND, editLastMessageSource, type EditLastMessageSource,
} from '../shared.js'

declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap {
    /** Replacement input written by the external edit-last-message plugin. */
    'edit-last-message': EditLastMessageSource
  }
}

export interface EditLastMessageHostRequest {
  readonly sessionId: string
  readonly messageSeq: number
  readonly text: string
}

export interface EditLastMessageHostResult {
  readonly accepted: true
  readonly replacementSeq: number
}

interface EditableTarget {
  readonly event: SessionEvent<'user/message'>
  readonly rootSeq: number
  readonly rootMessageId: string
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function isHumanEditSource(source: unknown): boolean {
  if (source !== null && typeof source === 'object' && (source as { kind?: unknown }).kind === 'user') return true
  return editLastMessageSource(source) !== undefined
}

function editableTarget(session: Session, messageSeq: SessionSeq): EditableTarget {
  const event = session.eventAt(messageSeq)
  if (event === undefined || event.seq !== messageSeq || event.type !== 'user/message') {
    throw new Error('the edited message is no longer available')
  }
  if (!isHumanEditSource(event.data.source)) {
    throw new Error('the addressed message is not editable user input')
  }
  const latest = [...session.surface.nodes].reverse().find((seq) => {
    const candidate = session.eventAt(seq)
    return candidate?.type === 'user/message' && isHumanEditSource(candidate.data.source)
  })
  if (latest !== messageSeq) throw new Error('the message is no longer the latest user message')
  const previous = editLastMessageSource(event.data.source)
  return {
    event,
    rootSeq: previous?.rootSeq ?? event.seq,
    rootMessageId: previous?.rootMessageId ?? String(event.data.id),
  }
}

type AppendMethod = Session['append']

interface AppendInterception {
  readonly settled: Promise<number>
  dispose(reason?: unknown): void
}

interface ReplacementPlan {
  readonly start: SessionSeq
  readonly end: SessionSeq
  readonly sourceEventSeqs: readonly SessionSeq[]
}

function replacementPlan(session: Session, targetSeq: SessionSeq): ReplacementPlan {
  const nodes = session.surface.nodes
  const startIndex = nodes.indexOf(targetSeq)
  if (startIndex < 0) throw new Error('the edited message left the current model context')
  const sourceEventSeqs = nodes.slice(startIndex)
  const end = sourceEventSeqs.at(-1)
  if (end === undefined) throw new Error('the edited message has no replaceable context tail')
  return { start: targetSeq, end, sourceEventSeqs }
}

/** Restore edit intent at admission, including input recovered from the durable inbox.
 * The returned disposer belongs to the plugin and must run after its pending work stops.
 */
export function installEditAdmission(session: Session): () => void {
  const own = Object.getOwnPropertyDescriptor(session, 'append')
  const previous = session.append
  const wrapped = function (this: Session, type: string, data: unknown, ...options: unknown[]): unknown {
    const message = data as { source?: unknown } | null
    const source = type === 'user/message' ? editLastMessageSource(message?.source) : undefined
    const supplied = options[0] as { surfaceOp?: unknown } | undefined
    if (source === undefined || (supplied?.surfaceOp !== undefined && supplied.surfaceOp !== 'append')) {
      return Reflect.apply(previous, this, [type, data, ...options])
    }
    const root = session.eventAt(SessionSeq(source.rootSeq))
    if (root?.type !== 'user/message' || String(root.data.id) !== source.rootMessageId) {
      throw new Error('recovered edit refers to an unavailable original message')
    }
    const targetSeq = [...session.surface.nodes].reverse().find(seq => {
      const event = session.eventAt(seq)
      if (event?.type !== 'user/message') return false
      const marker = editLastMessageSource(event.data.source)
      return seq === source.rootSeq || (marker?.rootSeq === source.rootSeq && marker.rootMessageId === source.rootMessageId)
    })
    if (targetSeq === undefined) throw new Error('recovered edit target is no longer in the model context')
    editableTarget(session, targetSeq)
    const plan = replacementPlan(session, targetSeq)
    return Reflect.apply(previous, this, [type, data, {
      surfaceOp: { op: 'replace', start: plan.start, end: plan.end },
      sourceEventSeqs: plan.sourceEventSeqs,
    }])
  } as AppendMethod
  Object.defineProperty(session, 'append', { configurable: true, writable: true, value: wrapped })
  return () => {
    if (session.append !== wrapped) return
    if (own === undefined) delete (session as { append?: AppendMethod }).append
    else Object.defineProperty(session, 'append', own)
  }
}

/**
 * Replace exactly one future append of `message` with a surface rewrite. The
 * raw Session log stays append-only; only the current model-visible surface is
 * cut from `targetSeq` through its then-current tail.
 */
function interceptReplacementAppend(
  session: Session,
  plan: ReplacementPlan,
  messageId: string,
): AppendInterception {
  const result = deferred<number>()
  const previousOwn = Object.getOwnPropertyDescriptor(session, 'append')
  const previous = session.append
  let active = true

  const restore = (): void => {
    if (!active) return
    active = false
    if (session.append !== wrapped) return
    if (previousOwn === undefined) delete (session as { append?: AppendMethod }).append
    else Object.defineProperty(session, 'append', previousOwn)
  }
  const reject = (reason: unknown): void => {
    restore()
    result.reject(reason)
  }
  const wrapped = function (this: Session, type: string, data: unknown, ...options: unknown[]): unknown {
    const candidate = data as { id?: unknown } | null
    if (type !== 'user/message' || candidate?.id !== messageId) {
      return Reflect.apply(previous, this, [type, data, ...options])
    }
    try {
      restore()
      const logged = Reflect.apply(previous, this, [type, data, {
        surfaceOp: { op: 'replace', start: plan.start, end: plan.end },
        sourceEventSeqs: plan.sourceEventSeqs,
      }]) as SessionEvent<'user/message'>
      result.resolve(logged.seq)
      return logged
    } catch (error: unknown) {
      reject(error)
      throw error
    }
  } as AppendMethod

  Object.defineProperty(session, 'append', {
    configurable: true,
    writable: true,
    value: wrapped,
  })

  return {
    settled: result.promise,
    dispose(reason = new Error('edit interception disposed before admission')): void { reject(reason) },
  }
}

/** Same-session semantic rewind followed by an ordinary AgentLoop turn. */
export async function rewriteLastMessage(
  agent: Agent,
  request: Pick<EditLastMessageHostRequest, 'messageSeq' | 'text'>,
  signal?: AbortSignal,
): Promise<EditLastMessageHostResult> {
  const text = request.text
  if (text.trim().length === 0) throw new Error('replacement message is empty')
  if (agent.status !== 'idle') throw new Error('the session is still running')
  if (agent.inbox.nextTurn.length > 0) throw new Error('the session already has queued user messages')
  const targetSeq = SessionSeq(request.messageSeq)
  const target = editableTarget(agent.session, targetSeq)
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: EDIT_LAST_MESSAGE_SOURCE_KIND,
      version: 1,
      rootSeq: target.rootSeq,
      rootMessageId: target.rootMessageId,
    },
  })
  let interception: AppendInterception | undefined
  try {
    await agent.runMaintenance(async (maintenanceSignal) => {
      signal?.throwIfAborted()
      maintenanceSignal.throwIfAborted()
      if (agent.inbox.nextTurn.length > 0) throw new Error('the session already has queued user messages')
      editableTarget(agent.session, targetSeq)
      const plan = replacementPlan(agent.session, targetSeq)
      interception = interceptReplacementAppend(agent.session, plan, String(message.id))
      agent.followup(message)
    })
    if (interception === undefined) throw new Error('edit interception was not installed')
    // Once the message is queued, a disconnected RPC must not turn it back into
    // an ordinary append with the old context. Wait until the loop either admits
    // the replacement or retires without doing so.
    const admitted = interception.settled.then((replacementSeq) => ({
      kind: 'admitted' as const,
      replacementSeq,
    }))
    const retired = agent.whenIdle().then(() => ({ kind: 'retired' as const }))
    const outcome = await Promise.race([admitted, retired])
    if (outcome.kind === 'retired') {
      throw new Error('the agent retired before admitting the edited message')
    }
    const replacementSeq = outcome.replacementSeq
    return { accepted: true, replacementSeq }
  } catch (error: unknown) {
    interception?.dispose(error)
    throw error
  }
}
