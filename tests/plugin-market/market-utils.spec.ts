import { describe, expect, it } from 'vitest'
import {
  compareByStars,
  dshBundleEvidence,
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
    expect(dshBundleEvidence({ name: 'escaping-patch', dsh: { bundle: { patch: '../outside.yml' } } })).toBeUndefined()
    expect(dshBundleEvidence({ name: 'absolute-patch', dsh: { bundle: { patch: 'C:\\outside.yml' } } })).toBeUndefined()
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

})
