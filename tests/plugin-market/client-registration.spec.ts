import type { ComponentType } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconGlobeOutline14: () => null,
}))

import { PluginMarket } from '../../src/plugin-market/client/PluginMarket.tsx'
import { apply } from '../../src/plugin-market/client/index.ts'

describe('plugin community client registration', () => {
  it('contributes an independent Settings navigation section', () => {
    let injectedSlot: string | undefined
    let registration: {
      readonly options: { readonly name: string; readonly id: string; readonly order: number; readonly label: () => string }
      readonly component: ComponentType<never>
    } | undefined
    const ctx = {
      effect: (setup: () => () => void) => { setup() },
      locale: {
        register: vi.fn(() => () => {}),
        bind: vi.fn(() => (key: string) => key === 'nav' ? '插件社区' : key),
      },
      slots: {
        inject: vi.fn((name: string, setup: () => () => void) => {
          injectedSlot = name
          setup()
        }),
        register: vi.fn((options, component) => {
          registration = { options, component }
          return () => {}
        }),
      },
    } as unknown as ClientContext

    apply(ctx)

    expect(injectedSlot).toBe('settings.section')
    expect(registration?.options).toMatchObject({
      name: 'settings.section',
      id: 'plugin-community',
      order: 20,
    })
    expect(registration?.options.label()).toBe('插件社区')
    expect(registration?.component).toBe(PluginMarket)
  })
})
