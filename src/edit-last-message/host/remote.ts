import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { EditLastMessageHostRequest, EditLastMessageHostResult } from './rewind.js'
import { rewriteLastMessage } from './rewind.js'

function exposeRemote<This extends object, Args extends unknown[], Result>(
  service: This,
  name: string,
  method: (this: This, ...args: Args) => Result,
): void {
  Remote(name)(method, {
    name,
    static: false,
    private: false,
    addInitializer(initializer: (this: This) => void): void { initializer.call(service) },
  } as unknown as ClassMethodDecoratorContext<This, typeof method>)
}

function assertRequest(value: unknown): EditLastMessageHostRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('editLastMessage/rewrite: request must be an object')
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate['sessionId'] !== 'string' || candidate['sessionId'].length === 0
    || candidate['sessionId'].length > 512
    || typeof candidate['messageSeq'] !== 'number'
    || !Number.isSafeInteger(candidate['messageSeq'])
    || candidate['messageSeq'] < 0
    || typeof candidate['text'] !== 'string'
    || candidate['text'].length > 200_000) {
    throw new TypeError('editLastMessage/rewrite: invalid sessionId, messageSeq, or text')
  }
  return {
    sessionId: candidate['sessionId'],
    messageSeq: candidate['messageSeq'],
    text: candidate['text'],
  }
}

/** Host capability consumed by the inline Client editor. */
export class EditLastMessageRemote extends TypertRemoteService {
  static inject = ['agents']

  constructor(ctx: Context) {
    super(ctx, 'editLastMessage')
    exposeRemote(this, 'rewrite', this.rewrite)
  }

  async rewrite(request: unknown, signal: AbortSignal): Promise<EditLastMessageHostResult> {
    const valid = assertRequest(request)
    const agent = this.ctx.agents.get(SessionId(valid.sessionId))
    if (agent === undefined) throw new Error(`editLastMessage/rewrite: session ${JSON.stringify(valid.sessionId)} is not live`)
    if (agent.session.header.origin === 'subagent') {
      throw new Error('editLastMessage/rewrite: subagent conversations cannot be edited')
    }
    return rewriteLastMessage(agent, valid, signal)
  }
}
