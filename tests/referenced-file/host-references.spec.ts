import { describe, expect, it } from 'vitest'
import { ReferencedFileIndexCache } from '../../src/referenced-file/host/index-cache.ts'
import { listReferencedFiles, type ListingFileSystem } from '../../src/referenced-file/host/listing.ts'
import {
  injectReferencedFileContext, loadReferencedFiles, parseFileReferences,
  type ReferenceFileSystem,
} from '../../src/referenced-file/host/references.ts'

interface FakeTarget {
  targetKey: string
  displayPath: string
}

function target(path: string): FakeTarget {
  return { targetKey: path, displayPath: path }
}

function referenceFs(files: Record<string, Uint8Array>): ReferenceFileSystem {
  return {
    async resolve(path, options) {
      const absolute = path.startsWith('/') ? path : `${options?.cwd ?? ''}/${path}`
      const normalized = absolute.replaceAll('\\', '/').replace(/\/+/gu, '/')
      const segments: string[] = []
      for (const part of normalized.split('/')) {
        if (part === '' || part === '.') continue
        if (part === '..') segments.pop()
        else segments.push(part)
      }
      return target(`/${segments.join('/')}`) as never
    },
    contains(parent, child) {
      return child.displayPath === parent.displayPath || child.displayPath.startsWith(`${parent.displayPath}/`)
    },
    async stat(file) {
      const bytes = files[file.displayPath]
      return bytes === undefined ? undefined : { type: 'file', version: 'v1' as never, size: bytes.byteLength }
    },
    async readBytes(file, _signal, maxBytes) {
      const bytes = files[file.displayPath]
      if (bytes === undefined) throw new Error('missing')
      if (bytes.byteLength > maxBytes) throw new Error('too large')
      return bytes
    },
  }
}

const limits = { maxFileBytes: 100, maxReferences: 3, maxTotalBytes: 200 }

describe('Host # parsing and loading', () => {
  it('parses explicit escaped paths and bare paths without treating headings as references', () => {
    expect(parseFileReferences('# Heading\nread #src/a.ts and #<docs/a\\>b.md>')).toEqual([
      { path: 'src/a.ts', explicit: false },
      { path: 'docs/a>b.md', explicit: true },
    ])
  })

  it('loads contained UTF-8 files and rejects workspace escape', async () => {
    const fs = referenceFs({ '/ws/src/a.ts': new TextEncoder().encode('export const a = 1') })
    await expect(loadReferencedFiles(fs, '/ws', [{ path: 'src/a.ts', explicit: true }], limits))
      .resolves.toEqual([{ path: 'src/a.ts', bytes: 18, text: 'export const a = 1' }])
    await expect(loadReferencedFiles(fs, '/ws', [{ path: '../secret.txt', explicit: true }], limits))
      .rejects.toThrow('outside the session workspace')
  })

  it('fails explicit missing and binary files while ignoring ordinary unmatched hashtags', async () => {
    const fs = referenceFs({ '/ws/bin.dat': new Uint8Array([1, 0, 2]) })
    await expect(loadReferencedFiles(fs, '/ws', [{ path: 'topic', explicit: false }], limits))
      .resolves.toEqual([])
    await expect(loadReferencedFiles(fs, '/ws', [{ path: 'missing.ts', explicit: true }], limits))
      .rejects.toThrow('file does not exist')
    await expect(loadReferencedFiles(fs, '/ws', [{ path: 'bin.dat', explicit: true }], limits))
      .rejects.toThrow('binary data')
  })

  it('injects one provenance-labelled snapshot after the claimed user prompt', async () => {
    const fs = referenceFs({ '/ws/a.txt': new TextEncoder().encode('alpha') })
    const prompt = {
      id: 'u1', role: 'user', content: [{ type: 'text', text: 'read #<a.txt>' }], source: { kind: 'user' },
    } as never
    const downstream = {
      id: 'p1', role: 'user', content: [{ type: 'text', text: 'runtime' }], source: { kind: 'plugin', plugin: 'other' },
    } as never
    const entered = await injectReferencedFileContext(fs, '/ws', [prompt], [prompt, downstream], limits)
    expect(entered).toHaveLength(3)
    expect(entered[1]?.source).toMatchObject({ kind: 'plugin', plugin: 'referenced-file' })
    expect(entered[1]?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('alpha') })
    expect(entered[2]).toBe(downstream)
    await expect(injectReferencedFileContext(fs, '/ws', [prompt], [downstream], limits))
      .resolves.toEqual([downstream])
  })
})

