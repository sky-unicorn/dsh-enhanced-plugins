import { describe, expect, it, vi } from 'vitest'
import { apply, NS } from '../../src/edit-last-message/client/index.ts'

describe('edit-last-message client registration', () => {
  it('owns its locale and shadows the built-in user renderer', () => {
    const localeRegister = vi.fn(() => vi.fn())
    const slotRegister = vi.fn(() => vi.fn())
    const slotInject = vi.fn((_name: string, factory: () => unknown) => factory())
    const definitionRegister = vi.fn(() => vi.fn())
    const ctx = {
      effect: (factory: () => unknown) => factory(),
      get: (name: string) => name === 'connection' ? { rpc: { call: vi.fn() } } : undefined,
      locale: { register: localeRegister },
      uiConversation: { events: { register: definitionRegister } },
      slots: { inject: slotInject, register: slotRegister },
    }

    apply(ctx as never)

    expect(localeRegister).toHaveBeenCalledWith(NS, expect.objectContaining({ zh: expect.any(Object), en: expect.any(Object) }))
    expect(slotInject).toHaveBeenCalledWith('conversation.chat.node', expect.any(Function))
    expect(definitionRegister).toHaveBeenCalledTimes(2)
    expect(slotRegister).toHaveBeenCalledTimes(3)
    expect(slotRegister.mock.calls[0]?.[0]).toEqual({
      name: 'conversation.chat.node',
      key: 'user',
      priority: -10,
      locale: NS,
      inject: expect.any(Function),
    })
    expect(slotRegister.mock.calls[1]?.[0]).toMatchObject({ key: 'edited-user', priority: -10, locale: NS })
    expect(slotRegister.mock.calls[2]?.[0]).toMatchObject({ key: 'edit-cut-end', priority: -10 })
  })
})
