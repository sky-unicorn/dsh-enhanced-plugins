/** Host half: safe candidate discovery and per-request # file context. */
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
// Context service and event declaration merges.
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-session'
import { Config, type Config as ReferencedFileConfig } from './config.js'
import { injectReferencedFileContext } from './references.js'
import { ReferencedFilesRemote } from './remote.js'

export { Config } from './config.js'
export { ReferencedFileIndexCache } from './index-cache.js'
export {
  buildReferencedFileIndex, listReferencedFiles, MAX_RETURNED_CANDIDATES,
  searchReferencedFileIndex, type IndexedFileCandidate, type ListingFileSystem,
  type ModifiedTimeReader, type ReferencedFileIndex,
} from './listing.js'
export {
  createReferencedFileMessage, injectReferencedFileContext, loadReferencedFiles,
  parseFileReferences, referencesFromMessages, type ReferenceFileSystem,
} from './references.js'
export { ReferencedFilesRemote } from './remote.js'
export type {
  ListReferencedFilesRequest, ListReferencedFilesResponse, LoadedReferencedFile,
  ParsedFileReference, ReferencedFileCandidate,
} from './types.js'

/** Cordis plugin name used in lifecycle diagnostics. */
export const name = 'referenced-file'
/** Required Host capabilities. */
export const inject = ['fs', 'sessions']

/** Register the Remote and the waterfall-safe pre-step context contribution. */
export function apply(ctx: Context, config: ReferencedFileConfig): void {
  new ReferencedFilesRemote(ctx, config)
  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const entered = await injectReferencedFileContext(
      ctx.fs,
      agent.session.header.cwd,
      messages,
      decision.messages,
      config,
      signal,
    )
    return { kind: 'enter', messages: entered }
  })
}
