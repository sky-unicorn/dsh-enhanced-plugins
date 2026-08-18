import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { Config } from './config.js'
import {
  buildReferencedFileIndex,
  searchReferencedFileIndex,
  type ListingFileSystem,
  type ModifiedTimeReader,
  type ReferencedFileIndex,
} from './listing.js'
import type { ListReferencedFilesResponse } from './types.js'

interface IndexBuild {
  controller: AbortController
  promise: Promise<ReferencedFileIndex>
}

interface CacheEntry {
  root: FsTarget
  index?: ReferencedFileIndex
  expiresAt: number
  build?: IndexBuild
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
    void promise.then(
      value => {
        signal.removeEventListener('abort', aborted)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', aborted)
        reject(error)
      },
    )
  })
}

/** Bounded, non-persistent workspace path index with stale-while-revalidate refresh. */
export class ReferencedFileIndexCache {
  private readonly entries = new Map<unknown, CacheEntry>()
  private disposed = false

  constructor(
    private readonly fs: ListingFileSystem,
    private readonly config: Config,
    private readonly modifiedTimeReader?: ModifiedTimeReader,
  ) {}

  /** Resolve, build or reuse one workspace index, then rank at most 20 paths. */
  async list(cwd: string, query: string, signal?: AbortSignal): Promise<ListReferencedFilesResponse> {
    if (this.disposed) throw new Error('referenced-file index cache is disposed')
    signal?.throwIfAborted()
    const root = await this.fs.resolve(cwd, { signal })
    let entry = this.entries.get(root.targetKey)
    if (entry === undefined) {
      entry = { root, expiresAt: 0 }
      this.entries.set(root.targetKey, entry)
      this.evictOverflow()
    } else {
      this.touch(root.targetKey, entry)
    }

    if (entry.index !== undefined && Date.now() < entry.expiresAt) {
      return searchReferencedFileIndex(entry.index, query, this.config.maxCandidates)
    }

    const build = entry.build ?? this.startBuild(root.targetKey, entry)
    if (entry.index !== undefined) {
      return searchReferencedFileIndex(entry.index, query, this.config.maxCandidates)
    }
    const index = await awaitWithSignal(build.promise, signal)
    return searchReferencedFileIndex(index, query, this.config.maxCandidates)
  }

  /** Abort refreshes and release every cached path snapshot during unload/HMR. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const builds = Array.from(this.entries.values())
      .map(entry => entry.build)
      .filter((build): build is IndexBuild => build !== undefined)
    for (const build of builds) build.controller.abort()
    this.entries.clear()
    await Promise.allSettled(builds.map(build => build.promise))
  }

  private startBuild(key: unknown, entry: CacheEntry): IndexBuild {
    const controller = new AbortController()
    const promise = buildReferencedFileIndex(
      this.fs,
      entry.root,
      this.config,
      controller.signal,
      this.modifiedTimeReader,
    )
    const build = { controller, promise }
    entry.build = build
    void promise.then(
      index => {
        if (this.disposed || this.entries.get(key) !== entry || entry.build !== build) return
        entry.index = index
        entry.expiresAt = Date.now() + this.config.indexTtlMs
        entry.build = undefined
      },
      () => {
        if (this.entries.get(key) === entry && entry.build === build) entry.build = undefined
      },
    )
    return build
  }

  private touch(key: unknown, entry: CacheEntry): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
  }

  private evictOverflow(): void {
    while (this.entries.size > this.config.maxCachedWorkspaces) {
      const oldest = this.entries.entries().next().value as [unknown, CacheEntry] | undefined
      if (oldest === undefined) return
      this.entries.delete(oldest[0])
      oldest[1].build?.controller.abort()
    }
  }
}
