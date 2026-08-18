import { describe, expect, it } from 'vitest'
import {
  compareByStars,
  dshBundleEvidence,
  findInstalledPackageName,
  isPackageName,
  npmPackageCandidates,
  npmRepositoryMatches,
} from '../../src/plugin-market/market-utils.ts'

describe('market catalog helpers', () => {
  it('identifies plugins only from an installable DSH bundle manifest', () => {
    expect(dshBundleEvidence({
      name: '@example/plugin',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })).toEqual({ packageName: '@example/plugin', bundlePatch: './cordis.patch.yml' })
    expect(dshBundleEvidence({ name: 'topic-only', keywords: ['dsh-plugin'] })).toBeUndefined()
    expect(dshBundleEvidence({ name: 'missing-patch', dsh: { bundle: {} } })).toBeUndefined()
    expect(dshBundleEvidence({ name: 'empty-patch', dsh: { bundle: { patch: '  ' } } })).toBeUndefined()
  })

  it('orders higher star counts before lower ones with deterministic ties', () => {
    const entries = [
      { fullName: 'z/older', stars: 5, updatedAt: '2026-01-01T00:00:00Z' },
      { fullName: 'a/newer', stars: 5, updatedAt: '2026-02-01T00:00:00Z' },
      { fullName: 'b/popular', stars: 50, updatedAt: '2025-01-01T00:00:00Z' },
    ]
    expect(entries.sort(compareByStars).map(entry => entry.fullName))
      .toEqual(['b/popular', 'a/newer', 'z/older'])
  })

  it('extracts only simple npm specs from dsh add guidance', () => {
    expect(npmPackageCandidates([
      'dsh plugin --profile web add @example/plugin',
      'pnpm dsh plugin --profile web add "plain-plugin@1.2.3"',
      'dsh plugin --profile web add github:owner/repo',
      'dsh plugin --profile web add ./source-directory',
      'dsh plugin --profile web add -w link:/source-directory',
      'git clone https://github.com/owner/repo.git',
    ], 'declared-plugin')).toEqual(['@example/plugin', 'plain-plugin', 'declared-plugin'])
  })

  it('requires an npm package to identify the same GitHub repository', () => {
    expect(npmRepositoryMatches(
      { type: 'git', url: 'git+https://github.com/Owner/Repo.git' },
      'owner/repo',
    )).toBe(true)
    expect(npmRepositoryMatches('github:owner/repo', 'owner/repo')).toBe(true)
    expect(npmRepositoryMatches('https://github.com/other/repo', 'owner/repo')).toBe(false)
    expect(npmRepositoryMatches(undefined, 'owner/repo')).toBe(false)
  })

  it('correlates installed catalog entries by package name, GitHub spec, or manifest repository', () => {
    const dependencies = {
      'declared-plugin': '1.2.3',
      'git-plugin': 'github:owner/git-repo#abc123',
      'renamed-plugin': '4.5.6',
    }
    const manifests = new Map([
      ['renamed-plugin', { repository: 'https://github.com/owner/manifest-repo.git' }],
    ])

    expect(findInstalledPackageName('owner/declared-repo', ['declared-plugin'], dependencies, manifests))
      .toBe('declared-plugin')
    expect(findInstalledPackageName('owner/git-repo', [], dependencies, manifests)).toBe('git-plugin')
    expect(findInstalledPackageName('owner/manifest-repo', [], dependencies, manifests)).toBe('renamed-plugin')
    expect(findInstalledPackageName('owner/not-installed', [], dependencies, manifests)).toBeUndefined()
  })

  it('rejects package names that could escape the profile node_modules directory', () => {
    expect(isPackageName('normal-package')).toBe(true)
    expect(isPackageName('@scope/package')).toBe(true)
    expect(isPackageName('..')).toBe(false)
    expect(isPackageName('@scope/..')).toBe(false)
  })
})
