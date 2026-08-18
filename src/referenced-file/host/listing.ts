import { stat } from 'node:fs/promises'
import type { FsDirEntry, FsTarget, FileSystem } from '@deepseek-ai/dsh-fs'
import type { Config } from './config.js'
import type { ListReferencedFilesResponse, ReferencedFileCandidate } from './types.js'

/** Minimal filesystem face used by candidate traversal and unit tests. */
export type ListingFileSystem = Pick<FileSystem, 'contains' | 'listDir' | 'resolve'>
  & Partial<Pick<FileSystem, 'processPath'>>

/** Hard wire cap: no candidate query returns more than this many paths. */
export const MAX_RETURNED_CANDIDATES = 20

/** Host-only indexed candidate; target and mtime never cross the browser wire. */
export interface IndexedFileCandidate extends ReferencedFileCandidate {
  target: FsTarget
  modifiedAt?: number
}

/** Content-free workspace snapshot reused by later path queries. */
export interface ReferencedFileIndex {
  files: IndexedFileCandidate[]
  truncated: boolean
}

/** Optional test/provider seam for reading one canonical target's modification time. */
export type ModifiedTimeReader = (target: FsTarget, signal?: AbortSignal) => Promise<number | undefined>

interface PendingDirectory {
  target: FsTarget
  relative: string
  depth: number
}

function safeBasename(entry: FsDirEntry): boolean {
  return entry.name !== ''
    && entry.name !== '.'
    && entry.name !== '..'
    && !entry.name.includes('/')
}

function joinRelative(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`
}

function score(path: string, query: string): number | undefined {
  if (query === '') return 0
  const candidate = path.toLocaleLowerCase()
  const needle = query.replaceAll('\\', '/').toLocaleLowerCase()
  const basename = candidate.slice(candidate.lastIndexOf('/') + 1)
  if (candidate === needle) return 0
  if (basename === needle) return 5
  if (candidate.startsWith(needle)) return 10
  if (basename.startsWith(needle)) return 20
  if (candidate.split('/').some(segment => segment.startsWith(needle))) return 30
  const pathIndex = candidate.indexOf(needle)
  if (pathIndex >= 0) return 40 + pathIndex
  return undefined
}

function compareModified(left: IndexedFileCandidate, right: IndexedFileCandidate): number {
  if (left.modifiedAt !== undefined && right.modifiedAt !== undefined && left.modifiedAt !== right.modifiedAt) {
    return right.modifiedAt - left.modifiedAt
  }
  if (left.modifiedAt !== undefined) return -1
  if (right.modifiedAt !== undefined) return 1
  return 0
}

async function defaultModifiedTimeReader(
  fs: ListingFileSystem,
  target: FsTarget,
  signal?: AbortSignal,
): Promise<number | undefined> {
  if (fs.processPath === undefined) return undefined
  signal?.throwIfAborted()
  try {
    const info = await stat(fs.processPath(target))
    signal?.throwIfAborted()
    return info.isFile() && Number.isFinite(info.mtimeMs) ? info.mtimeMs : undefined
  } catch (error: unknown) {
    signal?.throwIfAborted()
    // A remote/non-shared execution world or a concurrently removed file has
    // no Host-readable mtime. Path matching remains available without it.
    return undefined
  }
}

async function attachModifiedTimes(
  files: IndexedFileCandidate[],
  reader: ModifiedTimeReader,
  signal?: AbortSignal,
): Promise<void> {
  const concurrency = Math.min(32, files.length)
  let cursor = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < files.length) {
      signal?.throwIfAborted()
      const index = cursor
      cursor += 1
      const file = files[index]
      if (file === undefined) continue
      const modifiedAt = await reader(file.target, signal)
      if (modifiedAt !== undefined) file.modifiedAt = modifiedAt
    }
  }))
}

/**
 * Traverse one session workspace and build a content-free candidate index.
 * Every resolved child is rechecked against the canonical root, so a backend
 * following a repository-owned symlink cannot expose an outside target.
 */
export async function buildReferencedFileIndex(
  fs: ListingFileSystem,
  root: FsTarget,
  config: Pick<Config, 'excludeDirectories' | 'maxDepth' | 'maxScannedEntries'>,
  signal?: AbortSignal,
  modifiedTimeReader: ModifiedTimeReader = (target, activeSignal) =>
    defaultModifiedTimeReader(fs, target, activeSignal),
): Promise<ReferencedFileIndex> {
  const excluded = new Set(config.excludeDirectories.map(name => name.toLocaleLowerCase()))
  const pending: PendingDirectory[] = [{ target: root, relative: '', depth: 0 }]
  const visited = new Set<unknown>([root.targetKey])
  const files: IndexedFileCandidate[] = []
  let scanned = 0
  let truncated = false
  let pendingIndex = 0

  while (pendingIndex < pending.length) {
    signal?.throwIfAborted()
    const directory = pending[pendingIndex]
    pendingIndex += 1
    if (directory === undefined) break
    const entries = await fs.listDir(directory.target, signal)
    for (const entry of entries) {
      signal?.throwIfAborted()
      scanned += 1
      if (scanned > config.maxScannedEntries) {
        truncated = true
        break
      }
      if (!safeBasename(entry) || !fs.contains(root, entry.target)) continue
      const relative = joinRelative(directory.relative, entry.name)
      if (entry.type === 'directory') {
        if (directory.depth >= config.maxDepth || excluded.has(entry.name.toLocaleLowerCase())) continue
        if (visited.has(entry.target.targetKey)) continue
        visited.add(entry.target.targetKey)
        pending.push({ target: entry.target, relative, depth: directory.depth + 1 })
        continue
      }
      if (entry.type !== 'file') continue
      files.push({
        path: relative,
        target: entry.target,
        ...(entry.size === undefined ? {} : { size: entry.size }),
      })
    }
    if (truncated) break
  }

  await attachModifiedTimes(files, modifiedTimeReader, signal)
  return { files, truncated }
}

/** Rank one cached workspace snapshot without performing filesystem I/O. */
export function searchReferencedFileIndex(
  index: ReferencedFileIndex,
  query: string,
  maxCandidates: number,
): ListReferencedFilesResponse {
  const normalizedQuery = query.trim()
  const ranked: Array<{ candidate: IndexedFileCandidate; score: number }> = []
  for (const candidate of index.files) {
    const candidateScore = score(candidate.path, normalizedQuery)
    if (candidateScore !== undefined) ranked.push({ candidate, score: candidateScore })
  }
  ranked.sort((left, right) => compareModified(left.candidate, right.candidate)
    || left.score - right.score
    || left.candidate.path.localeCompare(right.candidate.path))
  const limit = Math.min(MAX_RETURNED_CANDIDATES, Math.max(1, maxCandidates))
  return {
    candidates: ranked.slice(0, limit).map(({ candidate }) => ({
      path: candidate.path,
      ...(candidate.size === undefined ? {} : { size: candidate.size }),
    })),
    truncated: index.truncated,
  }
}

/** One-shot compatibility helper; Remote callers should reuse an index cache. */
export async function listReferencedFiles(
  fs: ListingFileSystem,
  cwd: string,
  query: string,
  config: Pick<Config, 'excludeDirectories' | 'maxCandidates' | 'maxDepth' | 'maxScannedEntries'>,
  signal?: AbortSignal,
  modifiedTimeReader?: ModifiedTimeReader,
): Promise<ListReferencedFilesResponse> {
  const root = await fs.resolve(cwd, { signal })
  const index = await buildReferencedFileIndex(fs, root, config, signal, modifiedTimeReader)
  return searchReferencedFileIndex(index, query, config.maxCandidates)
}
