import { describe, expect, it } from 'vitest'
import { Config, type Config as PluginConfig } from '../../src/plugin-market/index.ts'

describe('plugin market configuration', () => {
  it('provides bounded defaults', () => {
    expect(Config({} as PluginConfig)).toMatchObject({
      profile: 'web',
      topic: 'dsh-plugin',
      pageSize: 12,
      operationTimeoutMs: 120000,
    })
  })

  it('rejects an excessive discovery page', () => {
    expect(() => Config({ pageSize: 31 } as PluginConfig)).toThrow()
  })
})
