import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Config } from './config.js'
import { ReferencedFileIndexCache } from './index-cache.js'
import type { ListReferencedFilesRequest, ListReferencedFilesResponse } from './types.js'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertListRequest(value: unknown): ListReferencedFilesRequest {
  if (!isPlainObject(value)
    || typeof value['sessionId'] !== 'string'
    || value['sessionId'].length === 0
    || value['sessionId'].length > 512
    || typeof value['query'] !== 'string'
    || value['query'].length > 256) {
    throw new TypeError('referencedFiles/list: request must contain a sessionId and a query of at most 256 characters')
  }
  return { sessionId: value['sessionId'], query: value['query'] }
}

/** Content-free workspace file discovery Remote used by the composer menu. */
export class ReferencedFilesRemote extends TypertRemoteService {
  static inject = ['fs', 'sessions']
  private readonly indexes: ReferencedFileIndexCache

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'referencedFiles')
    this.indexes = new ReferencedFileIndexCache(ctx.fs, config)
    ctx.effect(() => async () => { await this.indexes.dispose() }, 'referenced-file: workspace candidate indexes')
  }

  /** List safe workspace-relative candidate paths for one live session. */
  @Remote('list')
  async list(request: ListReferencedFilesRequest, signal: AbortSignal): Promise<ListReferencedFilesResponse> {
    const valid = assertListRequest(request)
    const session = this.ctx.sessions.get(SessionId(valid.sessionId))
    if (session === undefined) throw new Error(`referencedFiles/list: session ${JSON.stringify(valid.sessionId)} is not live`)
    if (session.header.cwd === undefined) return { candidates: [], truncated: false }
    return this.indexes.list(session.header.cwd, valid.query, signal)
  }
}
