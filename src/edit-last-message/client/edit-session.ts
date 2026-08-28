import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'

/** Identity and replacement text supplied by the inline bubble editor. */
export interface EditLastMessageRequest {
  messageSeq: number
  text: string
}

interface EditLastMessageResponse {
  accepted: true
  replacementSeq: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertResponse(value: unknown): EditLastMessageResponse {
  if (!isPlainObject(value)
    || value['accepted'] !== true
    || typeof value['replacementSeq'] !== 'number'
    || !Number.isSafeInteger(value['replacementSeq'])
    || value['replacementSeq'] < 0) {
    throw new Error('editLastMessage/rewrite: invalid response')
  }
  return { accepted: true, replacementSeq: value['replacementSeq'] }
}

/** Client for the plugin-owned same-session semantic rewind Remote. */
export class EditLastMessageClient {
  constructor(private readonly rpc: ClientConnectionRpc) {}

  async rewrite(sessionId: SessionId, request: EditLastMessageRequest): Promise<EditLastMessageResponse> {
    const result = await this.rpc.call('/api', 'editLastMessage/rewrite', {
      args: { request: { sessionId, ...request } },
    })
    if (!result.ok) throw new Error(result.error.message)
    return assertResponse(result.value)
  }
}
