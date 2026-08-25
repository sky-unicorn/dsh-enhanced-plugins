import { describe, expect, it, vi } from 'vitest'
import {
  buildPluginIndex,
  dshBundleEvidence,
  githubActionsCommandValue,
  readPrevious,
} from '../../scripts/update-plugin-index.mjs'

const topic = 'dsh-plugin'

function repository(fullName: string, updatedAt: string) {
  const [owner, name] = fullName.split('/') as [string, string]
  return {
    name,
    full_name: fullName,
    description: `${name} description`,
    html_url: `https://github.com/${fullName}`,
    stargazers_count: 5,
    updated_at: updatedAt,
    pushed_at: updatedAt,
    topics: [topic],
    default_branch: 'main',
    owner: { avatar_url: `https://github.com/${owner}.png` },
    archived: false,
    disabled: false,
  }
}

function previousRepository(value: ReturnType<typeof repository>, packageName: string) {
  return {
    ...value,
    market: { packageName, bundlePatch: './cordis.patch.yml', installCommands: [] },
  }
}

describe('plugin market indexer', () => {
  it('accepts only safe root DSH bundle declarations', () => {
    expect(dshBundleEvidence({
      name: '@example/plugin',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })).toEqual({ packageName: '@example/plugin', bundlePatch: './cordis.patch.yml' })
    expect(dshBundleEvidence({
      name: '@example/plugin',
      dsh: { bundle: { patch: '../outside.yml' } },
    })).toBeUndefined()
  })

  it('reuses unchanged validations and checks only changed repository manifests', async () => {
    const unchanged = repository('example/unchanged', '2026-08-24T00:00:00Z')
    const changed = repository('sky-unicorn/dsh-enhanced-plugins', '2026-08-25T00:00:00Z')
    const invalid = repository('example/not-a-bundle', '2026-08-25T01:00:00Z')
    const { pushed_at: _legacyMissingPushedAt, ...legacyUnchanged } = previousRepository(
      unchanged,
      '@example/unchanged',
    )
    const previous = {
      schemaVersion: 2,
      validation: 'root-dsh-bundle-v1',
      topic,
      syncedAt: '2026-08-24T00:00:00.000Z',
      repositories: [legacyUnchanged],
    }
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith('https://api.github.com/search/repositories?')) {
        return new Response(JSON.stringify({
          total_count: 3,
          incomplete_results: false,
          items: [unchanged, changed, invalid],
        }), { status: 200 })
      }
      if (url.includes('/sky-unicorn/dsh-enhanced-plugins/')) {
        return new Response(JSON.stringify({
          name: 'dsh-enhanced-plugins',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }), { status: 200 })
      }
      if (url.includes('/example/not-a-bundle/')) return new Response('', { status: 404 })
      throw new Error(`Unexpected fetch ${url}`)
    })

    const index = await buildPluginIndex({
      previous,
      fetchImpl: fetchMock,
      searchIntervalMs: 0,
      now: () => new Date('2026-08-25T02:00:00.000Z'),
    })

    expect(index).toMatchObject({
      schemaVersion: 2,
      syncedAt: '2026-08-25T02:00:00.000Z',
      repositories: [
        { full_name: 'sky-unicorn/dsh-enhanced-plugins', market: { packageName: 'dsh-enhanced-plugins' } },
        { full_name: 'example/unchanged', market: { packageName: '@example/unchanged' } },
      ],
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/example/unchanged/'))).toBe(false)
  })

  it('skips a repository whose root package manifest is not valid JSON', async () => {
    const malformed = repository('example/malformed', '2026-08-25T01:00:00Z')
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith('https://api.github.com/search/repositories?')) {
        return Response.json({ total_count: 1, incomplete_results: false, items: [malformed] })
      }
      return new Response('{ invalid package json', { status: 200 })
    })

    const index = await buildPluginIndex({
      fetchImpl: fetchMock,
      searchIntervalMs: 0,
      now: () => new Date('2026-08-25T02:00:00.000Z'),
    })

    expect(index.repositories).toEqual([])
  })

  it('refuses an unexpected large shrink instead of replacing the last-good index', async () => {
    const kept = repository('example/kept', '2026-08-25T00:00:00Z')
    const previous = {
      schemaVersion: 2,
      validation: 'root-dsh-bundle-v1',
      topic,
      syncedAt: '2026-08-24T00:00:00.000Z',
      repositories: Array.from({ length: 20 }, (_, index) => previousRepository(
        repository(`example/plugin-${index}`, '2026-08-24T00:00:00Z'),
        `example-plugin-${index}`,
      )),
    }
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith('https://api.github.com/search/repositories?')) {
        return new Response(JSON.stringify({ total_count: 1, incomplete_results: false, items: [kept] }))
      }
      return new Response(JSON.stringify({
        name: 'example-kept',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))
    })

    await expect(buildPluginIndex({
      previous,
      fetchImpl: fetchMock,
      searchIntervalMs: 0,
      now: () => new Date('2026-08-25T02:00:00.000Z'),
    })).rejects.toThrow('Refusing to publish an index that shrank from 20 to 1')
  })

  it('treats the bundled seed as non-authoritative only while bootstrapping', async () => {
    const seed = { schemaVersion: 2, repositories: [] }
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const bootstrap = await readPrevious({
        previousUrl: 'https://example.test/market-index.json',
        previous: 'seed.json',
      }, {
        fetchImpl: vi.fn(async () => new Response('', { status: 404 })),
        readJsonFileImpl: vi.fn(async () => seed),
      })
      expect(bootstrap).toEqual({ document: seed, authoritative: false })

      const published = { schemaVersion: 2, repositories: [{ full_name: 'example/plugin' }] }
      const update = await readPrevious({
        previousUrl: 'https://example.test/market-index.json',
        previous: 'seed.json',
      }, {
        fetchImpl: vi.fn(async () => Response.json(published)),
        readJsonFileImpl: vi.fn(async () => seed),
      })
      expect(update).toEqual({ document: published, authoritative: true })
    } finally {
      stderr.mockRestore()
    }
  })

  it('fails closed when an existing published index cannot be read', async () => {
    await expect(readPrevious({
      previousUrl: 'https://example.test/market-index.json',
      previous: 'seed.json',
    }, {
      fetchImpl: vi.fn(async () => new Response('', { status: 503 })),
      readJsonFileImpl: vi.fn(),
    })).rejects.toThrow('Previous published index unavailable: previous index returned 503')
  })

  it('escapes diagnostic text before emitting a GitHub Actions command', () => {
    expect(githubActionsCommandValue('failed 100%\r\nnext line'))
      .toBe('failed 100%25%0D%0Anext line')
  })
})