describe('candidate traversal', () => {
  it('ranks matches, skips excluded directories, and never exposes outside targets', async () => {
    const root = target('/ws')
    const src = target('/ws/src')
    const nodeModules = target('/ws/node_modules')
    const fs: ListingFileSystem = {
      async resolve() { return root as never },
      contains(parent, child) {
        return child.displayPath === parent.displayPath || child.displayPath.startsWith(`${parent.displayPath}/`)
      },
      async listDir(directory) {
        if (directory.displayPath === '/ws') return [
          { name: 'README.md', type: 'file', target: target('/ws/README.md') as never, size: 10 },
          { name: 'src', type: 'directory', target: src as never },
          { name: 'node_modules', type: 'directory', target: nodeModules as never },
          { name: 'escape.txt', type: 'file', target: target('/outside/escape.txt') as never },
        ]
        if (directory.displayPath === '/ws/src') return [
          { name: 'index.ts', type: 'file', target: target('/ws/src/index.ts') as never, size: 20 },
          { name: 'input.ts', type: 'file', target: target('/ws/src/input.ts') as never, size: 30 },
        ]
        throw new Error(`unexpected traversal: ${directory.displayPath}`)
      },
    }
    await expect(listReferencedFiles(fs, '/ws', 'in', {
      excludeDirectories: ['node_modules'], maxCandidates: 10, maxDepth: 5, maxScannedEntries: 20,
    })).resolves.toEqual({
      candidates: [
        { path: 'src/index.ts', size: 20 },
        { path: 'src/input.ts', size: 30 },
      ],
      truncated: false,
    })
  })

  it('returns at most 20 candidates and orders equally relevant files by newest modification', async () => {
    const root = target('/ws')
    const entries = Array.from({ length: 25 }, (_, index) => ({
      name: `file-${String(index).padStart(2, '0')}.ts`,
      type: 'file' as const,
      target: target(`/ws/file-${String(index).padStart(2, '0')}.ts`) as never,
      size: index,
    }))
    const fs: ListingFileSystem = {
      async resolve() { return root as never },
      contains() { return true },
      async listDir() { return entries },
    }
    const result = await listReferencedFiles(fs, '/ws', '', {
      excludeDirectories: [], maxCandidates: 100, maxDepth: 1, maxScannedEntries: 100,
    }, undefined, async file => Number(file.displayPath.slice(-5, -3)))
    expect(result.candidates).toHaveLength(20)
    expect(result.candidates.slice(0, 3).map(candidate => candidate.path)).toEqual([
      'file-24.ts', 'file-23.ts', 'file-22.ts',
    ])
  })

  it('keeps newest matches first while a longer path query narrows the result', async () => {
    const root = target('/ws')
    const src = target('/ws/src')
    const docs = target('/ws/docs')
    const files = [
      { path: '/ws/src/index.ts', modifiedAt: 10 },
      { path: '/ws/docs/index.ts', modifiedAt: 20 },
      { path: '/ws/src/very-new-index.ts', modifiedAt: 1_000 },
    ]
    const fs: ListingFileSystem = {
      async resolve() { return root as never },
      contains() { return true },
      async listDir(directory) {
        if (directory.displayPath === '/ws') return [
          { name: 'src', type: 'directory', target: src as never },
          { name: 'docs', type: 'directory', target: docs as never },
        ]
        if (directory.displayPath === '/ws/src') return [
          { name: 'index.ts', type: 'file', target: target('/ws/src/index.ts') as never },
          { name: 'very-new-index.ts', type: 'file', target: target('/ws/src/very-new-index.ts') as never },
        ]
        if (directory.displayPath === '/ws/docs') return [
          { name: 'index.ts', type: 'file', target: target('/ws/docs/index.ts') as never },
        ]
        throw new Error(`unexpected traversal: ${directory.displayPath}`)
      },
    }
    const result = await listReferencedFiles(fs, '/ws', 'index.ts', {
      excludeDirectories: [], maxCandidates: 20, maxDepth: 1, maxScannedEntries: 100,
    }, undefined, async file => files.find(candidate => candidate.path === file.displayPath)?.modifiedAt)
    expect(result.candidates.map(candidate => candidate.path)).toEqual([
      'src/very-new-index.ts', 'docs/index.ts', 'src/index.ts',
    ])
    const narrowed = await listReferencedFiles(fs, '/ws', 'src/index.ts', {
      excludeDirectories: [], maxCandidates: 20, maxDepth: 1, maxScannedEntries: 100,
    }, undefined, async file => files.find(candidate => candidate.path === file.displayPath)?.modifiedAt)
    expect(narrowed.candidates.map(candidate => candidate.path)).toEqual(['src/index.ts'])
  })

  it('reuses one workspace index across later queries', async () => {
    const root = target('/ws')
    let listings = 0
    const fs: ListingFileSystem = {
      async resolve() { return root as never },
      contains() { return true },
      async listDir() {
        listings += 1
        return [
          { name: 'README.md', type: 'file', target: target('/ws/README.md') as never },
          { name: 'src.ts', type: 'file', target: target('/ws/src.ts') as never },
        ]
      },
    }
    const cache = new ReferencedFileIndexCache(fs, {
      excludeDirectories: [],
      indexTtlMs: 30_000,
      maxCachedWorkspaces: 2,
      maxCandidates: 20,
      maxDepth: 2,
      maxFileBytes: 100,
      maxReferences: 3,
      maxScannedEntries: 100,
      maxTotalBytes: 200,
    }, async () => undefined)
    await expect(cache.list('/ws', '')).resolves.toMatchObject({ candidates: expect.any(Array) })
    await expect(cache.list('/ws', 'src')).resolves.toMatchObject({
      candidates: [{ path: 'src.ts' }],
    })
    expect(listings).toBe(1)
    await cache.dispose()
  })

  it('aborts and settles an active index build when disposed', async () => {
    const root = target('/ws')
    let releaseStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => { releaseStarted = resolve })
    let observedAbort = false
    const fs: ListingFileSystem = {
      async resolve() { return root as never },
      contains() { return true },
      async listDir(_directory, signal) {
        releaseStarted?.()
        return new Promise((resolve, reject) => {
          const abort = (): void => {
            observedAbort = true
            reject(signal?.reason ?? new Error('aborted'))
          }
          if (signal?.aborted === true) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        })
      },
    }
    const cache = new ReferencedFileIndexCache(fs, {
      excludeDirectories: [],
      indexTtlMs: 30_000,
      maxCachedWorkspaces: 2,
      maxCandidates: 20,
      maxDepth: 2,
      maxFileBytes: 100,
      maxReferences: 3,
      maxScannedEntries: 100,
      maxTotalBytes: 200,
    }, async () => undefined)
    const pending = cache.list('/ws', '')
    const rejected = expect(pending).rejects.toBeDefined()
    await started
    await cache.dispose()
    await rejected
    expect(observedAbort).toBe(true)
  })
})
