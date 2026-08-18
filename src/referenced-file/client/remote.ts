import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'

/** Content-free candidate exposed to the browser. */
export interface ReferencedFileCandidate {
  path: string
  size?: number
}

/** Validated response from the Host Remote. */
export interface ReferencedFileCandidates {
  candidates: ReferencedFileCandidate[]
  truncated: boolean
}

const MAX_CANDIDATES = 20

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertResponse(value: unknown): ReferencedFileCandidates {
  if (!isPlainObject(value)
    || !Array.isArray(value['candidates'])
    || value['candidates'].length > MAX_CANDIDATES
    || typeof value['truncated'] !== 'boolean') {
    throw new Error('referencedFiles/list: invalid response')
  }
  const candidates: ReferencedFileCandidate[] = []
  for (const candidate of value['candidates']) {
    if (!isPlainObject(candidate)
      || typeof candidate['path'] !== 'string'
      || candidate['path'].length === 0
      || (candidate['size'] !== undefined && (
        typeof candidate['size'] !== 'number' || !Number.isSafeInteger(candidate['size']) || candidate['size'] < 0
      ))) {
      throw new Error('referencedFiles/list: invalid candidate')
    }
    candidates.push({
      path: candidate['path'],
      ...(candidate['size'] === undefined ? {} : { size: candidate['size'] as number }),
    })
  }
  return { candidates, truncated: value['truncated'] }
}

/** Browser client for the plugin-owned, content-free candidate Remote. */
export class ReferencedFilesClient {
  constructor(private readonly rpc: ClientConnectionRpc) {}

  async list(sessionId: string, query: string, signal?: AbortSignal): Promise<ReferencedFileCandidates> {
    const result = await this.rpc.call('/api', 'referencedFiles/list', {
      args: { request: { sessionId, query } },
    }, signal)
    if (!result.ok) throw new Error(result.error.message)
    return assertResponse(result.value)
  }
}
